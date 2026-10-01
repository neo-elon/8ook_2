'use strict';

/* Community feed, profiles, likes, comments, and realtime synchronization. */

async function fetchRemoteCommunityBooks() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('books')
      .select('*')
      .not('user_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!error && Array.isArray(data)) {
      remoteCommunityBooks = data.map(b => {
        if (b.user_id === 'f2432e6e-0481-4e8e-a516-213bd12434f9') {
          return { ...b, user_id: '1df9f1ae-d5bf-4076-bd1d-b3f32916b216' };
        }
        return b;
      });
      renderCommunityBooks();
      renderCommunityPopularBooks();
      renderCommunityScraps();
    }
  } catch (e) {
    console.warn('Failed to fetch remote community books:', e);
  }
}

function getBookGroupingKey(b) {
  if (!b || !b.title) return '';
  const parts = splitBookTitle(b);
  let main = (parts && parts.main) ? parts.main : b.title;
  // 에디션, 부제목, 판본 등 괄호 표기 제거하여 원 도서명 정규화
  main = String(main).replace(/\s*\([^)]*\)/g, '').replace(/\s*<[^>]*>/g, '').replace(/\s*〈[^〉]*〉/g, '');
  return String(main).trim().toLowerCase().replace(/[\s\-_:·・《》〈〉()（）[\]'"]/g, '');
}

// Resolve the owner of each library book.
function resolveCommunityBookOwner(b, source) {
  if (!b) return 'unknown_user';
  if (b._ownerId) return b._ownerId;

  // 1. 도서 객체에 저장된 user_id 및 Gmail(thejs2050) 확인
  const uid = b.user_id ? String(b.user_id) : '';
  const email = (b.user_email || (b.user && b.user.email) || '').toLowerCase();
  if (uid === '7396cf84-8b75-4617-a050-5ed974fcbe02' || email.includes('thejs2050')) return 'user_owner_oha';
  if (uid === '1df9f1ae-d5bf-4076-bd1d-b3f32916b216' || uid === 'f2432e6e-0481-4e8e-a516-213bd12434f9') return 'user_owner_neo';
  if (uid) return 'user_' + uid;

  // 2. 도서 ID 패턴(고유 UUID 포함 여부) 확인
  const bid = b.id ? String(b.id) : '';
  if (bid.includes('7396cf84-8b75-4617-a050-5ed974fcbe02') || bid.includes('7396cf84')) return 'user_owner_oha';
  if (bid.includes('1df9f1ae-d5bf-4076-bd1d-b3f32916b216') || bid.includes('1df9f1ae') || bid.startsWith('mqds3vy')) return 'user_owner_neo';

  // Identify the current user for in-memory library books.
  const effSource = source || b._source || '';
  if (effSource === 'local') {
    if (currentUser) {
      if (isOhaUser(currentUser)) {
        return 'user_owner_oha';
      }
      if (currentUser.id === '1df9f1ae-d5bf-4076-bd1d-b3f32916b216') {
        return 'user_owner_neo';
      }
      if (currentUser.id) return 'user_' + currentUser.id;
    }
    return 'user_local';
  }

  if (email) return 'user_email_' + email.trim();
  if (b.owner) return 'user_owner_' + String(b.owner).trim();

  return 'remote_user_' + (bid || 'anon');
}

function getAllCommunityBooks() {
  const map = new Map();
  const seenUserTitle = new Set();

  function processBook(b, source) {
    // Exclude remote test books without a registered owner.
    if (!b || isGuideBook(b) || !b.title || isLikeRecord(b) || isCommentRecord(b) || isProfileRecord(b) || b.is_public === false || (source === 'remote' && !b.user_id)) return;
    const ownerId = resolveCommunityBookOwner(b, source);
    const normTitle = getBookGroupingKey(b);
    if (!normTitle) return;
    const userTitleKey = ownerId + '::' + normTitle;

    // Combine duplicate books by the same user for community display.
    if (seenUserTitle.has(userTitleKey)) {
      if (map.has(b.id)) return;
      const existingKey = Array.from(map.keys()).find(k => {
        const eb = map.get(k);
        return eb && normTitle === getBookGroupingKey(eb);
      });
      if (existingKey) {
        const eb = map.get(existingKey);
        const bScraps = (b.scraps || []).length;
        const ebScraps = (eb.scraps || []).length;
        const bHasAladin = b.cover && b.cover.includes('image.aladin.co.kr');
        const ebHasAladin = eb.cover && eb.cover.includes('image.aladin.co.kr');
        const hasBetterCover = bHasAladin && !ebHasAladin;
        if (bScraps > ebScraps || hasBetterCover || (!eb.cover && b.cover)) {
          map.set(existingKey, {
            ...eb,
            ...b,
            _source: source,
            _ownerId: ownerId,
            cover: (bHasAladin || !ebHasAladin) ? (b.cover || eb.cover) : eb.cover,
            spineCover: (b.spineCover && b.spineCover.includes('image.aladin.co.kr')) ? b.spineCover : (eb.spineCover || b.spineCover),
            id: existingKey
          });
        }
      }
      return;
    }
    seenUserTitle.add(userTitleKey);
    map.set(b.id, {
      ...b,
      _source: source,
      _ownerId: ownerId
    });
  }

  // 1. Remote community books from Supabase across all users (공개 도서만 포함)
  if (Array.isArray(remoteCommunityBooks)) {
    remoteCommunityBooks.forEach(b => processBook(b, 'remote'));
  }

  // 2. 현재 로그인 사용자의 로컬 books (공개 도서만 병합)
  if (Array.isArray(books)) {
    books.forEach(b => processBook(b, 'local'));
  }

  return Array.from(map.values());
}

async function showCommunity(pushHistory = true) {
  saveCurrentGalleryScroll();
  document.body.classList.remove('page-detail');
  closeAppMenu();
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  const scrapsView = document.getElementById('view-scraps');
  if (scrapsView) scrapsView.classList.remove('show');
  document.getElementById('view-community').classList.add('show');
  syncNicknameUI();

  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.style.display = 'inline-flex';
    backBtn.classList.add('show');
  }
  const searchGroup = document.getElementById('header-search-group');
  if (searchGroup) searchGroup.style.display = 'none';
  const vl = document.getElementById('view-label');
  if (vl) {
    vl.style.display = 'inline-block';
    vl.textContent = '북클럽';
  }

  if (pushHistory && window.history && window.history.pushState) {
    if (!window.history.state || window.history.state.view !== 'community') {
      window.history.pushState({ view: 'community' }, '', '#community');
    }
  }

  // 커뮤니티 도서 초기 10권(2열 5줄) 설정 및 무한 스크롤 리스너 준비
  communityBooksLimit = 10;
  communityPopularBooksLimit = 10;
  initCommunityScroll();

  // 먼저 로컬/기존 캐시로 즉시 렌더링
  renderCommunityBooks();
  renderCommunityPopularBooks();
  renderCommunityScraps();
  switchCommunityTab(currentCommunityTab);

  // 최신 Supabase 원격 도서, 좋아요 및 말풍선 댓글 데이터 비동기 페치 및 동기화 렌더링
  await Promise.all([
    fetchRemoteCommunityBooks(),
    fetchCommunityLikes(),
    fetchCommunityComments(),
    fetchCommunityProfiles()
  ]);
  initCommunityLikesChannel();
  initCommunityCommentsChannel();

  // 모든 원격 도서 및 댓글 데이터 수신 완료 후 화면 동기화 재렌더링
  if (currentCommunityTab === 'books') {
    renderCommunityBooks();
  } else if (currentCommunityTab === 'popular') {
    renderCommunityPopularBooks();
  } else if (currentCommunityTab === 'scraps') {
    renderCommunityScraps();
  }
}

function switchCommunityTab(tab) {
  currentCommunityTab = tab;
  const booksBtn = document.getElementById('comm-tab-books-btn');
  const popularBtn = document.getElementById('comm-tab-popular-btn');
  const scrapsBtn = document.getElementById('comm-tab-scraps-btn');
  const booksPanel = document.getElementById('comm-books-panel');
  const popularPanel = document.getElementById('comm-popular-panel');
  const scrapsPanel = document.getElementById('comm-scraps-panel');

  if (booksBtn) booksBtn.classList.toggle('active', tab === 'books');
  if (popularBtn) popularBtn.classList.toggle('active', tab === 'popular');
  if (scrapsBtn) scrapsBtn.classList.toggle('active', tab === 'scraps');

  if (booksPanel) booksPanel.classList.toggle('active', tab === 'books');
  if (popularPanel) popularPanel.classList.toggle('active', tab === 'popular');
  if (scrapsPanel) scrapsPanel.classList.toggle('active', tab === 'scraps');

  if (tab === 'popular') {
    renderCommunityPopularBooks();
  } else if (tab === 'books') {
    renderCommunityBooks();
  }
}

const communityBooksSort = 'read';

function updateCommunityBooksSortButtons() {
  const capEl = document.getElementById('comm-books-panel-caption');
  if (capEl) {
    capEl.textContent = '완독일이 최신인 순서대로 정렬';
  }
}

function setCommunityBooksSort(sortType = 'read') {
  updateCommunityBooksSortButtons();
  communityBooksLimit = 9;
  renderCommunityBooks();
}

function getSortedCommunityBooks() {
  const allBooks = getAllCommunityBooks();
  return [...allBooks].sort((a, b) => {
    // 기본: 완독일(date) 최신순 우선 정렬
    const dateA = getSafeTimestamp(a.date);
    const dateB = getSafeTimestamp(b.date);
    if (dateA && dateB && dateA !== dateB) return dateB - dateA;
    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;

    // 완독일이 같거나 없는 경우 등록일(created_at) 최신순
    const createA = getSafeTimestamp(a.created_at);
    const createB = getSafeTimestamp(b.created_at);
    if (createA && createB && createA !== createB) return createB - createA;
    if (createA && !createB) return -1;
    if (!createA && createB) return 1;

    // 데이터셋 seq 최신순
    return (b.seq || 0) - (a.seq || 0);
  });
}

