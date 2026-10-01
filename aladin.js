'use strict';

/* Aladin book search, JSONP lookup, sorting, selection, and page-detail helpers. */

function hideSearchResults() {
  const r = document.getElementById('aladin-results');
  if (!r) return;
  r.classList.remove('show');
  r.innerHTML = '';
}

function fetchAladinCover(title, author) {
  return new Promise((resolve) => {
    const key = getApiKey();
    let query = title.trim();
    const colonIdx = query.indexOf(':');
    if (colonIdx !== -1) query = query.substring(0, colonIdx).trim();
    const parenIdx = query.indexOf('(');
    if (parenIdx !== -1) query = query.substring(0, parenIdx).trim();

    if (author) {
      const cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '').trim();
      query += ' ' + cleanAuthor;
    }

    const cbName = '_aladinCb_cover_' + (++aladinCallbackCounter);
    const script = document.createElement('script');
    const params = new URLSearchParams({
      ttbkey: key,
      Query: query,
      QueryType: 'Keyword',
      MaxResults: '1',
      start: '1',
      SearchTarget: 'Book',
      output: 'JS',
      Cover: 'Big',
      Sort: 'Accuracy',
      callback: cbName
    });

    let done = false;
    const cleanup = () => {
      if (!done) {
        done = true;
        delete window[cbName];
        script.remove();
      }
    };

    window[cbName] = function (arg1, arg2) {
      const data = (typeof arg1 === 'boolean' || typeof arg1 === 'number') ? arg2 : arg1;
      cleanup();
      if (data && data.item && data.item.length > 0 && data.item[0].cover) {
        let cover = (data.item[0].cover || '').replace('/coversum/', '/cover500/').replace('/cover200/', '/cover500/');
        resolve(cover);
      } else {
        resolve(null);
      }
    };

    script.onerror = () => { cleanup(); resolve(null); };
    setTimeout(() => { cleanup(); resolve(null); }, 6000);
    script.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${params}`;
    document.body.appendChild(script);
  });
}

function searchAladin() {
  const query = document.getElementById('bk-title').value.trim();
  if (!query) { toast('도서 제목을 입력해주세요'); return; }

  currentAladinQuery = query;
  currentAladinSort = 'Accuracy';

  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 검색 중...</div>`;

  runAladinJsonp(query, key, results, currentAladinSort);
}

function searchAladinByIsbn(isbn) {
  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 바코드로 도서 검색 중...</div>`;

  runAladinLookUpJsonp(isbn, key, results, true);
}

function runAladinLookUpJsonp(isbn, key, results, isBarcodeScan = false) {
  const cbName = '_aladinCb_lookup_' + (++aladinCallbackCounter);
  const script = document.createElement('script');

  const params = new URLSearchParams({
    ttbkey: key,
    itemIdType: 'ISBN13',
    ItemId: isbn,
    output: 'JS',
    Cover: 'Big',
    OptResult: 'subInfo',
    callback: cbName
  });

  script.src = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?${params}`;

  window[cbName] = function (arg1, arg2) {
    delete window[cbName];
    script.remove();
    const data = (typeof arg1 === 'boolean' || typeof arg1 === 'number') ? arg2 : arg1;
    console.info('[8ook aladin] ISBN lookup response', { isbn, hasData: !!data, itemCount: data && Array.isArray(data.item) ? data.item.length : 0, data });
    if (data && data.item && data.item.length > 0) {
      handleAladinResults(data.item, isBarcodeScan, isbn);
    } else {
      // Step 2: Try 10-digit ISBN ItemLookUp
      const cbName10 = '_aladinCb_lookup10_' + (++aladinCallbackCounter);
      const script10 = document.createElement('script');
      const params10 = new URLSearchParams({
        ttbkey: key,
        itemIdType: 'ISBN',
        ItemId: isbn,
        output: 'JS',
        Cover: 'Big',
        OptResult: 'subInfo',
        callback: cbName10
      });
      script10.src = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?${params10}`;

      const tryKeywordFallback = () => {
        // Step 3: Fallback to ItemSearch with Keyword=ISBN (captures books indexed by keyword)
        const cbNameKw = '_aladinCb_lookupKw_' + (++aladinCallbackCounter);
        const scriptKw = document.createElement('script');
        const paramsKw = new URLSearchParams({
          ttbkey: key,
          Query: isbn,
          QueryType: 'Keyword',
          MaxResults: '12',
          start: '1',
          SearchTarget: 'Book',
          output: 'JS',
          Cover: 'Big',
          OptResult: 'subInfo',
          callback: cbNameKw
        });
        scriptKw.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${paramsKw}`;
        window[cbNameKw] = function (kw1, kw2) {
          delete window[cbNameKw];
          scriptKw.remove();
          const kwData = (typeof kw1 === 'boolean' || typeof kw1 === 'number') ? kw2 : kw1;
          if (kwData && kwData.item && kwData.item.length > 0) {
            handleAladinResults(kwData.item, isBarcodeScan, isbn);
          } else {
            results.innerHTML = `<div class="search-empty">바코드로 도서를 찾을 수 없습니다. (ISBN: ${esc(isbn)})<br><span style="font-size:12px; opacity:0.8; margin-top:6px; display:inline-block;">도서 제목이나 저자명으로 직접 검색해 보세요.</span></div>`;
          }
        };
        scriptKw.onerror = function () {
          delete window[cbNameKw];
          scriptKw.remove();
          results.innerHTML = `<div class="search-empty">바코드로 도서를 찾을 수 없습니다. (ISBN: ${esc(isbn)})</div>`;
        };
        document.body.appendChild(scriptKw);
      };

      window[cbName10] = function (tArg1, tArg2) {
        delete window[cbName10];
        script10.remove();
        const data10 = (typeof tArg1 === 'boolean' || typeof tArg1 === 'number') ? tArg2 : tArg1;
        if (data10 && data10.item && data10.item.length > 0) {
          handleAladinResults(data10.item, isBarcodeScan, isbn);
        } else {
          tryKeywordFallback();
        }
      };
      script10.onerror = function () {
        delete window[cbName10];
        script10.remove();
        tryKeywordFallback();
      };
      document.body.appendChild(script10);
    }
  };

  script.onerror = function () {
    delete window[cbName];
    script.remove();
    results.innerHTML = `<div class="search-empty">검색 실패 — 도서 검색 상태를 확인해주세요.</div>`;
  };

  setTimeout(() => {
    if (window[cbName]) {
      delete window[cbName];
      script.remove();
      results.innerHTML = `<div class="search-empty">응답 시간 초과</div>`;
    }
  }, 10000);

  document.body.appendChild(script);
}


