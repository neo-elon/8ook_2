'use strict';

/* ============================================================
   BARCODE SCANNER ENGINE & MODAL LOGIC (ZXING-WASM NEXT-GEN)
   - 최신 WebAssembly 엔진 (zxing-wasm / ZXing-C++ v2.2+)
   - 360도 전방위 회전 인식 (tryRotate) & 적응형 국소 이진화 (LocalAverage)
   - 싱글톤 Native BarcodeDetector (EAN-13 지원 환경 하드웨어 가속)
   - ISBN-13 (978/979) 체크섬 검증 & 도서 바코드 우선 매칭
   - 실시간 트래킹 박스 오버레이, 손전등(Torch), 줌(Zoom 1x/2x), 탭 투 포커스
   - 사진 앨범 직접 분석 & 모달 내 수동 ISBN 직접 입력 지원
   ============================================================ */
let barcodeStream = null;
let barcodeScanLoop = null;
let barcodeCurrentFacing = 'environment';
let barcodeAutoScanningActive = true;
let nativeBarcodeDetectorInstance = null;
let sharedZXingReaderInstance = null;
let isBarcodeTorchOn = false;
let barcodeCurrentZoom = 1.5;
let barcodeSupportedZoomRange = null;
let barcodeHasTorch = false;
let barcodeProcessingCanvas = null;
let barcodeProcessingCtx = null;

// Initialize Web Audio Context for scanning feedback sound
let barcodeAudioCtx = null;
function playBarcodeBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!barcodeAudioCtx) barcodeAudioCtx = new AudioCtx();
    if (barcodeAudioCtx.state === 'suspended') barcodeAudioCtx.resume();

    const osc = barcodeAudioCtx.createOscillator();
    const gain = barcodeAudioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1760, barcodeAudioCtx.currentTime); // A6 note
    gain.gain.setValueAtTime(0.12, barcodeAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, barcodeAudioCtx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(barcodeAudioCtx.destination);
    osc.start();
    osc.stop(barcodeAudioCtx.currentTime + 0.08);
  } catch (_) { }
}

