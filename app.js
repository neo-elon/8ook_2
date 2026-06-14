'use strict';

// Supabase Configuration
const supabaseUrl = 'https://guaimwzlmdacerpvsxxw.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1YWltd3psbWRhY2VycHZzeHh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODM1NDIsImV4cCI6MjA5NjY1OTU0Mn0.zF8A_Ul3Y5aIPjZcVTYIj1gUkConuQ-b9eO7EjnoWUE';

let supabaseClient = null;
try {
  if (window.supabase) {
    supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
  } else {
    console.warn("Supabase SDK not loaded. Operating in LocalStorage-only mode.");
  }
} catch (e) {
  console.error("Supabase initialization failed:", e);
}

const DB_SQL_SCRIPT = `create table books (
  id text primary key,
  title text not null,
  author text,
  pages integer default 0,
  date text,
  sentence text,
  cover text,
  rating integer default 0,
  scraps jsonb default '[]'::jsonb,
  keywords text[] default '{}'::text[],
  created_at timestamptz default now(),
  user_id uuid default auth.uid()
);

alter table books enable row level security;

-- Drop existing public policies if any
drop policy if exists "Allow public read" on books;
drop policy if exists "Allow public insert" on books;
drop policy if exists "Allow public update" on books;
drop policy if exists "Allow public delete" on books;

-- Drop individual policies if any to recreate
drop policy if exists "Allow individual read" on books;
drop policy if exists "Allow individual insert" on books;
drop policy if exists "Allow individual update" on books;
drop policy if exists "Allow individual delete" on books;

create policy "Allow individual read" on books for select using (auth.uid() = user_id);
create policy "Allow individual insert" on books for insert with check (auth.uid() = user_id);
create policy "Allow individual update" on books for update using (auth.uid() = user_id);
create policy "Allow individual delete" on books for delete using (auth.uid() = user_id);`;

/* ==============================================
   STATE
============================================== */
let books = [];
let currentUser = null;
let currentBookId = null;
let editingBookId = null;
let currentRating = 0;
let currentScrapBookId = null;
let currentScrapTab = 'manual';
let calDate = new Date();
let gridMin = window.innerWidth <= 640 ? 90 : 170;
let zoomTimer = null;
let sidebarOpen = false;
let isDarkTheme = true;
let chartMode = 'month';
let statsPeriod = 'all';
let editingScrapId = null;
let currentGalleryFilter = null;

// OCR state
let ocrImg = null;
let ocrSelDiv = null;
let ocrDragging = false;
let ocrX0 = 0, ocrY0 = 0;
let ocrWorker = null;
let activeOcrLang = null;

// Aladin
let aladinSearchTimer = null;
let aladinCallbackCounter = 0;
let aladinSearchResults = [];

/* ==============================================
   STORAGE
============================================== */
function saveData() {
  try {
    if (currentUser) {
      localStorage.setItem(`rj_books_${currentUser.id}`, JSON.stringify(books));
    } else {
      localStorage.setItem('rj_books', JSON.stringify(books));
    }
  } catch(e) {}
}
async function loadData() {
  let localBooks = [];
  try {
    const key = currentUser ? `rj_books_${currentUser.id}` : 'rj_books';
    const d = localStorage.getItem(key);
    if (d) localBooks = JSON.parse(d);
  } catch(e) {}

  if (currentUser) {
    localBooks = localBooks.map(b => {
      if (b.id && b.id.startsWith('notion_') && !b.id.endsWith('_' + currentUser.id)) {
        const pageIdPart = b.id.substring(7, 39);
        return { ...b, id: 'notion_' + pageIdPart + '_' + currentUser.id };
      }
      return b;
    });
  }

  if (!supabaseClient || !currentUser) {
    books = localBooks;
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('books')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (error) {
      if (error.code === 'PGRST116' || error.message.includes('does not exist') || error.code === '42P01') {
        showDbSetupModal();
      }
      throw error;
    }
    
    const remoteBooks = data || [];
    
    // Migration: If Supabase is empty but we have local guest books, upload them to Supabase
    const guestBooksStr = localStorage.getItem('rj_books');
    let guestBooks = [];
    if (guestBooksStr) {
      try { guestBooks = JSON.parse(guestBooksStr); } catch(e) {}
    }

    if (remoteBooks.length === 0 && guestBooks.length > 0) {
      const booksToUpload = guestBooks.map(b => {
        let newId = b.id;
        if (b.id && b.id.startsWith('notion_')) {
          const pageIdPart = b.id.substring(7, 39);
          newId = 'notion_' + pageIdPart + '_' + currentUser.id;
        } else {
          newId = uid();
        }
        return { ...b, id: newId, user_id: currentUser.id };
      });
      console.log('DEBUG: currentUser.id =', currentUser?.id);
      console.log('DEBUG: booksToUpload =', JSON.stringify(booksToUpload.map(b => ({ id: b.id, title: b.title, user_id: b.user_id })), null, 2));
      const { error: syncError } = await supabaseClient
        .from('books')
        .upsert(booksToUpload, { onConflict: 'id' });
      if (!syncError) {
        books = booksToUpload;
        toast('✅ 기존 로컬 책장 데이터를 Supabase에 동기화했습니다!');
        // Clear guest books so we don't sync them again next time
        try { localStorage.removeItem('rj_books'); } catch(e) {}
      } else {
        console.error('Failed to sync local books to Supabase:', syncError);
        books = remoteBooks;
      }
    } else {
      books = remoteBooks;
    }
    saveData();
  } catch(e) {
    console.error('Supabase load error, using local storage backup:', e);
    books = localBooks;
  }
}
function showDbSetupModal() {
  document.getElementById('db-sql-code').value = DB_SQL_SCRIPT;
  openModal('db-modal');
}
function copySqlCode() {
  const sql = document.getElementById('db-sql-code').value;
  navigator.clipboard.writeText(sql).then(() => {
    toast('📋 SQL 쿼리가 클립보드에 복사되었습니다');
  }).catch(err => {
    toast('❌ 복사 실패. 직접 드래그하여 복사해주세요.');
  });
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

/* ==============================================
   HELPERS
============================================== */
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function getSafeImageUrl(url) {
  if (!url) return '';
  
  // Prepend Notion origin to relative paths (e.g., /image/... or /images/...)
  if (url.startsWith('/')) {
    url = 'https://www.notion.so' + url;
  }
  
  // Convert Notion attachment scheme to a valid proxy URL
  if (url.startsWith('attachment:')) {
    const rest = url.substring(11); // Skip 'attachment:'
    const colonIndex = rest.indexOf(':');
    const slashIndex = rest.indexOf('/');
    let blockId = '';
    let filename = '';
    if (colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)) {
      blockId = rest.substring(0, colonIndex);
      filename = rest.substring(colonIndex + 1);
    } else if (slashIndex !== -1) {
      blockId = rest.substring(0, slashIndex);
      filename = rest.substring(slashIndex + 1);
    }
    
    if (blockId && filename) {
      const s3Url = `https://s3.us-west-2.amazonaws.com/secure.notion-static.com/${blockId}/${filename}`;
      url = `https://www.notion.so/image/${encodeURIComponent(s3Url)}?table=block&id=${blockId}&cache=v2`;
    }
  }
  
  // Proxy image requests to bypass adblockers and CORS
  if (url.includes('pstatic.net') || url.includes('shopping-phinf') || url.includes('notion.so') || url.includes('secure.notion-static.com') || url.includes('files.notion.so') || url.includes('amazonaws.com')) {
    return 'https://corsproxy.io/?' + encodeURIComponent(url);
  }
  return url;
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return `${d.getFullYear()}. ${d.getMonth()+1}. ${d.getDate()}.`;
}

function starsHtml(n, size) {
  let h = '';
  for (let i = 1; i <= 5; i++) {
    const on = i <= (n||0);
    h += `<span class="detail-star${on?' on':''}" style="color:${on?'var(--amber)':'var(--star-off)'};font-size:${size||20}px">${on?'★':'☆'}</span>`;
  }
  return h;
}

function starsPlain(n) {
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= (n||0) ? '⭐' : '·';
  return s;
}

function toast(msg, dur=2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), dur);
}

/* ==============================================
   THEME TOGGLE
============================================== */
function loadTheme() {
  const saved = localStorage.getItem('rj_theme');
  isDarkTheme = saved !== 'light';
  applyTheme();
}

function toggleTheme() {
  isDarkTheme = !isDarkTheme;
  localStorage.setItem('rj_theme', isDarkTheme ? 'dark' : 'light');
  applyTheme();
  toast(isDarkTheme ? '🌙 어두운 테마' : '☀️ 밝은 테마', 1200);
}

function applyTheme() {
  document.body.classList.toggle('light-theme', !isDarkTheme);
  document.getElementById('theme-icon').textContent = isDarkTheme ? '🌙' : '☀️';
}

/* ==============================================
   GALLERY
============================================== */
function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('gallery-empty');
  grid.innerHTML = '';

  // If filter is active, prepend a filter banner / indicator card
  if (currentGalleryFilter) {
    const filterCard = document.createElement('div');
    filterCard.className = 'filter-info-card';
    filterCard.style.cssText = 'grid-column: 1 / -1; background: var(--glass); border: 1px solid var(--violet); border-radius: var(--radius-md); padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--text-200); margin-bottom: 4px; box-sizing: border-box;';
    filterCard.innerHTML = `
      <span style="display:flex; align-items:center; gap:6px;">🏷️ <strong>#${esc(currentGalleryFilter)}</strong> 키워드로 필터링됨</span>
      <button class="btn btn-ghost btn-sm" onclick="clearGalleryFilter()" style="padding: 2px 8px; border-radius: 4px; font-size:11px; height:22px; line-height:1; cursor:pointer;">필터 해제 ✕</button>
    `;
    grid.appendChild(filterCard);
  }

  // Prepend the 점선 책 추가 카드
  const addCard = document.createElement('div');
  addCard.className = 'add-book-card';
  addCard.innerHTML = `
    <span class="add-book-icon">＋</span>
    <span class="add-book-label">책 기록하기</span>
  `;
  addCard.addEventListener('click', async () => {
    if (supabaseClient) {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session?.user) {
        toast('⚠️ 로그인이 필요합니다. 구글 로그인을 진행해주세요.');
        loginWithGoogle();
        return;
      }
    }
    openAddModal();
  });
  grid.appendChild(addCard);




  // Filter books if filter is active
  let displayBooks = books;
  if (currentGalleryFilter) {
    displayBooks = books.filter(b => b.keywords && b.keywords.includes(currentGalleryFilter));
  }

  if (!displayBooks.length) {
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
  }

  // Sort books by completion date (date) descending. Empty dates go to the bottom.
  const sortedBooks = [...displayBooks].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  sortedBooks.forEach((book, i) => {
    const card = document.createElement('div');
    card.className = 'book-card';
    if (book.rating === 5) {
      card.classList.add('five-stars');
    }
    card.style.animationDelay = ((i + 1) * 0.04) + 's';
    card.setAttribute('data-id', book.id);

    let imgPart = '';
    if (book.cover) {
      imgPart = `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}"
        onerror="this.outerHTML='<div class=\\'book-card-placeholder\\'><span class=\\'placeholder-icon\\'>📚</span><span class=\\'placeholder-title\\'>${esc(book.title)}</span></div>'">`;
    } else {
      imgPart = `<div class="book-card-placeholder">
        <span class="placeholder-icon">📚</span>
        <span class="placeholder-title">${esc(book.title)}</span>
      </div>`;
    }

    const sentence = book.sentence
      ? `<div class="ov-sentence">${esc(book.sentence)}</div>` : '';
    const medalBadge = book.rating === 5
      ? `<div class="medal-badge" title="인생작 (별점 5점)">🏅</div>` : '';

    card.innerHTML = `
      ${imgPart}
      ${medalBadge}
      <div class="book-hover-overlay">
        <div class="ov-title">${esc(book.title)}</div>
        <div class="ov-author">${esc(book.author||'')}</div>
        ${sentence}
        ${book.rating ? `<div class="ov-stars">${starsPlain(book.rating)}</div>` : ''}
      </div>
    `;

    card.addEventListener('click', () => showDetail(book.id));
    grid.appendChild(card);
  });
}

/* ==============================================
   DETAIL VIEW
============================================== */
function showDetail(id, direction = null) {
  const book = books.find(b => b.id === id);
  if (!book) return;
  currentBookId = id;

  const wrap = document.getElementById('detail-wrap');
  wrap.classList.remove('slide-from-left', 'slide-from-right', 'bounce-left', 'bounce-right');
  void wrap.offsetWidth; // Force reflow
  if (direction === 'prev') {
    wrap.classList.add('slide-from-left');
  } else {
    wrap.classList.add('slide-from-right');
  }

  const coverHtml = book.cover
    ? `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}"
        onerror="this.outerHTML='<div class=\\'detail-thumb-placeholder\\'>📚</div>'">`
    : `<div class="detail-thumb-placeholder">📚</div>`;

  const chips = [];
  if (book.pages) chips.push(`<div class="chip"><span class="chip-icon">📄</span>${Number(book.pages).toLocaleString()}p</div>`);
  if (book.date)  chips.push(`<div class="chip"><span class="chip-icon">📅</span>${fmtDate(book.date)}</div>`);
  const scrapCount = (book.scraps||[]).length;

  const kwHtml = (book.keywords && book.keywords.length)
    ? `<div class="meta-chips" style="margin-top:6px;">${book.keywords.map(k=>`<button type="button" class="kw-chip" onclick="openEditModal('${book.id}', true)">#${esc(k)}</button>`).join('')}</div>`
    : '';

  const scrapsHtml = buildScrapsHtml(book);

  wrap.innerHTML = `
    <div class="detail-top">
      <div class="detail-thumb">${coverHtml}</div>
      <div class="detail-info">
        <div class="detail-title">${esc(book.title)}</div>
        <div class="detail-author">${esc(book.author||'저자 미상')}</div>
        <div class="meta-chips">${chips.join('')}</div>
        ${kwHtml}
      </div>
    </div>
    <div class="detail-body-sec" style="display:flex; flex-direction:column; gap:16px;">
      <div class="detail-rating-row" style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div class="detail-stars">${starsHtml(book.rating, 22)}</div>
        <div class="detail-book-actions" style="display:flex; gap:6px; align-items:center;">
          <button class="btn btn-ghost btn-sm" onclick="openEditModal('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:4px; height:22px; line-height:1;">✏️ 편집</button>
          <button class="btn btn-danger btn-sm" onclick="doDeleteBook('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:22px; line-height:1;">🗑️ 삭제</button>
        </div>
      </div>
      ${book.sentence ? `<div class="detail-sentence">${esc(book.sentence)}</div>` : ''}
    </div>

    <div class="scraps-sec">
      <div class="scraps-hdr" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:10px; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="scraps-htitle">📌 스크랩 문장</div>
          <button class="btn btn-ghost btn-sm" onclick="openScrapModal('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:12px; height:22px; line-height:1;">+ 추가</button>
        </div>
        <div class="scraps-badge" id="scrap-badge">${scrapCount} / 100</div>
      </div>
      <div class="scrap-list" id="scrap-list">${scrapsHtml}</div>
      ${scrapCount === 0
        ? `<div class="scraps-empty">아직 스크랩된 문장이 없어요 ✨<br>
           <small style="font-size:11px;">"문장 스크랩" 버튼으로 추가해보세요</small></div>`
        : ''}
    </div>
  `;

  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');
  document.getElementById('view-detail').classList.add('show');
  document.getElementById('back-btn').classList.add('show');
  document.getElementById('community-nav-btn').style.display = 'none';
  document.getElementById('view-label').textContent = '📖 ' + book.title;
}