async function handleCameraScan(input) {
  const file = input.files[0];
  if (!file) return;

  const results = document.getElementById('aladin-results');
  if (results) {
    results.classList.add('show');
    results.innerHTML = `<div class="search-loading"><span class="spin"></span> 바코드 고정밀 분석 중...</div>`;
  }

  _initBarcodeEngines();

  // 1. Try ZXingWASM directly on the file
  if (typeof ZXingWASM !== 'undefined' && ZXingWASM.readBarcodes) {
    try {
      const detected = await ZXingWASM.readBarcodes(file, {
        formats: ['EAN13', 'ISBN', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39'],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 5
      });
      if (detected && detected.length > 0) {
        const codes = detected.map(r => r.text).filter(Boolean);
        const best = pickBestBookBarcode(codes);
        if (best) {
          toast(`바코드 인식 완료: ${best}`);
          searchAladinByIsbn(best);
          input.value = '';
          return;
        }
      }
    } catch (e) {
      console.warn('WASM file scan error:', e);
    }
  }

  // 2. Fallback using canvas & ZXing
  const reader = new FileReader();
  reader.onload = function (e) {
    const tempImg = new Image();
    tempImg.onload = async function () {
      const canvas = document.createElement('canvas');
      canvas.width = tempImg.naturalWidth;
      canvas.height = tempImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(tempImg, 0, 0);

      // Try WASM from canvas
      const wasmCode = await _scanFrameWithZxingWasm(canvas, { tryHarder: true, tryRotate: true });
      if (wasmCode && wasmCode.code) {
        toast(`바코드 인식 완료: ${wasmCode.code}`);
        searchAladinByIsbn(wasmCode.code);
        input.value = '';
        return;
      }

      // Old ZXing fallback
      if (sharedZXingReaderInstance) {
        try {
          const res = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
          if (res && res.text) {
            toast(`바코드 인식 완료: ${res.text}`);
            searchAladinByIsbn(res.text);
            input.value = '';
            return;
          }
        } catch (_) { }
      }

      if (results) {
        results.innerHTML = `<div class="search-empty">바코드를 인식하지 못했습니다. 책 뒷면의 바코드가 선명하게 보이도록 다시 촬영해 주세요.</div>`;
      }
    };
    tempImg.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function changeAladinSort(newSort) {
  if (currentAladinSort === newSort) return;
  currentAladinSort = newSort;
  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  if (results && currentAladinQuery) {
    const listEl = results.querySelector('.search-results-list');
    if (listEl) {
      const label = newSort === 'SalesPoint' ? '인기순' : newSort === 'PublishTime' ? '최신순' : '정확도순';
      listEl.innerHTML = `<div class="search-loading"><span class="spin"></span> ${label}으로 정렬 중...</div>`;
    }
    results.querySelectorAll('.sort-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === newSort);
    });
    runAladinJsonp(currentAladinQuery, key, results, newSort);
  }
}

function runAladinJsonp(query, key, results, sort = currentAladinSort || 'Accuracy') {
  currentAladinQuery = query;
  currentAladinSort = sort;
  const cbName = '_aladinCb_' + (++aladinCallbackCounter);
  const script = document.createElement('script');

  const params = new URLSearchParams({
    ttbkey: key,
    Query: query,
    QueryType: 'Keyword',
    MaxResults: '25',
    start: '1',
    SearchTarget: 'Book',
    output: 'JS',
    Cover: 'Big',
    OptResult: 'subInfo',
    Sort: sort,
    callback: cbName
  });

  script.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${params}`;

  window[cbName] = function (arg1, arg2) {
    delete window[cbName];
    script.remove();
    const data = (typeof arg1 === 'boolean' || typeof arg1 === 'number') ? arg2 : arg1;
    if (data && data.item && data.item.length > 0) {
      handleAladinResults(data);
    } else {
      // Fallback: try QueryType=Title
      const cbNameTitle = '_aladinCb_title_' + (++aladinCallbackCounter);
      const scriptTitle = document.createElement('script');
      const paramsTitle = new URLSearchParams({
        ttbkey: key,
        Query: query,
        QueryType: 'Title',
        MaxResults: '25',
        start: '1',
        SearchTarget: 'Book',
        output: 'JS',
        Cover: 'Big',
        OptResult: 'subInfo',
        Sort: sort,
        callback: cbNameTitle
      });
      scriptTitle.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${paramsTitle}`;
      window[cbNameTitle] = function (tArg1, tArg2) {
        delete window[cbNameTitle];
        scriptTitle.remove();
        const dataTitle = (typeof tArg1 === 'boolean' || typeof tArg1 === 'number') ? tArg2 : tArg1;
        handleAladinResults(dataTitle);
      };
      scriptTitle.onerror = function () {
        delete window[cbNameTitle];
        scriptTitle.remove();
        results.innerHTML = `<div class="search-empty">검색 결과가 없거나 네트워크 오류가 발생했습니다. <button type="button" class="btn btn-ghost btn-xs" style="margin-top:6px;" onclick="hideSearchResults()">닫기</button></div>`;
      };
      document.body.appendChild(scriptTitle);
    }
  };

  script.onerror = function () {
    delete window[cbName];
    script.remove();
    results.innerHTML = `<div class="search-empty">검색 실패 — 네트워크 상태를 확인해주세요. <button type="button" class="btn btn-ghost btn-xs" style="margin-top:6px;" onclick="hideSearchResults()">닫기</button></div>`;
  };

  setTimeout(() => {
    if (window[cbName]) {
      delete window[cbName];
      script.remove();
      results.innerHTML = `<div class="search-empty">응답 시간 초과 <button type="button" class="btn btn-ghost btn-xs" style="margin-top:6px;" onclick="hideSearchResults()">닫기</button></div>`;
    }
  }, 10000);

  document.body.appendChild(script);
}

