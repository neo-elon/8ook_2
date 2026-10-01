'use strict';

/* ==============================================
   DETAIL VIEW
============================================== */
function showDetail(id, direction = null, pushHistory = true) {
  let book = books.find(b => b.id === id);
  if (!book && typeof remoteCommunityBooks !== 'undefined' && Array.isArray(remoteCommunityBooks)) {
    book = remoteCommunityBooks.find(b => b.id === id);
  }
  if (!book && (id === '8ook_user_guide' || id === 'guide' || (typeof id === 'string' && id.includes('guide')))) {
    book = getUserGuideBook();
  }
  if (!book) return;
  currentBookId = id;
  cleanBookScraps(book);

  const wrap = document.getElementById('detail-wrap');
  wrap.classList.remove('slide-from-left', 'slide-from-right', 'bounce-left', 'bounce-right');
  void wrap.offsetWidth; // Force reflow
  if (direction === 'prev') {
    wrap.classList.add('slide-from-left');
  } else {
    wrap.classList.add('slide-from-right');
  }

  const isGuideDetail = isGuideBook(book);
  if (isGuideDetail) {
    wrap.classList.add('guide-detail-mode');
  } else {
    wrap.classList.remove('guide-detail-mode');
  }

  const coverHtml = book.cover
    ? `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}" ${libraryEventAttrs('copyBlogCoverImage', [book.id])} title="클릭하여 블로그용 편집 표지(2번 포맷) 복사" style="cursor:pointer;" onerror="handleDetailThumbError(this)">`
    : `<div class="detail-thumb-placeholder">8ook</div>`;

  const chips = [];
  if (book.pages) chips.push(`<div class="chip">${Number(book.pages).toLocaleString()}p</div>`);
  if (book.date) chips.push(`<div class="chip">${esc(fmtDate(book.date))}</div>`);
  if (book.is_public === false) {
    chips.push(`<div class="chip" style="background:rgba(239,68,68,0.15); color:#f87171; border-color:rgba(239,68,68,0.3);" title="내 서재에만 보이고 북클럽에는 비공개됩니다">🔒 비공개</div>`);
  }
  const scrapCount = (book.scraps || []).length;

  const kwHtml = (book.keywords && book.keywords.length)
    ? `<div class="meta-chips" style="margin-top:6px;">${book.keywords.map(k => `<button type="button" class="kw-chip" ${libraryEventAttrs('openEditModal', [book.id, true])}>#${esc(k)}</button>`).join('')}</div>`
    : '';

  const scrapsHtml = buildScrapsHtml(book);

  const titleParts = splitBookTitle(book);

  wrap.innerHTML = `
    <div class="detail-top">
      <div class="detail-thumb">${coverHtml}</div>
      <div class="detail-info">
        <div class="detail-title-group">
          <div class="detail-title">${esc(titleParts.main)}</div>
          ${titleParts.sub ? `<div class="detail-subtitle">${esc(titleParts.sub)}</div>` : ''}
        </div>
        <div class="detail-author">${esc(book.author || '저자 미상')}</div>
        <div class="meta-chips">${chips.join('')}</div>
        ${kwHtml}
      </div>
    </div>
    <div class="detail-body-sec" style="display:flex; flex-direction:column; gap:16px;">
      <div class="detail-rating-row" style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div class="detail-stars">${starsHtml(book.rating, 22)}</div>
        <div class="detail-book-actions" style="display:inline-flex; gap:6px; align-items:center;">
          ${isGuideDetail
            ? `<button class="btn btn-ghost btn-sm" onclick="showDetail('8ook_user_guide'); toast('가이드가 최신 상태로 갱신되었습니다');" style="padding:0 8px; font-size:11px; border-radius:4px; height:24px; line-height:1; color:#d4af37; border-color:rgba(212,175,55,0.4); display:inline-flex; align-items:center;">가이드 최신화</button>`
            : `<button class="btn btn-ghost btn-sm" ${libraryEventAttrs('openEditModal', [book.id])} style="padding:0 8px; font-size:11.5px; border-radius:4px; height:24px; line-height:1; display:inline-flex; align-items:center; justify-content:center;">편집</button>
               <button class="btn btn-danger btn-sm" ${libraryEventAttrs('doDeleteBook', [book.id])} style="padding:0 8px; font-size:11.5px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:24px; line-height:1; display:inline-flex; align-items:center; justify-content:center;">삭제</button>`
          }
        </div>
      </div>
      ${book.sentence ? `<div class="detail-sentence">${esc(book.sentence)}</div>` : ''}
    </div>

    <div class="scraps-sec">
      <div class="scraps-hdr" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:10px; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="scraps-htitle">${isGuideDetail ? '상세 가이드 챕터' : '수집한 문장'}</div>
        </div>
        <div class="scraps-badge" id="scrap-badge">${scrapCount} ${isGuideDetail ? '챕터' : '/ 100'}</div>
      </div>
      <div class="scrap-list" id="scrap-list">${scrapsHtml}</div>
      ${!isGuideDetail && scrapCount === 0
      ? `<div class="scraps-empty">아직 수집한 문장이 없습니다.<br>
           <small style="font-size:11px;">아래의 "+ 문장 추가" 버튼으로 문장을 기록해보세요</small></div>`
      : ''}
      ${!isGuideDetail ? `
      <div class="scraps-bottom-action">
        <button type="button" class="scrap-add-bottom-btn" ${libraryEventAttrs('openScrapModal', [book.id])}>
          <span style="font-size:15px; font-weight:700; color:var(--lavender); line-height:1;">＋</span>
          <span>문장 추가</span>
        </button>
        <button type="button" class="scrap-copy-bottom-btn" ${libraryEventAttrs('copyBookForBlog', [book.id])} title="블로그 포스팅용으로 도서 정보와 수집한 문장 전체를 복사합니다">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--lavender); flex-shrink:0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span>내용 복사</span>
        </button>
        <button type="button" class="scrap-cover-bottom-btn" ${libraryEventAttrs('copyBlogCoverImage', [book.id])} title="블로그용 편집 표지 이미지를 클립보드에 복사합니다">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--lavender); flex-shrink:0;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
          <span>표지 복사</span>
        </button>
      </div>` : ''}
    </div>
  `;

  saveCurrentGalleryScroll();
  document.body.classList.add('page-detail');
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');
  const scrapsView = document.getElementById('view-scraps');
  if (scrapsView) scrapsView.classList.remove('show');
  document.getElementById('view-detail').classList.add('show');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.classList.add('show');
    backBtn.style.display = 'inline-flex';
  }
  const searchGroup = document.getElementById('header-search-group');
  if (searchGroup) searchGroup.style.display = 'none';
  const vl = document.getElementById('view-label');
  if (vl) {
    vl.style.display = 'inline-block';
    vl.textContent = book.title;
  }
  if (pushHistory && window.history && window.history.pushState) {
    if (!window.history.state || window.history.state.bookId !== id) {
      window.history.pushState({ view: 'detail', bookId: id }, '', '#book=' + id);
    }
  }
}

