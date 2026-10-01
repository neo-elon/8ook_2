'use strict';

/* Blog cover generation and blog-ready book copying. */

function drawBlogCoverCanvas(img) {
  const size = 800;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // 1. 차콜 배경 채우기
  ctx.fillStyle = '#383838';
  ctx.fillRect(0, 0, size, size);

  // 2. 배경 이미지: 정사각형 전체를 채우도록 확대(cover)하여 배치
  const imgW = img.naturalWidth || img.width || 400;
  const imgH = img.naturalHeight || img.height || 600;
  const scale = Math.max(size / imgW, size / imgH);
  const bgW = imgW * scale;
  const bgH = imgH * scale;
  const bgX = (size - bgW) / 2;
  const bgY = (size - bgH) / 2;

  ctx.save();
  // 흑백 및 밝기 조정 (배경을 한결 은은하고 밝게 표현)
  if ('filter' in ctx) {
    ctx.filter = 'grayscale(100%) brightness(0.58) contrast(0.92)';
    ctx.drawImage(img, bgX, bgY, bgW, bgH);
  } else {
    ctx.drawImage(img, bgX, bgY, bgW, bgH);
    ctx.fillStyle = 'rgba(50, 50, 50, 0.35)';
    ctx.fillRect(0, 0, size, size);
  }
  ctx.restore();

  // 가장자리 은은한 비네팅 효과 (중앙 도서에 자연스럽게 시선 집중)
  const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.72);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);

  // 3. 중앙 전면 도서 표지 (원본 가로세로 비율 유지)
  const targetCoverH = Math.round(size * 0.85); // 캔버스 높이의 85% (약 680px)
  const targetCoverW = Math.round(targetCoverH * (imgW / imgH));
  const coverX = Math.round((size - targetCoverW) / 2);
  const coverY = Math.round((size - targetCoverH) / 2);

  // 중앙 표지 뒤 부드러운 드롭 섀도우
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = 35;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#000000';
  ctx.fillRect(coverX, coverY, targetCoverW, targetCoverH);
  ctx.restore();

  // 선명한 원본 전면 표지 렌더링
  ctx.save();
  ctx.drawImage(img, coverX, coverY, targetCoverW, targetCoverH);
  // 미세한 1px 테두리로 경계선 선명화
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(coverX + 0.5, coverY + 0.5, targetCoverW - 1, targetCoverH - 1);
  ctx.restore();

  return canvas.toDataURL('image/jpeg', 0.92);
}

function generateBlogCover(coverUrl) {
  return new Promise((resolve) => {
    if (!coverUrl) return resolve('');

    const img = new Image();
    img.crossOrigin = 'anonymous';

    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    // 타임아웃 방지 (4초)
    const timer = setTimeout(() => {
      finish(coverUrl);
    }, 4000);

    img.onload = () => {
      clearTimeout(timer);
      try {
        const dataUrl = drawBlogCoverCanvas(img);
        finish(dataUrl || coverUrl);
      } catch (err) {
        console.warn('Canvas export failed:', err);
        finish(coverUrl);
      }
    };

    img.onerror = () => {
      clearTimeout(timer);
      // 직접 로딩(CORS 등) 실패 시 안전한 프록시 경유 재시도
      if (!coverUrl.startsWith('data:') && !coverUrl.includes('wsrv.nl')) {
        const proxyUrl = `https://wsrv.nl/?url=${encodeURIComponent(coverUrl)}&output=jpg`;
        const pImg = new Image();
        pImg.crossOrigin = 'anonymous';
        const pTimer = setTimeout(() => finish(coverUrl), 3000);
        pImg.onload = () => {
          clearTimeout(pTimer);
          try {
            const dataUrl = drawBlogCoverCanvas(pImg);
            finish(dataUrl || coverUrl);
          } catch (e) {
            finish(coverUrl);
          }
        };
        pImg.onerror = () => {
          clearTimeout(pTimer);
          finish(coverUrl);
        };
        pImg.src = proxyUrl;
      } else {
        finish(coverUrl);
      }
    };

    img.src = coverUrl;
  });
}