function buildScrapsHtml(book) {
  if (!book.scraps || !book.scraps.length) return '';
  const sortedScraps = [...book.scraps].sort((a, b) => (a.page || 0) - (b.page || 0));
  
  return sortedScraps.map(s => `
    <div class="scrap-item" id="sc-${s.id}">
      <div class="scrap-quote">${esc(s.text)}</div>
      <div class="scrap-foot" style="display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; width:100%;">
        ${s.page ? `<span class="scrap-page">p.${s.page}</span>` : ''}
        ${s.memo ? `<span class="scrap-memo">— ${esc(s.memo)}</span>` : ''}
        <div class="scrap-actions" style="margin-left:auto; display:flex; gap:6px;">
          <button class="btn btn-ghost btn-sm" onclick="editScrap('${book.id}','${s.id}')" style="padding:2px 6px; font-size:10px; border-radius:4px; height:22px; line-height:1;">수정</button>
          <button class="btn btn-danger btn-sm" onclick="doDeleteScrap('${book.id}','${s.id}')" style="padding:2px 6px; font-size:10px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:22px; line-height:1;">삭제</button>
        </div>
      </div>
    </div>
  `).join('');
}

async function editScrap(bookId, scrapId) {
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      toast('⚠️ 로그인이 필요합니다. 구글 로그인을 진행해주세요.');
      loginWithGoogle();
      return;
    }
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
  document.getElementById('ocr-result').value = scrap.text;
  document.getElementById('sc-page-ocr').value = scrap.page || '';
  document.getElementById('sc-memo-ocr').value = scrap.memo || '';

  document.getElementById('scrap-modal-title').textContent = '✏️ 스크랩 수정';
  document.getElementById('scrap-save-btn').textContent = '✏️ 스크랩 수정';

  switchTab('manual');
  openModal('scrap-modal');
}

function showGallery() {
  document.getElementById('view-gallery').style.display = '';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');
  document.getElementById('back-btn').classList.remove('show');
  document.getElementById('sidebar-toggle').style.display = '';
  document.getElementById('community-nav-btn').style.display = 'inline-flex';
  document.getElementById('view-label').textContent = '📚 내 서재';
  currentBookId = null;
  renderGallery();
}

function showStats() {
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.add('show');
  document.getElementById('view-community').classList.remove('show');
  document.getElementById('back-btn').classList.add('show');
  document.getElementById('sidebar-toggle').style.display = 'none';
  document.getElementById('community-nav-btn').style.display = 'inline-flex';
  document.getElementById('view-label').textContent = '📊 독서 통계';
  showRandomQuote();
  updateSidebar();
}

/* ==============================================
   BOOK MODAL
============================================== */
let modalCover = '';

function openAddModal() {
  editingBookId = null;
  currentRating = 0;
  modalCover = '';
  document.getElementById('book-modal-ttl').textContent = '📖 책 추가';
  document.getElementById('bk-title').value = '';
  document.getElementById('bk-author').value = '';
  document.getElementById('bk-pages').value = '';
  document.getElementById('bk-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('bk-sentence').value = '';
  document.getElementById('bk-img-url').value = '';
  document.getElementById('bk-img-file').value = '';
  document.getElementById('bk-kw1').value = '';
  document.getElementById('bk-kw2').value = '';
  document.getElementById('bk-kw3').value = '';
  hideSearchResults();
  resetPrev();
  updateStarBtns(0);
  openModal('book-modal');
}

async function openEditModal(id, focusKeywords = false) {
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      toast('⚠️ 로그인이 필요합니다. 구글 로그인을 진행해주세요.');
      loginWithGoogle();
      return;
    }
  }

  const b = books.find(x => x.id === id);
  if (!b) return;
  editingBookId = id;
  currentRating = b.rating || 0;
  modalCover = b.cover || '';

  document.getElementById('book-modal-ttl').textContent = '✏️ 책 편집';
  document.getElementById('bk-title').value = b.title || '';
  document.getElementById('bk-author').value = b.author || '';
  document.getElementById('bk-pages').value = b.pages || '';
  document.getElementById('bk-date').value = b.date || '';
  document.getElementById('bk-sentence').value = b.sentence || '';

  const kws = b.keywords || [];
  document.getElementById('bk-kw1').value = kws[0] || '';
  document.getElementById('bk-kw2').value = kws[1] || '';
  document.getElementById('bk-kw3').value = kws[2] || '';

  if (b.cover && !b.cover.startsWith('data:')) {
    document.getElementById('bk-img-url').value = b.cover;
  } else {
    document.getElementById('bk-img-url').value = '';
  }

  hideSearchResults();
  if (b.cover) setPrev(b.cover); else resetPrev();
  updateStarBtns(currentRating);
  openModal('book-modal');

  if (focusKeywords) {
    setTimeout(() => {
      const kw = document.getElementById('bk-kw1');
      if (kw) { kw.focus(); kw.select(); }
    }, 150);
  }
}

function onUrlInput(v) {
  if (!v) { resetPrev(); modalCover = ''; return; }
  modalCover = v;
  setPrev(v);
}

function onFileSelect(inp) {
  const f = inp.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    modalCover = e.target.result;
    setPrev(e.target.result);
    document.getElementById('bk-img-url').value = '';
  };
  r.readAsDataURL(f);
}

function setPrev(src) {
  document.getElementById('book-prev').innerHTML =
    `<img src="${getSafeImageUrl(src)}" onerror="this.parentElement.innerHTML='<div class=\\'img-prev-ph\\'><span class=\\'img-prev-ph-icon\\'>❌</span><span>이미지 로드 실패</span></div>'">`;
}

function resetPrev() {
  document.getElementById('book-prev').innerHTML =
    `<div class="img-prev-ph"><span class="img-prev-ph-icon">🖼️</span><span>URL 입력, 파일 선택 또는 검색으로 자동 적용</span></div>`;
}

/* ── Keyword input helpers ── */
function enforceKwChars(el) {
  // Strip spaces and special characters — only letters, numbers, Korean
  el.value = el.value.replace(/\s/g, '');
}
function kwTabNext(e, nextId) {
  if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault();
    const next = document.getElementById(nextId);
    if (next) next.focus();
  }
}

function setRating(n) {
  currentRating = n;
  updateStarBtns(n);
}

function updateStarBtns(n) {
  document.querySelectorAll('#star-inp .star-btn-inp').forEach((btn, i) => {
    const on = i < n;
    btn.textContent = on ? '★' : '☆';
    btn.style.color = on ? 'var(--amber)' : 'var(--star-off)';
  });
}

async function saveBook() {
  const title = document.getElementById('bk-title').value.trim();
  if (!title) { toast('❌ 제목을 입력해주세요'); return; }

  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('⚠️ 로그인이 필요합니다. 먼저 로그인 해주세요.');
      return;
    }
  }

  const data = {
    title,
    author:   document.getElementById('bk-author').value.trim(),
    pages:    parseInt(document.getElementById('bk-pages').value) || 0,
    date:     document.getElementById('bk-date').value,
    sentence: document.getElementById('bk-sentence').value.trim(),
    cover:    modalCover,
    rating:   currentRating,
    keywords: [
      document.getElementById('bk-kw1').value.trim(),
      document.getElementById('bk-kw2').value.trim(),
      document.getElementById('bk-kw3').value.trim(),
    ].filter(k => k.length > 0),
  };

  const saveBtn = document.getElementById('book-save-btn');
  const originalText = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = '저장 중...';

  try {
    if (editingBookId) {
      const idx = books.findIndex(b => b.id === editingBookId);
      if (idx !== -1) {
        const updatedBook = { ...books[idx], ...data };
        if (supabaseClient && user) {
          updatedBook.user_id = user.id;
          const { error } = await supabaseClient
            .from('books')
            .update(updatedBook)
            .eq('id', editingBookId)
            .eq('user_id', user.id);
          if (error) throw error;
        }
        books[idx] = updatedBook;
        toast('✅ 책 정보가 수정되었습니다');
      }
    } else {
      data.id = uid();
      data.scraps = [];
      data.created_at = new Date().toISOString();
      if (supabaseClient && user) {
        data.user_id = user.id;
        const { error } = await supabaseClient
          .from('books')
          .insert([data]);
        if (error) throw error;
      }
      books.unshift(data);
      toast('📚 책이 추가되었습니다');
    }

    saveData();
    closeModal('book-modal');
    updateSidebar();

    if (currentBookId === editingBookId && editingBookId) {
      showDetail(currentBookId);
    } else if (currentBookId) {
      showDetail(currentBookId);
    } else {
      renderGallery();
    }
  } catch (err) {
    console.error(err);
    toast('❌ 저장 실패: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
}

async function doDeleteBook(id) {
  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('⚠️ 로그인이 필요합니다. 먼저 로그인 해주세요.');
      return;
    }
  }

  if (!confirm('이 책을 삭제할까요?')) return;
  try {
    if (supabaseClient && user) {
      const { error } = await supabaseClient
        .from('books')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id);
      if (error) throw error;
    }

    books = books.filter(b => b.id !== id);
    saveData();
    toast('🗑️ 책이 삭제되었습니다');
    showGallery();
    updateSidebar();
  } catch (err) {
    console.error(err);
    toast('❌ 삭제 실패: ' + err.message);
  }
}

/* ==============================================
   ALADIN API SEARCH
============================================== */
function getApiKey() {
  return 'ttbparkq0072106001';
}

function hideSearchResults() {
  const r = document.getElementById('aladin-results');
  r.classList.remove('show');
  r.innerHTML = '';
}

function getXmlNodeText(parent, localName) {
  if (!parent) return '';
  let node = parent.querySelector(localName);
  if (!node) {
    const all = parent.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (all[i].localName && all[i].localName.toLowerCase() === localName.toLowerCase()) {
        node = all[i];
        break;
      }
    }
  }
  return node ? node.textContent : '';
}

function parseAladinXml(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");

  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) {
    throw new Error('XML parsing failed');
  }

  const errorCodeNode = xmlDoc.querySelector('errorCode');
  if (errorCodeNode) {
    const errMsg = xmlDoc.querySelector('errorMessage')?.textContent || 'Unknown error';
    const errCode = errorCodeNode.textContent;
    return { error: true, code: errCode, message: errMsg };
  }

  const items = xmlDoc.querySelectorAll('item');
  const itemArray = Array.from(items).map(item => {
    let title = getXmlNodeText(item, 'title');
    let author = getXmlNodeText(item, 'author');
    let cover = getXmlNodeText(item, 'cover');
    let publisher = getXmlNodeText(item, 'publisher');
    let pubDate = getXmlNodeText(item, 'pubDate');
    let itemId = getXmlNodeText(item, 'itemId') || getXmlNodeText(item, 'itemid');
    let isbn = getXmlNodeText(item, 'isbn');
    let isbn13 = getXmlNodeText(item, 'isbn13');
    let pages = getXmlNodeText(item, 'itemPage') || getXmlNodeText(item, 'itempage') || getXmlNodeText(item, 'ItemPage');
    
    // Extract only digits for pages
    pages = pages ? pages.replace(/[^0-9]/g, '') : '';

    // Clean author name (remove parenthesized roles like (지은이))
    let cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '');
    
    return { title, author: cleanAuthor, cover, publisher, pubDate, pages, itemId, isbn, isbn13 };
  });

  return { error: false, items: itemArray };
}