function formatCommunityBook(b) {
  const titleParts = splitBookTitle(b);
  const userRating = (b.rating && Number(b.rating) > 0) ? Number(b.rating) : null;
  const userReview = (b.sentence || b.review || b.oneLineReview || '').trim();

  let timeStr = '';
  let timeTooltip = '';

  const formatSimpleDate = (val) => {
    if (!val) return '';
    const s = String(val).trim();
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(s)) return s.replace(/-/g, '.');
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    }
    return s;
  };

  // 완독일순: 완독일(date) 우선 표시
  if (b.date) {
    const s = String(b.date).trim();
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(s)) {
      timeStr = s.replace(/-/g, '.');
    } else {
      timeStr = formatTimeAgo(b.date);
    }
    timeTooltip = `완독일: ${formatSimpleDate(b.date)}` + (b.created_at ? ` (추가일: ${formatSimpleDate(b.created_at)})` : '');
  } else if (b.created_at) {
    timeStr = formatTimeAgo(b.created_at);
    timeTooltip = `추가일: ${formatSimpleDate(b.created_at)}`;
  }

  let kwList = [];
  if (Array.isArray(b.keywords)) {
    kwList = b.keywords;
  } else if (typeof b.keywords === 'string' && b.keywords.trim()) {
    kwList = b.keywords.split(',').map(s => s.trim());
  } else if (Array.isArray(b.tags)) {
    kwList = b.tags;
  } else if (typeof b.tags === 'string' && b.tags.trim()) {
    kwList = b.tags.split(',').map(s => s.trim());
  }
  kwList = kwList.map(k => String(k).replace(/^#/, '').trim()).filter(Boolean).slice(0, 3);

  return {
    ...b,
    id: b.id,
    title: titleParts.main || b.title,
    subtitle: titleParts.sub || b.subtitle || '',
    author: b.author || '저자 미상',
    cover: b.cover || '',
    rating: userRating,
    review: userReview || null,
    keywords: kwList,
    date: b.date || '',
    created_at: b.created_at || '',
    time: timeStr,
    timeTooltip: timeTooltip,
    user_id: b.user_id,
    _source: b._source,
    _ownerId: b._ownerId || resolveCommunityBookOwner(b, b._source),
    nickname: b.nickname
  };
}

function getCommunityBooksList() {
  const sorted = getSortedCommunityBooks();
  return sorted.slice(0, communityBooksLimit).map(formatCommunityBook);
}

function handleCoverError(img) {
  img.onerror = null;
  const ph = document.createElement('div');
  ph.className = 'book-card-placeholder';
  const span = document.createElement('span');
  span.className = 'placeholder-title';
  span.textContent = img.getAttribute('data-title') || img.alt || '';
  ph.appendChild(span);
  img.replaceWith(ph);
}

function handleDetailThumbError(img) {
  img.onerror = null;
  const ph = document.createElement('div');
  ph.className = 'detail-thumb-placeholder';
  ph.textContent = '8ook';
  img.replaceWith(ph);
}

function handleScrapCoverError(img) {
  img.onerror = null;
  const ph = document.createElement('div');
  ph.className = 'scrap-card-cover-placeholder';
  ph.textContent = '8ook';
  for (const attr of ['data-library-click', 'data-library-args']) {
    if (img.hasAttribute(attr)) ph.setAttribute(attr, img.getAttribute(attr));
  }
  img.replaceWith(ph);
}

function handlePrevError(img) {
  img.onerror = null;
  const parent = img.parentElement;
  if (parent) {
    parent.innerHTML = '<div class="img-prev-ph"><span style="font-size:10px; color:var(--text-300);">표지 오류</span></div>';
  }
}

function handleSpinePrevError(img) {
  if (!img) return;
  img.onerror = null;
  const parent = img.parentElement;
  if (parent) {
    parent.innerHTML = '<div class="img-prev-ph spine-ph"><span style="font-size:10px; writing-mode:vertical-rl; letter-spacing:1px; color:var(--text-300);">기본 책등</span></div>';
  }
}

function handleRealSpineError(img) {
  if (!img) return;
  const src = img.getAttribute('src') || img.src;
  if (src && !src.startsWith('data:')) {
    spineImgStatusCache[src] = { status: 'fail' };
    scheduleSaveSpineStatusCache();
  }
  img.onerror = null;
  img.classList.add('hide-real');
  img.style.display = 'none';
  const parent = img.parentElement;
  const fb = parent ? parent.querySelector('.spine-custom-view') : null;
  if (fb) {
    fb.classList.add('show-fallback');
    fb.style.display = 'flex';
  }
}

function handleCommCoverError(img) {
  img.onerror = null;
  const ph = document.createElement('div');
  const isScrap = img.classList.contains('comm-scrap-cover');
  ph.className = isScrap ? 'comm-scrap-cover-placeholder' : 'comm-book-cover-placeholder';
  ph.textContent = '8ook';
  for (const attr of ['data-community-click', 'data-community-args']) {
    if (img.hasAttribute(attr)) ph.setAttribute(attr, img.getAttribute(attr));
  }
  img.replaceWith(ph);
}

function buildCommunityBookCardHtml(b, storedBookLikes, myId) {
  const bid = String(b.id);
  const titleParts = splitBookTitle(b);
  const mainTitle = b.title && b.subtitle !== undefined ? b.title : (titleParts.main || b.title);

  const coverUrl = b.cover ? getSafeImageUrl(b.cover) : '';
  const coverHtml = coverUrl
    ? `<img class="comm-book-cover" src="${esc(coverUrl)}" alt="${esc(mainTitle)}" referrerpolicy="no-referrer" decoding="async" ${communityEventAttrs('showDetail', [bid], 'onclick')} onerror="handleCommCoverError(this)">`
    : `<div class="comm-book-cover-placeholder" ${communityEventAttrs('showDetail', [bid], 'onclick')}>8ook</div>`;

  const ratingHtml = (b.rating && Number(b.rating) > 0)
    ? `<div class="comm-book-rating">${'★'.repeat(Math.min(5, Math.max(1, Math.round(b.rating))))}${'☆'.repeat(Math.max(0, 5 - Math.round(b.rating)))} <span style="font-size:10px; color:var(--text-300); font-weight:600;">${Number(b.rating).toFixed(1)}</span></div>`
    : '';

  const kwList = Array.isArray(b.keywords) ? b.keywords.slice(0, 3) : [];
  const keywordsHtml = kwList.length > 0
    ? `<div class="comm-book-keywords">${kwList.map(k => `<span class="comm-book-kw-tag" ${communityEventAttrs('showDetail', [bid], 'onclick')}>#${esc(k)}</span>`).join('')}</div>`
    : '';

  const reviewHtml = (b.review && b.review.trim())
    ? `<div class="comm-book-review">“${esc(b.review.trim())}”</div>`
    : '';

  const remoteSet = communityLikesMap.get(bid) || new Set();
  const isLiked = (currentUser && remoteSet.has(currentUser.id)) || remoteSet.has(myId) || !!storedBookLikes['bk_' + bid];
  let currentLikes = remoteSet.size;
  if (isLiked && !remoteSet.has(myId) && (!currentUser || !remoteSet.has(currentUser.id))) {
    currentLikes += 1;
  }

  const ownerInfo = getCommunityItemOwnerNickname(b, b._source);
  const ownerNick = ownerInfo.nickname;
  const isMe = ownerInfo.isMe;

  const comments = getBookComments(bid);
  const commentCount = comments.length;
  const hasComments = commentCount > 0;

  return `
    <div class="comm-book-card" id="comm-bk-${esc(bid)}">
      <div class="comm-book-header">
        ${coverHtml}
        <div class="comm-book-info">
          <div class="comm-book-user-bar">
            <span class="comm-book-user" ${communityEventAttrs('openUserProfileCard', [ownerNick, b.user_id || b._ownerId || ''], 'onclick')} style="cursor: pointer;" title="${esc(ownerNick)}님의 프로필 보기"><span class="comm-user-at">@</span><span class="comm-user-name">${esc(ownerNick)}</span></span>
            ${isMe ? '<span class="comm-my-badge">나</span>' : ''}
            ${b.date ? `<span class="comm-book-time" title="${esc(b.timeTooltip || `도서 완독일: ${fmtDate(b.date)}`)}">• 완독 ${esc(fmtDate(b.date))}</span>` : (b.time ? `<span class="comm-book-time" title="${esc(b.timeTooltip || '')}">• ${esc(b.time)}</span>` : '')}
          </div>
          <div class="comm-book-title" ${communityEventAttrs('showDetail', [bid], 'onclick')}>${esc(mainTitle)}</div>
          <div class="comm-book-author-row">
            <div class="comm-book-author">${esc(b.author)}</div>
            ${ratingHtml}
          </div>
        </div>
      </div>
      ${reviewHtml}
      <div class="comm-book-meta">
        ${keywordsHtml}
        <div class="comm-book-meta-right">
          <button type="button" class="comm-book-comment-btn${hasComments ? ' active' : ''}" id="comm-cmt-toggle-btn-${esc(bid)}" ${communityEventAttrs('toggleBookCommentsSection', [bid], 'onclick')} title="${hasComments ? '댓글 작성하기' : '댓글 보기 및 작성'}">
            <span class="comm-comment-icon">💬</span> <span id="comm-cmt-cnt-${esc(bid)}">${commentCount}</span>
          </button>
          <button type="button" class="comm-book-like-btn${isLiked ? ' liked' : ''}" data-target-id="${esc(bid)}" ${communityEventAttrs('toggleCommunityBookLike', [bid], 'onclick')} title="좋아요">
            <span class="comm-heart-icon">♥</span> <span class="like-count">${currentLikes}</span>
          </button>
        </div>
      </div>
      <div class="comm-book-comments-sec${hasComments ? '' : ' collapsed'}" id="comm-cmts-sec-${esc(bid)}">
        <div class="comm-comments-list" id="comm-cmts-list-${esc(bid)}">
          ${renderCommentsListHtml(bid, comments)}
        </div>
        <div class="comm-comment-form">
          <div class="comm-comment-input-box">
            <input type="text" class="comm-comment-input" id="comm-cmt-input-${esc(bid)}" placeholder="댓글 남기기..." maxlength="200" ${communityEventAttrs('handleCommentKeyDown', [bid], 'onkeydown')} />
            <button type="button" class="comm-comment-submit-btn" ${communityEventAttrs('submitBookComment', [bid], 'onclick')} title="댓글 등록">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function updateCommunityBooksTrigger(currentCount, totalCount) {
  const triggerEl = document.getElementById('comm-books-load-trigger');
  if (!triggerEl) return;
  if (currentCount < totalCount) {
    triggerEl.style.display = 'block';
    triggerEl.innerHTML = `
      <button type="button" class="comm-load-more-btn" onclick="loadMoreCommunityBooks()" title="도서 더 불러오기">
        <span>도서 더 보기 (${Math.min(currentCount, totalCount)} / ${totalCount}) ↓</span>
      </button>
    `;
  } else if (totalCount > 9) {
    triggerEl.style.display = 'block';
    triggerEl.innerHTML = `
      <div class="comm-all-loaded-text">모든 도서를 불러왔습니다 (${totalCount}권)</div>
    `;
  } else {
    triggerEl.style.display = 'none';
    triggerEl.innerHTML = '';
  }
}

function getCommunityColumnCount() {
  if (window.innerWidth <= 768) return 1;
  return 2;
}

// 카드의 텍스트 길이 및 내용에 따른 추정 높이 계산
function estimateCommunityCardHeight(b, isPopular = false) {
  let h = 260; // 기본 표지 + 제목 + 여백
  if (isPopular) {
    if (Array.isArray(b.keywords) && b.keywords.length > 0) h += 32;
    if (Array.isArray(b.reviews)) {
      b.reviews.forEach(r => {
        h += 24 + Math.ceil(String(r).length / 22) * 20;
      });
    }
  } else {
    if (Array.isArray(b.keywords) && b.keywords.length > 0) h += 32;
    if (b.review) {
      h += 24 + Math.ceil(String(b.review).length / 22) * 20;
    }
    const cmts = getBookComments(b.id);
    if (cmts.length > 0) {
      h += 42 + Math.min(cmts.length, 3) * 52;
    } else {
      h += 50;
    }
  }
  return h;
}

// y값(컬럼 높이) 기준으로 가장 낮은 컬럼을 찾아주는 진정한 Masonry 헬퍼
function getShortestColumn(colEls, colHeights) {
  if (!colEls || colEls.length === 0) return null;
  let minCol = colEls[0];
  let minHeight = Infinity;
  let minIdx = 0;

  for (let i = 0; i < colEls.length; i++) {
    const domH = colEls[i].offsetHeight || 0;
    const currentH = domH > 0 ? domH : (colHeights ? (colHeights[i] || 0) : 0);
    if (currentH < minHeight) {
      minHeight = currentH;
      minCol = colEls[i];
      minIdx = i;
    }
  }
  return { col: minCol, index: minIdx };
}

function renderCommunityBooks() {
  const container = document.getElementById('comm-books-grid');
  if (!container) return;

  updateCommunityBooksSortButtons();

  const sorted = getSortedCommunityBooks();
  const totalCount = sorted.length;
  const list = sorted.slice(0, communityBooksLimit).map(formatCommunityBook);

  const countEl = document.getElementById('comm-books-count');
  if (countEl) countEl.remove();

  const titleEl = document.getElementById('comm-books-panel-title');
  if (titleEl) {
    titleEl.textContent = '새로 추가된 책';
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="width: 100%; padding: 60px 20px; text-align: center; color: var(--text-300); font-size: 13.5px;">
        <div style="font-weight: 600; color: var(--text-200); margin-bottom: 4px;">아직 서재에 추가된 도서가 없습니다.</div>
        <div style="font-size: 12px; color: var(--text-400);">서재에 책을 등록하면 최근 추가된 도서로 이곳에 표시됩니다.</div>
      </div>
    `;
    const triggerEl = document.getElementById('comm-books-load-trigger');
    if (triggerEl) triggerEl.innerHTML = '';
    return;
  }

  let storedBookLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_book_likes');
    if (raw) storedBookLikes = JSON.parse(raw);
  } catch (e) {}

  const myId = getClientLikeId();
  const numCols = getCommunityColumnCount();
  container._colCount = numCols;

  container.innerHTML = Array.from({ length: numCols }, (_, i) => 
    `<div class="comm-books-col" data-col="${i}"></div>`
  ).join('');

  const colEls = container.querySelectorAll('.comm-books-col');
  const colHeights = Array.from({ length: numCols }, () => 0);

  // 세로 갯수가 아닌 y값(누적 높이)이 가장 낮은 컬럼에 순차 배치!
  list.forEach((b) => {
    const cardHtml = buildCommunityBookCardHtml(b, storedBookLikes, myId);
    const target = getShortestColumn(colEls, colHeights);
    if (target && target.col) {
      target.col.insertAdjacentHTML('beforeend', cardHtml);
      const estH = estimateCommunityCardHeight(b, false);
      colHeights[target.index] = Math.max(target.col.offsetHeight || 0, colHeights[target.index] + estH);
    }
  });

  updateCommunityBooksTrigger(communityBooksLimit, totalCount);
  setupCommunityBooksObserver();
}