async function copyBlogCoverImage(bookId) {
  let book = books.find(b => b.id === bookId);
  if (!book && bookId === '8ook_user_guide') {
    book = getUserGuideBook();
  }
  if (!book || !book.cover) {
    toast('표지 이미지가 없습니다.');
    return;
  }

  toast('블로그용 표지 이미지를 생성하는 중...');
  const coverUrl = getSafeImageUrl(book.cover);
  const dataUrl = await generateBlogCover(coverUrl);

  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    toast('표지 이미지 생성에 실패했습니다.');
    return;
  }

  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    // 폭넓은 클립보드 호환성을 위해 image/png로 복사
    const pngCanvas = document.createElement('canvas');
    const pngImg = new Image();
    pngImg.src = dataUrl;
    await new Promise(r => { pngImg.onload = r; });
    pngCanvas.width = pngImg.width;
    pngCanvas.height = pngImg.height;
    const pctx = pngCanvas.getContext('2d');
    pctx.drawImage(pngImg, 0, 0);
    pngCanvas.toBlob(async (pngBlob) => {
      if (pngBlob && navigator.clipboard && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          toast('블로그용 편집 표지 이미지가 복사되었습니다! (Ctrl+V로 붙여넣기)');
        } catch (e) {
          downloadBlogCoverImage(bookId);
        }
      } else {
        downloadBlogCoverImage(bookId);
      }
    }, 'image/png');
  } catch (err) {
    console.warn('Clipboard image copy failed, downloading instead:', err);
    downloadBlogCoverImage(bookId);
  }
}