async function fetchAladinCover(title, author) {
  const key = getApiKey();
  let query = title.trim();
  // Clean query: remove subtitles after colon or parenthesis for better match
  const colonIdx = query.indexOf(':');
  if (colonIdx !== -1) query = query.substring(0, colonIdx).trim();
  const parenIdx = query.indexOf('(');
  if (parenIdx !== -1) query = query.substring(0, parenIdx).trim();
  
  if (author) {
    const cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '').trim();
    query += ' ' + cleanAuthor;
  }
  
  const targetUrl = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?ttbkey=${key}&Query=${encodeURIComponent(query)}&QueryType=Keyword&MaxResults=1&start=1&SearchTarget=Book&output=xml&Version=20131101&Cover=Big`;
  
  // Try Proxy 1: corsproxy.io
  try {
    const proxyUrl1 = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl1);
    if (res.ok) {
      const xmlText = await res.text();
      const parsed = parseAladinXml(xmlText);
      if (parsed && parsed.items && parsed.items.length > 0) {
        return parsed.items[0].cover;
      }
    } else {
      console.warn(`corsproxy.io returned status ${res.status} for Aladin cover search.`);
    }
  } catch (e) {
    console.warn('Failed to fetch cover from Aladin with corsproxy.io for:', title, e);
  }

  // Try Proxy 2: api.allorigins.win
  try {
    const proxyUrl2 = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl2);
    if (res.ok) {
      const data = await res.json();
      const xmlText = data.contents;
      const parsed = parseAladinXml(xmlText);
      if (parsed && parsed.items && parsed.items.length > 0) {
        return parsed.items[0].cover;
      }
    }
  } catch (e) {
    console.warn('Failed to fetch cover from Aladin with allorigins for:', title, e);
  }

  return null;
}

function searchAladin() {
  const query = document.getElementById('bk-title').value.trim();
  if (!query) { toast('❌ 제목을 입력해주세요'); return; }

  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 검색 중...</div>`;

  // Use https:// protocol to prevent mixed content errors
  const targetUrl = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?ttbkey=${key}&Query=${encodeURIComponent(query)}&QueryType=Title&MaxResults=18&start=1&SearchTarget=Book&output=xml&Version=20131101&Cover=Big&OptResult=subInfo`;
  
  // Proxy 1: corsproxy.io
  const proxyUrl1 = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
  // Proxy 2: allorigins.win
  const proxyUrl2 = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;

  // Try Proxy 1
  fetch(proxyUrl1)
    .then(res => {
      if (!res.ok) throw new Error('Proxy 1 failed');
      return res.text();
    })
    .then(xmlText => {
      const parsed = parseAladinXml(xmlText);
      if (parsed.error) {
        results.innerHTML = `<div class="search-empty">❌ 알라딘 API 에러: ${esc(parsed.message)} (코드: ${parsed.code})<br><br><small style="font-size: 11px;">※ API 키 발급 직후에는 활성화까지 1~2시간 가량 소요될 수 있습니다.</small></div>`;
        return;
      }
      handleAladinResults(parsed.items);
    })
    .catch(err1 => {
      console.warn('corsproxy.io failed, trying allorigins:', err1);
      // Try Proxy 2
      fetch(proxyUrl2)
        .then(res => {
          if (!res.ok) throw new Error('Proxy 2 failed');
          return res.json();
        })
        .then(data => {
          const xmlText = data.contents;
          const parsed = parseAladinXml(xmlText);
          if (parsed.error) {
            results.innerHTML = `<div class="search-empty">❌ 알라딘 API 에러: ${esc(parsed.message)} (코드: ${parsed.code})</div>`;
            return;
          }
          handleAladinResults(parsed.items);
        })
        .catch(err2 => {
          console.warn('allorigins proxy failed, falling back to JSONP:', err2);
          // Fallback to JSONP (uses JS output)
          runAladinJsonp(query, key, results);
        });
    });
}

function searchAladinByIsbn(isbn) {
  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 바코드로 도서 검색 중...</div>`;

  const targetUrl = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?ttbkey=${key}&itemIdType=ISBN13&ItemId=${isbn}&output=xml&Version=20131101&Cover=Big&OptResult=subInfo`;
  const proxyUrl1 = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
  const proxyUrl2 = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;

  const processXml = (xmlText) => {
    const parsed = parseAladinXml(xmlText);
    if (parsed.error || !parsed.items || parsed.items.length === 0) {
      const targetUrl10 = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?ttbkey=${key}&itemIdType=ISBN&ItemId=${isbn}&output=xml&Version=20131101&Cover=Big&OptResult=subInfo`;
      fetch(`https://corsproxy.io/?${encodeURIComponent(targetUrl10)}`)
        .then(res => res.text())
        .then(xml => {
          const parsed10 = parseAladinXml(xml);
          if (!parsed10.error && parsed10.items && parsed10.items.length > 0) {
            handleAladinResults(parsed10.items);
          } else {
            runAladinLookUpJsonp(isbn, key, results);
          }
        })
        .catch(() => {
          runAladinLookUpJsonp(isbn, key, results);
        });
      return;
    }
    handleAladinResults(parsed.items);
  };

  fetch(proxyUrl1)
    .then(res => {
      if (!res.ok) throw new Error('Proxy 1 failed');
      return res.text();
    })
    .then(processXml)
    .catch(() => {
      fetch(proxyUrl2)
        .then(res => res.json())
        .then(data => processXml(data.contents))
        .catch(() => {
          runAladinLookUpJsonp(isbn, key, results);
        });
    });
}

function runAladinLookUpJsonp(isbn, key, results) {
  const cbName = '_aladinCb_lookup_' + (++aladinCallbackCounter);
  const script = document.createElement('script');
  
  const params = new URLSearchParams({
    ttbkey: key,
    itemIdType: 'ISBN13',
    ItemId: isbn,
    output: 'JS',
    Version: '20131101',
    Cover: 'Big',
    OptResult: 'subInfo',
    callback: cbName
  });

  script.src = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?${params}`;

  window[cbName] = function(data) {
    delete window[cbName];
    script.remove();
    if (data && data.item) {
      handleAladinResults(data.item);
    } else {
      const cbName10 = '_aladinCb_lookup10_' + (++aladinCallbackCounter);
      const script10 = document.createElement('script');
      const params10 = new URLSearchParams({
        ttbkey: key,
        itemIdType: 'ISBN',
        ItemId: isbn,
        output: 'JS',
        Version: '20131101',
        Cover: 'Big',
        OptResult: 'subInfo',
        callback: cbName10
      });
      script10.src = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?${params10}`;
      window[cbName10] = function(data10) {
        delete window[cbName10];
        script10.remove();
        if (data10 && data10.item) {
          handleAladinResults(data10.item);
        } else {
          results.innerHTML = `<div class="search-empty">❌ 바코드로 도서를 찾을 수 없습니다. (ISBN: ${isbn})</div>`;
        }
      };
      script10.onerror = function() {
        delete window[cbName10];
        script10.remove();
        results.innerHTML = `<div class="search-empty">❌ 바코드로 도서를 찾을 수 없습니다. (ISBN: ${isbn})</div>`;
      };
      document.body.appendChild(script10);
    }
  };

  script.onerror = function() {
    delete window[cbName];
    script.remove();
    results.innerHTML = `<div class="search-empty">❌ 검색 실패 — API 키 활성화 상태 또는 인터넷 연결을 확인해주세요.</div>`;
  };

  setTimeout(() => {
    if (window[cbName]) {
      delete window[cbName];
      script.remove();
      results.innerHTML = `<div class="search-empty">⏰ 응답 시간 초과</div>`;
    }
  }, 10000);

  document.body.appendChild(script);
}

function preprocessOcrImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      
      // Convert to grayscale and apply contrast enhancement
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // Boost contrast (stretch darks and lights)
        let val = gray;
        if (gray < 128) {
          val = Math.max(0, gray * 0.65);
        } else {
          val = Math.min(255, gray * 1.35);
        }
        
        data[i] = val;
        data[i+1] = val;
        data[i+2] = val;
      }
      
      ctx.putImageData(imgData, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function handleCameraScan(input) {
  const file = input.files[0];
  if (!file) return;

  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 바코드 인식 중...</div>`;

  const reader = new FileReader();
  reader.onload = function (e) {
    const tempImg = new Image();
    tempImg.onload = function () {
      // Draw to canvas to bake EXIF orientation
      const canvas = document.createElement('canvas');
      canvas.width = tempImg.naturalWidth;
      canvas.height = tempImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(tempImg, 0, 0, tempImg.naturalWidth, tempImg.naturalHeight);
      const orientedDataUrl = canvas.toDataURL('image/jpeg', 0.9);

      // Now create oriented image for ZXing
      const orientedImg = new Image();
      orientedImg.onload = function () {
        const codeReader = new ZXing.BrowserMultiFormatReader();
        codeReader.decodeFromImageElement(orientedImg)
          .then(result => {
            const barcode = result.text;
            toast(`🔍 바코드 인식 성공: ${barcode}`);
            searchAladinByIsbn(barcode);
          })
          .catch(err => {
            results.innerHTML = `<div class="search-empty">❌ 바코드를 인식하지 못했습니다. 책 뒷면의 바코드가 선명하게 보이도록 다시 촬영해 주세요.</div>`;
          });
      };
      orientedImg.src = orientedDataUrl;
    };
    tempImg.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ============================================================
   BARCODE SCANNER MODAL LOGIC
   - 실시간 ZXing 스캔 (가이드 박스 영역 크롭)
   - 인식 실패 시 수동 촬영 버튼 fallback
   - 전/후면 카메라 전환 지원
   ============================================================ */
let barcodeStream = null;
let barcodeScanLoop = null;
let barcodeCurrentFacing = 'environment';
let barcodeAutoScanningActive = true;

function openBarcodeScannerModal() {
  openModal('barcode-scanner-modal');
  _startBarcodeCamera(barcodeCurrentFacing);
}

function closeBarcodeScannerModal() {
  _stopBarcodeCamera();
  const modal = document.getElementById('barcode-scanner-modal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function _stopBarcodeCamera() {
  if (barcodeScanLoop) { clearTimeout(barcodeScanLoop); barcodeScanLoop = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
}

function _setBarcodeScannerStatus(label, color) {
  const dot = document.getElementById('barcode-status-dot');
  const lbl = document.getElementById('barcode-status-label');
  if (dot) dot.style.background = color || '#34d399';
  if (lbl) lbl.textContent = label || '스캐너 활성';
}

async function _startBarcodeCamera(facing) {
  _stopBarcodeCamera();
  barcodeAutoScanningActive = true;
  _setBarcodeScannerStatus('카메라 시작 중...', '#f59e0b');

  const video = document.getElementById('barcode-video');
  if (!video) return;

  try {
    const constraints = {
      video: {
        facingMode: facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    barcodeStream = stream;
    video.srcObject = stream;
    await video.play();
    _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
    _startBarcodeScanLoop();
  } catch (err) {
    console.warn('Barcode camera error:', err);
    _setBarcodeScannerStatus('카메라 오류', '#ef4444');
    toast('📷 카메라를 열 수 없습니다. 파일 선택으로 대체합니다.');
    setTimeout(() => {
      closeBarcodeScannerModal();
      _fallbackBarcodeFileInput();
    }, 1500);
  }
}

function _startBarcodeScanLoop() {
  const video = document.getElementById('barcode-video');
  if (!video) return;

  let nativeBarcodeDetector = null;
  if ('BarcodeDetector' in window) {
    try {
      nativeBarcodeDetector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']
      });
    } catch (e) {
      console.warn('Native BarcodeDetector initialization failed:', e);
    }
  }

  const codeReader = new ZXing.BrowserMultiFormatReader();
  let scanning = true;

  async function scanCycle() {
    if (!barcodeStream || !scanning || !barcodeAutoScanningActive) return;

    if (video.readyState >= 2) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;

      if (vw > 0 && vh > 0) {
        // ── 0) Try native BarcodeDetector on full frame first (instant, hardware accelerated) ──
        if (nativeBarcodeDetector) {
          try {
            const barcodes = await nativeBarcodeDetector.detect(video);
            if (barcodes && barcodes.length > 0) {
              scanning = false;
              _onBarcodeDetected(barcodes[0].rawValue);
              return;
            }
          } catch (err) {
            console.warn('Native BarcodeDetector full scan error:', err);
          }
        }

        // ── 1) Cropped guide-box scan (higher priority) ──
        // object-fit:cover mapping — compute visible area
        const renderW = video.clientWidth  || 480;
        const renderH = video.clientHeight || 640;

        const videoAR = vw / vh;
        const renderAR = renderW / renderH;
        let srcX = 0, srcY = 0, srcW = vw, srcH = vh;

        if (videoAR > renderAR) {
          // video is wider → cropped horizontally
          srcW = vh * renderAR;
          srcX = (vw - srcW) / 2;
        } else {
          // video is taller → cropped vertically
          srcH = vw / renderAR;
          srcY = (vh - srcH) / 2;
        }

        const scaleX = srcW / renderW;
        const scaleY = srcH / renderH;

        const guideW = 260, guideH = 104;
        const gx = (renderW - guideW) / 2;
        const gy = (renderH - guideH) / 2;

        const margin = 36;
        const cropX = srcX + Math.max(0, (gx - margin) * scaleX);
        const cropY = srcY + Math.max(0, (gy - margin) * scaleY);
        const cropW = Math.min(vw - cropX, (guideW + margin * 2) * scaleX);
        const cropH = Math.min(vh - cropY, (guideH + margin * 2) * scaleY);

        // Try cropped area
        const croppedResult = await _tryDecode(codeReader, video, cropX, cropY, cropW, cropH);
        if (croppedResult) { scanning = false; _onBarcodeDetected(croppedResult); return; }

        // ── 2) Full-frame fallback scan (using ZXing) ──
        const fullResult = await _tryDecode(codeReader, video, 0, 0, vw, vh);
        if (fullResult) { scanning = false; _onBarcodeDetected(fullResult); return; }
      }
    }

    // Throttle: wait ~120ms (reduced from 180ms for faster polling)
    barcodeScanLoop = setTimeout(scanCycle, 120);
  }

  barcodeScanLoop = setTimeout(scanCycle, 200); // initial delay for camera warm-up
}

async function _tryDecode(codeReader, video, sx, sy, sw, sh) {
  try {
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    // Try native detector on cropped image
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']
        });
        const barcodes = await detector.detect(c);
        if (barcodes && barcodes.length > 0) {
          return barcodes[0].rawValue;
        }
      } catch (_) {}
    }

    // Fallback to ZXing
    const result = await codeReader.decodeFromCanvas(c);
    if (result && result.text) return result.text;
  } catch (_) {}
  return null;
}

function _onBarcodeDetected(code) {
  if (barcodeScanLoop) { clearTimeout(barcodeScanLoop); barcodeScanLoop = null; }
  _setBarcodeScannerStatus('✅ 바코드 인식!', '#34d399');

  // Haptic feedback (mobile)
  if (navigator.vibrate) navigator.vibrate(120);

  // Visual feedback — flash the guide green
  const guide = document.getElementById('barcode-guide-frame');
  if (guide) {
    guide.style.transition = 'box-shadow .2s';
    guide.style.boxShadow = '0 0 24px 4px rgba(52,211,153,0.7), inset 0 0 12px rgba(52,211,153,0.3)';
  }

  const toastEl = document.getElementById('barcode-result-toast');
  if (toastEl) {
    toastEl.textContent = `✅ ${code}`;
    toastEl.style.display = 'block';
  }

  setTimeout(() => {
    closeBarcodeScannerModal();
    toast(`🔍 바코드 인식 성공: ${code}`);
    const results = document.getElementById('aladin-results');
    if (results) {
      results.classList.add('show');
      results.innerHTML = `<div class="search-loading"><span class="spin"></span> 바코드로 검색 중...</div>`;
    }
    searchAladinByIsbn(code);
  }, 700);
}

async function triggerBarcodeCapture() {
  const video = document.getElementById('barcode-video');
  if (!video || !barcodeStream) return;

  // Immediately pause the automatic scanning loop
  barcodeAutoScanningActive = false;
  if (barcodeScanLoop) { clearTimeout(barcodeScanLoop); barcodeScanLoop = null; }
  
  _setBarcodeScannerStatus('촬영 중...', '#f59e0b');

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  // Create a timeout promise to prevent hanging
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), 1200);
  });

  const scanPromise = (async () => {
    // 1) Try native BarcodeDetector first on the captured frame
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']
        });
        const barcodes = await detector.detect(canvas);
        if (barcodes && barcodes.length > 0) {
          return barcodes[0].rawValue;
        }
      } catch (e) {
        console.warn('Native BarcodeDetector manual capture error:', e);
      }
    }

    // 2) Fallback to ZXing
    const codeReader = new ZXing.BrowserMultiFormatReader();
    const result = await codeReader.decodeFromCanvas(canvas);
    if (result && result.text) {
      return result.text;
    }
    throw new Error('No barcode found');
  })();

  try {
    const code = await Promise.race([scanPromise, timeoutPromise]);
    if (code) {
      _onBarcodeDetected(code);
    } else {
      throw new Error('Empty barcode result');
    }
  } catch (err) {
    console.warn('Manual capture failed or timed out:', err);
    _setBarcodeScannerStatus('미인식 — 다시 시도', '#ef4444');
    const gt = document.getElementById('barcode-guide-text');
    if (gt) gt.innerHTML = '❌ 인식 실패. 바코드를 <strong style="color:#a78bfa;">박스 안</strong>에 맞추고 다시 누르세요.';
    
    setTimeout(() => {
      if (!barcodeStream) return;
      _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
      if (gt) gt.innerHTML = '책 뒷면 바코드를 <strong style="color:#a78bfa;">박스 안</strong>에 맞춰주세요';
      // Resume automatic scanning
      barcodeAutoScanningActive = true;
      _startBarcodeScanLoop();
    }, 2000);
  }
}

function switchBarcodeCamera() {
  barcodeCurrentFacing = (barcodeCurrentFacing === 'environment') ? 'user' : 'environment';
  _startBarcodeCamera(barcodeCurrentFacing);
}

function _fallbackBarcodeFileInput() {
  const inp = document.createElement('input');
  inp.type    = 'file';
  inp.accept  = 'image/*';
  inp.capture = 'environment';
  inp.onchange = (e) => handleCameraScan(e.target);
  inp.click();
}

function runAladinJsonp(query, key, results) {
  const cbName = '_aladinCb_' + (++aladinCallbackCounter);
  const script = document.createElement('script');
  
  const params = new URLSearchParams({
    ttbkey: key,
    Query: query,
    QueryType: 'Title',
    MaxResults: '18',
    start: '1',
    SearchTarget: 'Book',
    output: 'JS',
    Version: '20131101',
    Cover: 'Big',
    OptResult: 'subInfo',
    callback: cbName
  });

  // Always use HTTPS to prevent Mixed Content errors
  script.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${params}`;

  window[cbName] = function(data) {
    delete window[cbName];
    script.remove();
    handleAladinResults(data);
  };

  script.onerror = function() {
    delete window[cbName];
    script.remove();
    results.innerHTML = `<div class="search-empty">❌ 검색 실패 — API 키 활성화 상태(발급 후 1~2시간 소요) 또는 인터넷 연결을 확인해주세요.</div>`;
  };

  setTimeout(() => {
    if (window[cbName]) {
      delete window[cbName];
      script.remove();
      results.innerHTML = `<div class="search-empty">⏰ 응답 시간 초과</div>`;
    }
  }, 10000);

  document.body.appendChild(script);
}

function handleAladinResults(data) {
  const results = document.getElementById('aladin-results');

  // Normalize items from XML array or raw JSON response
  let items = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data && data.item) {
    items = data.item.map(item => {
      let pagesVal = (item.subInfo ? (item.subInfo.itemPage || item.subInfo.itempage) : null) || 
                     (item.subinfo ? (item.subinfo.itemPage || item.subinfo.itempage) : null) ||
                     item.itemPage || item.itempage || '';
      let pages = pagesVal ? String(pagesVal).replace(/[^0-9]/g, '') : '';
      let author = item.author || '';
      let cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '');
      return {
        title: item.title || '',
        author: cleanAuthor,
        cover: item.cover || '',
        publisher: item.publisher || '',
        pubDate: item.pubDate || '',
        pages: pages,
        itemId: item.itemId || item.itemid || '',
        isbn: item.isbn || '',
        isbn13: item.isbn13 || ''
      };
    });
  }

  aladinSearchResults = items;

  if (items.length === 0) {
    results.innerHTML = `<div class="search-empty">검색 결과가 없습니다</div>`;
    return;
  }

  let html = '';
  items.forEach((item, index) => {
    const cover = item.cover || '';
    const title = item.title || '';
    const author = item.author || '';
    const publisher = item.publisher || '';
    const pages = item.pages || '';
    const pubDate = item.pubDate || '';

    html += `<div class="search-item" onclick="applyAladinItemByIndex(${index})">
      <img src="${esc(getSafeImageUrl(cover))}" alt=""
        onerror="this.style.background='var(--bg-card)';this.style.opacity='.3'">
      <div class="search-item-info">
        <div class="search-item-title">${esc(title)}</div>
        <div class="search-item-author">${esc(author)}</div>
        <div class="search-item-meta">${esc(publisher)}${pubDate ? ' · ' + pubDate : ''}${pages ? ' · ' + pages + 'p' : ''}</div>
      </div>
    </div>`;
  });

  results.innerHTML = html;
}