function loadMoreCommunityBooks() {
  if (isCommunityBooksLoading) return;
  const container = document.getElementById('comm-books-grid');
  if (!container) return;

  const sorted = getSortedCommunityBooks();
  const totalCount = sorted.length;
  if (communityBooksLimit >= totalCount) return;

  isCommunityBooksLoading = true;
  const prevLimit = communityBooksLimit;
  communityBooksLimit += 6; // 3열 기준 2줄(6권)씩 추가

  const nextBatch = sorted.slice(prevLimit, communityBooksLimit).map(formatCommunityBook);

  let storedBookLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_book_likes');
    if (raw) storedBookLikes = JSON.parse(raw);
  } catch (e) {}
  const myId = getClientLikeId();

  let colEls = container.querySelectorAll('.comm-books-col');
  if (!colEls || colEls.length === 0) {
    renderCommunityBooks();
    isCommunityBooksLoading = false;
    return;
  }

  const colHeights = Array.from(colEls).map(c => c.offsetHeight || 0);

  // 추가 로드 시에도 y값(높이)이 가장 낮은 컬럼에 순차 배치!
  nextBatch.forEach((b) => {
    const cardHtml = buildCommunityBookCardHtml(b, storedBookLikes, myId);
    const target = getShortestColumn(colEls, colHeights);
    if (target && target.col) {
      target.col.insertAdjacentHTML('beforeend', cardHtml);
      const estH = estimateCommunityCardHeight(b, false);
      colHeights[target.index] = Math.max(target.col.offsetHeight || 0, colHeights[target.index] + estH);
    }
  });

  updateCommunityBooksTrigger(communityBooksLimit, totalCount);

  setTimeout(() => {
    isCommunityBooksLoading = false;
  }, 200);
}

function setupCommunityBooksObserver() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (communityBooksObserver) {
    communityBooksObserver.disconnect();
  }
  const triggerEl = document.getElementById('comm-books-load-trigger');
  if (!triggerEl) return;

  communityBooksObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (currentCommunityTab === 'books' && !isCommunityBooksLoading) {
          loadMoreCommunityBooks();
        }
      }
    });
  }, {
    root: document.getElementById('view-community') || null,
    rootMargin: '250px 0px',
    threshold: 0.05
  });

  communityBooksObserver.observe(triggerEl);
}

function checkCommunityScroll() {
  if (currentCommunityTab === 'books') {
    if (isCommunityBooksLoading) return;
  } else if (currentCommunityTab === 'popular') {
    if (isCommunityPopularLoading) return;
  } else {
    return;
  }
  const commView = document.getElementById('view-community');
  if (!commView || !commView.classList.contains('show')) return;

  const remainingInner = commView.scrollHeight - (commView.scrollTop + commView.clientHeight);
  const remainingWindow = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);

  if (remainingInner < 300 || remainingWindow < 300) {
    if (currentCommunityTab === 'books') {
      const allBooks = getAllCommunityBooks();
      if (communityBooksLimit < allBooks.length) {
        loadMoreCommunityBooks();
      }
    } else if (currentCommunityTab === 'popular') {
      const allPopular = getMostShelvedCommunityBooks();
      if (communityPopularBooksLimit < allPopular.length) {
        loadMoreCommunityPopularBooks();
      }
    }
  }
}

let _commResizeTimer = null;
function handleCommunityResize() {
  clearTimeout(_commResizeTimer);
  _commResizeTimer = setTimeout(() => {
    const commView = document.getElementById('view-community');
    if (!commView || !commView.classList.contains('show')) return;
    const newCols = getCommunityColumnCount();
    const booksContainer = document.getElementById('comm-books-grid');
    if (booksContainer && booksContainer._colCount !== newCols) {
      renderCommunityBooks();
    }
    const popContainer = document.getElementById('comm-popular-grid');
    if (popContainer && popContainer._colCount !== newCols) {
      renderCommunityPopularBooks();
    }
  }, 150);
}

function initCommunityScroll() {
  const commView = document.getElementById('view-community');
  if (commView && !commView._scrollBound) {
    commView._scrollBound = true;
    commView.addEventListener('scroll', checkCommunityScroll, { passive: true });
    window.addEventListener('scroll', checkCommunityScroll, { passive: true });
    window.addEventListener('resize', handleCommunityResize, { passive: true });
  }
}

