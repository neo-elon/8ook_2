'use strict';

// Aladin TTB API key helper (restored from pre-refactor app.js)
function getApiKey() {
  return 'ttbparkq0072106001';
}

/* Aladin book search, JSONP lookup, sorting, selection, and page-detail helpers. */

function hideSearchResults() {
  const r = document.getElementById('aladin-results');
  if (!r) return;
  r.classList.remove('show');
  r.innerHTML = '';
}

async function fetchAladinCover(title, author) {
  try {
    const items = await searchBookProviders([title, author].filter(Boolean).join(' '));
    return items.find(item => item.cover)?.cover || null;
  } catch (error) {
    console.warn('[8ook books] Cover lookup failed', error);
    return null;
  }
}

function normalizeBackfillText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function lookupAladinItemForBackfill(book) {
  return new Promise((resolve) => {
    const key = getApiKey();
    const cbName = '_aladinCb_backfill_' + (++aladinCallbackCounter);
    const script = document.createElement('script');
    const params = new URLSearchParams({
      ttbkey: key,
      Query: book.title || '',
      QueryType: 'Title',
      MaxResults: '10',
      start: '1',
      SearchTarget: 'Book',
      output: 'JS',
      Version: '20131101',
      Cover: 'Big',
      OptResult: 'subInfo',
      Sort: 'Accuracy',
      callback: cbName
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { delete window[cbName]; } catch (_) {}
      script.remove();
      resolve(value || null);
    };
    window[cbName] = function (arg1, arg2) {
      const data = (typeof arg1 === 'boolean' || typeof arg1 === 'number') ? arg2 : arg1;
      const items = Array.isArray(data?.item) ? data.item : [];
      const wantedTitle = normalizeBackfillText(book.title);
      const wantedAuthor = normalizeBackfillText(book.author);
      const candidates = items.filter(it => {
        const title = normalizeBackfillText(decodeHtml(it.title || ''));
        const author = normalizeBackfillText(decodeHtml(it.author || ''));
        const titleMatch = title === wantedTitle || title.startsWith(wantedTitle) || wantedTitle.startsWith(title);
        const authorMatch = !wantedAuthor || !author || author.includes(wantedAuthor) || wantedAuthor.includes(author);
        return titleMatch && authorMatch;
      });
      if (candidates.length !== 1) { finish(null); return; }
      const it = candidates[0];
      const isbn13 = String(it.isbn13 || '').replace(/[^0-9]/g, '');
      if (isbn13.length !== 13) { finish(null); return; }
      finish({ isbn13, title: decodeHtml(it.title || ''), cover: (it.cover || '').replace('/coversum/', '/cover500/').replace('/cover200/', '/cover500/') });
    };
    script.onerror = () => finish(null);
    setTimeout(() => finish(null), 7000);
    script.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${params}`;
    document.body.appendChild(script);
  });
}

async function backfillYes24SpinesOnce() {
  // Legacy Aladin-based migration disabled.
  return;
  const markerKey = 'rj_yes24_spine_backfill_v1';
  try { if (localStorage.getItem(markerKey) === 'done') return; } catch (_) {}
  if (!Array.isArray(books) || books.length === 0 || !supabaseClient?.functions?.invoke) return;

  const context = await getBookWriteContext();
  if (!context) return;
  const { client, user } = context;

  // One-time migration only: never overwrite a stored/manual/real spine.
  const candidates = books.filter(book => {
    if (!book || isGuideBook(book) || book.user_id !== user.id) return false;
    if (book.spineCover || book.spine) return false;
    return Boolean(book.cover);
  });

  let updated = 0;
  for (const book of candidates) {
    const aladinItem = await lookupAladinItemForBackfill(book);
    if (!aladinItem) continue;
    try {
      const { data, error } = await supabaseClient.functions.invoke('yes24-spine', {
        body: { isbn13: aladinItem.isbn13 }
      });
      if (error || data?.ok !== true || data?.found !== true) continue;
      const returnedIsbn = String(data.book?.isbn13 || '').replace(/[^0-9]/g, '');
      if (returnedIsbn && returnedIsbn !== aladinItem.isbn13) continue;
      const sideCover = getSafeImageUrl(data.book?.sideCover || '');
      if (!sideCover || !(await validateYes24SpineImage(sideCover))) continue;

      const { error: updateError } = await client.from('books')
        .update({ spineCover: sideCover })
        .eq('id', book.id)
        .eq('user_id', user.id)
        .is('spineCover', null);
      if (updateError) {
        console.warn('[8ook yes24 backfill] update failed', book.id, updateError);
        continue;
      }
      book.spineCover = sideCover;
      updated++;
    } catch (error) {
      console.warn('[8ook yes24 backfill] skipped', book.id, error);
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  try { localStorage.setItem(markerKey, 'done'); } catch (_) {}
  if (updated > 0) {
    renderGallery();
    toast(`YES24 실제 책등 이미지 ${updated}권을 기존 서재에 적용했습니다`);
  }
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

async function runAladinLookUpJsonp(isbn, key, results, isBarcodeScan = false) {
  const requestId = ++bookSearchRequestId;
  try {
    const items = await searchBookProviders(isbn, 'Accuracy', true);
    if (requestId !== bookSearchRequestId) return;
    const exact = items.filter(item => String(item.isbn13) === String(isbn) || String(item.isbn) === String(isbn));
    if (exact.length) {
      handleAladinResults(exact, isBarcodeScan, isbn);
    } else {
      results.innerHTML = '<div class="search-empty">ISBN과 일치하는 도서를 찾지 못했습니다. 제목으로 검색해보세요.</div>';
    }
  } catch (error) {
    if (requestId !== bookSearchRequestId) return;
    console.error('[8ook books] ISBN lookup failed', error);
    results.innerHTML = '<div class="search-empty">도서 조회에 실패했습니다. 잠시 후 다시 시도해주세요.</div>';
  }
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

// Search providers: Open Library first, Google Books as a fallback.
// Keep the existing result UI and form mapping through handleAladinResults().
let bookSearchRequestId = 0;
async function requestBookJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('Book API HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOpenLibraryBook(doc) {
  const isbn13 = (doc.isbn || []).find(v => /^97[89]\d{10}$/.test(String(v))) || '';
  const isbn = (doc.isbn || []).find(v => /^\d{9}[\dX]$/.test(String(v))) || '';
  const cover = doc.cover_i
    ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-L.jpg'
    : (isbn13 ? 'https://covers.openlibrary.org/b/isbn/' + isbn13 + '-L.jpg?default=false' : '');
  return {
    title: doc.title || '',
    author: (doc.author_name || []).join(', '),
    publisher: (doc.publisher || [])[0] || '',
    pubDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
    pages: doc.number_of_pages_median || '',
    cover, isbn, isbn13,
    itemId: isbn13 || isbn || ''
  };
}

function normalizeGoogleBook(entry) {
  const info = entry.volumeInfo || {};
  const identifiers = info.industryIdentifiers || [];
  const isbn13 = identifiers.find(x => x.type === 'ISBN_13')?.identifier || '';
  const isbn = identifiers.find(x => x.type === 'ISBN_10')?.identifier || '';
  const images = info.imageLinks || {};
  const cover = (images.thumbnail || images.smallThumbnail || '').replace(/^http:/, 'https:');
  return {
    title: info.title || '',
    author: (info.authors || []).join(', '),
    publisher: info.publisher || '',
    pubDate: info.publishedDate || '',
    pages: info.pageCount || '',
    cover, isbn, isbn13, itemId: isbn13 || isbn || ''
  };
}

async function searchBookProviders(query, sort = 'Accuracy', isbnSearch = false) {
  const olParams = new URLSearchParams({
    [isbnSearch ? 'isbn' : 'q']: query,
    limit: isbnSearch ? '10' : '25',
    fields: 'key,title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i,isbn'
  });
  if (sort === 'PublishTime') olParams.set('sort', 'new');

  const googleParams = new URLSearchParams({
    q: isbnSearch ? 'isbn:' + query : query,
    maxResults: isbnSearch ? '10' : '25',
    printType: 'books',
    orderBy: sort === 'PublishTime' ? 'newest' : 'relevance'
  });
  const errors = [];
  const providers = [
    async () => {
      const data = await requestBookJson('https://openlibrary.org/search.json?' + olParams);
      return (data.docs || []).map(doc => {
        const item = normalizeOpenLibraryBook(doc);
        if (isbnSearch && (doc.isbn || []).includes(query)) {
          if (query.length === 13) item.isbn13 = query;
          else item.isbn = query;
          item.itemId = query;
        }
        return item;
      }).filter(item => item.title);
    },
    async () => {
      const data = await requestBookJson('https://www.googleapis.com/books/v1/volumes?' + googleParams);
      return (data.items || []).map(normalizeGoogleBook).filter(item => item.title);
    }
  ];

  for (const provider of providers) {
    try {
      const items = await provider();
      if (items.length) return items;
    } catch (error) {
      errors.push(error);
      console.warn('[8ook books] Provider unavailable', error);
    }
  }
  // No provider returned books. Avoid turning rate limits into a false "no results".
  if (errors.length === providers.length) {
    throw new Error('도서 검색 제공처에 일시적으로 연결할 수 없습니다.');
  }
  return [];
}

async function runAladinJsonp(query, key, results, sort = currentAladinSort || 'Accuracy') {
  currentAladinQuery = query;
  currentAladinSort = sort;
  const requestId = ++bookSearchRequestId;
  try {
    const items = await searchBookProviders(query, sort);
    if (requestId !== bookSearchRequestId) return;
    handleAladinResults(items);
  } catch (error) {
    if (requestId !== bookSearchRequestId) return;
    console.error('[8ook books] Search failed', error);
    results.innerHTML = '<div class="search-empty">도서 검색 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.</div>';
  }
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

let yes24SpineRequestSeq = 0;

function getSpineImageQuality(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    const timer = setTimeout(() => { img.onload = img.onerror = null; resolve(null); }, 6000);
    img.onload = () => {
      clearTimeout(timer);
      if (!img.naturalWidth || !img.naturalHeight) { resolve(null); return; }
      const ratio = img.naturalWidth / img.naturalHeight;
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        ratio,
        pixels: img.naturalWidth * img.naturalHeight
      });
    };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

async function shouldPreferYes24Spine(yes24Url, currentUrl) {
  const [yes24, current] = await Promise.all([
    getSpineImageQuality(yes24Url),
    getSpineImageQuality(currentUrl)
  ]);

  // Reject YES24 placeholders/non-spine images.
  if (!yes24 || yes24.ratio > 0.45) return false;

  // If the existing Aladin spine cannot be measured, a valid YES24 spine is an improvement.
  if (!current || current.ratio > 0.45) return true;

  // Compare the dimensions that matter when a narrow spine is enlarged.
  // YES24 replaces the current image only when it has a meaningful resolution advantage.
  const yes24ShortEdge = Math.min(yes24.width, yes24.height);
  const currentShortEdge = Math.min(current.width, current.height);
  const shortEdgeGain = yes24ShortEdge / Math.max(1, currentShortEdge);
  const pixelGain = yes24.pixels / Math.max(1, current.pixels);

  return shortEdgeGain >= 1.15 || pixelGain >= 1.35;
}

async function fetchYes24SpineForAladinItem(item) {
  if (!item || !supabaseClient || !supabaseClient.functions || typeof supabaseClient.functions.invoke !== 'function') {
    return;
  }

  const isbn13 = String(item.isbn13 || '').replace(/[^0-9]/g, '');
  const title = String(item.title || '').trim();
  if (!isbn13 && !title) return;

  const requestSeq = ++yes24SpineRequestSeq;
  const fallbackSpine = item.cover ? getSpineImageUrl(item.cover) : '';

  try {
    const { data, error } = await supabaseClient.functions.invoke('yes24-spine', {
      body: isbn13.length === 13 ? { isbn13 } : { title }
    });

    if (requestSeq !== yes24SpineRequestSeq) return;

    if (error || !data || data.ok !== true || data.found !== true) {
      return;
    }

    const returnedIsbn = String(data.book?.isbn13 || '').replace(/[^0-9]/g, '');
    if (isbn13.length === 13 && returnedIsbn && returnedIsbn !== isbn13) {
      console.warn('[8ook yes24] ISBN mismatch; keeping Aladin spine', { isbn13, returnedIsbn });
      return;
    }

    const sideCover = getSafeImageUrl(data.book?.sideCover || '');
    if (!sideCover) return;

    const shouldUseYes24 = await shouldPreferYes24Spine(sideCover, fallbackSpine);
    if (requestSeq !== yes24SpineRequestSeq) return;
    if (!shouldUseYes24) {
      console.info('[8ook yes24] existing Aladin spine is equal or better; keeping it');
      return;
    }

    modalSpineCover = sideCover;
    setSpinePrev(sideCover);
  } catch (error) {
    console.warn('[8ook yes24] spine lookup failed; keeping Aladin spine', error);
    if (!modalSpineCover && fallbackSpine) {
      modalSpineCover = fallbackSpine;
      setSpinePrev(fallbackSpine);
    }
  }
}

function applyAladinItem(item) {
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

  // A fresh Aladin selection is the only automatic trigger for YES24 spine lookup.
  // Existing saved/manual spineCover values are therefore never overwritten merely by opening an edit modal.
  fetchYes24SpineForAladinItem(item);

  const identifier = item.itemId || item.isbn13 || item.isbn;
  if (identifier && !cleanPages) {
    fetchDetailedPages(identifier);
  }
}

async function fetchDetailedPages(itemId) {
  const isbn = String(itemId || '').trim();
  if (!/^(?:97[89]\d{10}|\d{9}[\dX])$/.test(isbn)) return;
  try {
    const items = await searchBookProviders(isbn, 'Accuracy', true);
    const match = items.find(item => item.isbn13 === isbn || item.isbn === isbn);
    const field = document.getElementById('bk-pages');
    if (field && !field.value && match?.pages) field.value = String(match.pages);
  } catch (error) {
    console.warn('[8ook books] Page lookup failed', error);
  }
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