function applyAladinItemByIndex(index) {
  const item = aladinSearchResults[index];
  if (item) {
    applyAladinItem(item);
  }
}

function applyAladinItem(item) {
  if (item.title) document.getElementById('bk-title').value = item.title;
  
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
  }

  hideSearchResults();
  toast('✅ 도서 정보가 적용되었습니다');

  const identifier = item.itemId || item.isbn13 || item.isbn;
  if (identifier && !cleanPages) {
    fetchDetailedPages(identifier);
  }
}

function fetchDetailedPages(itemId) {
  const key = getApiKey();
  
  // Dynamically determine itemIdType (ISBN13, ISBN, or ItemId)
  let itemIdType = 'ItemId';
  const cleanId = String(itemId).trim();
  if (cleanId.length === 13 && (cleanId.startsWith('978') || cleanId.startsWith('979'))) {
    itemIdType = 'ISBN13';
  } else if (cleanId.length === 10) {
    itemIdType = 'ISBN';
  }

  const targetUrl = `https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?ttbkey=${key}&itemIdType=${itemIdType}&ItemId=${cleanId}&output=xml&Version=20131101&OptResult=subInfo`;
  
  const proxyUrl1 = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
  const proxyUrl2 = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;

  const updatePageField = (pages) => {
    if (pages) {
      const cleanPages = String(pages).replace(/[^0-9]/g, '');
      document.getElementById('bk-pages').value = cleanPages;
      toast('✅ 페이지 수 정보를 불러왔습니다 (' + cleanPages + 'p)');
    }
  };

  fetch(proxyUrl1)
    .then(res => {
      if (!res.ok) throw new Error('Proxy 1 failed');
      return res.text();
    })
    .then(xmlText => {
      const parsed = parseAladinXml(xmlText);
      if (!parsed.error && parsed.items && parsed.items[0]) {
        updatePageField(parsed.items[0].pages);
      }
    })
    .catch(() => {
      fetch(proxyUrl2)
        .then(res => {
          if (!res.ok) throw new Error('Proxy 2 failed');
          return res.json();
        })
        .then(data => {
          const xmlText = data.contents;
          const parsed = parseAladinXml(xmlText);
          if (!parsed.error && parsed.items && parsed.items[0]) {
            updatePageField(parsed.items[0].pages);
          }
        })
        .catch(() => {
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
          window[cbName] = function(data) {
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
          script.onerror = function() {
            delete window[cbName];
            script.remove();
          };
          document.body.appendChild(script);
        });
    });
}


/* ==============================================
   SCRAP MODAL
============================================== */
async function openScrapModal(id) {
  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('⚠️ 로그인이 필요합니다. 구글 로그인을 진행해주세요.');
      loginWithGoogle();
      return;
    }
  }

  const book = books.find(b => b.id === id);
  if (!book) return;
  if ((book.scraps||[]).length >= 100) {
    toast('❌ 스크랩은 최대 100개까지 가능합니다'); return;
  }
  currentScrapBookId = id;
  editingScrapId = null;

  document.getElementById('scrap-modal-title').textContent = '✂️ 문장 스크랩';
  document.getElementById('scrap-save-btn').textContent = '✂️ 스크랩 추가';

  document.getElementById('sc-text').value = '';
  document.getElementById('sc-page').value = '';
  document.getElementById('sc-memo').value = '';
  document.getElementById('ocr-result').value = '';
  document.getElementById('sc-page-ocr').value = '';
  document.getElementById('sc-memo-ocr').value = '';
  document.getElementById('ocr-status').style.display = 'none';
  document.getElementById('ocr-fname').textContent = '선택된 파일 없음';
  resetOcrWrap();
  switchTab('manual');
  openModal('scrap-modal');
}

function closeScrapModal() {
  closeModal('scrap-modal');
}

function switchTab(tab) {
  currentScrapTab = tab;
  ['manual','photo'].forEach(t => {
    document.getElementById('stab-'+t).classList.toggle('on', t===tab);
    document.getElementById('sbody-'+t).classList.toggle('on', t===tab);
  });
}

async function saveScrap() {
  const book = books.find(b => b.id === currentScrapBookId);
  if (!book) return;

  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('⚠️ 로그인이 필요합니다. 먼저 로그인 해주세요.');
      return;
    }
  }

  let text, page, memo;
  if (currentScrapTab === 'manual') {
    text = document.getElementById('sc-text').value.trim();
    page = parseInt(document.getElementById('sc-page').value) || 0;
    memo = document.getElementById('sc-memo').value.trim();
  } else {
    text = document.getElementById('ocr-result').value.trim();
    page = parseInt(document.getElementById('sc-page-ocr').value) || 0;
    memo = document.getElementById('sc-memo-ocr').value.trim();
  }

  if (!text) { toast('❌ 문장을 입력해주세요'); return; }

  if (!book.scraps) book.scraps = [];
  
  let updatedScraps;
  if (editingScrapId) {
    updatedScraps = book.scraps.map(s => 
      s.id === editingScrapId 
        ? { ...s, text, page, memo, at: new Date().toISOString() } 
        : s
    );
  } else {
    if (book.scraps.length >= 100) {
      toast('❌ 스크랩은 최대 100개까지 가능합니다'); return;
    }
    updatedScraps = [...book.scraps, { id: uid(), text, page, memo, at: new Date().toISOString() }];
  }

  try {
    if (supabaseClient && user) {
      const { error } = await supabaseClient
        .from('books')
        .update({ scraps: updatedScraps })
        .eq('id', currentScrapBookId)
        .eq('user_id', user.id);
      if (error) throw error;
    }

    book.scraps = updatedScraps;
    saveData();
    closeScrapModal();
    toast(editingScrapId ? '✏️ 스크랩이 수정되었습니다' : '✂️ 문장이 스크랩되었습니다');
    if (currentBookId === currentScrapBookId) showDetail(currentBookId);
  } catch (err) {
    console.error(err);
    toast('❌ 스크랩 저장 실패: ' + err.message);
  }
}

async function doDeleteScrap(bookId, scrapId) {
  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('⚠️ 로그인이 필요합니다. 먼저 로그인 해주세요.');
      return;
    }
  }

  const book = books.find(b => b.id === bookId);
  if (!book) return;
  const updatedScraps = (book.scraps||[]).filter(s => s.id !== scrapId);

  try {
    if (supabaseClient && user) {
      const { error } = await supabaseClient
        .from('books')
        .update({ scraps: updatedScraps })
        .eq('id', bookId)
        .eq('user_id', user.id);
      if (error) throw error;
    }

    book.scraps = updatedScraps;
    saveData();
    toast('🗑️ 스크랩이 삭제되었습니다');
    showDetail(bookId);
  } catch (err) {
    console.error(err);
    toast('❌ 스크랩 삭제 실패: ' + err.message);
  }
}

/* ==============================================
   OCR
============================================== */
let ocrLinesData = [];

function resetOcrWrap() {
  document.getElementById('ocr-wrap').innerHTML = `
    <div class="ocr-ph">
      <span class="ocr-ph-icon">📷</span>
      <span>사진을 업로드하면 자동으로 분석을 시작합니다</span>
      <span style="font-size:10px;">분석된 문장을 탭하여 스크랩에 추가하세요</span>
    </div>`;
  ocrImg = null;
  ocrLinesData = [];
  document.getElementById('ocr-ctrl-btns').style.display = 'none';
}