function getMostShelvedCommunityBooks() {
  const groups = new Map();
  const seenBookIds = new Set();

  function addToGroup(b, source) {
    if (!b || isGuideBook(b) || !b.title || b.title === '__like__' || b.id?.startsWith('like_') || b.is_public === false || (source === 'remote' && !b.user_id)) return;
    const strId = b.id ? String(b.id) : null;
    if (strId && seenBookIds.has(strId)) return;
    if (strId) seenBookIds.add(strId);

    const normTitle = getBookGroupingKey(b);
    if (!normTitle) return;

    if (!groups.has(normTitle)) {
      groups.set(normTitle, {
        repBook: b,
        copies: [],
        totalScraps: 0,
        distinctUsers: new Set()
      });
    }
    const g = groups.get(normTitle);
    g.copies.push({ ...b, _source: source });
    g.totalScraps += (b.scraps || []).length;

    // Identify duplicate registrations by the same reader.
    const personId = resolveCommunityBookOwner(b, source);
    g.distinctUsers.add(personId);

    // Pick best representative (one with cover, review, and author)
    if (!g.repBook.cover && b.cover) g.repBook = b;
    if (!g.repBook.review && (b.review || b.sentence)) g.repBook = b;
  }

  // 1. Supabase 원격 도서 (각 도서의 출처 반영)
  if (Array.isArray(remoteCommunityBooks)) {
    remoteCommunityBooks.forEach(b => addToGroup(b, 'remote'));
  }

  // 2. 현재 로그인/로컬 사용자의 서재 도서
  if (Array.isArray(books)) {
    books.forEach(b => addToGroup(b, 'local'));
  }

  const result = [];
  groups.forEach((g) => {
    // 한 사람이 여러 번 꽂은 것은 1회로 합산 -> 서로 다른 독서가(서재) 수만 카운트
    const count = g.distinctUsers.size;

    // 서로 다른 독서가가 1명(1회) 이하인 책은 제외 (2명 이상의 서로 다른 독서가가 꽂은 책만 노출)
    if (count <= 1) return;

    const b = g.repBook;
    const titleParts = splitBookTitle(b);
    const mainTitle = b.title && b.subtitle !== undefined ? b.title : (titleParts.main || b.title);
    const subTitle = b.subtitle !== undefined ? b.subtitle : (titleParts.sub || '');

    // 독서가별 평점 평균 계산 (동일 독서가가 여러 번 꽂아도 1인의 평점으로 정합성 유지)
    const userRatingMap = new Map();
    g.copies.forEach(copy => {
      const ownerId = resolveCommunityBookOwner(copy, copy._source);
      const r = parseFloat(copy.rating);
      if (!isNaN(r) && r > 0) {
        userRatingMap.set(ownerId, r);
      }
    });
    let ratingSum = 0;
    userRatingMap.forEach(r => ratingSum += r);
    const avgRating = userRatingMap.size > 0 ? parseFloat((ratingSum / userRatingMap.size).toFixed(1)) : null;
    const ratingCount = userRatingMap.size;

    // copies를 완독일(date) 최신순으로 정렬
    const sortedCopies = [...g.copies].sort((ca, cb) => {
      const ta = getSafeTimestamp(ca.date) || getSafeTimestamp(ca.created_at) || getSafeTimestamp(ca.time) || 0;
      const tb = getSafeTimestamp(cb.date) || getSafeTimestamp(cb.created_at) || getSafeTimestamp(cb.time) || 0;
      return tb - ta;
    });

    // 여러 독서가의 나만의 한문장 모두 수집 (작성자 닉네임 매핑, 중복 제거, 완독일 최신순)
    const reviews = [];
    const seenReviews = new Set();
    sortedCopies.forEach(copy => {
      const rev = (copy.sentence || copy.review || copy.oneLineReview || '').trim();
      if (rev && !seenReviews.has(rev)) {
        seenReviews.add(rev);
        const ownerInfo = getCommunityItemOwnerNickname(copy, copy._source);
        const copyDate = getSafeTimestamp(copy.date) || getSafeTimestamp(copy.created_at) || getSafeTimestamp(copy.time) || 0;
        reviews.push({
          text: rev,
          nickname: ownerInfo.nickname,
          isMe: ownerInfo.isMe,
          date: copyDate
        });
      }
    });

    const bid = String(b.id);
    const remoteSet = communityLikesMap.get(bid) || new Set();
    const likesCount = remoteSet.size;

    // 여러 독서가가 꼽은 모든 키워드 수집 (동일 독서가가 중복 등록한 경우 겹치지 않게 서로 다른 독서가 수만 카운트)
    const kwMap = new Map();
    sortedCopies.forEach(copy => {
      const ownerId = resolveCommunityBookOwner(copy, copy._source);
      let rawKws = [];
      if (Array.isArray(copy.keywords)) rawKws = copy.keywords;
      else if (typeof copy.keywords === 'string' && copy.keywords.trim()) rawKws = copy.keywords.split(',');
      else if (Array.isArray(copy.tags)) rawKws = copy.tags;
      else if (typeof copy.tags === 'string' && copy.tags.trim()) rawKws = copy.tags.split(',');

      rawKws.forEach(k => {
        const clean = String(k).replace(/^#/, '').trim();
        if (!clean) return;
        const lowerKey = clean.toLowerCase();
        if (!kwMap.has(lowerKey)) {
          kwMap.set(lowerKey, { text: clean, users: new Set() });
        }
        kwMap.get(lowerKey).users.add(ownerId);
      });
    });

    const allKeywords = Array.from(kwMap.values())
      .map(item => ({ text: item.text, count: item.users.size }))
      .sort((a, b) => b.count - a.count);

    // 참여 독서가 닉네임 목록 수집 (완독일 최신순 정렬)
    const readerMap = new Map();
    sortedCopies.forEach(copy => {
      const info = getCommunityItemOwnerNickname(copy, copy._source);
      if (info && info.nickname) {
        const copyDate = getSafeTimestamp(copy.date) || getSafeTimestamp(copy.created_at) || getSafeTimestamp(copy.time) || 0;
        if (!readerMap.has(info.nickname) || copyDate > readerMap.get(info.nickname).date) {
          readerMap.set(info.nickname, {
            nickname: info.nickname,
            isMe: info.isMe,
            date: copyDate
          });
        }
      }
    });

    const readers = Array.from(readerMap.values()).sort((a, b) => {
      // 1. 완독일(date) 최신순
      if (b.date !== a.date) return b.date - a.date;
      // 2. 완독일 동일 시 본인 우선
      return (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0);
    });

    result.push({
      id: b.id,
      title: mainTitle,
      subtitle: subTitle,
      author: b.author || '저자 미상',
      cover: b.cover || '',
      rating: avgRating,
      ratingCount: ratingCount,
      keywords: allKeywords,
      reviews: reviews,
      shelvedCount: count,
      readers: readers,
      likesCount: likesCount
    });
  });

  // 여러 번 꽂힌 순(내림차순) 정렬, 동일 시 좋아요/평점 순
  result.sort((a, b) => {
    if (b.shelvedCount !== a.shelvedCount) return b.shelvedCount - a.shelvedCount;
    if (b.likesCount !== a.likesCount) return b.likesCount - a.likesCount;
    return (b.rating || 0) - (a.rating || 0);
  });

  return result;
}

function buildCommunityPopularBookCardHtml(b, storedBookLikes, myId) {
  const bid = String(b.id);
  const coverUrl = b.cover ? getSafeImageUrl(b.cover) : '';
  const coverHtml = coverUrl
    ? `<img class="comm-book-cover" src="${esc(coverUrl)}" alt="${esc(b.title)}" referrerpolicy="no-referrer" decoding="async" onerror="handleCommCoverError(this)">`
    : `<div class="comm-book-cover-placeholder">8ook</div>`;

  const ratingHtml = (b.rating && Number(b.rating) > 0)
    ? `<div class="comm-book-rating">${'★'.repeat(Math.min(5, Math.max(1, Math.round(b.rating))))}${'☆'.repeat(Math.max(0, 5 - Math.round(b.rating)))} <span style="font-size:10px; color:var(--text-300); font-weight:600;">${Number(b.rating).toFixed(1)}</span></div>`
    : '';

  const kwList = Array.isArray(b.keywords) ? b.keywords : [];
  const keywordsHtml = kwList.length > 0
    ? `<div class="comm-book-keywords">${kwList.map(item => {
        const text = typeof item === 'object' ? item.text : String(item);
        const count = typeof item === 'object' ? (item.count || 1) : 1;
        const isMulti = count > 1;
        const badgeHtml = isMulti ? `<span class="comm-kw-count">${count}</span>` : '';
        const cls = isMulti ? 'comm-book-kw-tag is-highlighted' : 'comm-book-kw-tag';
        const titleText = isMulti ? `#${text} (${count}명의 독서가가 함께 꼽은 키워드)` : `#${text}`;
        return `<span class="${cls}">#${esc(text)}${badgeHtml}</span>`;
      }).join('')}</div>`
    : '';

  const reviewsList = Array.isArray(b.reviews) ? b.reviews : (b.review ? [{ text: b.review, nickname: '' }] : []);
  const reviewsHtml = reviewsList.length > 0
    ? reviewsList.map(r => {
        const text = typeof r === 'object' ? r.text : String(r);
        const nick = typeof r === 'object' ? r.nickname : '';
        const isMe = typeof r === 'object' ? r.isMe : false;
        const writerHtml = nick
          ? `<span class="comm-review-writer"><span class="comm-user-at">@</span><span class="comm-user-name">${esc(nick)}</span>${isMe ? '<span class="comm-my-badge">나</span>' : ''}</span>`
          : '';
        return `
          <div class="comm-book-review-row">
            ${writerHtml}
            <div class="comm-book-review">“${esc(text)}”</div>
          </div>
        `;
      }).join('')
    : '';

  const readersHtml = (Array.isArray(b.readers) && b.readers.length > 0)
    ? `<div class="comm-book-user-bar comm-popular-user-bar">
        ${b.readers.map(r => `
          <span class="comm-book-user" ${communityEventAttrs('openUserProfileCard', [r.nickname, r.userId || ''], 'onclick')} style="cursor: pointer;" title="${esc(r.nickname)}님의 프로필 보기"><span class="comm-user-at">@</span><span class="comm-user-name">${esc(r.nickname)}</span>${r.isMe ? '<span class="comm-my-badge">나</span>' : ''}</span>
        `).join('')}
      </div>`
    : `<div class="comm-shelved-badge">🔖 ${b.shelvedCount}명의 선택</div>`;

  const remoteSet = communityLikesMap.get(bid) || new Set();
  const isLiked = (currentUser && remoteSet.has(currentUser.id)) || remoteSet.has(myId) || !!storedBookLikes['bk_' + bid];
  let currentLikes = remoteSet.size;
  if (isLiked && !remoteSet.has(myId) && (!currentUser || !remoteSet.has(currentUser.id))) {
    currentLikes += 1;
  }

  return `
    <div class="comm-book-card comm-popular-book-card" id="comm-pop-${esc(bid)}">
      <div class="comm-book-header">
        ${coverHtml}
        <div class="comm-book-info">
          ${readersHtml}
          <div class="comm-book-title">${esc(b.title)}</div>
          <div class="comm-book-author-row">
            <div class="comm-book-author">${esc(b.author)}</div>
            ${ratingHtml}
          </div>
        </div>
      </div>
      ${reviewsHtml}
      <div class="comm-book-meta">
        ${keywordsHtml}
        <div class="comm-book-meta-right">
          <button type="button" class="comm-book-like-btn${isLiked ? ' liked' : ''}" data-target-id="${esc(bid)}" ${communityEventAttrs('toggleCommunityBookLike', [bid], 'onclick')} title="좋아요">
            <span class="comm-heart-icon">♥</span> <span class="like-count">${currentLikes}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function updateCommunityPopularTrigger(currentCount, totalCount) {
  const triggerEl = document.getElementById('comm-popular-load-trigger');
  if (!triggerEl) return;
  if (currentCount < totalCount) {
    triggerEl.style.display = 'block';
    triggerEl.innerHTML = `
      <button type="button" class="comm-load-more-btn" onclick="loadMoreCommunityPopularBooks()" title="도서 더 불러오기">
        <span>도서 더 보기 (${Math.min(currentCount, totalCount)} / ${totalCount}) ↓</span>
      </button>
    `;
  } else if (totalCount > 9) {
    triggerEl.style.display = 'block';
    triggerEl.innerHTML = `
      <div class="comm-all-loaded-text">함께 읽은 도서를 모두 불러왔습니다 (${totalCount}권)</div>
    `;
  } else {
    triggerEl.style.display = 'none';
    triggerEl.innerHTML = '';
  }
}