function handleAladinResults(data, autoApplySingle = false, searchedIsbn = '') {
  const results = document.getElementById('aladin-results');

  // Normalize items from XML array or raw JSON response
  let items = [];
  if (Array.isArray(data)) {
    items = data.map(item => {
      let pagesVal = (item.subInfo ? (item.subInfo.itemPage || item.subInfo.itempage) : null) ||
        (item.subinfo ? (item.subinfo.itemPage || item.subinfo.itempage) : null) ||
        (item.bookinfo ? (item.bookinfo.itemPage || item.bookinfo.itempage) : null) ||
        item.itemPage || item.itempage || '';
      let pages = pagesVal ? String(pagesVal).replace(/[^0-9]/g, '') : '';
      let author = item.author || '';
      let cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '');
      let cover = (item.cover || '').replace('/coversum/', '/cover500/').replace('/cover200/', '/cover500/');
      return {
        title: decodeHtml(item.title || ''),
        author: decodeHtml(cleanAuthor),
        cover: cover,
        publisher: decodeHtml(item.publisher || ''),
        pubDate: item.pubDate || '',
        pages: pages,
        itemId: item.itemId || item.itemid || '',
        isbn: item.isbn || '',
        isbn13: item.isbn13 || ''
      };
    });
  } else if (data && data.item) {
    items = data.item.map(item => {
      let pagesVal = (item.subInfo ? (item.subInfo.itemPage || item.subInfo.itempage) : null) ||
        (item.subinfo ? (item.subinfo.itemPage || item.subinfo.itempage) : null) ||
        (item.bookinfo ? (item.bookinfo.itemPage || item.bookinfo.itempage) : null) ||
        item.itemPage || item.itempage || '';
      let pages = pagesVal ? String(pagesVal).replace(/[^0-9]/g, '') : '';
      let author = item.author || '';
      let cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '');
      let cover = (item.cover || '').replace('/coversum/', '/cover500/').replace('/cover200/', '/cover500/');
      return {
        title: decodeHtml(item.title || ''),
        author: decodeHtml(cleanAuthor),
        cover: cover,
        publisher: decodeHtml(item.publisher || ''),
        pubDate: item.pubDate || '',
        pages: pages,
        itemId: item.itemId || item.itemid || '',
        isbn: item.isbn || '',
        isbn13: item.isbn13 || ''
      };
    });
  }

  // Smart re-ranking when sorting by Accuracy
  if (currentAladinSort === 'Accuracy' && currentAladinQuery && items.length > 0 && !autoApplySingle) {
    const qClean = currentAladinQuery.toLowerCase().replace(/\s+/g, '');
    items.sort((a, b) => {
      const tA = (a.title || '').toLowerCase().replace(/\s+/g, '');
      const tB = (b.title || '').toLowerCase().replace(/\s+/g, '');
      const score = (t) => {
        if (t === qClean) return 0;
        if (t.startsWith(qClean)) return 1;
        if (t.includes(qClean)) return 2;
        return 3;
      };
      return score(tA) - score(tB);
    });
  }

  aladinSearchResults = items;

  if (items.length === 0) {
    results.innerHTML = `<div class="search-empty">검색 결과가 없습니다 <button type="button" class="btn btn-ghost btn-xs" style="margin-top:6px;" onclick="hideSearchResults()">닫기</button></div>`;
    return;
  }

  // ✨ 바코드 스캔 결과가 1권이면 번거로운 선택 과정 없이 즉시 도서 정보 자동 입력!
  if (autoApplySingle) {
    if (items.length === 1) {
      applyAladinItem(items[0]);
      toast(`'${items[0].title}' 도서 정보가 자동 입력되었습니다`);
      return;
    } else if (searchedIsbn) {
      // 2권 이상 검색되었더라도 스캔한 ISBN과 일치하는 도서가 있으면 자동 선택
      const cleanTarget = String(searchedIsbn).replace(/[^0-9]/g, '');
      const exactMatch = items.find(it => {
        const c13 = String(it.isbn13 || '').replace(/[^0-9]/g, '');
        const c10 = String(it.isbn || '').replace(/[^0-9]/g, '');
        return (c13 && c13 === cleanTarget) || (c10 && c10 === cleanTarget);
      });
      if (exactMatch) {
        applyAladinItem(exactMatch);
        toast(`'${exactMatch.title}' 도서 정보가 자동 입력되었습니다`);
        return;
      }
    }
  }

  let listHtml = '';
  items.forEach((item, index) => {
    const cover = item.cover || '';
    const title = item.title || '';
    const author = item.author || '';
    const publisher = item.publisher || '';
    const pages = item.pages || '';
    const pubDate = item.pubDate || '';

    listHtml += `<div class="search-item" onclick="applyAladinItemByIndex(${index})">
      <img src="${esc(getSafeImageUrl(cover))}" alt=""
        onerror="this.style.background='var(--bg-card)';this.style.opacity='.3'">
      <div class="search-item-info">
        <div class="search-item-title">${esc(title)}</div>
        <div class="search-item-author">${esc(author)}</div>
        <div class="search-item-meta">${esc(publisher)}${pubDate ? ' · ' + esc(pubDate) : ''}${pages ? ' · ' + esc(pages) + 'p' : ''}</div>
      </div>
    </div>`;
  });

  const sortHtml = !autoApplySingle ? `
    <div class="search-results-hdr">
      <div class="search-results-count">검색 결과 <span>${items.length}</span>권</div>
      <div class="search-sort-chips">
        <button type="button" class="sort-chip ${currentAladinSort === 'Accuracy' ? 'active' : ''}" data-sort="Accuracy" onclick="changeAladinSort('Accuracy')">정확도순</button>
        <button type="button" class="sort-chip ${currentAladinSort === 'SalesPoint' ? 'active' : ''}" data-sort="SalesPoint" onclick="changeAladinSort('SalesPoint')">인기순</button>
        <button type="button" class="sort-chip ${currentAladinSort === 'PublishTime' ? 'active' : ''}" data-sort="PublishTime" onclick="changeAladinSort('PublishTime')">최신순</button>
      </div>
      <button type="button" class="search-results-close" onclick="hideSearchResults()" title="닫기" aria-label="닫기">×</button>
    </div>` : '';

  results.innerHTML = `
    ${sortHtml}
    <div class="search-results-list">
      ${listHtml}
    </div>
    ${items.length > 3 ? '<div class="search-results-tip">원하는 도서를 클릭하면 책 정보가 자동 입력됩니다.</div>' : ''}
  `;
}