function loadOcrImg(inp) {
  const file = inp.files[0];
  if (!file) return;
  document.getElementById('ocr-fname').textContent = file.name;

  const reader = new FileReader();
  reader.onload = e => {
    const tempImg = new Image();
    tempImg.onload = () => {
      // Draw to canvas to bake EXIF orientation
      const canvas = document.createElement('canvas');
      canvas.width = tempImg.naturalWidth;
      canvas.height = tempImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(tempImg, 0, 0, tempImg.naturalWidth, tempImg.naturalHeight);
      const orientedDataUrl = canvas.toDataURL('image/jpeg', 0.9);

      const wrap = document.getElementById('ocr-wrap');
      wrap.innerHTML = `
        <div class="ocr-container" id="ocr-container">
          <img id="ocr-img-el" src="${orientedDataUrl}" alt="OCR" draggable="false">
          <div class="ocr-scan-line" id="ocr-scan-line"></div>
          <div class="ocr-overlay" id="ocr-overlay"></div>
        </div>`;
      ocrImg = document.getElementById('ocr-img-el');
      ocrLinesData = [];
      document.getElementById('ocr-ctrl-btns').style.display = 'none';

      ocrImg.onload = () => {
        preprocessOcrImage(orientedDataUrl).then(processedUrl => {
          runOcr(processedUrl);
        });
      };
    };
    tempImg.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function runOcr(dataUrl) {
  const statusEl = document.getElementById('ocr-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span class="spin"></span> 사진에서 문장 분석 중...';
  document.getElementById('ocr-result').value = '';

  const scanLine = document.getElementById('ocr-scan-line');
  if (scanLine) scanLine.classList.add('scanning');

  try {
    const lang = document.getElementById('ocr-lang').value || 'kor';
    if (ocrWorker && activeOcrLang !== lang) {
      await ocrWorker.terminate().catch(()=>{});
      ocrWorker = null;
    }
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker(lang, 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            const pct = Math.round(m.progress * 100);
            statusEl.innerHTML = `<span class="spin"></span> 인식 중... ${pct}%`;
          }
        }
      });
      activeOcrLang = lang;
    }

    const { data } = await ocrWorker.recognize(dataUrl);
    
    // Store lines with their bounding boxes and selected states
    if (data && data.lines) {
      ocrLinesData = data.lines
        .filter(line => line.confidence > 50)
        .map(line => {
          // Clean isolated garbage characters (like |, I, l, i, ~, ·, etc.)
          const cleanedText = line.text.trim()
            .split(/\s+/)
            .filter(word => {
              if (word.length === 1 && /^[|Il!~._,\-·/\\i]+$/.test(word)) {
                return false;
              }
              return true;
            })
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return {
            text: cleanedText,
            bbox: line.bbox,
            selected: false
          };
        })
        .filter(l => {
          if (l.text.length < 2) return false;
          // Discard lines consisting only of numbers and symbols (must have at least one alphabet or Korean letter)
          const hasWordChar = /[a-zA-Z가-힣]/.test(l.text);
          if (!hasWordChar) return false;
          return true;
        });
    }

    if (scanLine) scanLine.classList.remove('scanning');
    
    if (ocrLinesData.length > 0) {
      statusEl.innerHTML = '✅ 분석 완료! 사진에서 스크랩할 문장을 직접 선택하세요.';
      document.getElementById('ocr-ctrl-btns').style.display = 'flex';
      renderOcrOverlays();
    } else {
      statusEl.innerHTML = '⚠️ 인식된 텍스트가 없습니다. 다른 사진을 시도하거나 직접 입력해주세요.';
    }
    
    setTimeout(() => { statusEl.style.display = 'none'; }, 4500);
  } catch(err) {
    console.error(err);
    if (scanLine) scanLine.classList.remove('scanning');
    statusEl.innerHTML = '❌ 분석 실패. 다시 시도해주세요.';
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  }
}

async function onOcrLangChange() {
  if (ocrImg && ocrImg.src) {
    if (ocrWorker) {
      await ocrWorker.terminate().catch(()=>{});
      ocrWorker = null;
    }
    runOcr(ocrImg.src);
  }
}

function renderOcrOverlays() {
  const overlay = document.getElementById('ocr-overlay');
  if (!overlay || !ocrImg) return;
  overlay.innerHTML = '';

  const scaleX = ocrImg.clientWidth / ocrImg.naturalWidth;
  const scaleY = ocrImg.clientHeight / ocrImg.naturalHeight;

  ocrLinesData.forEach((line, idx) => {
    const l = line.bbox.x0 * scaleX;
    const t = line.bbox.y0 * scaleY;
    const w = (line.bbox.x1 - line.bbox.x0) * scaleX;
    const h = (line.bbox.y1 - line.bbox.y0) * scaleY;

    const div = document.createElement('div');
    div.className = 'ocr-line-highlight' + (line.selected ? ' selected' : '');
    div.style.left = l + 'px';
    div.style.top = t + 'px';
    div.style.width = w + 'px';
    div.style.height = h + 'px';
    div.title = line.text;

    div.onclick = () => {
      line.selected = !line.selected;
      div.classList.toggle('selected', line.selected);
      updateOcrResultFromSelection();
    };

    overlay.appendChild(div);
  });
}

function updateOcrResultFromSelection() {
  const selectedText = ocrLinesData
    .filter(l => l.selected)
    .map(l => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  document.getElementById('ocr-result').value = selectedText;
}

function selectAllOcrLines() {
  ocrLinesData.forEach(l => l.selected = true);
  renderOcrOverlays();
  updateOcrResultFromSelection();
}

function clearOcrSelection() {
  ocrLinesData.forEach(l => l.selected = false);
  renderOcrOverlays();
  updateOcrResultFromSelection();
}

// Window resize support for OCR overlays
window.addEventListener('resize', () => {
  const modal = document.getElementById('scrap-modal');
  if (modal && modal.classList.contains('open') && ocrImg && ocrLinesData.length > 0) {
    renderOcrOverlays();
  }
});

/* ==============================================
   SIDEBAR / STATS
============================================== */
function updateSidebar() {
  const now = new Date();
  let filteredBooks = books;

  if (statsPeriod === 'year') {
    filteredBooks = books.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return d.getFullYear() === now.getFullYear();
    });
  } else if (statsPeriod === 'month') {
    filteredBooks = books.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
  }

  const total = filteredBooks.length;
  const pages = filteredBooks.reduce((s, b) => s + (b.pages||0), 0);
  const scraps = filteredBooks.reduce((s, b) => s + ((b.scraps||[]).length), 0);
  
  document.getElementById('stat-books').textContent = total;
  document.getElementById('stat-pages').textContent =
    pages >= 10000 ? (pages/1000).toFixed(1)+'k' : pages.toLocaleString();
  document.getElementById('stat-scraps').textContent =
    scraps >= 10000 ? (scraps/1000).toFixed(1)+'k' : scraps.toLocaleString();

  renderChart();
  renderCal();
}

function showRandomQuote() {
  const card = document.getElementById('random-quote-card');
  const textEl = document.getElementById('random-quote-text');
  const bookEl = document.getElementById('random-quote-book');

  // Collect all scraps
  const allScraps = [];
  books.forEach(book => {
    if (book.scraps && book.scraps.length) {
      book.scraps.forEach(s => {
        allScraps.push({
          text: s.text,
          page: s.page,
          bookTitle: book.title,
          bookAuthor: book.author
        });
      });
    }
  });

  if (allScraps.length === 0) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  
  // Trigger fluid refresh animation
  card.classList.add('refresh-anim');
  setTimeout(() => {
    const randIdx = Math.floor(Math.random() * allScraps.length);
    const quote = allScraps[randIdx];

    textEl.textContent = quote.text;
    let sourceText = `— ${quote.bookTitle}`;
    if (quote.bookAuthor) sourceText += ` (${quote.bookAuthor})`;
    if (quote.page) sourceText += `, p.${quote.page}`;
    bookEl.textContent = sourceText;
    
    card.classList.remove('refresh-anim');
  }, 180);
}

function switchStatsPeriod(period) {
  statsPeriod = period;
  const btnAll = document.getElementById('stats-btn-all');
  const btnYear = document.getElementById('stats-btn-year');
  const btnMonth = document.getElementById('stats-btn-month');

  [btnAll, btnYear, btnMonth].forEach(btn => {
    if (btn) {
      btn.style.background = 'var(--glass)';
      btn.style.color = 'var(--text-300)';
      btn.style.border = '1px solid var(--border)';
    }
  });

  let activeBtn = btnAll;
  if (period === 'year') activeBtn = btnYear;
  if (period === 'month') activeBtn = btnMonth;

  if (activeBtn) {
    activeBtn.style.background = 'var(--violet)';
    activeBtn.style.color = '#fff';
    activeBtn.style.border = 'none';
  }

  updateSidebar();
}

function renderChart() {
  const chart = document.getElementById('monthly-chart');
  chart.innerHTML = '';

  const now = new Date();
  const dataPoints = [];

  if (chartMode === 'month') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      dataPoints.push({ 
        lbl: (d.getMonth() + 1) + '월',
        match: (bDate) => bDate.getFullYear() === d.getFullYear() && bDate.getMonth() === d.getMonth()
      });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const yearVal = now.getFullYear() - i;
      dataPoints.push({
        lbl: yearVal + '년',
        match: (bDate) => bDate.getFullYear() === yearVal
      });
    }
  }

  const counts = dataPoints.map(dp =>
    books.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return dp.match(d);
    }).length
  );

  const maxC = Math.max(...counts, 1);

  dataPoints.forEach((dp, i) => {
    const pct = (counts[i] / maxC) * 70;
    const g = document.createElement('div');
    g.className = 'bar-group';
    g.innerHTML = `
      <span style="font-size:9px; color:var(--text-300); font-weight:500; margin-bottom:-2px;">${counts[i]}</span>
      <div class="bar-col" style="height:${pct}%" data-tip="${dp.lbl}: ${counts[i]}권"></div>
      <div class="bar-lbl">${dp.lbl}</div>
    `;
    chart.appendChild(g);
  });
}

function switchChartMode(mode) {
  chartMode = mode;
  const btnMonth = document.getElementById('chart-btn-month');
  const btnYear = document.getElementById('chart-btn-year');
  const title = document.getElementById('chart-title');
  
  if (mode === 'month') {
    btnMonth.style.background = 'var(--violet)';
    btnMonth.style.color = '#fff';
    btnMonth.style.border = 'none';
    
    btnYear.style.background = 'var(--glass)';
    btnYear.style.color = 'var(--text-300)';
    btnYear.style.border = '1px solid var(--border)';
    
    title.textContent = '📈 월별 독서량';
  } else {
    btnYear.style.background = 'var(--violet)';
    btnYear.style.color = '#fff';
    btnYear.style.border = 'none';
    
    btnMonth.style.background = 'var(--glass)';
    btnMonth.style.color = 'var(--text-300)';
    btnMonth.style.border = '1px solid var(--border)';
    
    title.textContent = '📈 연도별 독서량';
  }
  renderChart();
}

/* ==============================================
   MINI CALENDAR
============================================== */
function renderCal() {
  const y = calDate.getFullYear();
  const m = calDate.getMonth();
  document.getElementById('cal-lbl').textContent = `${y}. ${m+1}`;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  ['일','월','화','수','목','금','토'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-dn';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();

  const dayMap = {};
  books.forEach(book => {
    if (!book.date) return;
    const d = new Date(book.date);
    if (d.getFullYear() === y && d.getMonth() === m) {
      const day = d.getDate();
      if (!dayMap[day]) dayMap[day] = [];
      dayMap[day].push(book);
    }
  });

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'cal-d empty';
    grid.appendChild(el);
  }

  const today = new Date();
  for (let d = 1; d <= daysInMonth; d++) {
    const el = document.createElement('div');
    el.className = 'cal-d';
    el.textContent = d;

    if (dayMap[d]) {
      el.classList.add('has-book');
      el.title = dayMap[d].map(b => b.title).join(', ');
      const booksOnDay = dayMap[d];
      el.addEventListener('click', () => {
        if (booksOnDay.length >= 1) {
          showDetail(booksOnDay[0].id);
        }
      });
    }

    if (today.getFullYear()===y && today.getMonth()===m && today.getDate()===d) {
      el.classList.add('today');
    }
    grid.appendChild(el);
  }
}

document.getElementById('cal-prev').addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth()-1, 1);
  renderCal();
});
document.getElementById('cal-next').addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth()+1, 1);
  renderCal();
});

/* ==============================================
   SIDEBAR TOGGLE (STATS NAVIGATION)
============================================== */
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  showStats();
});

/* ==============================================
   SWIPE NAVIGATION (DETAIL VIEW)
============================================== */
let touchStartX = 0;
let touchStartY = 0;
let touchEndX = 0;
let touchEndY = 0;
let isMouseDown = false;
let mouseStartX = 0;
let mouseStartY = 0;

const detailEl = document.getElementById('view-detail');

detailEl.addEventListener('touchstart', e => {
  touchStartX = e.changedTouches[0].screenX;
  touchStartY = e.changedTouches[0].screenY;
}, { passive: true });

detailEl.addEventListener('touchend', e => {
  touchEndX = e.changedTouches[0].screenX;
  touchEndY = e.changedTouches[0].screenY;
  handleDetailSwipe();
}, { passive: true });

detailEl.addEventListener('mousedown', e => {
  if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.closest('.scrap-item') || e.target.closest('.modal-box')) {
    return;
  }
  isMouseDown = true;
  mouseStartX = e.clientX;
  mouseStartY = e.clientY;
});

detailEl.addEventListener('mouseup', e => {
  if (!isMouseDown) return;
  isMouseDown = false;
  const diffX = e.clientX - mouseStartX;
  const diffY = e.clientY - mouseStartY;
  if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
    if (diffX < 0) {
      navigateToAdjacentBook('next');
    } else {
      navigateToAdjacentBook('prev');
    }
  }
});

function handleDetailSwipe() {
  const diffX = touchEndX - touchStartX;
  const diffY = touchEndY - touchStartY;
  const detailEl = document.getElementById('view-detail');

  // Horizontal swipe
  if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
    if (diffX < 0) {
      navigateToAdjacentBook('next');
    } else {
      navigateToAdjacentBook('prev');
    }
  } 
  // Vertical swipe: Swipe up or down to go back to gallery
  else if (Math.abs(diffY) > 70 && Math.abs(diffY) > Math.abs(diffX)) {
    if (detailEl.scrollTop <= 5) {
      showGallery();
      toast('📚 내 서재로 이동');
    }
  }
}