function renderCommunityPopularBooks() {
  const container = document.getElementById('comm-popular-grid');
  if (!container) return;

  const allPopular = getMostShelvedCommunityBooks();
  const totalCount = allPopular.length;
  const list = allPopular.slice(0, communityPopularBooksLimit);

  if (list.length === 0) {
    container.innerHTML = `
      <div style="width: 100%; padding: 60px 20px; text-align: center; color: var(--text-300); font-size: 13.5px;">
        <div style="font-weight: 600; color: var(--text-200); margin-bottom: 4px;">아직 함께 읽은 도서가 없습니다.</div>
        <div style="font-size: 12px; color: var(--text-400);">2명 이상의 독서가가 함께 읽은 책이 이곳에 모입니다.</div>
      </div>
    `;
    const triggerEl = document.getElementById('comm-popular-load-trigger');
    if (triggerEl) triggerEl.innerHTML = '';
    return;
  }

  let storedBookLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_book_likes');
    if (raw) storedBookLikes = JSON.parse(raw);
  } catch (e) {}

  const myId = getClientLikeId();
  const numCols = getCommunityColumnCount();
  container._colCount = numCols;

  container.innerHTML = Array.from({ length: numCols }, (_, i) => 
    `<div class="comm-books-col" data-col="${i}"></div>`
  ).join('');

  const colEls = container.querySelectorAll('.comm-books-col');
  const colHeights = Array.from({ length: numCols }, () => 0);

  // 긴 카드가 있어도 세로 갯수가 아닌 y값(누적 높이)이 가장 낮은 컬럼에 순차 배치!
  list.forEach((b) => {
    const cardHtml = buildCommunityPopularBookCardHtml(b, storedBookLikes, myId);
    const target = getShortestColumn(colEls, colHeights);
    if (target && target.col) {
      target.col.insertAdjacentHTML('beforeend', cardHtml);
      const estH = estimateCommunityCardHeight(b, true);
      colHeights[target.index] = Math.max(target.col.offsetHeight || 0, colHeights[target.index] + estH);
    }
  });

  updateCommunityPopularTrigger(communityPopularBooksLimit, totalCount);
  setupCommunityPopularObserver();
}

function loadMoreCommunityPopularBooks() {
  if (isCommunityPopularLoading) return;
  const container = document.getElementById('comm-popular-grid');
  if (!container) return;

  const allPopular = getMostShelvedCommunityBooks();
  const totalCount = allPopular.length;
  if (communityPopularBooksLimit >= totalCount) return;

  isCommunityPopularLoading = true;
  const prevLimit = communityPopularBooksLimit;
  communityPopularBooksLimit += 6;

  const nextBatch = allPopular.slice(prevLimit, communityPopularBooksLimit);

  let storedBookLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_book_likes');
    if (raw) storedBookLikes = JSON.parse(raw);
  } catch (e) {}
  const myId = getClientLikeId();

  let colEls = container.querySelectorAll('.comm-books-col');
  if (!colEls || colEls.length === 0) {
    renderCommunityPopularBooks();
    isCommunityPopularLoading = false;
    return;
  }

  const colHeights = Array.from(colEls).map(c => c.offsetHeight || 0);

  // 추가 로드 시에도 y값(높이)이 가장 낮은 컬럼에 순차 배치!
  nextBatch.forEach((b) => {
    const cardHtml = buildCommunityPopularBookCardHtml(b, storedBookLikes, myId);
    const target = getShortestColumn(colEls, colHeights);
    if (target && target.col) {
      target.col.insertAdjacentHTML('beforeend', cardHtml);
      const estH = estimateCommunityCardHeight(b, true);
      colHeights[target.index] = Math.max(target.col.offsetHeight || 0, colHeights[target.index] + estH);
    }
  });

  updateCommunityPopularTrigger(communityPopularBooksLimit, totalCount);

  setTimeout(() => {
    isCommunityPopularLoading = false;
  }, 200);
}

function setupCommunityPopularObserver() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (communityPopularObserver) {
    communityPopularObserver.disconnect();
  }
  const triggerEl = document.getElementById('comm-popular-load-trigger');
  if (!triggerEl) return;

  communityPopularObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (currentCommunityTab === 'popular' && !isCommunityPopularLoading) {
          loadMoreCommunityPopularBooks();
        }
      }
    });
  }, {
    root: document.getElementById('view-community') || null,
    rootMargin: '250px 0px',
    threshold: 0.05
  });

  communityPopularObserver.observe(triggerEl);
}

async function toggleCommunityBookLike(id, btnEl, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const strId = String(id);
  let storedLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_book_likes');
    if (raw) storedLikes = JSON.parse(raw);
  } catch (e) {}

  const key = 'bk_' + strId;
  const myId = getClientLikeId();
  if (!communityLikesMap.has(strId)) {
    communityLikesMap.set(strId, new Set());
  }
  const remoteSet = communityLikesMap.get(strId);

  const wasLiked = (currentUser && remoteSet.has(currentUser.id)) || remoteSet.has(myId) || !!storedLikes[key];
  const willBeLiked = !wasLiked;

  // 1. Update local cache
  if (willBeLiked) {
    storedLikes[key] = true;
    remoteSet.add(myId);
    if (currentUser) remoteSet.add(currentUser.id);
  } else {
    delete storedLikes[key];
    remoteSet.delete(myId);
    if (currentUser) remoteSet.delete(currentUser.id);
  }
  try {
    localStorage.setItem('rj_community_book_likes', JSON.stringify(storedLikes));
  } catch (e) {}

  // 2. Immediate UI update
  btnEl.classList.toggle('liked', willBeLiked);
  const countSpan = btnEl.querySelector('.like-count');
  if (countSpan) {
    countSpan.textContent = String(remoteSet.size);
  }
  if (willBeLiked) {
    toast('도서에 좋아요를 남겼습니다 ♥');
  } else {
    toast('도서 좋아요를 취소했습니다.');
  }

  // 3. Broadcast to all open tabs and connected devices
  broadcastLikeUpdate(strId, currentUser?.id || myId, willBeLiked);

  // 4. If logged in, persist to Supabase books table
  if (currentUser && supabaseClient) {
    const safeUId = currentUser.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeTargetId = strId.replace(/[^a-zA-Z0-9_-]/g, '');
    const likeRowId = 'like_' + safeUId + '_' + safeTargetId;

    try {
      if (willBeLiked) {
        const { error } = await supabaseClient.from('books').upsert({
          id: likeRowId,
          user_id: currentUser.id,
          title: '__like__',
          author: strId,
          is_public: true,
          created_at: new Date().toISOString()
        }, { onConflict: 'id' });
        if (error) console.warn('[Like Sync] Upsert error:', error);
      } else {
        const { error } = await supabaseClient.from('books').delete().eq('id', likeRowId).eq('user_id', currentUser.id);
        if (error) console.warn('[Like Sync] Delete error:', error);
      }
    } catch (err) {
      console.warn('[Like Sync] Supabase error:', err);
    }
  } else if (willBeLiked) {
    setTimeout(() => {
      if (!currentUser) {
        toast('로그인하시면 다른 기기에서도 좋아요가 영구 보존됩니다.');
      }
    }, 1200);
  }
}

/* ==============================================
   COMMUNITY BOOK COMMENTS (말풍선 댓글)
============================================== */
const DEFAULT_COMMUNITY_COMMENTS = {
  'neo_2025_001': [
    {
      id: 'cmt_seed_1',
      bookId: 'neo_2025_001',
      userId: 'user_owner_oha',
      nickname: 'oha',
      text: '완독 축하드려요! 저도 이 책 읽어보고 싶었는데 평점과 한 줄 평 보고 바로 장바구니에 담았습니다 :)',
      createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString()
    },
    {
      id: 'cmt_seed_reply_1',
      bookId: 'neo_2025_001',
      parentId: 'cmt_seed_1',
      userId: 'user_owner_neo',
      nickname: 'neo_elon',
      text: '감사합니다 @oha님! 읽으시면 분명 마음에 드실 거예요.',
      createdAt: new Date(Date.now() - 1000 * 60 * 20).toISOString()
    }
  ],
  'neo_2025_002': [
    {
      id: 'cmt_seed_2',
      bookId: 'neo_2025_002',
      userId: 'user_owner_neo',
      nickname: 'neo_elon',
      text: '생각할 거리가 정말 많은 책이었습니다. 꼭 읽어보시길 추천해요!',
      createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString()
    }
  ]
};

function loadCommunityCommentsFromStorage() {
  try {
    const raw = localStorage.getItem('8ook_community_comments');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        communityCommentsMap.clear();
        Object.entries(parsed).forEach(([bid, list]) => {
          if (Array.isArray(list)) {
            communityCommentsMap.set(String(bid), list);
          }
        });
        return;
      }
    }
  } catch (e) {}

  // Initialize with seed comments if empty
  communityCommentsMap.clear();
  Object.entries(DEFAULT_COMMUNITY_COMMENTS).forEach(([bid, list]) => {
    communityCommentsMap.set(String(bid), [...list]);
  });
  saveCommunityCommentsToStorage();
}

function saveCommunityCommentsToStorage() {
  try {
    const obj = {};
    communityCommentsMap.forEach((list, bid) => {
      if (Array.isArray(list) && list.length > 0) {
        obj[bid] = list;
      }
    });
    localStorage.setItem('8ook_community_comments', JSON.stringify(obj));
  } catch (e) {}
}

function getBookComments(bookId) {
  const strId = String(bookId);
  return communityCommentsMap.get(strId) || [];
}