// Library values stay JSON data; preserve argument types and do not decode entities.
function libraryEventAttrs(action, args) {
  const encoded = JSON.stringify(args).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  return `data-library-click="${action}" data-library-args="${encoded}"`;
}

function handleLibraryDelegatedClick(event) {
  const element = event.target.closest?.('[data-library-click]');
  if (!element) return;
  const actions = {
    addScrapTag: args => addScrapTag(...args),
    cancelInlineScrapMemo: args => cancelInlineScrapMemo(...args),
    copyBlogCoverImage: args => copyBlogCoverImage(...args),
    copyBookForBlog: args => copyBookForBlog(...args),
    copyScrapQuoteText: args => copyScrapQuoteText(...args),
    doDeleteBook: args => doDeleteBook(...args),
    doDeleteScrap: args => doDeleteScrap(...args),
    editScrap: args => editScrap(...args),
    filterScrapsByTag: args => filterScrapsByTag(...args),
    openEditModal: args => openEditModal(...args),
    openInlineScrapMemo: args => openInlineScrapMemo(...args),
    openScrapModal: args => openScrapModal(...args),
    removeScrapTag: args => removeScrapTag(...args),
    saveInlineScrapMemo: args => saveInlineScrapMemo(...args),
    selectRepBookForSlot: args => selectRepBookForSlot(...args),
    showDetail: args => showDetail(...args),
    showScraps: args => showScraps(...args),
  };
  const action = element.getAttribute('data-library-click');
  if (!Object.prototype.hasOwnProperty.call(actions, action)) return;
  actions[action](JSON.parse(element.getAttribute('data-library-args')));
}