// ISBN-13 Checksum verification (Modulo 10 algorithm)
function isValidIsbn13(isbn) {
  const clean = String(isbn).replace(/[^0-9]/g, '');
  if (!/^97[89]\d{10}$/.test(clean)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(clean[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(clean[12], 10);
}

// Smart Barcode Filter: prioritize ISBN-13 (978/979) over auxiliary barcodes
function pickBestBookBarcode(codes) {
  if (!codes || !codes.length) return null;
  // 1) Valid ISBN-13
  for (const c of codes) {
    const clean = String(c).replace(/[^0-9]/g, '');
    if (isValidIsbn13(clean)) return clean;
  }
  // 2) 13 digits starting with 978 or 979
  for (const c of codes) {
    const clean = String(c).replace(/[^0-9]/g, '');
    if (clean.length === 13 && (clean.startsWith('978') || clean.startsWith('979'))) {
      return clean;
    }
  }
  // 3) Any 13 digits EAN
  for (const c of codes) {
    const clean = String(c).replace(/[^0-9]/g, '');
    if (clean.length === 13) return clean;
  }
  // 4) Any 10 digits ISBN
  for (const c of codes) {
    const clean = String(c).replace(/[^0-9Xx]/g, '');
    if (clean.length === 10) return clean;
  }
  return codes[0];
}

function openBarcodeScannerModal() {
  openModal('barcode-scanner-modal');
  isBarcodeTorchOn = false;
  barcodeCurrentZoom = 1.5;
  const manualInput = document.getElementById('barcode-manual-isbn-input');
  if (manualInput) manualInput.value = '';
  _initBarcodeEngines();
  _startBarcodeCamera(barcodeCurrentFacing);
  _setupTapToFocus();
}

function closeBarcodeScannerModal() {
  _stopBarcodeCamera();
  const video = document.getElementById('barcode-video');
  if (video) video.style.transform = 'none';
  const modal = document.getElementById('barcode-scanner-modal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

async function _initBarcodeEngines() {
  console.info('[8ook barcode] init', {
    wasm: typeof ZXingWASM !== 'undefined',
    native: 'BarcodeDetector' in window,
    legacy: typeof ZXing !== 'undefined'
  });
  // 1. Pre-warm ZXingWASM WebAssembly engine
  if (typeof ZXingWASM !== 'undefined' && ZXingWASM.prepareZXingModule) {
    try {
      ZXingWASM.prepareZXingModule();
    } catch (e) {
      console.warn('ZXingWASM prepare error:', e);
    }
  }

  // 2. Check native BarcodeDetector if EAN-13 is actively supported
  if (!nativeBarcodeDetectorInstance && 'BarcodeDetector' in window) {
    try {
      let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];
      if (typeof BarcodeDetector.getSupportedFormats === 'function') {
        const supported = await BarcodeDetector.getSupportedFormats();
        if (supported && supported.includes('ean_13')) {
          formats = formats.filter(f => supported.includes(f));
          nativeBarcodeDetectorInstance = new BarcodeDetector({ formats });
          console.info('[8ook barcode] native ready', formats);
        } else {
          nativeBarcodeDetectorInstance = null;
        }
      } else {
        nativeBarcodeDetectorInstance = new BarcodeDetector({ formats });
      }
    } catch (e) {
      console.warn('Native BarcodeDetector init error:', e);
      nativeBarcodeDetectorInstance = null;
    }
  }

  // 3. Fallback shared ZXing pure JS reader
  if (!sharedZXingReaderInstance && typeof ZXing !== 'undefined') {
    try {
      const hints = new Map();
      if (ZXing.DecodeHintType) {
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
          ZXing.BarcodeFormat.EAN_13,
          ZXing.BarcodeFormat.EAN_8,
          ZXing.BarcodeFormat.UPC_A,
          ZXing.BarcodeFormat.UPC_E,
          ZXing.BarcodeFormat.CODE_128,
          ZXing.BarcodeFormat.CODE_39
        ]);
      }
      sharedZXingReaderInstance = new ZXing.BrowserMultiFormatReader(hints);
      console.info('[8ook barcode] legacy ZXing ready');
    } catch (e) {
      console.warn('ZXing init error:', e);
    }
  }
}

function _stopBarcodeCamera() {
  if (barcodeScanLoop) {
    cancelAnimationFrame(barcodeScanLoop);
    clearTimeout(barcodeScanLoop);
    barcodeScanLoop = null;
  }
  if (barcodeStream) {
    barcodeStream.getTracks().forEach(t => t.stop());
    barcodeStream = null;
  }
  _clearTrackCanvas();
}

function _setBarcodeScannerStatus(label, color) {
  const dot = document.getElementById('barcode-status-dot');
  const lbl = document.getElementById('barcode-status-label');
  if (dot) dot.style.background = color || '#34d399';
  if (lbl) lbl.textContent = label || '스캐너 활성';
}

function _setupTapToFocus() {
  const video = document.getElementById('barcode-video');
  const indicator = document.getElementById('barcode-focus-indicator');
  if (!video || !indicator) return;

  video.onclick = async (e) => {
    const rect = video.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    indicator.style.left = x + 'px';
    indicator.style.top = y + 'px';
    indicator.style.opacity = '1';
    indicator.style.transform = 'translate(-50%, -50%) scale(1)';

    setTimeout(() => {
      indicator.style.opacity = '0';
      indicator.style.transform = 'translate(-50%, -50%) scale(1.3)';
    }, 400);

    if (barcodeStream) {
      const track = barcodeStream.getVideoTracks()[0];
      if (track && track.applyConstraints) {
        try {
          await track.applyConstraints({
            advanced: [{ focusMode: 'continuous' }]
          });
        } catch (_) { }
      }
    }
  };
}

async function _startBarcodeCamera(facing) {
  _stopBarcodeCamera();
  barcodeAutoScanningActive = true;
  _setBarcodeScannerStatus('카메라 연결 중...', '#f59e0b');

  const video = document.getElementById('barcode-video');
  if (!video) return;

  try {
    const constraints = {
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        advanced: [
          { focusMode: 'continuous' },
          { exposureMode: 'continuous' }
        ]
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    barcodeStream = stream;
    video.srcObject = stream;
    await video.play();

    // Check device capabilities (Torch, Zoom)
    const track = stream.getVideoTracks()[0];
    const zoomBtn = document.getElementById('barcode-zoom-btn');

    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();

      // Torch
      barcodeHasTorch = !!caps.torch;
      const torchBtn = document.getElementById('barcode-torch-btn');
      if (torchBtn) torchBtn.style.display = barcodeHasTorch ? 'flex' : 'none';

      // Zoom (Default 1.5x)
      if (caps.zoom) {
        barcodeSupportedZoomRange = caps.zoom;
        const minZ = caps.zoom.min || 1;
        const maxZ = caps.zoom.max || 1;
        barcodeCurrentZoom = Math.max(minZ, Math.min(1.5, maxZ));
        try {
          await track.applyConstraints({
            advanced: [{ zoom: barcodeCurrentZoom }]
          });
        } catch (_) { }
        video.style.transform = 'none';
      } else {
        barcodeSupportedZoomRange = null;
        // Hardware zoom not supported -> apply smooth digital zoom
        barcodeCurrentZoom = 1.5;
        video.style.transform = 'scale(1.5)';
      }
    } else {
      barcodeSupportedZoomRange = null;
      barcodeCurrentZoom = 1.5;
      video.style.transform = 'scale(1.5)';
    }

    if (zoomBtn) {
      zoomBtn.style.display = 'flex';
      zoomBtn.textContent = barcodeCurrentZoom + 'x';
      zoomBtn.style.background = barcodeCurrentZoom > 1 ? '#c99365' : 'rgba(0,0,0,0.6)';
      zoomBtn.style.color = barcodeCurrentZoom > 1 ? '#000' : '#fff';
    }

    console.info('[8ook barcode] camera ready', { width: video.videoWidth, height: video.videoHeight, facing });
    _setBarcodeScannerStatus('자동 스캔 중 (AI/WASM)', '#34d399');
    _startBarcodeScanLoop();
  } catch (err) {
    console.warn('Barcode camera error:', err);
    _setBarcodeScannerStatus('카메라 오류', '#ef4444');
    toast('카메라를 열 수 없습니다. 사진 선택 또는 직접 입력을 이용해 주세요.');
  }
}

async function toggleBarcodeTorch() {
  if (!barcodeStream || !barcodeHasTorch) return;
  const track = barcodeStream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return;

  try {
    isBarcodeTorchOn = !isBarcodeTorchOn;
    await track.applyConstraints({
      advanced: [{ torch: isBarcodeTorchOn }]
    });
    const btn = document.getElementById('barcode-torch-btn');
    if (btn) {
      btn.style.background = isBarcodeTorchOn ? '#c99365' : 'rgba(0,0,0,0.6)';
      btn.style.color = isBarcodeTorchOn ? '#000' : '#fff';
    }
  } catch (err) {
    console.warn('Torch toggle error:', err);
  }
}

async function toggleBarcodeZoom() {
  if (!barcodeStream) return;
  const track = barcodeStream.getVideoTracks()[0];
  const video = document.getElementById('barcode-video');
  const btn = document.getElementById('barcode-zoom-btn');

  // Cycle: 1.5x -> 2x -> 1x -> 1.5x
  if (barcodeCurrentZoom === 1.5) {
    barcodeCurrentZoom = 2;
  } else if (barcodeCurrentZoom === 2) {
    barcodeCurrentZoom = 1;
  } else {
    barcodeCurrentZoom = 1.5;
  }

  if (track && barcodeSupportedZoomRange) {
    const minZoom = barcodeSupportedZoomRange.min || 1;
    const maxZoom = barcodeSupportedZoomRange.max || 1;
    const targetZoom = Math.max(minZoom, Math.min(barcodeCurrentZoom, maxZoom));
    try {
      await track.applyConstraints({
        advanced: [{ zoom: targetZoom }]
      });
    } catch (_) { }
  } else if (video) {
    video.style.transform = (barcodeCurrentZoom === 1) ? 'none' : `scale(${barcodeCurrentZoom})`;
  }

  if (btn) {
    btn.textContent = barcodeCurrentZoom + 'x';
    btn.style.background = barcodeCurrentZoom > 1 ? '#c99365' : 'rgba(0,0,0,0.6)';
    btn.style.color = barcodeCurrentZoom > 1 ? '#000' : '#fff';
  }
}

function _clearTrackCanvas() {
  const canvas = document.getElementById('barcode-track-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function _drawTrackingBox(cornerPoints, videoEl) {
  const canvas = document.getElementById('barcode-track-canvas');
  if (!canvas || !cornerPoints || cornerPoints.length < 4 || !videoEl) return;

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const vw = videoEl.videoWidth || 1;
  const vh = videoEl.videoHeight || 1;
  const cw = canvas.width;
  const ch = canvas.height;

  // Video object-fit:cover scale mapping
  const videoAR = vw / vh;
  const canvasAR = cw / ch;
  let renderW, renderH, offsetX, offsetY;

  if (videoAR > canvasAR) {
    renderH = ch;
    renderW = ch * videoAR;
    offsetX = (cw - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = cw;
    renderH = cw / videoAR;
    offsetX = 0;
    offsetY = (ch - renderH) / 2;
  }

  const mapX = (x) => offsetX + (x / vw) * renderW;
  const mapY = (y) => offsetY + (y / vh) * renderH;

  ctx.beginPath();
  ctx.moveTo(mapX(cornerPoints[0].x), mapY(cornerPoints[0].y));
  for (let i = 1; i < cornerPoints.length; i++) {
    ctx.lineTo(mapX(cornerPoints[i].x), mapY(cornerPoints[i].y));
  }
  ctx.closePath();

  ctx.lineWidth = 3;
  ctx.strokeStyle = '#34d399';
  ctx.fillStyle = 'rgba(52, 211, 153, 0.2)';
  ctx.fill();
  ctx.stroke();
}

function _drawTrackingBoxFromPosition(position, videoEl, canvasW, canvasH) {
  if (!position || !videoEl) return;
  const vw = videoEl.videoWidth || 1;
  const vh = videoEl.videoHeight || 1;
  let pts = null;
  if (Array.isArray(position) && position.length >= 4) {
    pts = position;
  } else if (position.topLeft && position.topRight && position.bottomRight && position.bottomLeft) {
    const scaleX = vw / (canvasW || vw);
    const scaleY = vh / (canvasH || vh);
    pts = [
      { x: position.topLeft.x * scaleX, y: position.topLeft.y * scaleY },
      { x: position.topRight.x * scaleX, y: position.topRight.y * scaleY },
      { x: position.bottomRight.x * scaleX, y: position.bottomRight.y * scaleY },
      { x: position.bottomLeft.x * scaleX, y: position.bottomLeft.y * scaleY }
    ];
  }
  if (pts) _drawTrackingBox(pts, videoEl);
}

// Helper: Scan single canvas or image data with ZXingWASM
async function _scanFrameWithZxingWasm(canvasOrImageData, options = {}) {
  if (typeof ZXingWASM === 'undefined' || !ZXingWASM.readBarcodesFromImageData) return null;
  try {
    const opts = {
      formats: ['EAN13', 'ISBN', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39'],
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
      binarizer: options.binarizer || 'LocalAverage',
      maxNumberOfSymbols: 4,
      ...options
    };
    const imgData = (canvasOrImageData instanceof ImageData)
      ? canvasOrImageData
      : canvasOrImageData.getContext('2d').getImageData(0, 0, canvasOrImageData.width, canvasOrImageData.height);

    const results = await ZXingWASM.readBarcodesFromImageData(imgData, opts);
    if (results && results.length > 0) {
      const codes = results.map(r => r.text).filter(Boolean);
      const best = pickBestBookBarcode(codes);
      if (best) {
        const item = results.find(r => r.text === best) || results[0];
        return { code: best, item, position: item.position };
      }
    }
  } catch (_) { }
  return null;
}

// Center guide cropped region canvas
function _getCroppedCanvas(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const cropW = Math.round(vw * 0.72);
  const cropH = Math.round(vh * 0.48);
  const cropX = Math.round((vw - cropW) / 2);
  const cropY = Math.round((vh - cropH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return canvas;
}

// Contrast Boost helper
function _applyContrastBoost(ctx, width, height) {
  try {
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const val = gray < 128 ? Math.max(0, gray * 0.6) : Math.min(255, gray * 1.4);
      d[i] = val; d[i + 1] = val; d[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);
  } catch (_) { }
}

function _startBarcodeScanLoop() {
  const video = document.getElementById('barcode-video');
  if (!video) return;

  let lastScanTime = 0;
  const scanInterval = 75; // ~13 FPS: optimal for WASM throughput and minimal CPU heat
  let isScanningFrame = false;
  let frameCounter = 0;

  async function loop(now) {
    if (!barcodeStream || !barcodeAutoScanningActive) return;

    if (now - lastScanTime >= scanInterval && video.readyState >= 2 && !isScanningFrame) {
      lastScanTime = now;
      isScanningFrame = true;
      frameCounter++;

      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw > 0 && vh > 0) {
          // Normalize frame dimension to max 900px for sub-5ms WebAssembly execution
          const maxDim = 900;
          let targetW = vw;
          let targetH = vh;
          if (Math.max(vw, vh) > maxDim) {
            const scale = maxDim / Math.max(vw, vh);
            targetW = Math.round(vw * scale);
            targetH = Math.round(vh * scale);
          }

          if (!barcodeProcessingCanvas) {
            barcodeProcessingCanvas = document.createElement('canvas');
          }
          if (barcodeProcessingCanvas.width !== targetW || barcodeProcessingCanvas.height !== targetH) {
            barcodeProcessingCanvas.width = targetW;
            barcodeProcessingCanvas.height = targetH;
            barcodeProcessingCtx = barcodeProcessingCanvas.getContext('2d', { willReadFrequently: true });
          }

          barcodeProcessingCtx.drawImage(video, 0, 0, targetW, targetH);

          let detected = null;

          // ── Tier 1: Modern ZXingWASM (ZXing-C++ WebAssembly) ──
          if (typeof ZXingWASM !== 'undefined' && ZXingWASM.readBarcodesFromImageData) {
            try {
              const imgData = barcodeProcessingCtx.getImageData(0, 0, targetW, targetH);
              const binarizerType = (frameCounter % 3 === 0) ? 'GlobalHistogram' : 'LocalAverage';
              const results = await ZXingWASM.readBarcodesFromImageData(imgData, {
                formats: ['EAN13', 'ISBN', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39'],
                tryHarder: true,
                tryRotate: true,
                tryInvert: true,
                tryDownscale: true,
                binarizer: binarizerType,
                maxNumberOfSymbols: 4
              });
              if (results && results.length > 0) {
                const codes = results.map(r => r.text).filter(Boolean);
                const best = pickBestBookBarcode(codes);
                if (best) {
                  const item = results.find(r => r.text === best) || results[0];
                  detected = { code: best, position: item.position, canvasW: targetW, canvasH: targetH };
                }
              }
            } catch (err) {
              if (frameCounter === 1 || frameCounter % 60 === 0) console.warn('[8ook barcode] WASM frame error', err);
            }
          }

          // ── Tier 2: Native BarcodeDetector (Zero-copy GPU Hardware Accelerated) ──
          if (!detected && nativeBarcodeDetectorInstance) {
            try {
              const barcodes = await nativeBarcodeDetectorInstance.detect(video);
              if (barcodes && barcodes.length > 0) {
                const rawCodes = barcodes.map(b => b.rawValue).filter(Boolean);
                const best = pickBestBookBarcode(rawCodes);
                if (best) {
                  const matched = barcodes.find(b => b.rawValue === best) || barcodes[0];
                  detected = { code: best, points: matched.cornerPoints || null };
                }
              }
            } catch (err) {
              if (frameCounter === 1 || frameCounter % 60 === 0) console.warn('[8ook barcode] native frame error', err);
            }
          }

          // ── Tier 3: ZXing Legacy Fallback with Center Crop ──
          if (!detected && sharedZXingReaderInstance && (frameCounter % 2 === 0)) {
            try {
              const cropCanvas = _getCroppedCanvas(video);
              if (cropCanvas) {
                let res = null;
                if (typeof sharedZXingReaderInstance.decodeFromCanvas === 'function') {
                  res = await sharedZXingReaderInstance.decodeFromCanvas(cropCanvas);
                } else if (typeof sharedZXingReaderInstance.decodeFromImageElement === 'function') {
                  const img = new Image();
                  img.src = cropCanvas.toDataURL('image/png');
                  await img.decode();
                  res = await sharedZXingReaderInstance.decodeFromImageElement(img);
                }
                const text = res && (typeof res.getText === 'function' ? res.getText() : res.text);
                if (text) detected = { code: text };
              }
            } catch (err) {
              if (frameCounter === 2 || frameCounter % 60 === 0) console.warn('[8ook barcode] legacy frame error', err);
            }
          }

          if (detected && detected.code) {
            console.info('[8ook barcode] detected', detected.code);
            barcodeAutoScanningActive = false;
            if (detected.position) {
              _drawTrackingBoxFromPosition(detected.position, video, detected.canvasW, detected.canvasH);
            } else if (detected.points) {
              _drawTrackingBox(detected.points, video);
            }
            _onBarcodeDetected(detected.code);
            return;
          }
        }
      } catch (err) {
        console.warn('[8ook barcode] scan loop error', err);
      } finally {
        isScanningFrame = false;
      }
    }

    if (barcodeAutoScanningActive && barcodeStream) {
      barcodeScanLoop = requestAnimationFrame(loop);
    }
  }

  barcodeScanLoop = requestAnimationFrame(loop);
}

function _onBarcodeDetected(rawCode, position) {
  if (barcodeScanLoop) {
    cancelAnimationFrame(barcodeScanLoop);
    clearTimeout(barcodeScanLoop);
    barcodeScanLoop = null;
  }
  barcodeAutoScanningActive = false;

  const cleanCode = String(rawCode).replace(/[^0-9Xx]/g, '');

  if (position) {
    const video = document.getElementById('barcode-video');
    _drawTrackingBoxFromPosition(position, video);
  }

  // Sound feedback
  playBarcodeBeep();

  // Haptic feedback (mobile)
  if (navigator.vibrate) navigator.vibrate([40, 60, 40]);

  _setBarcodeScannerStatus('인식 완료', '#34d399');

  // Flash guide frame green
  const guide = document.getElementById('barcode-guide-frame');
  if (guide) {
    guide.style.boxShadow = '0 0 30px 6px rgba(52,211,153,0.8), inset 0 0 20px rgba(52,211,153,0.4)';
  }

  const toastEl = document.getElementById('barcode-result-toast');
  if (toastEl) {
    toastEl.textContent = cleanCode;
    toastEl.style.display = 'block';
  }

  setTimeout(() => {
    closeBarcodeScannerModal();
    toast(`도서 바코드 인식 완료: ${cleanCode}`);
    const results = document.getElementById('aladin-results');
    if (results) {
      results.classList.add('show');
      results.innerHTML = `<div class="search-loading"><span class="spin"></span> 도서 정보 검색 중...</div>`;
    }
    searchAladinByIsbn(cleanCode);
  }, 500);
}

// Manual Capture Button Action (high-resolution multi-binarizer deep scan)
async function triggerBarcodeCapture() {
  const video = document.getElementById('barcode-video');
  if (!video || !barcodeStream) return;

  barcodeAutoScanningActive = false;
  if (barcodeScanLoop) {
    cancelAnimationFrame(barcodeScanLoop);
    clearTimeout(barcodeScanLoop);
    barcodeScanLoop = null;
  }

  _setBarcodeScannerStatus('고화질 정밀 분석 중...', '#f59e0b');

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  let detected = null;

  // 1. ZXingWASM full frame high resolution (LocalAverage)
  if (typeof ZXingWASM !== 'undefined') {
    detected = await _scanFrameWithZxingWasm(canvas, { binarizer: 'LocalAverage', tryHarder: true, tryRotate: true });
  }

  // 2. ZXingWASM full frame (GlobalHistogram)
  if (!detected && typeof ZXingWASM !== 'undefined') {
    detected = await _scanFrameWithZxingWasm(canvas, { binarizer: 'GlobalHistogram', tryHarder: true, tryRotate: true });
  }

  // 3. Center crop WASM
  if (!detected && typeof ZXingWASM !== 'undefined') {
    const crop = _getCroppedCanvas(video);
    if (crop) {
      detected = await _scanFrameWithZxingWasm(crop, { tryHarder: true, tryRotate: true });
    }
  }

  // 4. Native detector
  if (!detected && nativeBarcodeDetectorInstance) {
    try {
      const barcodes = await nativeBarcodeDetectorInstance.detect(canvas);
      if (barcodes && barcodes.length > 0) {
        const best = pickBestBookBarcode(barcodes.map(b => b.rawValue));
        if (best) {
          const matched = barcodes.find(b => b.rawValue === best) || barcodes[0];
          detected = { code: best, points: matched.cornerPoints };
        }
      }
    } catch (_) { }
  }

  // 5. Shared ZXing reader fallback
  if (!detected && sharedZXingReaderInstance) {
    try {
      const res = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
      if (res && res.text) detected = { code: res.text };
    } catch (_) { }
  }

  if (detected && detected.code) {
    _onBarcodeDetected(detected.code, detected.item?.position || detected.points);
  } else {
    _setBarcodeScannerStatus('미인식 — 재시도', '#ef4444');
    const gt = document.getElementById('barcode-guide-text');
    if (gt) gt.innerHTML = '바코드를 <strong style="color:#c99365;">박스 안</strong>에 맞추거나, 아래에 <strong style="color:#c99365;">ISBN</strong>을 직접 입력해주세요';

    setTimeout(() => {
      if (!barcodeStream) return;
      _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
      if (gt) gt.innerHTML = '도서 뒷면 바코드를 <strong style="color:#c99365;">박스 안</strong>에 맞춰주세요';
      barcodeAutoScanningActive = true;
      _startBarcodeScanLoop();
    }, 2000);
  }
}

// Album Photo Select Handler (handles 360-degree rotation, gallery uploads)
async function handleBarcodeAlbumSelect(input) {
  const file = input.files[0];
  if (!file) return;

  _setBarcodeScannerStatus('사진 분석 중...', '#f59e0b');
  toast('사진에서 고정밀 바코드 분석 중...');

  _initBarcodeEngines();
  let foundCode = null;

  // 1. ZXingWASM direct file read (Best in industry, handles 360° rotation & inversion)
  if (typeof ZXingWASM !== 'undefined' && ZXingWASM.readBarcodes) {
    try {
      const results = await ZXingWASM.readBarcodes(file, {
        formats: ['EAN13', 'ISBN', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39'],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 5
      });
      if (results && results.length > 0) {
        foundCode = pickBestBookBarcode(results.map(r => r.text));
      }
    } catch (e) {
      console.warn('ZXingWASM album file decode error:', e);
    }
  }

  // 2. If not found, try GlobalHistogram binarizer via image canvas
  if (!foundCode) {
    try {
      const imgBitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = imgBitmap.width;
      canvas.height = imgBitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgBitmap, 0, 0);

      // Try ZXingWASM with GlobalHistogram
      if (typeof ZXingWASM !== 'undefined' && ZXingWASM.readBarcodesFromImageData) {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = await ZXingWASM.readBarcodesFromImageData(imgData, {
          formats: ['EAN13', 'ISBN', 'EAN8', 'UPCA', 'UPCE', 'Code128'],
          tryHarder: true,
          tryRotate: true,
          tryInvert: true,
          binarizer: 'GlobalHistogram'
        });
        if (res && res.length > 0) {
          foundCode = pickBestBookBarcode(res.map(r => r.text));
        }
      }

      // Try Native detector
      if (!foundCode && nativeBarcodeDetectorInstance) {
        try {
          const barcodes = await nativeBarcodeDetectorInstance.detect(canvas);
          if (barcodes && barcodes.length > 0) {
            foundCode = pickBestBookBarcode(barcodes.map(b => b.rawValue));
          }
        } catch (_) { }
      }

      // Try ZXing with contrast stretching
      if (!foundCode && sharedZXingReaderInstance) {
        try {
          const res = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
          if (res && res.text) foundCode = res.text;
        } catch (_) { }
      }

      if (!foundCode && sharedZXingReaderInstance) {
        _applyContrastBoost(ctx, canvas.width, canvas.height);
        try {
          const res2 = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
          if (res2 && res2.text) foundCode = res2.text;
        } catch (_) { }
      }
    } catch (err) {
      console.warn('Canvas image processing error:', err);
    }
  }

  if (foundCode) {
    _onBarcodeDetected(foundCode);
  } else {
    toast('사진에서 바코드를 찾을 수 없습니다. 선명한 사진을 사용하시거나 직접 ISBN을 입력해주세요.');
    _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
  }
  input.value = '';
}

// Manual ISBN Direct Input Handler from Scanner Modal
function submitBarcodeManualIsbn() {
  const input = document.getElementById('barcode-manual-isbn-input');
  if (!input) return;
  const raw = input.value.trim();
  const clean = raw.replace(/[^0-9Xx]/g, '');
  if (!clean || (clean.length !== 10 && clean.length !== 13)) {
    toast('10자리 또는 13자리 ISBN 번호를 입력해주세요');
    input.focus();
    return;
  }
  closeBarcodeScannerModal();
  toast(`ISBN 직접 검색: ${clean}`);
  const results = document.getElementById('aladin-results');
  if (results) {
    results.classList.add('show');
    results.innerHTML = `<div class="search-loading"><span class="spin"></span> 도서 정보 검색 중...</div>`;
  }
  searchAladinByIsbn(clean);
}

function switchBarcodeCamera() {
  barcodeCurrentFacing = (barcodeCurrentFacing === 'environment') ? 'user' : 'environment';
  _startBarcodeCamera(barcodeCurrentFacing);
}