function renderCommentsListHtml(bookId, comments) {
  if (!comments || comments.length === 0) {
    return `<div class="comm-comment-empty-hint">첫 번째 댓글을 남겨보세요.</div>`;
  }
  const myId = getClientLikeId();
  const currentNick = getUserNickname();

  // Separate root comments and child replies
  const roots = [];
  const repliesMap = new Map();

  comments.forEach(c => {
    if (c.parentId) {
      if (!repliesMap.has(c.parentId)) {
        repliesMap.set(c.parentId, []);
      }
      repliesMap.get(c.parentId).push(c);
    } else {
      roots.push(c);
    }
  });

  // Keep orphaned replies visible
  repliesMap.forEach((repList, pId) => {
    if (!comments.some(c => c.id === pId)) {
      roots.push(...repList);
      repliesMap.delete(pId);
    }
  });

  return roots.map(c => {
    const isMyComment = (currentUser && c.userId === currentUser.id) || c.userId === myId || (c.nickname && c.nickname === currentNick);
    const childReplies = repliesMap.get(c.id) || [];

    const repliesHtml = childReplies.length > 0 ? `
      <div class="comm-replies-thread">
        ${childReplies.map(r => {
          const isMyReply = (currentUser && r.userId === currentUser.id) || r.userId === myId || (r.nickname && r.nickname === currentNick);
          return `
            <div class="comm-reply-item${isMyReply ? ' my-comment' : ''}" id="cmt-item-${esc(r.id)}">
              <div class="comm-comment-meta-row">
                <span class="comm-reply-branch">↳</span>
                <span class="comm-comment-author" ${communityEventAttrs('openUserProfileCard', [r.nickname || '독서가', r.userId || ''], 'onclick')} style="cursor: pointer;" title="${esc(r.nickname || '독서가')}님의 프로필 보기"><span class="comm-user-at">@</span>${esc(r.nickname || '독서가')}</span>
                ${isMyReply ? '<span class="comm-my-badge" style="font-size:9px; padding:1px 4.5px; line-height:1.2;">나</span>' : ''}
                <span class="comm-comment-time">${esc(formatTimeAgo(r.createdAt))}</span>
                <button type="button" class="comm-reply-toggle-btn" ${communityEventAttrs('toggleReplyInput', [c.id, bookId, r.nickname], 'onclick')} title="답글 달기">답글</button>
                ${isMyReply ? `<button type="button" class="comm-comment-delete-btn" ${communityEventAttrs('deleteBookComment', [r.id, bookId], 'onclick')} title="댓글 삭제">✕</button>` : ''}
              </div>
              <div class="comm-comment-bubble comm-reply-bubble">
                ${esc(r.text)}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    return `
      <div class="comm-comment-item${isMyComment ? ' my-comment' : ''}" id="cmt-item-${esc(c.id)}">
        <div class="comm-comment-meta-row">
          <span class="comm-comment-author" ${communityEventAttrs('openUserProfileCard', [c.nickname || '독서가', c.userId || ''], 'onclick')} style="cursor: pointer;" title="${esc(c.nickname || '독서가')}님의 프로필 보기"><span class="comm-user-at">@</span>${esc(c.nickname || '독서가')}</span>
          ${isMyComment ? '<span class="comm-my-badge" style="font-size:9px; padding:1px 4.5px; line-height:1.2;">나</span>' : ''}
          <span class="comm-comment-time">${esc(formatTimeAgo(c.createdAt))}</span>
          <button type="button" class="comm-reply-toggle-btn" ${communityEventAttrs('toggleReplyInput', [c.id, bookId, c.nickname], 'onclick')} title="답글 달기">답글</button>
          ${isMyComment ? `<button type="button" class="comm-comment-delete-btn" ${communityEventAttrs('deleteBookComment', [c.id, bookId], 'onclick')} title="댓글 삭제">✕</button>` : ''}
        </div>
        <div class="comm-comment-bubble">
          ${esc(c.text)}
        </div>
        ${repliesHtml}
        <div class="comm-reply-form" id="comm-reply-form-${esc(c.id)}" style="display: none;">
          <div class="comm-reply-input-box">
            <span class="comm-reply-to-tag" id="comm-reply-to-tag-${esc(c.id)}">@${esc(c.nickname)}</span>
            <input type="text" class="comm-reply-input" id="comm-reply-input-${esc(c.id)}" placeholder="답글을 남겨보세요..." maxlength="200" ${communityEventAttrs('handleReplyKeyDown', [c.id, bookId], 'onkeydown')} />
            <button type="button" class="comm-comment-submit-btn" ${communityEventAttrs('submitBookReply', [c.id, bookId], 'onclick')} title="답글 등록">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
            <button type="button" class="comm-reply-cancel-btn" ${communityEventAttrs('toggleReplyInput', [c.id, bookId], 'onclick')} title="취소">✕</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleReplyInput(parentId, bookId, targetNick) {
  const formEl = document.getElementById('comm-reply-form-' + parentId);
  if (!formEl) return;
  const isCurrentlyVisible = formEl.style.display !== 'none' && formEl.style.display !== '';
  if (isCurrentlyVisible && (!targetNick || formEl.dataset.targetNick === targetNick)) {
    formEl.style.display = 'none';
    return;
  }
  formEl.style.display = 'block';
  formEl.dataset.targetNick = targetNick || '';
  const tagEl = document.getElementById('comm-reply-to-tag-' + parentId);
  if (tagEl && targetNick) {
    tagEl.textContent = '@' + targetNick;
  }
  const inputEl = document.getElementById('comm-reply-input-' + parentId);
  if (inputEl) {
    inputEl.focus();
  }
}

function handleReplyKeyDown(event, parentId, bookId) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitBookReply(parentId, bookId);
  } else if (event.key === 'Escape') {
    toggleReplyInput(parentId, bookId);
  }
}

async function submitBookReply(parentId, bookId) {
  const strId = String(bookId);
  const strParentId = String(parentId);
  const input = document.getElementById('comm-reply-input-' + strParentId);
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    toast('답글 내용을 입력해주세요.');
    input.focus();
    return;
  }
  if (text.length > 200) {
    toast('답글은 최대 200자까지 작성할 수 있습니다.');
    return;
  }

  // 기기 간 공유 및 영구 저장을 위해 로그인 필수
  if (!currentUser) {
    toast('답글을 다른 기기와 공유하려면 구글 로그인이 필요합니다.');
    loginWithGoogle();
    return;
  }

  // 세션 유효성 검사 및 자동 갱신
  if (supabaseClient) {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session) {
        const { data: refData } = await supabaseClient.auth.refreshSession();
        if (refData && refData.session) {
          currentUser = refData.session.user;
        } else {
          toast('로그인 세션이 만료되었습니다. 다시 로그인해주세요.');
          loginWithGoogle();
          return;
        }
      }
    } catch (e) {}
  }

  const nick = getUserNickname();
  const replyId = 'cmt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const newReply = {
    id: replyId,
    bookId: strId,
    parentId: strParentId,
    userId: currentUser.id,
    nickname: nick,
    text: text,
    createdAt: new Date().toISOString()
  };

  if (!communityCommentsMap.has(strId)) {
    communityCommentsMap.set(strId, []);
  }
  communityCommentsMap.get(strId).push(newReply);
  saveCommunityCommentsToStorage();

  input.value = '';
  updateBookCommentsUI(strId);

  // Supabase 원격 저장 및 에러 핸들링
  if (supabaseClient) {
    try {
      let { error: insertError } = await supabaseClient.from('books').insert({
        id: replyId,
        user_id: currentUser.id,
        title: '__comment__',
        author: strId,
        sentence: text,
        keywords: [nick, strParentId],
        created_at: newReply.createdAt,
        is_public: true
      });

      if (insertError) {
        console.warn('[Reply Sync] Insert error, attempting session refresh retry...', insertError);
        const { data: refData } = await supabaseClient.auth.refreshSession();
        if (refData && refData.session) {
          currentUser = refData.session.user;
          const retryRes = await supabaseClient.from('books').insert({
            id: replyId,
            user_id: currentUser.id,
            title: '__comment__',
            author: strId,
            sentence: text,
            keywords: [nick, strParentId],
            created_at: newReply.createdAt,
            is_public: true
          });
          insertError = retryRes.error;
        }
      }

      if (insertError) {
        console.error('[Reply Sync] Supabase insert failed permanently:', insertError);
        toast(`답글 서버 저장 실패 (${insertError.message || '네트워크 오류'}).`);
        // 로컬 롤백
        const list = communityCommentsMap.get(strId) || [];
        communityCommentsMap.set(strId, list.filter(c => c.id !== replyId));
        saveCommunityCommentsToStorage();
        updateBookCommentsUI(strId);
        return;
      }
    } catch (err) {
      console.error('[Reply Sync] Supabase insert exception:', err);
      toast('답글 전송 중 오류가 발생했습니다.');
      const list = communityCommentsMap.get(strId) || [];
      communityCommentsMap.set(strId, list.filter(c => c.id !== replyId));
      saveCommunityCommentsToStorage();
      updateBookCommentsUI(strId);
      return;
    }
  }

  toast('답글이 등록되었습니다 💬');
  broadcastCommentUpdate('add', newReply);
}

async function submitBookComment(bookId) {
  const strId = String(bookId);
  const input = document.getElementById('comm-cmt-input-' + strId);
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    toast('댓글 내용을 입력해주세요.');
    input.focus();
    return;
  }
  if (text.length > 200) {
    toast('댓글은 최대 200자까지 작성할 수 있습니다.');
    return;
  }

  // 기기 간 공유 및 영구 저장을 위해 로그인 필수
  if (!currentUser) {
    toast('댓글을 다른 기기와 공유하려면 구글 로그인이 필요합니다.');
    loginWithGoogle();
    return;
  }

  // 세션 유효성 검사 및 자동 갱신
  if (supabaseClient) {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session) {
        const { data: refData } = await supabaseClient.auth.refreshSession();
        if (refData && refData.session) {
          currentUser = refData.session.user;
        } else {
          toast('로그인 세션이 만료되었습니다. 다시 로그인해주세요.');
          loginWithGoogle();
          return;
        }
      }
    } catch (e) {}
  }

  const nick = getUserNickname();
  const cmtId = 'cmt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const newCmt = {
    id: cmtId,
    bookId: strId,
    userId: currentUser.id,
    nickname: nick,
    text: text,
    createdAt: new Date().toISOString()
  };

  if (!communityCommentsMap.has(strId)) {
    communityCommentsMap.set(strId, []);
  }
  communityCommentsMap.get(strId).push(newCmt);
  saveCommunityCommentsToStorage();

  input.value = '';
  updateBookCommentsUI(strId);

  // Supabase 원격 저장 및 에러 핸들링
  if (supabaseClient) {
    try {
      let { error: insertError } = await supabaseClient.from('books').insert({
        id: cmtId,
        user_id: currentUser.id,
        title: '__comment__',
        author: strId,
        sentence: text,
        keywords: [nick],
        created_at: newCmt.createdAt,
        is_public: true
      });

      if (insertError) {
        console.warn('[Comment Sync] Insert error, attempting session refresh retry...', insertError);
        const { data: refData } = await supabaseClient.auth.refreshSession();
        if (refData && refData.session) {
          currentUser = refData.session.user;
          const retryRes = await supabaseClient.from('books').insert({
            id: cmtId,
            user_id: currentUser.id,
            title: '__comment__',
            author: strId,
            sentence: text,
            keywords: [nick],
            created_at: newCmt.createdAt,
            is_public: true
          });
          insertError = retryRes.error;
        }
      }

      if (insertError) {
        console.error('[Comment Sync] Supabase insert failed permanently:', insertError);
        toast(`댓글 서버 저장 실패 (${insertError.message || '네트워크 오류'}).`);
        // 로컬 롤백
        const list = communityCommentsMap.get(strId) || [];
        communityCommentsMap.set(strId, list.filter(c => c.id !== cmtId));
        saveCommunityCommentsToStorage();
        updateBookCommentsUI(strId);
        return;
      }
    } catch (err) {
      console.error('[Comment Sync] Supabase insert exception:', err);
      toast('댓글 전송 중 오류가 발생했습니다.');
      const list = communityCommentsMap.get(strId) || [];
      communityCommentsMap.set(strId, list.filter(c => c.id !== cmtId));
      saveCommunityCommentsToStorage();
      updateBookCommentsUI(strId);
      return;
    }
  }

  toast('댓글이 등록되었습니다.');
  broadcastCommentUpdate('add', newCmt);
}

async function deleteBookComment(commentId, bookId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const strId = String(bookId);
  const strCmtId = String(commentId);
  if (!confirm('이 댓글을 삭제하시겠습니까?')) return;

  if (!currentUser) {
    toast('댓글 삭제를 위해 로그인이 필요합니다.');
    return;
  }

  // Supabase 원격 삭제
  if (supabaseClient) {
    try {
      const { error: delError } = await supabaseClient
        .from('books')
        .delete()
        .eq('id', strCmtId)
        .eq('user_id', currentUser.id);

      if (delError) {
        console.error('[Comment Sync] Delete error:', delError);
        toast(`댓글 삭제 실패: ${delError.message || '오류'}`);
        return;
      }
    } catch (err) {
      console.error('[Comment Sync] Delete exception:', err);
      toast('댓글 삭제 중 오류가 발생했습니다.');
      return;
    }
  }

  if (communityCommentsMap.has(strId)) {
    const list = communityCommentsMap.get(strId);
    const toDeleteIds = [strCmtId];
    list.forEach(c => {
      if (c.parentId === strCmtId) {
        toDeleteIds.push(c.id);
      }
    });
    const nextList = list.filter(c => !toDeleteIds.includes(c.id));
    communityCommentsMap.set(strId, nextList);
    saveCommunityCommentsToStorage();
    updateBookCommentsUI(strId);
    toast('댓글이 삭제되었습니다.');
  }

  broadcastCommentUpdate('delete', { id: strCmtId, bookId: strId });
}

function handleCommentKeyDown(event, bookId) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitBookComment(bookId);
  }
}

function toggleBookCommentsSection(bookId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const strId = String(bookId);
  const sec = document.getElementById('comm-cmts-sec-' + strId);
  if (!sec) return;
  const comments = getBookComments(strId);
  const input = document.getElementById('comm-cmt-input-' + strId);

  // 댓글이 달린 카드는 댓글창을 열어서 고정 (아이콘 클릭 시 닫히지 않고 입력창으로 바로 포커스)
  if (comments && comments.length > 0) {
    sec.classList.remove('collapsed');
    const btn = document.getElementById('comm-cmt-toggle-btn-' + strId);
    if (btn) btn.classList.add('active');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return;
  }

  // 댓글이 아직 없는 카드는 토글
  sec.classList.toggle('collapsed');
  const isCollapsed = sec.classList.contains('collapsed');
  const btn = document.getElementById('comm-cmt-toggle-btn-' + strId);
  if (btn) {
    btn.classList.toggle('active', !isCollapsed);
  }
  if (!isCollapsed && input) {
    input.focus();
  }
}

function updateBookCommentsUI(bookId) {
  const strId = String(bookId);
  const comments = getBookComments(strId);
  const listEl = document.getElementById('comm-cmts-list-' + strId);
  if (listEl) {
    listEl.innerHTML = renderCommentsListHtml(strId, comments);
    listEl.scrollTop = listEl.scrollHeight;
  }
  const cntEl = document.getElementById('comm-cmt-cnt-' + strId);
  if (cntEl) {
    cntEl.textContent = String(comments.length);
  }
  // 댓글이 달린 도서카드는 댓글창을 열어서 고정
  const sec = document.getElementById('comm-cmts-sec-' + strId);
  const btn = document.getElementById('comm-cmt-toggle-btn-' + strId);
  if (comments.length > 0) {
    if (sec) sec.classList.remove('collapsed');
    if (btn) btn.classList.add('active');
  }
}

async function fetchCommunityComments() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('books')
      .select('id, user_id, author, sentence, keywords, created_at')
      .eq('title', '__comment__')
      .order('created_at', { ascending: true });

    if (!error && Array.isArray(data)) {
      // Supabase 원격 댓글을 책 ID별로 그룹화
      const remoteMap = new Map();
      data.forEach(row => {
        const bookId = String(row.author);
        if (!bookId) return;
        if (!remoteMap.has(bookId)) {
          remoteMap.set(bookId, []);
        }
        const nick = (Array.isArray(row.keywords) && row.keywords[0]) || '독서가';
        const parentId = (Array.isArray(row.keywords) && row.keywords[1]) || null;
        remoteMap.get(bookId).push({
          id: row.id,
          bookId: bookId,
          parentId: parentId,
          userId: row.user_id,
          nickname: nick,
          text: row.sentence || '',
          createdAt: row.created_at
        });
      });

      // 기존 시드 댓글 중 Supabase에 아직 등록되지 않은 기본 예시 보존
      const seedComments = DEFAULT_COMMUNITY_COMMENTS || {};
      Object.entries(seedComments).forEach(([sBid, sList]) => {
        if (!remoteMap.has(sBid)) {
          remoteMap.set(sBid, [...sList]);
        }
      });

      // Supabase SSOT(단일 진실 공급원)로 communityCommentsMap 동기화
      communityCommentsMap.clear();
      remoteMap.forEach((list, bid) => {
        communityCommentsMap.set(bid, list);
      });

      saveCommunityCommentsToStorage();

      communityCommentsMap.forEach((_, bid) => {
        updateBookCommentsUI(bid);
      });
    }
  } catch (e) {
    console.warn('Failed to fetch community comments:', e);
  }
}

function initCommunityCommentsChannel() {
  // 브라우저 탭 간 BroadcastChannel
  if (typeof BroadcastChannel !== 'undefined' && !localCommentBroadcast) {
    try {
      localCommentBroadcast = new BroadcastChannel('8ook_comments_channel');
      localCommentBroadcast.onmessage = (event) => {
        if (event && event.data) {
          applyIncomingCommentUpdate(event.data);
        }
      };
    } catch (e) {}
  }

  // Supabase Realtime 채널을 통한 물리적 기기 간 실시간 동기화
  if (supabaseClient && !commCommentsChannel) {
    try {
      commCommentsChannel = supabaseClient
        .channel('realtime_community_comments')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'books',
          filter: 'title=eq.__comment__'
        }, (payload) => {
          const row = payload.new;
          if (!row) return;
          const bookId = String(row.author);
          const nick = (Array.isArray(row.keywords) && row.keywords[0]) || '독서가';
          const parentId = (Array.isArray(row.keywords) && row.keywords[1]) || null;
          const comment = {
            id: row.id,
            bookId: bookId,
            parentId: parentId,
            userId: row.user_id,
            nickname: nick,
            text: row.sentence || '',
            createdAt: row.created_at
          };
          applyIncomingCommentUpdate({ action: 'add', comment });
        })
        .on('postgres_changes', {
          event: 'DELETE',
          schema: 'public',
          table: 'books'
        }, (payload) => {
          const oldRow = payload.old;
          if (!oldRow || !oldRow.id) return;
          applyIncomingCommentUpdate({
            action: 'delete',
            comment: { id: oldRow.id, bookId: oldRow.author }
          });
        })
        .subscribe();
    } catch (e) {
      console.warn('Failed to subscribe to realtime comments:', e);
    }
  }
}

function broadcastCommentUpdate(action, commentData) {
  const payload = { action, comment: commentData };
  if (localCommentBroadcast) {
    try { localCommentBroadcast.postMessage(payload); } catch (e) {}
  }
}

function applyIncomingCommentUpdate(payload) {
  if (!payload || !payload.comment) return;
  const { action, comment } = payload;
  let bookId = comment.bookId ? String(comment.bookId) : '';

  // DELETE의 경우 postgres_changes에서 bookId(author)가 누락될 수 있으므로 전체 맵에서 comment.id 탐색
  if (!bookId || bookId === 'undefined') {
    for (const [bId, cList] of communityCommentsMap.entries()) {
      if (cList.some(c => c.id === comment.id)) {
        bookId = bId;
        break;
      }
    }
  }

  if (!bookId) return;

  if (!communityCommentsMap.has(bookId)) {
    communityCommentsMap.set(bookId, []);
  }
  const list = communityCommentsMap.get(bookId);

  if (action === 'add') {
    if (!list.some(c => c.id === comment.id)) {
      list.push(comment);
      saveCommunityCommentsToStorage();
      updateBookCommentsUI(bookId);
    }
  } else if (action === 'delete') {
    const nextList = list.filter(c => c.id !== comment.id && c.parentId !== comment.id);
    communityCommentsMap.set(bookId, nextList);
    saveCommunityCommentsToStorage();
    updateBookCommentsUI(bookId);
  }
}

function getCommunityScrapsList() {
  // Collect all users' actually entered sentences & scraps across ALL books
  const allBooks = getAllCommunityBooks();
  const userScraps = [];

  // Map for fast lookup of covers and book ids by book title
  const bookByTitle = new Map();
  allBooks.forEach(b => {
    if (b.title) {
      bookByTitle.set(b.title.trim().toLowerCase(), b);
    }
  });

  // ONLY collect from "수집한 문장" (b.scraps)
  allBooks.forEach(b => {
    if (b.scraps && b.scraps.length) {
      const bTitleParts = splitBookTitle(b);
      const bMainTitle = bTitleParts.main || b.title;
      const bDateTimestamp = parseBookDateTimestamp(b.date);
      b.scraps.forEach(s => {
        if (!s.text || !s.text.trim()) return;
        if (s.memo && s.memo.includes('노션 완독책장')) return;
        if (s.text && (s.text.includes('blog.naver.com/zzine315') || s.text.includes('zzine315'))) return;
        const scrapTime = s.created_at || s.at || b.created_at || b.date;
        const rawTime = parseBookDateTimestamp(scrapTime);
        userScraps.push({
          id: 'us_' + (s.id || uid()),
          bookId: b.id,
          bookDateTimestamp: bDateTimestamp,
          bookDate: b.date || '',
          text: s.text,
          bookTitle: bMainTitle,
          author: b.author || '',
          cover: b.cover || '',
          page: s.page || null,
          memo: s.memo || '',
          tags: s.tags || s.keywords || [],
          likes: 0,
          rawTime: rawTime,
          time: formatTimeAgo(scrapTime),
          // 독서가 1인당 1닉네임 일치를 위한 소유자 정보 전달
          user_id: b.user_id,
          _source: b._source,
          _ownerId: b._ownerId || resolveCommunityBookOwner(b, b._source),
          nickname: b.nickname
        });
      });
    }
  });

  // 도서 완독일(bookDateTimestamp) 최신순(내림차순) 정렬!
  userScraps.sort((a, b) => {
    if (a.bookDateTimestamp > 0 && b.bookDateTimestamp === 0) return -1;
    if (a.bookDateTimestamp === 0 && b.bookDateTimestamp > 0) return 1;
    if (a.bookDateTimestamp !== b.bookDateTimestamp) {
      return b.bookDateTimestamp - a.bookDateTimestamp;
    }
    return (b.rawTime || 0) - (a.rawTime || 0);
  });

  // 더미 데이터 병합을 완전히 제거하고 실제 독서가의 문장만 반환
  return userScraps;
}

function renderCommunityScraps() {
  const container = document.getElementById('comm-scraps-stream');
  if (!container) return;

  const list = getCommunityScrapsList();
  const countEl = document.getElementById('comm-scraps-count');
  if (countEl) countEl.remove();

  if (!list || list.length === 0) {
    container.innerHTML = `
      <div class="comm-empty-scraps" style="grid-column: 1 / -1; width: 100%; text-align: center; padding: 48px 16px; color: var(--text-sub); font-size: 14px; line-height: 1.6;">
        아직 등록된 이웃 독서가의 문장이 없습니다.<br>책을 읽고 마음에 와닿은 문장을 남겨보세요.
      </div>
    `;
    return;
  }

  let storedLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_likes');
    if (raw) storedLikes = JSON.parse(raw);
  } catch (e) {}

  const myId = getClientLikeId();

  const renderCard = (s, idx) => {
    const sid = String(s.id);
    const remoteSet = communityLikesMap.get(sid) || new Set();
    const isLiked = (currentUser && remoteSet.has(currentUser.id)) || remoteSet.has(myId) || !!storedLikes[sid];
    let currentLikes = remoteSet.size;
    if (isLiked && !remoteSet.has(myId) && (!currentUser || !remoteSet.has(currentUser.id))) {
      currentLikes += 1;
    }

    const tagsHtml = (s.tags && s.tags.length)
      ? `<div class="comm-scrap-tags">${s.tags.map(t => `<span class="comm-scrap-tag">#${esc(t)}</span>`).join('')}</div>`
      : '';

    const titleParts = splitBookTitle(s.bookTitle || '');
    const mainTitle = titleParts.main || s.bookTitle || '';

    let coverUrl = s.cover ? getSafeImageUrl(s.cover) : '';
    if (!coverUrl) {
      const normalize = (t) => (t || '').replace(/[\s\-_:：·,，\(\)]/g, '').toLowerCase();
      const normTitle = normalize(mainTitle);
      const coverBook = [...(Array.isArray(remoteCommunityBooks) ? remoteCommunityBooks : []), ...(Array.isArray(books) ? books : [])]
        .find(b => (normTitle && normalize(b.title) === normTitle) || (b.id === s.bookId));
      if (coverBook && coverBook.cover) coverUrl = getSafeImageUrl(coverBook.cover);
    }
    const clickDetail = s.bookId ? `${communityEventAttrs('showDetail', [s.bookId], 'onclick')}` : '';
    const coverHtml = coverUrl
      ? `<img class="comm-scrap-cover" src="${esc(coverUrl)}" alt="${esc(mainTitle)}" referrerpolicy="no-referrer" decoding="async" ${clickDetail} onerror="handleCommCoverError(this)">`
      : `<div class="comm-scrap-cover-placeholder" ${clickDetail}>8ook</div>`;

    const ownerInfo = getCommunityItemOwnerNickname(s, s._source);
    const ownerNick = ownerInfo.nickname;
    const isMe = ownerInfo.isMe;

    return `
      <div class="comm-scrap-card" id="csc-${esc(sid)}" style="order:${idx};">
        <div class="comm-scrap-header">
          ${coverHtml}
          <div class="comm-scrap-meta">
            <div class="comm-scrap-user-bar">
              <span class="comm-scrap-owner-wrap" ${communityEventAttrs('openUserProfileCard', [ownerNick, s.user_id || s._ownerId || ''], 'onclick')} style="cursor: pointer;" title="${esc(ownerNick)}님의 프로필 보기"><span class="comm-user-at">@</span><span class="comm-user-name">${esc(ownerNick)}</span>${isMe ? '<span class="comm-my-badge">나</span>' : ''}</span>
              ${s.bookDate ? `<span class="comm-scrap-time" title="도서 완독일: ${esc(fmtDate(s.bookDate))}">• 완독 ${esc(fmtDate(s.bookDate))}</span>` : (s.time ? `<span class="comm-scrap-time">• ${esc(s.time)}</span>` : '')}
            </div>
            <div class="comm-scrap-title" ${clickDetail}>${esc(mainTitle)}</div>
            <div class="comm-scrap-sub">
              <span class="comm-scrap-author">${esc(s.author || '저자 미상')}</span>
              ${s.page ? `<span class="comm-scrap-page">• p.${esc(s.page)}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="comm-scrap-text">${esc(s.text || '')}</div>
        ${s.memo ? `<div class="comm-scrap-memo-wrap"><div class="comm-scrap-memo">${esc(s.memo)}</div></div>` : ''}

        <div class="comm-scrap-footer">
          <div class="comm-scrap-tags">
            ${tagsHtml}
          </div>
          <div class="comm-scrap-actions">
            <button class="comm-scrap-btn" ${communityEventAttrs('copyCommunityQuote', [s.text || '', mainTitle || '', s.author || '', s.page || ''], 'onclick')} title="문장 복사">
              복사
            </button>
            <button type="button" class="comm-scrap-like-btn${isLiked ? ' liked' : ''}" data-target-id="${esc(sid)}" ${communityEventAttrs('toggleCommunityLike', [sid], 'onclick')} title="좋아요">
              <span class="comm-heart-icon">♥</span> <span class="like-count">${currentLikes}</span>
            </button>
          </div>
        </div>
      </div>
    `;
  };

  if (list.length <= 1) {
    container.innerHTML = list.map((s, idx) => renderCard(s, idx)).join('');
  } else {
    container.innerHTML = `
      <div class="comm-scraps-col" data-col="0"></div>
      <div class="comm-scraps-col" data-col="1"></div>
    `;
    const colEls = container.querySelectorAll('.comm-scraps-col');
    const colHeights = [0, 0];

    // 문장 길이 편차에 따라 세로 갯수가 아닌 y값(누적 높이)이 낮은 열에 순차 배치!
    list.forEach((s, idx) => {
      const cardHtml = renderCard(s, idx);
      const target = getShortestColumn(colEls, colHeights);
      if (target && target.col) {
        target.col.insertAdjacentHTML('beforeend', cardHtml);
        const estH = 150 + Math.ceil(String(s.text || '').length / 28) * 22 + (s.memo ? Math.ceil(String(s.memo).length / 28) * 18 : 0);
        colHeights[target.index] = Math.max(target.col.offsetHeight || 0, colHeights[target.index] + estH);
      }
    });
  }
}

function copyCommunityQuote(text, bookTitle, author, page) {
  let formatted = `“${text}”\n— 《${bookTitle}》`;
  if (author) formatted += `, ${author}`;
  if (page) formatted += ` (p.${page})`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(formatted).then(() => {
      toast('문장이 클립보드에 복사되었습니다.');
    }).catch(() => {
      fallbackCopyText(formatted, '문장이 클립보드에 복사되었습니다.');
    });
  } else {
    fallbackCopyText(formatted, '문장이 클립보드에 복사되었습니다.');
  }
}

async function toggleCommunityLike(id, btnEl, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const strId = String(id);
  let storedLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_likes');
    if (raw) storedLikes = JSON.parse(raw);
  } catch (e) {}

  const myId = getClientLikeId();
  if (!communityLikesMap.has(strId)) {
    communityLikesMap.set(strId, new Set());
  }
  const remoteSet = communityLikesMap.get(strId);

  const wasLiked = (currentUser && remoteSet.has(currentUser.id)) || remoteSet.has(myId) || !!storedLikes[strId];
  const willBeLiked = !wasLiked;

  // 1. Update local cache
  if (willBeLiked) {
    storedLikes[strId] = true;
    remoteSet.add(myId);
    if (currentUser) remoteSet.add(currentUser.id);
  } else {
    delete storedLikes[strId];
    remoteSet.delete(myId);
    if (currentUser) remoteSet.delete(currentUser.id);
  }
  try {
    localStorage.setItem('rj_community_likes', JSON.stringify(storedLikes));
  } catch (e) {}

  // 2. Immediate UI update
  btnEl.classList.toggle('liked', willBeLiked);
  const countSpan = btnEl.querySelector('.like-count');
  if (countSpan) {
    countSpan.textContent = String(remoteSet.size);
  }
  if (willBeLiked) {
    toast('문장에 좋아요를 남겼습니다 ♥');
  } else {
    toast('문장 좋아요를 취소했습니다.');
  }

  // 3. Broadcast
  broadcastLikeUpdate(strId, currentUser?.id || myId, willBeLiked);

  // 4. Supabase sync if logged in
  if (currentUser && supabaseClient) {
    const safeUId = currentUser.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeTargetId = strId.replace(/[^a-zA-Z0-9_-]/g, '');
    const likeRowId = 'like_' + safeUId + '_' + safeTargetId;

    try {
      if (willBeLiked) {
        const { error } = await supabaseClient.from('books').upsert({
          id: likeRowId,
          user_id: currentUser.id,
          title: '__like__',
          author: strId,
          is_public: true,
          created_at: new Date().toISOString()
        }, { onConflict: 'id' });
        if (error) console.warn('[Like Sync] Scrap upsert error:', error);
      } else {
        const { error } = await supabaseClient.from('books').delete().eq('id', likeRowId).eq('user_id', currentUser.id);
        if (error) console.warn('[Like Sync] Scrap delete error:', error);
      }
    } catch (err) {
      console.warn('[Like Sync] Supabase error:', err);
    }
  } else if (willBeLiked) {
    setTimeout(() => {
      if (!currentUser) {
        toast('로그인하시면 다른 기기에서도 좋아요가 영구 보존됩니다.');
      }
    }, 1200);
  }
}