document.addEventListener('click', handleLibraryDelegatedClick);

function buildScrapsHtml(book) {
  cleanBookScraps(book);
  if (!book.scraps || !book.scraps.length) return '';
  const isGuide = isGuideBook(book);
  const sortedScraps = [...book.scraps].sort((a, b) => ((a && a.page) || 0) - ((b && b.page) || 0));

  const renderCard = (s, idx) => {
    if (!s) return '';
    const sText = typeof s === 'string' ? s : (s.text || s.quote || '');
    if (!sText) return '';
    const sId = (s && s.id) ? s.id : ('sc-' + (book.id || 'b') + '-' + idx);
    const sMemo = (s && s.memo) || '';
    const sPage = (s && s.page) || null;
    const tags = (s && (s.tags || s.keywords)) || [];
    const tagsHtml = tags.length
      ? `<div class="scrap-tags-row" style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
           ${tags.map(t => `<span class="scrap-tag-chip" ${libraryEventAttrs('showScraps', [t])} title="#${esc(t)} 해시태그 문장 모아보기">#${esc(t)}</span>`).join('')}
         </div>`
      : '';

    return `
    <div class="scrap-item" id="${esc(sId)}" style="order:${idx};">
      <div class="scrap-quote">${esc(sText)}</div>
      ${sMemo ? `<div class="comm-scrap-memo-wrap"><div class="comm-scrap-memo">${esc(sMemo)}</div></div>` : ''}
      ${tagsHtml}
      <div class="scrap-foot" style="display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; width:100%; margin-top:4px;">
        ${sPage ? `<span class="scrap-page">p.${esc(sPage)}</span>` : ''}
        <div class="scrap-actions" style="margin-left:auto; display:flex; gap:6px;">
          <button class="btn btn-ghost btn-sm" ${libraryEventAttrs('copyScrapQuoteText', [sText, book.title || '', book.author || ''])} style="padding:2px 6px; font-size:10px; border-radius:4px; height:22px; line-height:1;" title="문장 복사">복사</button>
          ${isGuide ? '' : `
          <button class="btn btn-ghost btn-sm" ${libraryEventAttrs('editScrap', [book.id,sId])} style="padding:2px 6px; font-size:10px; border-radius:4px; height:22px; line-height:1;">수정</button>
          <button class="btn btn-danger btn-sm" ${libraryEventAttrs('doDeleteScrap', [book.id,sId])} style="padding:2px 6px; font-size:10px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:22px; line-height:1;">삭제</button>
          `}
        </div>
      </div>
    </div>
    `;
  };

  if (sortedScraps.length <= 1) {
    return sortedScraps.map((s, idx) => renderCard(s, idx)).join('');
  }

  const col0 = [];
  const col1 = [];
  sortedScraps.forEach((s, idx) => {
    if (idx % 2 === 0) col0.push(renderCard(s, idx));
    else col1.push(renderCard(s, idx));
  });

  return `
    <div class="scrap-col">${col0.join('')}</div>
    <div class="scrap-col">${col1.join('')}</div>
  `;
}

async function editScrap(bookId, scrapId) {
  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 구글 로그인을 진행해주세요.');
    loginWithGoogle();
    return;
  }

  const book = books.find(b => b.id === bookId);
  if (!book) return;
  const scrap = (book.scraps || []).find(s => s.id === scrapId);
  if (!scrap) return;

  currentScrapBookId = bookId;
  editingScrapId = scrapId;

  document.getElementById('sc-text').value = scrap.text;
  document.getElementById('sc-page').value = scrap.page || '';
  document.getElementById('sc-memo').value = scrap.memo || '';

  currentScrapTags = (scrap.tags || scrap.keywords || []).slice();
  renderScrapModalTags();

  document.getElementById('scrap-modal-title').textContent = '스크랩 수정';
  document.getElementById('scrap-save-btn').textContent = '스크랩 저장';

  openModal('scrap-modal');
  setTimeout(() => {
    const el = document.getElementById('sc-text');
    if (el) el.focus();
  }, 100);
}

function handleBackNavigation() {
  if (window.history && window.history.length > 1 && window.history.state && window.history.state.view && window.history.state.view !== 'gallery') {
    window.history.back();
  } else {
    showGallery(true);
  }
}

function showGallery(pushHistory = true) {
  document.body.classList.remove('page-detail');
  closeAppMenu();
  document.getElementById('view-gallery').style.display = '';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');
  const scrapsView = document.getElementById('view-scraps');
  if (scrapsView) scrapsView.classList.remove('show');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.classList.remove('show');
    backBtn.style.display = 'none';
  }
  const searchGroup = document.getElementById('header-search-group');
  if (searchGroup) searchGroup.style.display = '';
  const vl = document.getElementById('view-label');
  if (vl) vl.style.display = 'none';
  currentBookId = null;

  if (pushHistory && window.history && window.history.pushState) {
    if (window.history.state && window.history.state.view && window.history.state.view !== 'gallery') {
      window.history.pushState({ view: 'gallery' }, '', '#');
    }
  }

  const grid = document.getElementById('gallery-grid');
  if (isGalleryDirty || !grid || grid.children.length === 0) {
    renderGallery();
  } else {
    updateViewModeButtons();
    const scrollEl = document.getElementById('gallery-scroll');
    if (scrollEl && savedGalleryScrollTop > 0) {
      requestAnimationFrame(() => {
        scrollEl.scrollTop = savedGalleryScrollTop;
      });
    }
  }
}

function handleGallerySearch() {
  const input = document.getElementById('gallery-search-input');
  const clearBtn = document.getElementById('gallery-search-clear');
  if (clearBtn) {
    clearBtn.style.display = input && input.value ? 'block' : 'none';
  }
  savedGalleryScrollTop = 0;
  markGalleryDirty();
  renderGallery();
}

function clearGallerySearch() {
  const input = document.getElementById('gallery-search-input');
  const clearBtn = document.getElementById('gallery-search-clear');
  if (input) {
    input.value = '';
    input.focus();
  }
  if (clearBtn) clearBtn.style.display = 'none';
  savedGalleryScrollTop = 0;
  markGalleryDirty();
  renderGallery();
}

function showStats(pushHistory = true) {
  saveCurrentGalleryScroll();
  document.body.classList.remove('page-detail');
  closeAppMenu();
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.add('show');
  document.getElementById('view-community').classList.remove('show');
  const scrapsView = document.getElementById('view-scraps');
  if (scrapsView) scrapsView.classList.remove('show');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.classList.add('show');
    backBtn.style.display = 'inline-flex';
  }
  const searchGroup = document.getElementById('header-search-group');
  if (searchGroup) searchGroup.style.display = 'none';
  const vl = document.getElementById('view-label');
  if (vl) {
    vl.style.display = 'inline-block';
    vl.textContent = '독서 통계';
  }

  if (pushHistory && window.history && window.history.pushState) {
    if (!window.history.state || window.history.state.view !== 'stats') {
      window.history.pushState({ view: 'stats' }, '', '#stats');
    }
  }

  showRandomQuote();
  updateSidebar();
}