async function downloadBlogCoverImage(bookId) {
  let book = books.find(b => b.id === bookId);
  if (!book && bookId === '8ook_user_guide') {
    book = getUserGuideBook();
  }
  if (!book || !book.cover) return;

  const coverUrl = getSafeImageUrl(book.cover);
  const dataUrl = await generateBlogCover(coverUrl);
  const a = document.createElement('a');
  a.href = dataUrl;
  const titleParts = splitBookTitle(book);
  const safeName = (titleParts.main || book.title || 'book').replace(/[/\\?%*:|"<>]/g, '_');
  a.download = `${safeName}_블로그표지.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('블로그용 표지 이미지를 다운로드했습니다.');
}

function copyBookForBlog(bookId) {
  let book = books.find(b => b.id === bookId);
  if (!book && bookId === '8ook_user_guide') {
    book = getUserGuideBook();
  }
  if (!book) return;

  const titleParts = splitBookTitle(book);
  const title = titleParts.main || book.title || '제목 없음';
  const subtitle = titleParts.sub || book.subtitle || '';
  const author = book.author || '';
  const date = book.date ? fmtDate(book.date) : '';
  const pages = book.pages ? `${Number(book.pages).toLocaleString()}쪽` : '';
  const ratingVal = Number(book.rating) || 0;
  const ratingStr = ratingVal > 0 ? `${'★'.repeat(Math.round(ratingVal))}${'☆'.repeat(5 - Math.round(ratingVal))} (${ratingVal}점)` : '';
  const keywords = (book.keywords && book.keywords.length) ? book.keywords.map(k => `#${k}`).join(' ') : '';
  const sentence = book.sentence ? book.sentence.trim() : '';

  const coverUrl = book.cover ? getSafeImageUrl(book.cover) : '';

  const scraps = [...(book.scraps || [])].sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));

  // 첫 줄 제목행 생성 (순서: 저자  도서명  나만의 한문장)
  // 저자명에서 '지음', '(지은이)' 등 역할 표기를 제거하고 순수 이름만 추출
  const cleanAuthorForTitle = (author || '')
    .replace(/\s*\([^)]*(지은이|지음|저자|글|옮긴이|역자|편저)[^)]*\)/g, '')
    .replace(/^지은이\s*[:：]?\s*/g, '')
    .replace(/(?:[\s_]+)?(지음|지은이|저|글)\s*$/g, '')
    .trim();

  const titleDisplay = title ? (title.startsWith('《') ? title : `《${title}》`) : '';
  const blogTitleParts = [];
  if (cleanAuthorForTitle) blogTitleParts.push(cleanAuthorForTitle);
  if (titleDisplay) blogTitleParts.push(titleDisplay);
  if (sentence) blogTitleParts.push(sentence);
  const blogTitleLine = blogTitleParts.join('  ');

  // 1. Plain Text Format (No icons, no table)
  let plain = '';
  if (blogTitleLine) {
    plain += `${blogTitleLine}\n\n`;
  }
  plain += `《${title}》\n\n`;
  plain += `[도서 정보]\n`;
  plain += `도서명: 《${title}》\n`;
  if (subtitle) plain += `부제: ${subtitle}\n`;
  if (author) plain += `저자: ${author}\n`;
  if (date) plain += `완독일: ${date}\n`;
  if (pages) plain += `분량: ${pages}\n`;
  if (ratingStr) plain += `평점: ${ratingStr}\n`;
  if (coverUrl && coverUrl.startsWith('http')) plain += `표지: ${coverUrl}\n`;

  if (sentence) {
    plain += `\n[한 줄 평]\n“${sentence}”\n`;
  }

  plain += `\n────────────────────────────\n`;
  plain += `\n[수집한 문장 & 독서 기록]\n`;

  if (scraps.length === 0) {
    plain += `(기록된 문장이 없습니다.)\n`;
  } else {
    scraps.forEach((s) => {
      plain += `\n“${s.text}”\n`;
      if (s.page) {
        const pageNum = String(s.page).replace(/^[^\d]*/, '').trim() || String(s.page).trim();
        plain += `p.${pageNum}\n`;
      }
      if (s.memo) {
        plain += `${s.memo}\n`;
      }
    });
  }

  plain += `\n────────────────────────────\n출처: 8ook (나만의 독서기록)\n`;

  // 2. Rich HTML Format
  let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; line-height: 1.8; color: #222; max-width: 680px; padding: 8px 0; font-size: 15px;">`;
  if (blogTitleLine) {
    html += `<h1 style="margin: 0 0 12px 0; font-size: 22px; font-weight: 800; line-height: 1.5; color: #111; word-break: keep-all;">${esc(blogTitleLine)}</h1>`;
  }
  html += `<h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #111;">《${esc(title)}》</h2>`;
  if (subtitle) {
    html += `<div style="font-size: 15px; color: #666; margin-bottom: 14px;">${esc(subtitle)}</div>`;
  }

  if (coverUrl) {
    html += `<div style="margin: 14px 0 18px 0;">`;
    html += `<img src="${esc(coverUrl)}" alt="${esc(title)} 표지" style="max-width: 200px; height: auto; border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,0.15); display: block;" />`;
    html += `</div>`;
  }

  html += `<div style="margin: 14px 0 18px 0; font-size: 15px; line-height: 1.8;">`;
  if (author) html += `<div><strong>저자:</strong> ${esc(author)}</div>`;
  if (date) html += `<div><strong>완독일:</strong> ${esc(date)}</div>`;
  if (pages) html += `<div><strong>분량:</strong> ${esc(pages)}</div>`;
  if (ratingStr) html += `<div><strong>평점:</strong> ${esc(ratingStr)}</div>`;
  html += `</div>`;

  if (sentence) {
    html += `<blockquote style="margin: 16px 0 20px 0; padding: 14px 20px; border-left: 4px solid #8c6239; background: #faf7f2; border-radius: 4px; font-size: 16px; font-style: italic; color: #222; line-height: 1.7;">`;
    html += `“${esc(sentence)}”`;
    html += `</blockquote>`;
  }

  html += `<hr style="border: none; border-top: 1px dashed #d8cfc4; margin: 24px 0;" />`;
  html += `<h3 style="margin: 0 0 16px 0; font-size: 19px; font-weight: 700; color: #222;">수집한 문장 &amp; 독서 기록</h3>`;

  if (scraps.length === 0) {
    html += `<p style="color: #888; font-size: 14px;">(기록된 문장이 없습니다.)</p>`;
  } else {
    scraps.forEach((s) => {
      const pageNum = s.page ? (String(s.page).replace(/^[^\d]*/, '').trim() || String(s.page).trim()) : '';
      const pageHtml = pageNum ? `<div style="font-size: 13px; color: #78716c; margin-top: 6px; font-style: normal;">p.${esc(pageNum)}</div>` : '';

      html += `<div style="margin-bottom: 24px;">`;
      html += `<blockquote style="margin: 0 0 6px 0; padding: 12px 18px; background: #fbf9f5; border-left: 3px solid #c97a2b; border-radius: 4px; font-size: 16px; font-style: italic; line-height: 1.7; color: #111;">`;
      html += `“${esc(s.text)}”`;
      if (pageHtml) {
        html += pageHtml;
      }
      html += `</blockquote>`;

      if (s.memo) {
        html += `<div style="margin: 6px 0 0 4px; font-size: 15px; color: #333; line-height: 1.7;">${esc(s.memo)}</div>`;
      }
      html += `</div>`;
    });
  }

  html += `<hr style="border: none; border-top: 1px dashed #d8cfc4; margin: 24px 0 14px 0;" />`;
  html += `<div style="font-size: 13px; color: #999; text-align: right;">출처: 8ook (나만의 독서기록)</div>`;
  html += `</div>`;

  const successMsg = '블로그용 독서노트가 복사되었습니다! (네이버블로그, 노션 등에서 Ctrl+V)';
  if (navigator.clipboard && window.ClipboardItem) {
    const blobHtml = new Blob([html], { type: 'text/html' });
    const blobText = new Blob([plain], { type: 'text/plain' });
    navigator.clipboard.write([
      new ClipboardItem({
        'text/html': blobHtml,
        'text/plain': blobText
      })
    ]).then(() => {
      toast(successMsg);
    }).catch(() => {
      fallbackCopyText(plain, successMsg);
    });
  } else {
    fallbackCopyText(plain, successMsg);
  }
}