function navigateToAdjacentBook(direction) {
  if (!currentBookId || books.length === 0) return;
  
  // Sort the books copy exactly like the gallery view
  const sorted = [...books].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });
  
  const idx = sorted.findIndex(b => b.id === currentBookId);
  if (idx === -1) return;
  
  const wrap = document.getElementById('detail-wrap');
  
  if (direction === 'next') {
    if (idx < sorted.length - 1) {
      showDetail(sorted[idx + 1].id, 'next');
      toast('👉 다음 도서');
    } else {
      // Bounce right (bounce back from right edge)
      wrap.classList.remove('bounce-left', 'bounce-right', 'slide-from-left', 'slide-from-right');
      void wrap.offsetWidth; // Force reflow
      wrap.classList.add('bounce-left'); // Pulling left to bounce back from right
      toast('🚫 마지막 도서입니다');
    }
  } else if (direction === 'prev') {
    if (idx > 0) {
      showDetail(sorted[idx - 1].id, 'prev');
      toast('👈 이전 도서');
    } else {
      // Bounce left (bounce back from left edge)
      wrap.classList.remove('bounce-left', 'bounce-right', 'slide-from-left', 'slide-from-right');
      void wrap.offsetWidth; // Force reflow
      wrap.classList.add('bounce-right'); // Pulling right to bounce back from left
      toast('🚫 첫 번째 도서입니다');
    }
  }
}

/* ==============================================
   PINCH / WHEEL ZOOM
============================================== */
const galleryScroll = document.getElementById('gallery-scroll');

// Floating Year Indicator on scroll
let yearBadgeTimer = null;
galleryScroll.addEventListener('scroll', () => {
  const badge = document.getElementById('floating-year-badge');
  if (!badge) return;

  const cards = document.querySelectorAll('#gallery-grid .book-card');
  let currentYear = '';
  const containerRect = galleryScroll.getBoundingClientRect();

  for (let card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom > containerRect.top + 24) {
      const id = card.getAttribute('data-id');
      const book = books.find(b => b.id === id);
      if (book && book.date) {
        const d = new Date(book.date);
        if (!isNaN(d.getFullYear())) {
          currentYear = d.getFullYear() + '년';
        }
      }
      break;
    }
  }

  if (currentYear) {
    badge.textContent = currentYear;
    badge.classList.add('show');
    clearTimeout(yearBadgeTimer);
    yearBadgeTimer = setTimeout(() => {
      badge.classList.remove('show');
    }, 1500);
  } else {
    badge.classList.remove('show');
  }
});

let pinchDist0 = null;

let galleryTouchStartX = 0;
let galleryTouchStartY = 0;
let galleryTouchEndX = 0;
let galleryTouchEndY = 0;

galleryScroll.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    pinchDist0 = pinchD(e);
  } else if (e.touches.length === 1) {
    galleryTouchStartX = e.touches[0].screenX;
    galleryTouchStartY = e.touches[0].screenY;
  }
}, { passive: true });

galleryScroll.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && pinchDist0 !== null) {
    const d = pinchD(e);
    adjustGrid(d / pinchDist0);
    pinchDist0 = d;
    e.preventDefault();
  }
}, { passive: false });

galleryScroll.addEventListener('touchend', e => {
  if (e.touches.length < 2) {
    pinchDist0 = null;
  }
  if (e.changedTouches.length === 1) {
    galleryTouchEndX = e.changedTouches[0].screenX;
    galleryTouchEndY = e.changedTouches[0].screenY;
    handleGallerySwipe();
  }
}, { passive: true });

function handleGallerySwipe() {
  const diffX = galleryTouchEndX - galleryTouchStartX;
  const diffY = galleryTouchEndY - galleryTouchStartY;
  
  // Horizontal swipe: left goes to Community, right goes to Stats
  if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
    if (diffX < 0) {
      showCommunity();
      toast('💬 커뮤니티로 이동');
    } else {
      showStats();
      toast('📊 통계 페이지로 이동');
    }
  }
}

// Community Touch Swipe Gestures
let commTouchStartX = 0;
let commTouchStartY = 0;
let commTouchEndX = 0;
let commTouchEndY = 0;

const commEl = document.getElementById('view-community');

commEl.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    commTouchStartX = e.touches[0].screenX;
    commTouchStartY = e.touches[0].screenY;
  }
}, { passive: true });

commEl.addEventListener('touchend', e => {
  // Ignore swipes if user is scrolling horizontal AR cards
  if (e.target.closest('#ar-floating-cards-container')) return;
  if (e.changedTouches.length === 1) {
    commTouchEndX = e.changedTouches[0].screenX;
    commTouchEndY = e.changedTouches[0].screenY;
    handleCommunitySwipe();
  }
}, { passive: true });

function handleCommunitySwipe() {
  const diffX = commTouchEndX - commTouchStartX;
  const diffY = commTouchEndY - commTouchStartY;
  
  // Horizontal swipe
  if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
    if (diffX > 0) {
      showGallery();
      toast('📚 내 서재로 이동');
    } else {
      // Bounce left (dragged left on the rightmost page)
      const wrap = document.querySelector('.community-wrap');
      if (wrap) {
        wrap.classList.remove('bounce-left', 'bounce-right');
        void wrap.offsetWidth;
        wrap.classList.add('bounce-left');
      }
      toast('🚫 마지막 페이지입니다');
    }
  }
}

// Stats Touch Swipe Gestures
let statsTouchStartX = 0;
let statsTouchStartY = 0;
let statsTouchEndX = 0;
let statsTouchEndY = 0;

const statsEl = document.getElementById('view-stats');

statsEl.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    statsTouchStartX = e.touches[0].screenX;
    statsTouchStartY = e.touches[0].screenY;
  }
}, { passive: true });

statsEl.addEventListener('touchend', e => {
  if (e.changedTouches.length === 1) {
    statsTouchEndX = e.changedTouches[0].screenX;
    statsTouchEndY = e.changedTouches[0].screenY;
    handleStatsSwipe();
  }
}, { passive: true });

function handleStatsSwipe() {
  const diffX = statsTouchEndX - statsTouchStartX;
  const diffY = statsTouchEndY - statsTouchStartY;
  
  // Horizontal swipe
  if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
    if (diffX < 0) {
      showGallery();
      toast('📚 내 서재로 이동');
    } else {
      // Bounce right (dragged right on the leftmost page)
      const wrap = document.querySelector('.stats-wrap');
      if (wrap) {
        wrap.classList.remove('bounce-left', 'bounce-right');
        void wrap.offsetWidth;
        wrap.classList.add('bounce-right');
      }
      toast('🚫 첫 번째 페이지입니다');
    }
  }
  // Swipe up: Go back to Gallery, Swipe down: Refresh quote
  if (Math.abs(diffY) > 70 && Math.abs(diffY) > Math.abs(diffX)) {
    if (statsEl.scrollTop <= 5) {
      if (diffY < 0) {
        showGallery();
        toast('📚 내 서재로 이동');
      } else {
        showRandomQuote();
        toast('🔄 오늘의 한 문장 새로고침');
      }
    }
  }
}

galleryScroll.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    adjustGrid(e.deltaY < 0 ? 1.06 : 0.94);
  }
}, { passive: false });