function applyAladinItemByIndex(index) {
  const item = aladinSearchResults[index];
  if (item) {
    applyAladinItem(item);
  }
}

function applyAladinItem(item) {
  console.info('[8ook aladin] applying item', item);
  if (item.title) {
    const titleParts = splitBookTitle(item.title);
    document.getElementById('bk-title').value = titleParts.main;
    const subEl = document.getElementById('bk-subtitle');
    if (subEl) subEl.value = titleParts.sub;
  }

  if (item.author) {
    let cleanAuthor = item.author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '');
    document.getElementById('bk-author').value = cleanAuthor;
  }

  let cleanPages = item.pages ? String(item.pages).replace(/[^0-9]/g, '') : '';
  if (cleanPages) {
    document.getElementById('bk-pages').value = cleanPages;
  } else {
    document.getElementById('bk-pages').value = '';
  }

  if (item.cover) {
    modalCover = item.cover;
    document.getElementById('bk-img-url').value = item.cover;
    setPrev(item.cover);

    const spineEl = document.getElementById('spine-prev');
    if (spineEl) {
      const p = parseInt(cleanPages, 10) || 280;
      let w = Math.round(getSpineWidth(p) * 0.49);
      if (w < 20) w = 20;
      if (w > 56) w = 56;
      spineEl.style.width = w + 'px';
      spineEl.style.minWidth = w + 'px';
    }

    const spineUrl = getSpineImageUrl(item.cover);
    if (spineUrl) {
      modalSpineCover = spineUrl;
      setSpinePrev(spineUrl);
    } else {
      modalSpineCover = '';
      resetSpinePrev();
    }
  }

  hideSearchResults();
  toast('도서 정보가 적용되었습니다');

  const identifier = item.itemId || item.isbn13 || item.isbn;
  if (identifier && !cleanPages) {
    fetchDetailedPages(identifier);
  }
}