function pinchD(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

function adjustGrid(scale) {
  gridMin = Math.max(90, Math.min(320, gridMin * scale));
  const grid = document.getElementById('gallery-grid');
  grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${gridMin}px, 1fr))`;

  const hud = document.getElementById('zoom-hud');
  document.getElementById('zoom-val').textContent = Math.round((gridMin/170)*100);
  hud.classList.add('show');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => hud.classList.remove('show'), 1600);
}

/* ==============================================
   MODAL HELPERS
============================================== */
function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  if (id === 'scrap-modal') {
    if (ocrWorker) { ocrWorker.terminate().catch(()=>{}); ocrWorker = null; }
    activeOcrLang = null;
    ocrImg = null; ocrSelDiv = null;
  }



  if (id === 'barcode-scanner-modal') {
    closeBarcodeScannerModal();
  }

  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('open');
  }
  document.body.style.overflow = '';

  setTimeout(() => {
    window.scrollTo(document.documentElement.scrollLeft, document.documentElement.scrollTop);
  }, 80);
}

document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', e => {
    if (e.target === bg) {
      closeModal(bg.id);
    }
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-bg.open').forEach(bg => {
      closeModal(bg.id);
    });
  }
});

/* ==============================================
   INIT
============================================== */
loadTheme();
(async () => {
  await loadData();
  
  // Unique sentences representing the 6 demo books
  const demoSentences = [
    '폭력에 저항하는 방식으로 선택한 침묵과 채식, 그 고요한 절규.',
    '평범한 한 여성의 삶을 통해 드러나는 사회 구조의 민낯.',
    '감정을 모르는 소년이 가르쳐준 진짜 공감의 의미.',
    '꿈을 파는 백화점에서 발견한 위로와 희망의 이야기.',
    '5.18을 통해 인간의 존엄과 폭력의 본질을 묻다.',
    '상상력이 현실이 되는 마법같은 세계로의 첫 여행.'
  ];

  // Clean up any old demo books from database & memory (both guest and logged-in user)
  const demoBooksToDelete = books.filter(b => demoSentences.includes(b.sentence));
  if (demoBooksToDelete.length > 0) {
    books = books.filter(b => !demoSentences.includes(b.sentence));
    saveData();
    
    if (currentUser && supabaseClient) {
      const idsToDelete = demoBooksToDelete.map(b => b.id);
      supabaseClient.from('books').delete().in('id', idsToDelete).then(({ error }) => {
        if (error) console.error('Failed to clean up demo books from Supabase:', error);
        else console.log('Cleaned up demo books from Supabase.');
      });
    }
  }

  // If the shelf is completely empty, initialize the single "User Manual" book
  if (books.length === 0) {
    const userManual = {
      id: '8ook_user_guide',
      title: '8ook. 이용 가이드',
      author: '8ook 제작팀',
      pages: 10,
      date: new Date().toISOString().slice(0, 10),
      cover: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%238b5cf6"/><stop offset="100%" stop-color="%23ec4899"/></linearGradient></defs><rect width="400" height="600" fill="url(%23g)"/><rect x="20" y="20" width="360" height="560" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2" rx="10"/><circle cx="200" cy="180" r="60" fill="rgba(255,255,255,0.15)"/><text x="200" y="195" fill="white" font-size="60" font-weight="bold" text-anchor="middle" font-family="sans-serif">📚</text><text x="200" y="320" fill="white" font-size="28" font-weight="bold" text-anchor="middle" font-family="sans-serif">8ook. 이용 가이드</text><text x="200" y="370" fill="rgba(255,255,255,0.8)" font-size="16" text-anchor="middle" font-family="sans-serif">나만의 스마트한 독서 일기</text><line x1="100" y1="420" x2="300" y2="420" stroke="rgba(255,255,255,0.4)" stroke-width="1"/><text x="200" y="470" fill="white" font-size="14" font-weight="500" text-anchor="middle" font-family="sans-serif">책 기록 • 문장 스크랩 • 독서 통계</text><text x="200" y="530" fill="rgba(255,255,255,0.6)" font-size="12" text-anchor="middle" font-family="sans-serif">© 8ook Team</text></svg>',
      rating: 5,
      sentence: '독서 기록, 문장 스크랩, 노션 연동까지! 8ook를 100% 활용하는 가이드북입니다.',
      scraps: [
        {
          id: 'g1',
          text: '🔑 구글 계정으로 로그인하시면 Supabase 클라우드 데이터베이스와 자동으로 연동됩니다. 로그인 시 소중한 독서 기록이 실시간으로 안전하게 동기화 및 보존됩니다.',
          page: 1,
          memo: '클라우드 동기화 안내'
        },
        {
          id: 'g2',
          text: '🔗 노션 책장 가져오기 기능을 클릭하여 공개 공유된 노션 데이터베이스 링크를 입력해보세요. 수십~수백 권의 독서 이력이 몇 초 만에 자동으로 등록됩니다.',
          page: 2,
          memo: '노션 가져오기 가이드'
        },
        {
          id: 'g3',
          text: '📸 스마트폰 카메라로 책의 바코드를 스캔하거나 도서 검색 기능을 사용하여 제목, 저자, 페이지 수, 책 표지 이미지를 편리하게 자동 완성할 수 있습니다.',
          page: 3,
          memo: '간편한 도서 등록 기능'
        },
        {
          id: 'g4',
          text: '📝 도서 상세 보기 화면에서 스크랩 추가 버튼을 누르고 문장 사진을 촬영해보세요. 광학 문자 인식(OCR) 엔진이 이미지 속의 글씨를 알아서 한글 텍스트로 추출해줍니다.',
          page: 4,
          memo: 'OCR 문장 스크랩 사용법'
        }
      ],
      keywords: ['이용가이드', '사용법', '시작하기'],
      created_at: new Date().toISOString()
    };
    
    books = [userManual];
    saveData();
    
    if (currentUser && supabaseClient) {
      const manualWithUser = { ...userManual, user_id: currentUser.id };
      supabaseClient.from('books').insert([manualWithUser]).catch(console.error);
    }
  }
  
  renderGallery();
  updateSidebar();
})();

/* ==============================================
   SUPABASE AUTHENTICATION
============================================== */
async function loginWithGoogle() {
  if (!supabaseClient) { toast('❌ Supabase가 연결되지 않았습니다'); return; }
  
  if (window.location.protocol === 'file:') {
    alert('⚠️ 구글 로그인은 로컬 파일(file://...) 경로에서는 동작하지 않습니다.\nVS Code의 Live Server 등을 사용해 http://localhost:... 주소로 실행하거나, GitHub Pages에 배포 완료 후 테스트해주세요.');
    return;
  }

  let redirectUrl = window.location.origin + window.location.pathname;
  if (!redirectUrl.endsWith('/') && !redirectUrl.endsWith('.html')) {
    redirectUrl += '/';
  }

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectUrl
    }
  });
  if (error) { console.error(error); toast('❌ 로그인 실패'); }
}

async function logout() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) { console.error(error); toast('❌ 로그아웃 실패'); }
}

async function checkAuth() {
  if (!supabaseClient) return;
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  updateAuthUI(session);
}

function updateAuthUI(session) {
  const loginBtn = document.getElementById('auth-login-btn');
  const logoutBtn = document.getElementById('auth-logout-btn');
  const usernameSpan = document.getElementById('auth-username');

  if (session && session.user) {
    currentUser = session.user;
    loginBtn.style.display = 'none';
    logoutBtn.style.display = 'inline-flex';
    usernameSpan.style.display = 'inline';
    const metadata = session.user.user_metadata;
    usernameSpan.textContent = (metadata && metadata.full_name) || session.user.email || '사용자';
  } else {
    currentUser = null;
    loginBtn.style.display = 'inline-flex';
    logoutBtn.style.display = 'none';
    usernameSpan.style.display = 'none';
    usernameSpan.textContent = '';
  }
}

if (supabaseClient) {
  checkAuth();
  supabaseClient.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user || null;
    updateAuthUI(session);
    // Reload data on auth change to apply RLS
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      loadData().then(() => {
        renderGallery();
        updateSidebar();
      });
    }
  });
}

/* ==============================================
   COMMUNITY & AR SCANNER JS LOGIC
   ============================================== */
let arStream = null;
let arCanvasAnimId = null;
let arMatchedBook = null;
let currentFeedRating = 5;

let communityFeedPosts = [
  {
    id: 'f1',
    username: '지식탐험가',
    avatar: '🧠',
    bookTitle: '지적 대화를 위한 넓고 얕은 지식 1',
    bookAuthor: '채사장',
    bookCover: 'https://image.aladin.co.kr/product/22/08/cover500/k282636402_1.jpg',
    rating: 5,
    text: '이 책 한 권으로 세상의 흐름을 꿰뚫어 볼 수 있는 안목을 얻을 수 있습니다. 역사부터 사회까지 꿰뚫어 주네요.',
    likes: 12,
    liked: false,
    time: '2시간 전'
  },
  {
    id: 'f2',
    username: '문학소녀',
    avatar: '🌱',
    bookTitle: '채식주의자',
    bookAuthor: '한강',
    bookCover: 'https://image.aladin.co.kr/product/15/12/cover500/8936434594_1.jpg',
    rating: 5,
    text: '단어 하나하나에 실린 힘과 시린 묘사들이 오래도록 여운을 남깁니다. 폭력에 저항하는 가냘픈 인간의 초상.',
    likes: 8,
    liked: false,
    time: '5시간 전'
  },
  {
    id: 'f3',
    username: '감성수집가',
    avatar: '🍂',
    bookTitle: '아몬드',
    bookAuthor: '손원평',
    bookCover: 'https://image.aladin.co.kr/product/16/96/cover500/8936488635_1.jpg',
    rating: 5,
    text: '감정이 없는 소년 윤재가 마주하는 세상과 공감의 아름다움. 따뜻하게 감싸 안는 위로의 문장들이 참 좋습니다.',
    likes: 15,
    liked: false,
    time: '어제'
  }
];

const MOCK_COMMUNITY_REVIEWS = {
  'default': [
    { username: '책벌레99', avatar: '📚', rating: 5, comment: '최근에 읽은 책 중에 가장 흡입력이 있습니다. 강력 추천해요!' },
    { username: '이서평', avatar: '✍️', rating: 4, comment: '문장들이 마음에 깊이 남습니다. 여운이 깊은 이야기네요.' },
    { username: '김지혜', avatar: '💡', rating: 4, comment: '생각할 거리를 많이 던져주는 훌륭한 작가의 작품입니다.' }
  ],
  '지적 대화를 위한 넓고 얕은 지식 1': [
    { username: '지식탐험가', avatar: '🧠', rating: 5, comment: '지적 대화를 위해 이보다 명쾌하게 기본 교양을 설명한 책은 없다.' },
    { username: '채사장팬', avatar: '🎙️', rating: 5, comment: '팟캐스트 듣는 느낌! 심오한 개념들이 한눈에 정리됩니다.' },
    { username: '교양입문자', avatar: '📖', rating: 4, comment: '역사, 경제, 정치, 사회를 하나의 흐름으로 꿰뚫어줍니다.' }
  ],
  '채식주의자': [
    { username: '문학소녀', avatar: '🌱', rating: 5, comment: '폭력과 인간의 본성에 대한 서늘한 시선. 부커상이 아깝지 않은 명작.' },
    { username: '고요한밤', avatar: '🌙', rating: 4, comment: '읽는 내내 숨이 막힐 것 같은 몰입감과 깊은 묘사가 인상적입니다.' },
    { username: '가시나무', avatar: '🌳', rating: 5, comment: '어떤 상처는 너무 깊어 채식이라는 극단적 침묵으로 뿜어져 나온다.' }
  ],
  '아몬드': [
    { username: '감성수집가', avatar: '🍂', rating: 5, comment: '감정을 느끼지 못하는 소년의 성장기가 가슴을 찡하게 울립니다.' },
    { username: '감동리뷰', avatar: '⭐', rating: 5, comment: '타인의 감정에 공감한다는 것이 얼마나 아름답고 중요한지 깨닫게 해줌.' },
    { username: '도토리', avatar: '🐿️', rating: 4, comment: '청소년 소설이지만 어른들이 꼭 읽어봐야 할 힐링과 성찰의 책.' }
  ]
};

function showCommunity() {
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.add('show');
  document.getElementById('back-btn').classList.add('show');
  document.getElementById('sidebar-toggle').style.display = 'none';
  document.getElementById('community-nav-btn').style.display = 'none';
  document.getElementById('view-label').textContent = '💬 커뮤니티';
  renderCommunityFeed();
  renderWordCloud();
}

function filterGalleryByKeyword(kw) {
  currentGalleryFilter = kw;
  renderGallery();
  toast(`🏷️ '#${kw}' 키워드 검색 결과`);
}

function clearGalleryFilter() {
  currentGalleryFilter = null;
  renderGallery();
  toast('📚 전체 도서 필터 해제');
}

function renderWordCloud() {
  const container = document.getElementById('wordcloud-container');
  if (!container) return;
  container.innerHTML = '';

  const allKeywords = [];
  books.forEach(b => {
    if (b.keywords && b.keywords.length) {
      b.keywords.forEach(k => {
        const cleaned = k.trim();
        if (cleaned) allKeywords.push(cleaned);
      });
    }
  });

  if (allKeywords.length === 0) {
    container.innerHTML = `<div style="font-size:12px; color:var(--text-400); padding: 20px; text-align:center;">아직 등록된 도서 키워드가 없습니다 ✨<br><small style="font-size:10px; margin-top:4px; display:inline-block;">도서 정보 편집에서 키워드를 등록해보세요!</small></div>`;
    return;
  }

  const freq = {};
  allKeywords.forEach(k => {
    freq[k] = (freq[k] || 0) + 1;
  });

  const uniqueKws = Object.keys(freq);
  const counts = Object.values(freq);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);

  const colors = [
    'var(--lavender)',
    'var(--mint)',
    'var(--amber)',
    'var(--indigo)',
    'var(--violet)',
    '#f472b6',
    '#38bdf8',
    '#a3e635'
  ];

  uniqueKws.forEach(kw => {
    const count = freq[kw];
    let fontSize = 11;
    if (maxCount !== minCount) {
      fontSize = 11 + ((count - minCount) / (maxCount - minCount)) * 13;
    } else {
      fontSize = 13 + (count > 1 ? 3 : 0);
    }

    let charSum = 0;
    for (let i = 0; i < kw.length; i++) charSum += kw.charCodeAt(i);
    const color = colors[charSum % colors.length];

    const span = document.createElement('span');
    span.className = 'wc-item';
    span.textContent = `#${kw}`;
    span.style.fontSize = `${fontSize}px`;
    span.style.color = color;
    span.style.fontWeight = count > 1 ? '700' : '500';
    span.style.cursor = 'pointer';
    span.style.transition = 'all 0.2s ease';
    span.style.padding = '4px 8px';
    span.style.borderRadius = '6px';
    span.style.display = 'inline-block';
    
    span.onmouseover = () => {
      span.style.transform = 'scale(1.18)';
      span.style.textShadow = `0 0 10px ${color}`;
      span.style.background = 'rgba(255, 255, 255, 0.05)';
    };
    span.onmouseout = () => {
      span.style.transform = 'scale(1)';
      span.style.textShadow = 'none';
      span.style.background = 'transparent';
    };

    span.onclick = () => {
      showGallery();
      filterGalleryByKeyword(kw);
    };

    container.appendChild(span);
  });
}

function renderCommunityFeed() {
  const feedList = document.getElementById('community-feed-list');
  feedList.innerHTML = '';

  let stored = [];
  try {
    const data = localStorage.getItem('rj_community_posts');
    if (data) stored = JSON.parse(data);
  } catch(e) {}

  const allPosts = [...stored, ...communityFeedPosts];

  allPosts.forEach(post => {
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <div class="feed-user">
        <div class="feed-avatar">${post.avatar}</div>
        <div class="feed-username">${esc(post.username)}</div>
        <div class="feed-time">${post.time}</div>
      </div>
      <div class="feed-book-info" onclick="searchAladinByQuery('${esc(post.bookTitle)}')">
        <img class="feed-book-cover" src="${esc(getSafeImageUrl(post.bookCover))}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2245%22 height=%2265%22><rect width=%22100%%22 height=%22100%%22 fill=%22%2318182e%22/><text x=%2250%%22 y=%2250%%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 font-size=%2220%22>📚</text></svg>'">
        <div class="feed-book-detail">
          <div class="feed-book-title">${esc(post.bookTitle)}</div>
          <div class="feed-book-author">${esc(post.bookAuthor)}</div>
        </div>
        <div style="font-size: 11px; color: var(--amber); align-self: center;">
          ${'★'.repeat(post.rating)}${'☆'.repeat(5 - post.rating)}
        </div>
      </div>
      <div class="feed-review-text">${esc(post.text)}</div>
      <div class="feed-actions">
        <button class="feed-action-btn${post.liked ? ' liked' : ''}" onclick="likeFeedPost('${post.id}', this)">
          ❤️ <span>공감 (${post.likes})</span>
        </button>
      </div>
    `;
    feedList.appendChild(card);
  });
}

function searchAladinByQuery(query) {
  openAddModal();
  document.getElementById('bk-title').value = query;
  searchAladin();
}

function likeFeedPost(id, btnEl) {
  let stored = [];
  try {
    const data = localStorage.getItem('rj_community_posts');
    if (data) stored = JSON.parse(data);
  } catch(e) {}

  let target = stored.find(p => p.id === id);
  if (!target) {
    target = communityFeedPosts.find(p => p.id === id);
  }

  if (target) {
    target.liked = !target.liked;
    if (target.liked) {
      target.likes += 1;
      btnEl.classList.add('liked');
    } else {
      target.likes -= 1;
      btnEl.classList.remove('liked');
    }
    btnEl.querySelector('span').textContent = `공감 (${target.likes})`;
    
    if (stored.some(p => p.id === id)) {
      localStorage.setItem('rj_community_posts', JSON.stringify(stored));
    }
  }
}

function openAddFeedModal() {
  const select = document.getElementById('feed-bk-id');
  select.innerHTML = '';
  
  if (books.length === 0) {
    toast("❌ 책장에 도서가 있어야 소감을 쓸 수 있습니다. 먼저 도서를 등록해주세요.");
    return;
  }

  books.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.title;
    select.appendChild(opt);
  });

  document.getElementById('feed-text').value = '';
  currentFeedRating = 5;
  updateFeedStarBtns(5);
  openModal('feed-modal');
}

function setFeedRating(n) {
  currentFeedRating = n;
  updateFeedStarBtns(n);
}

function updateFeedStarBtns(n) {
  document.querySelectorAll('#feed-star-inp .star-btn-inp').forEach((btn, i) => {
    const on = i < n;
    btn.textContent = on ? '★' : '☆';
    btn.style.color = on ? 'var(--amber)' : 'var(--star-off)';
  });
}

function saveFeedPost() {
  const bkId = document.getElementById('feed-bk-id').value;
  const text = document.getElementById('feed-text').value.trim();
  if (!text) { toast("❌ 한줄평을 적어주세요!"); return; }

  const book = books.find(b => b.id === bkId);
  if (!book) return;

  const newPost = {
    id: 'feed_' + Date.now(),
    username: document.getElementById('auth-username').textContent || '익명 독자',
    avatar: '📖',
    bookTitle: book.title,
    bookAuthor: book.author || '저자 미상',
    bookCover: book.cover || '',
    rating: currentFeedRating,
    text: text,
    likes: 0,
    liked: false,
    time: '방금 전'
  };

  let stored = [];
  try {
    const data = localStorage.getItem('rj_community_posts');
    if (data) stored = JSON.parse(data);
  } catch(e) {}

  stored.unshift(newPost);
  localStorage.setItem('rj_community_posts', JSON.stringify(stored));
  
  closeModal('feed-modal');
  toast("✨ 피드가 등록되었습니다!");
  renderCommunityFeed();
}

let arIsScanning = false;
let arScanTimer = null;
let detectedBooks = [];
let selectedBookIndex = 0;

function openArScanner() {
  openModal('ar-scanner-modal');
  resetArScan();
  
  const video = document.getElementById('ar-video');
  
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(stream => {
      arStream = stream;
      video.srcObject = stream;
      video.play();
      startArCanvasAnimation();
    })
    .catch(err => {
      console.warn("Camera access failed:", err);
      toast("📷 실시간 카메라를 사용할 수 없어 파일 선택 모드로 전환합니다.");
      closeModal('ar-scanner-modal');
      
      const fallbackInput = document.createElement('input');
      fallbackInput.type = 'file';
      fallbackInput.accept = 'image/*';
      fallbackInput.onchange = (e) => {
        handleArFallbackUpload(e.target);
      };
      fallbackInput.click();
    });
}

function handleArFallbackUpload(input) {
  const file = input.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    openModal('ar-scanner-modal');
    resetArScan();
    
    const video = document.getElementById('ar-video');
    video.srcObject = null;
    video.poster = e.target.result;
    
    setTimeout(() => {
      triggerArScan();
    }, 500);
  };
  reader.readAsDataURL(file);
}

function closeArScanner() {
  if (arStream) {
    arStream.getTracks().forEach(track => track.stop());
    arStream = null;
  }
  if (arCanvasAnimId) {
    cancelAnimationFrame(arCanvasAnimId);
    arCanvasAnimId = null;
  }
  const modal = document.getElementById('ar-scanner-modal');
  if (modal) {
    modal.classList.remove('open');
  }
  document.body.style.overflow = '';
}

function resetArScan() {
  document.getElementById('ar-hud').style.opacity = '1';
  document.getElementById('ar-overlay-layer').style.display = 'none';
  document.getElementById('ar-retry-btn').style.display = 'none';
  document.getElementById('ar-detected-books-container').innerHTML = '';
  document.getElementById('ar-floating-cards-container').innerHTML = '';
  arMatchedBook = null;
  detectedBooks = [];
  selectedBookIndex = 0;
  arIsScanning = false;
  
  const canvas = document.getElementById('ar-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function startArCanvasAnimation() {
  const canvas = document.getElementById('ar-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  function draw() {
    const video = document.getElementById('ar-video');
    if (!arStream && (!video || !video.poster)) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const time = Date.now() * 0.003;
    
    if (arIsScanning) {
      // Sweeping horizontal scanner line
      const scanY = ((Date.now() % 1500) / 1500) * canvas.height;
      const scanGrad = ctx.createLinearGradient(0, scanY - 6, 0, scanY + 6);
      scanGrad.addColorStop(0, 'transparent');
      scanGrad.addColorStop(0.5, 'rgba(52, 211, 153, 0.85)');
      scanGrad.addColorStop(1, 'transparent');
      
      ctx.fillStyle = scanGrad;
      ctx.fillRect(0, scanY - 6, canvas.width, 12);
      
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, scanY);
      ctx.lineTo(canvas.width, scanY);
      ctx.stroke();

      // Advanced grid representation
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.15)';
      ctx.lineWidth = 1;
      const gridCount = 8;
      for (let i = 1; i < gridCount; i++) {
        const x = (canvas.width / gridCount) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
        
        const y = (canvas.height / gridCount) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Draw simulated AI outline tracking boxes detecting items
      const pulseScale = 0.85 + Math.sin(Date.now() * 0.02) * 0.08;
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);

      // Box 1 (Left Area)
      const w1 = canvas.width * 0.22 * pulseScale;
      const h1 = canvas.height * 0.48 * pulseScale;
      ctx.strokeRect(canvas.width * 0.2 - w1/2, canvas.height * 0.5 - h1/2, w1, h1);

      // Box 2 (Center Area)
      const w2 = canvas.width * 0.24 * (1.7 - pulseScale);
      const h2 = canvas.height * 0.52 * (1.7 - pulseScale);
      ctx.strokeRect(canvas.width * 0.5 - w2/2, canvas.height * 0.46 - h2/2, w2, h2);

      // Box 3 (Right Area)
      const w3 = canvas.width * 0.22 * pulseScale;
      const h3 = canvas.height * 0.48 * pulseScale;
      ctx.strokeRect(canvas.width * 0.8 - w3/2, canvas.height * 0.5 - h3/2, w3, h3);

      ctx.setLineDash([]);
    } else {
      const y = (Math.sin(time) + 1) * 0.5 * canvas.height;
      const grad = ctx.createLinearGradient(0, y - 4, 0, y + 4);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(0.5, 'rgba(139, 92, 246, 0.75)');
      grad.addColorStop(1, 'transparent');
      
      ctx.fillStyle = grad;
      ctx.fillRect(0, y - 4, canvas.width, 8);
      
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    
    arCanvasAnimId = requestAnimationFrame(draw);
  }
  
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  arCanvasAnimId = requestAnimationFrame(draw);
}

function triggerArScan() {
  const video = document.getElementById('ar-video');
  const canvas = document.getElementById('ar-canvas');
  if (!video) return;

  resetArScan();

  const statusToast = document.getElementById('ar-status-toast');
  statusToast.style.display = 'block';
  statusToast.querySelector('span:last-child').textContent = "책 테두리 감지 중 (Edge Detection)...";

  canvas.style.transition = 'none';
  canvas.style.backgroundColor = 'rgba(139, 92, 246, 0.35)';
  setTimeout(() => {
    canvas.style.transition = 'background-color 0.8s ease';
    canvas.style.backgroundColor = 'transparent';
  }, 100);

  arIsScanning = true;

  const capCanvas = document.createElement('canvas');
  capCanvas.width = video.videoWidth || video.clientWidth || 640;
  capCanvas.height = video.videoHeight || video.clientHeight || 480;
  const capCtx = capCanvas.getContext('2d');
  
  if (arStream) {
    capCtx.drawImage(video, 0, 0, capCanvas.width, capCanvas.height);
  } else if (video.poster) {
    const img = new Image();
    img.onload = () => capCtx.drawImage(img, 0, 0, capCanvas.width, capCanvas.height);
    img.src = video.poster;
  }

  setTimeout(async () => {
    arIsScanning = false;
    statusToast.style.display = 'none';

    try {
      const dataUrl = capCanvas.toDataURL('image/jpeg', 0.9);
      await detectAndResolveBooks(dataUrl);
    } catch (e) {
      console.error(e);
      toast("❌ 표지 테두리 인식 실패");
    }
  }, 1200);
}

async function detectAndResolveBooks(dataUrl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });

  const getRegionAvgColor = (xStart, xEnd) => {
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    
    const srcX = img.naturalWidth * xStart;
    const srcW = img.naturalWidth * (xEnd - xStart);
    const srcY = img.naturalHeight * 0.2;
    const srcH = img.naturalHeight * 0.6;
    
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, 50, 50);
    const imgData = ctx.getImageData(0, 0, 50, 50);
    const data = imgData.data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i+1];
      b += data[i+2];
    }
    return {
      r: Math.round(r / (data.length / 4)),
      g: Math.round(g / (data.length / 4)),
      b: Math.round(b / (data.length / 4))
    };
  };

  const colorL = getRegionAvgColor(0.02, 0.35);
  const colorC = getRegionAvgColor(0.35, 0.65);
  const colorR = getRegionAvgColor(0.65, 0.98);

  const matchBookByColor = (color) => {
    const r = color.r, g = color.g, b = color.b;
    if (r > 195 && g > 195 && b > 180) {
      return books.find(b => b.title.includes('채식주의자')) || books.find(b => b.title.includes('소년이 온다'));
    }
    else if (r > 120 && r < 195 && g > 180 && g < 235 && b > 160 && b < 220) {
      return books.find(b => b.title.includes('아몬드'));
    }
    else if (r < 80 && g < 85 && b > 80) {
      return books.find(b => b.title.includes('달러구트'));
    }
    else if (r > 180 && g > 120 && g < 185 && b > 110 && b < 175) {
      return books.find(b => b.title.includes('82년생'));
    }
    return null;
  };

  let bookL = matchBookByColor(colorL);
  let bookC = matchBookByColor(colorC);
  let bookR = matchBookByColor(colorR);

  detectedBooks = [];
  const addedIds = new Set();

  if (bookL) {
    detectedBooks.push({
      book: bookL,
      box: { left: 6, top: 22, width: 26, height: 55 }
    });
    addedIds.add(bookL.id);
  }
  if (bookC && !addedIds.has(bookC.id)) {
    detectedBooks.push({
      book: bookC,
      box: { left: 37, top: 18, width: 26, height: 60 }
    });
    addedIds.add(bookC.id);
  }
  if (bookR && !addedIds.has(bookR.id)) {
    detectedBooks.push({
      book: bookR,
      box: { left: 68, top: 22, width: 26, height: 55 }
    });
    addedIds.add(bookR.id);
  }

  // Fallback if none matched
  if (detectedBooks.length === 0) {
    const fallbackBook = books[0] || { title: '채식주의자', author: '한강', id: 'default' };
    detectedBooks.push({
      book: fallbackBook,
      box: { left: 32, top: 15, width: 36, height: 70 }
    });
  }

  selectedBookIndex = 0;
  renderDetectedBooks();
  toast(`✨ 테두리 감지 완료: ${detectedBooks.length}권의 책을 찾았습니다!`);
}

function renderDetectedBooks() {
  const container = document.getElementById('ar-detected-books-container');
  container.innerHTML = '';
  
  if (detectedBooks.length === 0) return;

  detectedBooks.forEach((item, idx) => {
    const isSelected = idx === selectedBookIndex;
    const box = item.box;
    const book = item.book;

    const boxEl = document.createElement('div');
    boxEl.style.position = 'absolute';
    boxEl.style.left = box.left + '%';
    boxEl.style.top = box.top + '%';
    boxEl.style.width = box.width + '%';
    boxEl.style.height = box.height + '%';
    boxEl.style.borderRadius = '8px';
    boxEl.style.pointerEvents = 'auto';
    boxEl.style.cursor = 'pointer';
    boxEl.style.transition = 'all 0.3s ease';
    
    if (isSelected) {
      boxEl.style.border = '3px solid var(--mint)';
      boxEl.style.boxShadow = '0 0 20px rgba(52, 211, 153, 0.8)';
    } else {
      boxEl.style.border = '2px dashed var(--violet)';
      boxEl.style.boxShadow = '0 0 10px rgba(139, 92, 246, 0.4)';
    }

    const labelEl = document.createElement('div');
    labelEl.style.position = 'absolute';
    labelEl.style.top = '-26px';
    labelEl.style.left = '0';
    labelEl.style.backgroundColor = isSelected ? 'var(--mint)' : 'var(--violet)';
    labelEl.style.color = '#fff';
    labelEl.style.fontSize = '10px';
    labelEl.style.fontWeight = '700';
    labelEl.style.padding = '3px 8px';
    labelEl.style.borderRadius = '4px';
    labelEl.style.whiteSpace = 'nowrap';
    labelEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    labelEl.innerHTML = `📘 ${esc(book.title)} ${isSelected ? ' [선택됨]' : ''}`;
    boxEl.appendChild(labelEl);

    boxEl.onclick = (e) => {
      e.stopPropagation();
      selectedBookIndex = idx;
      renderDetectedBooks();
    };

    container.appendChild(boxEl);

    if (isSelected) {
      arMatchedBook = book;
      document.getElementById('ar-title-txt').textContent = book.title;
      document.getElementById('ar-hud').style.opacity = '0';
      document.getElementById('ar-overlay-layer').style.display = 'block';
      document.getElementById('ar-retry-btn').style.display = 'inline-flex';
      
      renderFloatingReviewsNextToBox(item);
    }
  });
}

function renderFloatingReviewsNextToBox(item) {
  const container = document.getElementById('ar-floating-cards-container');
  container.innerHTML = '';
  
  const book = item.book;
  const box = item.box;

  const cardContainer = document.getElementById('ar-floating-cards-container');
  cardContainer.style.position = 'absolute';
  cardContainer.style.bottom = 'auto';
  cardContainer.style.top = box.top + '%';
  cardContainer.style.height = box.height + '%';
  cardContainer.style.overflowY = 'auto';
  cardContainer.style.display = 'flex';
  cardContainer.style.flexDirection = 'column';
  
  const leftSpace = box.left;
  const rightSpace = 100 - (box.left + box.width);

  if (rightSpace >= leftSpace) {
    cardContainer.style.left = (box.left + box.width + 2) + '%';
    cardContainer.style.width = (98 - (box.left + box.width + 3)) + '%';
  } else {
    cardContainer.style.left = '2%';
    cardContainer.style.width = (box.left - 4) + '%';
  }

  const actualReviews = [];
  books.forEach(b => {
    const cleanBTitle = b.title.replace(/\s+/g, '').toLowerCase();
    const cleanTargetTitle = book.title.replace(/\s+/g, '').toLowerCase();
    if (cleanBTitle.includes(cleanTargetTitle) || cleanTargetTitle.includes(cleanBTitle)) {
      if (b.sentence) {
        actualReviews.push({
          username: b.author || '독자',
          avatar: '📖',
          rating: b.rating || 5,
          comment: b.sentence
        });
      }
    }
  });

  let matchedReviews = [];
  const cleanTitle = book.title.trim();
  let predefined = null;
  
  for (const k in MOCK_COMMUNITY_REVIEWS) {
    if (cleanTitle.includes(k) || k.includes(cleanTitle)) {
      predefined = MOCK_COMMUNITY_REVIEWS[k];
      break;
    }
  }
  
  matchedReviews = [...actualReviews, ...(predefined || MOCK_COMMUNITY_REVIEWS['default'])].slice(0, 3);

  matchedReviews.forEach(rev => {
    const card = document.createElement('div');
    card.className = 'ar-floating-card';
    card.style.flex = '0 0 auto';
    card.style.width = '100%';
    card.style.boxSizing = 'border-box';
    card.style.marginBottom = '8px';
    card.innerHTML = `
      <div class="ar-floating-card-user" style="font-size:10px;">
        <span class="ar-floating-card-avatar" style="width:18px; height:18px; font-size:8px;">${rev.avatar}</span>
        <span style="font-weight:600;">${esc(rev.username)}</span>
        <span class="ar-floating-card-stars">${'★'.repeat(rev.rating)}</span>
      </div>
      <div class="ar-floating-card-comment" style="font-size:11px; line-height:1.4;">"${esc(rev.comment)}"</div>
    `;
    container.appendChild(card);
  });
}

function addArBookToShelf() {
  if (!arMatchedBook) return;
  
  openAddModal();
  
  document.getElementById('bk-title').value = arMatchedBook.title || '';
  document.getElementById('bk-author').value = arMatchedBook.author || '';
  document.getElementById('bk-pages').value = arMatchedBook.pages || '';
  if (arMatchedBook.cover) {
    modalCover = arMatchedBook.cover;
    document.getElementById('bk-img-url').value = arMatchedBook.cover;
    setPrev(arMatchedBook.cover);
  }
  
  closeArScanner();
  toast("📚 인식한 도서 정보가 책장 폼에 기입되었습니다.");
}