function fetchDetailedPages(itemId) {
  const key = getApiKey();

  let itemIdType = 'ItemId';
  const cleanId = String(itemId).trim();
  if (cleanId.length === 13 && (cleanId.startsWith('978') || cleanId.startsWith('979'))) {
    itemIdType = 'ISBN13';
  } else if (cleanId.length === 10) {
    itemIdType = 'ISBN';
  }

  const updatePageField = (pages) => {
    if (pages) {
      const cleanPages = String(pages).replace(/[^0-9]/g, '');
      document.getElementById('bk-pages').value = cleanPages;
      toast('페이지 수 정보를 불러왔습니다 (' + cleanPages + 'p)');
    }
  };

  const cbName = '_aladinCb_lookup_' + Date.now();
  const script = document.createElement('script');
  const params = new URLSearchParams({
    ttbkey: key,
    itemIdType: itemIdType,
    ItemId: cleanId,
    output: 'JS',
    Version: '20131101',
    OptResult: 'subInfo',
    callback: cbName
  });
  script.src = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?${params}`;
  window[cbName] = function (data) {
    delete window[cbName];
    script.remove();
    if (data && data.item && data.item[0]) {
      const item = data.item[0];
      const pages = (item.subInfo ? (item.subInfo.itemPage || item.subInfo.itempage) : null) ||
        (item.subinfo ? (item.subinfo.itemPage || item.subinfo.itempage) : null) ||
        item.itemPage || item.itempage || '';
      updatePageField(pages);
    }
  };
  script.onerror = function () {
    delete window[cbName];
    script.remove();
  };
  document.body.appendChild(script);
}


/* ==============================================
   SCRAP MODAL & HASHTAGS ARCHIVE
============================================== */
let currentScrapTags = [];
let currentScrapFilterTag = null;
let currentScrapSearchQuery = '';
let scrapsShuffleOrder = {};
let currentScrapSortOrder = 'date'; // 'date' (기본: 완독일 최신순) | 'random' (랜덤 섞기)

function getScrapRandomOrder(scrapId) {
  if (scrapsShuffleOrder[scrapId] === undefined) {
    scrapsShuffleOrder[scrapId] = Math.random();
  }
  return scrapsShuffleOrder[scrapId];
}

function setScrapsSortOrder(order) {
  currentScrapSortOrder = order;
  if (order === 'random') {
    scrapsShuffleOrder = {};
  }
  renderScrapsArchive();
}

function reshuffleScraps() {
  currentScrapSortOrder = 'random';
  scrapsShuffleOrder = {};
  renderScrapsArchive();
  toast('문장 순서를 새로 섞었습니다');
}


/* ── Smart Quote Sanitizer for iOS / iPadOS & Web ── */
function sanitizeUnmatchedSmartQuotes(str) {
  if (!str || typeof str !== 'string') return str;
  // 단어/문장 뒤에 잘못 입력된 여는 따옴표(“ 또는 ‘)를 올바른 뒤따옴표(” 또는 ’)로 자동 교정
  // 예: “단어“ -> “단어”
  let result = str.replace(/“([^“”\r\n]+)“/g, '“$1”');
  result = result.replace(/‘([^‘’\r\n]+)‘/g, '‘$1’');
  return result;
}

// 한글 조합(IME)이 끝난 안전한 시점(blur, change)에만 따옴표를 정규화하여 자모 분리를 방지
function fixSmartQuotes(el) {
  if (!el || typeof el.value !== 'string') return;
  const fixed = sanitizeUnmatchedSmartQuotes(el.value);
  if (fixed !== el.value) {
    el.value = fixed;
  }
}

// 안전한 blur 시점에 이벤트 위임으로 따옴표 교정 적용
document.addEventListener('blur', function (e) {
  const target = e.target;
  if (!target) return;
  if (target.id === 'sc-text' || target.id === 'bk-sentence' || target.id === 'sc-memo' || target.tagName === 'TEXTAREA') {
    fixSmartQuotes(target);
  }
}, true);
