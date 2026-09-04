'use strict';

// Supabase Configuration
const supabaseUrl = 'https://guaimwzlmdacerpvsxxw.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1YWltd3psbWRhY2VycHZzeHh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODM1NDIsImV4cCI6MjA5NjY1OTU0Mn0.zF8A_Ul3Y5aIPjZcVTYIj1gUkConuQ-b9eO7EjnoWUE';

// Persistent storage adapter (LocalStorage + SessionStorage + Safe Cookie backup for Mobile & iOS Safari ITP)
const persistentStorage = {
  getItem: (key) => {
    let val = null;
    try {
      val = localStorage.getItem(key);
      if (val) return val;
    } catch (e) {}

    try {
      val = sessionStorage.getItem(key);
      if (val) {
        // Sync to localStorage for persistence
        try { localStorage.setItem(key, val); } catch (e) {}
        return val;
      }
    } catch (e) {}

    try {
      const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + encodeURIComponent(key) + '=([^;]*)'));
      if (match) {
        val = decodeURIComponent(match[1]);
        try { localStorage.setItem(key, val); } catch (e) {}
        try { sessionStorage.setItem(key, val); } catch (e) {}
        return val;
      }
    } catch (e) {}
    return null;
  },
  setItem: (key, value) => {
    try { localStorage.setItem(key, value); } catch (e) {}
    try { sessionStorage.setItem(key, value); } catch (e) {}
    // Only store in cookie if under 3200 chars to strictly prevent browser 4KB cookie silent drop
    try {
      if (value && value.length < 3200) {
        const expDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
        const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; expires=${expDate}; path=/; SameSite=Lax${secureFlag}`;
      }
    } catch (e) {}
  },
  removeItem: (key) => {
    try { localStorage.removeItem(key); } catch (e) {}
    try { sessionStorage.removeItem(key); } catch (e) {}
    try {
      document.cookie = `${encodeURIComponent(key)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
    } catch (e) {}
  }
};

let supabaseClient = null;
try {
  if (window.supabase) {
    supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey, {
      auth: {
        storage: persistentStorage,
        storageKey: 'rj_8ook_auth_token',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce'
      }
    });
  } else {
    console.warn("Supabase SDK not loaded. Operating in LocalStorage-only mode.");
  }
} catch (e) {
  console.error("Supabase initialization failed:", e);
}

const DB_SQL_SCRIPT = `create table if not exists books (
  id text primary key,
  title text not null,
  author text,
  pages integer default 0,
  date text,
  sentence text,
  cover text,
  spineCover text,
  rating integer default 0,
  scraps jsonb default '[]'::jsonb,
  keywords text[] default '{}'::text[],
  created_at timestamptz default now(),
  user_id uuid default auth.uid()
);

-- 기존 테이블에 spineCover 컬럼이 없다면 추가
alter table books add column if not exists "spineCover" text;

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
let isDarkTheme = false;
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
      let { error: syncError } = await supabaseClient
        .from('books')
        .upsert(booksToUpload, { onConflict: 'id' });
      if (syncError && (syncError.code === 'PGRST204' || String(syncError.message).includes('spineCover'))) {
        const safeBooksToUpload = booksToUpload.map(({ spineCover, ...rest }) => rest);
        const res = await supabaseClient
          .from('books')
          .upsert(safeBooksToUpload, { onConflict: 'id' });
        syncError = res.error;
      }
      if (!syncError) {
        books = booksToUpload;
        toast('기존 로컬 책장 데이터를 Supabase에 동기화했습니다.');
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
    toast('SQL 쿼리가 클립보드에 복사되었습니다.');
  }).catch(err => {
    toast('복사 실패. 직접 드래그하여 복사해주세요.');
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
   THEME (레퍼런스 톤 단일 테마 고정)
============================================== */
function loadTheme() {
  document.body.classList.remove('light-theme');
}

function toggleTheme() {
  // 낮/밤 전환 기능 제거됨 (단일 배경색 고정)
}

function applyTheme() {
  document.body.classList.remove('light-theme');
}

function getSpineWidth(pages) {
  const p = parseInt(pages, 10) || 280;
  // 세로 길이 1.3배(351px) 기준 슬림한 기본 두께
  let w = Math.round(18 + (p * 0.055));
  if (w < 24) w = 24;
  if (w > 78) w = 78;
  return w;
}

function adjustSpineCardWidth(img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const card = img.closest('.book-card.spine-mode');
  if (!card) return;
  const h = 351; // 1.3배 세로 높이
  // 알라딘에서 실제 불러온 원본 이미지의 가로/세로 비율 100% 그대로 적용
  const ratio = img.naturalWidth / img.naturalHeight;
  let w = Math.round(h * ratio);
  if (w < 16) w = 16;
  card.style.width = w + 'px';
  card.style.setProperty('--spine-w', w + 'px');
}

function getGalleryViewMode() {
  try {
    const m = localStorage.getItem('rj_gallery_view_mode');
    if (m === 'spine') return 'spine-month';
    return m || 'spine-month';
  } catch(e) {
    return 'spine-month';
  }
}

let galleryViewMode = (function() {
  try {
    const m = localStorage.getItem('rj_gallery_view_mode');
    if (m === 'spine') return 'spine-month';
    return m || 'spine-month';
  } catch(e) {
    return 'spine-month';
  }
})();

function getSpineImageUrl(url) {
  if (!url) return '';
  if (url.includes('image.aladin.co.kr')) {
    const m = url.match(/\/product\/(\d+)\/(\d+)\/(?:cover\d*|coversum|cover|letslook)\/([^/?#]+)/i);
    if (m) {
      const dir1 = m[1];
      const dir2 = m[2];
      let filename = m[3];
      // Strip extension (.jpg, .png, etc)
      filename = filename.replace(/\.[a-zA-Z0-9]+$/, '');
      // Strip trailing _1, _2, _3, _b, _f, _spine
      filename = filename.replace(/_[0-9a-zA-Z]+$/, '');
      if (filename) {
        return getSafeImageUrl(`https://image.aladin.co.kr/product/${dir1}/${dir2}/Spine/${filename}_d.jpg`);
      }
    }
  }
  return '';
}

function getSpineTheme(book) {
  const spineThemes = [
    { bg: '#f8f6f0', text: '#111827', authorColor: '#374151', border: '#d1cdc3', tagBg: '#111827', tagText: '#f9fafb', isLight: true },
    { bg: '#1c2838', text: '#e2edee', authorColor: '#a0b2c6', border: '#2d3e54', tagBg: '#d4af37', tagText: '#1c2838', isLight: false },
    { bg: '#233830', text: '#e6f4ed', authorColor: '#9ec4b3', border: '#345247', tagBg: '#e6f4ed', tagText: '#233830', isLight: false },
    { bg: '#ede6d4', text: '#1c1917', authorColor: '#44403c', border: '#d6cbaf', tagBg: '#7f1d1d', tagText: '#fef2f2', isLight: true },
    { bg: '#4a151b', text: '#fce8ea', authorColor: '#e0a3aa', border: '#6e222a', tagBg: '#fce8ea', tagText: '#4a151b', isLight: false },
    { bg: '#1e1e24', text: '#f0f0f5', authorColor: '#9e9ea6', border: '#33333d', tagBg: '#8c6239', tagText: '#ffffff', isLight: false }
  ];
  let hash = 0;
  const str = (book.title || '') + (book.id || '');
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % spineThemes.length;
  return spineThemes[idx];
}

function setGalleryViewMode(mode) {
  if (mode === 'spine') mode = 'spine-month';
  galleryViewMode = mode;
  try { localStorage.setItem('rj_gallery_view_mode', mode); } catch(e) {}
  updateViewModeButtons();
  renderGallery();
}

function updateViewModeButtons() {
  const btnMonth = document.getElementById('btn-view-month');
  const btnYear = document.getElementById('btn-view-year');
  const btnStars = document.getElementById('btn-view-stars');
  const btnCover = document.getElementById('btn-view-cover');
  const resetBtn = (btn) => {
    if (!btn) return;
    btn.style.background = 'transparent';
    btn.style.color = 'var(--text-300)';
    btn.style.fontWeight = '400';
    btn.style.boxShadow = 'none';
  };
  [btnMonth, btnYear, btnStars, btnCover].forEach(resetBtn);

  if (galleryViewMode === 'stars' && btnStars) {
    btnStars.style.background = 'linear-gradient(135deg, #c97a2b 0%, #a6601e 100%)';
    btnStars.style.color = '#fff';
    btnStars.style.fontWeight = '700';
    btnStars.style.boxShadow = '0 2px 8px rgba(201, 122, 43, 0.4)';
  } else if (galleryViewMode === 'cover' && btnCover) {
    btnCover.style.background = 'var(--violet)';
    btnCover.style.color = '#fff';
    btnCover.style.fontWeight = '600';
  } else if (galleryViewMode === 'spine-year' && btnYear) {
    btnYear.style.background = 'var(--violet)';
    btnYear.style.color = '#fff';
    btnYear.style.fontWeight = '600';
  } else if (btnMonth) {
    btnMonth.style.background = 'var(--violet)';
    btnMonth.style.color = '#fff';
    btnMonth.style.fontWeight = '600';
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.book-card.spine-mode')) {
    document.querySelectorAll('.book-card.spine-mode.is-hovered').forEach(card => {
      card.classList.remove('is-hovered');
    });
  }
});

/* ==============================================
   GALLERY
============================================== */
function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('gallery-empty');
  grid.innerHTML = '';

  updateViewModeButtons();
  const isSpineShelf = galleryViewMode === 'spine' || galleryViewMode === 'spine-month' || galleryViewMode === 'spine-year' || galleryViewMode === 'stars';
  grid.classList.toggle('spine-view', isSpineShelf);

  // Handle Search Input display
  const searchInput = document.getElementById('gallery-search-input');
  const searchQuery = (searchInput ? searchInput.value : '').trim().toLowerCase();
  const clearBtn = document.getElementById('gallery-search-clear');
  if (clearBtn) {
    clearBtn.style.display = searchQuery ? 'flex' : 'none';
  }

  // If stars view is active, prepend 5-star banner
  if (galleryViewMode === 'stars') {
    const starCount = books.filter(b => b.rating === 5).length;
    const starsBanner = document.createElement('div');
    starsBanner.className = 'stars-shelf-banner';
    starsBanner.style.cssText = 'grid-column: 1 / -1; width: 100%; background: linear-gradient(135deg, rgba(201, 122, 43, 0.12) 0%, rgba(166, 96, 30, 0.05) 100%); border: 1px solid rgba(201, 122, 43, 0.3); border-radius: var(--radius-md); padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--text-100); margin-bottom: 8px; box-sizing: border-box;';
    starsBanner.innerHTML = `
      <span style="display:flex; align-items:center; gap:8px;">
        <strong>인생작 책장</strong>
        <span style="font-size:11px; opacity:0.8; color:var(--amber);">(★ 5.0)</span>
        <span class="shelf-year-count" style="margin-left:2px; font-weight:700; color:var(--amber); background:rgba(201,122,43,0.15);">${starCount}권</span>
        <button class="shelf-download-btn" onclick="downloadStarsShelfImage()" title="인생작 책장 이미지 저장" aria-label="인생작 책장 이미지 저장" style="color:var(--amber); opacity:0.75;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v12"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
          </svg>
        </button>
      </span>
      <div style="display:flex; align-items:center; gap:6px;">
        <button class="btn btn-ghost btn-xs" onclick="setGalleryViewMode('spine-month')" style="font-size:11px; color:var(--text-300); cursor:pointer; height:24px; padding:0 8px;">책장 보기 ✕</button>
      </div>
    `;
    grid.appendChild(starsBanner);
  }

  // If filter is active, prepend a filter banner / indicator card
  if (currentGalleryFilter) {
    const filterCard = document.createElement('div');
    filterCard.className = 'filter-info-card';
    filterCard.style.cssText = 'grid-column: 1 / -1; width: 100%; background: var(--glass); border: 1px solid var(--violet); border-radius: var(--radius-md); padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--text-200); margin-bottom: 4px; box-sizing: border-box;';
    filterCard.innerHTML = `
      <span style="display:flex; align-items:center; gap:6px;"><strong>#${esc(currentGalleryFilter)}</strong> 태그 도서</span>
      <button class="btn btn-ghost btn-sm" onclick="clearGalleryFilter()" style="padding: 2px 8px; border-radius: 4px; font-size:11px; height:22px; line-height:1; cursor:pointer;">필터 해제 ✕</button>
    `;
    grid.appendChild(filterCard);
  }

  // Filter books
  let displayBooks = books;
  if (galleryViewMode === 'stars') {
    displayBooks = displayBooks.filter(b => b.rating === 5);
  }
  if (currentGalleryFilter) {
    displayBooks = displayBooks.filter(b => b.keywords && b.keywords.includes(currentGalleryFilter));
  }

  if (searchQuery) {
    displayBooks = displayBooks.filter(b => {
      const titleMatch = b.title && b.title.toLowerCase().includes(searchQuery);
      const authorMatch = b.author && b.author.toLowerCase().includes(searchQuery);
      const keywordMatch = b.keywords && b.keywords.some(k => k.toLowerCase().includes(searchQuery));
      const sentenceMatch = b.sentence && b.sentence.toLowerCase().includes(searchQuery);
      return titleMatch || authorMatch || keywordMatch || sentenceMatch;
    });
  }

  if (!displayBooks.length) {
    empty.classList.add('show');
    if (searchQuery) {
      empty.querySelector('.empty-icon').textContent = 'SEARCH';
      empty.querySelector('.empty-h').textContent = '검색 결과가 없습니다';
      empty.querySelector('.empty-p').innerHTML = `"${esc(searchQuery)}"에 매칭되는 책을 찾지 못했어요.<br>다른 검색어로 검색해 보세요.`;
    } else if (galleryViewMode === 'stars') {
      empty.querySelector('.empty-icon').textContent = 'FAVORITES';
      empty.querySelector('.empty-h').textContent = '아직 등록된 인생작이 없어요';
      empty.querySelector('.empty-p').innerHTML = '도서를 기록하거나 수정할 때 <strong>별점 5점(★★★★★)</strong>을 부여하면<br>이곳 인생작 전용 서재에 소중히 모아집니다.';
    } else if (currentGalleryFilter) {
      empty.querySelector('.empty-icon').textContent = 'FILTER';
      empty.querySelector('.empty-h').textContent = '필터 결과가 없습니다';
      empty.querySelector('.empty-p').innerHTML = `#${esc(currentGalleryFilter)} 태그를 가진 책이 없습니다.`;
    } else {
      empty.querySelector('.empty-icon').textContent = '8ook.';
      empty.querySelector('.empty-h').textContent = '아직 기록된 책이 없어요';
      empty.querySelector('.empty-p').innerHTML = '상단의 <strong>＋</strong> 버튼으로 첫 번째 책을 기록해보세요.';
    }
  } else {
    empty.classList.remove('show');
  }

  const sortedBooks = [...displayBooks].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  if (isSpineShelf) {
    const shelfContainer = document.createElement('div');
    shelfContainer.className = 'yearly-shelves-container';

    // 인생작 책장: 연도별/월별 구분 없이 단 하나의 선반(한 책장)에 모두 모아서 렌더링
    if (galleryViewMode === 'stars') {
      const shelfRow = document.createElement('div');
      shelfRow.className = 'spine-shelf-row';
      enableSpineShelfWheel(shelfRow);

      sortedBooks.forEach((book, i) => {
        const card = createBookCardElement(book, i, true);
        shelfRow.appendChild(card);
      });

      shelfContainer.appendChild(shelfRow);
      grid.appendChild(shelfContainer);

      requestAnimationFrame(() => {
        shelfContainer.querySelectorAll('.spine-real-img').forEach(img => {
          if (img.complete && img.naturalWidth) {
            adjustSpineCardWidth(img);
          }
        });
      });
      return;
    }

    // 연도별 책장 렌더링
    if (galleryViewMode === 'spine-year') {
      const yearGroups = {};
      sortedBooks.forEach(book => {
        let yKey = '기타';
        if (book.date) {
          const d = new Date(book.date);
          const y = d.getFullYear();
          if (!isNaN(y)) {
            yKey = String(y);
          }
        }
        if (!yearGroups[yKey]) yearGroups[yKey] = [];
        yearGroups[yKey].push(book);
      });

      const yearKeys = Object.keys(yearGroups).sort((a, b) => {
        if (a === '기타') return 1;
        if (b === '기타') return -1;
        return b.localeCompare(a);
      });

      let globalIndex = 0;

      yearKeys.forEach(yKey => {
        const yearSection = document.createElement('div');
        yearSection.className = 'shelf-year-section';

        const booksInYear = yearGroups[yKey];
        const yearLabel = yKey !== '기타' ? `${yKey}년` : '완독일 미정';

        const header = document.createElement('div');
        header.className = 'shelf-year-header';
        header.innerHTML = `
          <div class="shelf-year-badge">
            <span class="shelf-year-title">${yearLabel}</span>
            <span class="shelf-year-count">${booksInYear.length}권</span>
          </div>
          <div class="shelf-year-line"></div>
        `;
        yearSection.appendChild(header);

        const shelfRow = document.createElement('div');
        shelfRow.className = 'spine-shelf-row';
        enableSpineShelfWheel(shelfRow);

        booksInYear.forEach(book => {
          const card = createBookCardElement(book, globalIndex++, true);
          shelfRow.appendChild(card);
        });

        yearSection.appendChild(shelfRow);
        shelfContainer.appendChild(yearSection);
      });

      grid.appendChild(shelfContainer);

      requestAnimationFrame(() => {
        shelfContainer.querySelectorAll('.spine-real-img').forEach(img => {
          if (img.complete && img.naturalWidth) {
            adjustSpineCardWidth(img);
          }
        });
      });
      return;
    }

    // 기본: 월별(연-월) 층 선반 렌더링
    const monthGroups = {};
    sortedBooks.forEach(book => {
      let ymKey = '기타';
      if (book.date) {
        const d = new Date(book.date);
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        if (!isNaN(y) && !isNaN(m)) {
          ymKey = `${y}-${String(m).padStart(2, '0')}`;
        }
      }
      if (!monthGroups[ymKey]) monthGroups[ymKey] = [];
      monthGroups[ymKey].push(book);
    });

    const monthKeys = Object.keys(monthGroups).sort((a, b) => {
      if (a === '기타') return 1;
      if (b === '기타') return -1;
      return b.localeCompare(a);
    });

    let globalIndex = 0;

    monthKeys.forEach(ymKey => {
      const monthSection = document.createElement('div');
      monthSection.className = 'shelf-year-section';

      const booksInMonth = monthGroups[ymKey];
      let monthLabel = '완독일 미정';
      if (ymKey !== '기타') {
        const parts = ymKey.split('-');
        monthLabel = `${parts[0]}년 ${parseInt(parts[1], 10)}월`;
      }

      const header = document.createElement('div');
      header.className = 'shelf-year-header';
      header.innerHTML = `
        <div class="shelf-year-badge">
          <span class="shelf-year-title">${monthLabel}</span>
          <span class="shelf-year-count">${booksInMonth.length}권</span>
          <button class="shelf-download-btn" onclick="downloadMonthShelfImage('${esc(ymKey)}', '${esc(monthLabel)}')" title="${esc(monthLabel)} 책장 이미지 저장" aria-label="책장 이미지 저장">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v12"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
            </svg>
          </button>
        </div>
        <div class="shelf-year-line"></div>
      `;
      monthSection.appendChild(header);

      const shelfRow = document.createElement('div');
      shelfRow.className = 'spine-shelf-row';
      enableSpineShelfWheel(shelfRow);

      booksInMonth.forEach(book => {
        const card = createBookCardElement(book, globalIndex++, true);
        shelfRow.appendChild(card);
      });

      monthSection.appendChild(shelfRow);
      shelfContainer.appendChild(monthSection);
    });

    grid.appendChild(shelfContainer);

    // Sync already-cached spine images immediately
    requestAnimationFrame(() => {
      shelfContainer.querySelectorAll('.spine-real-img').forEach(img => {
        if (img.complete && img.naturalWidth) {
          adjustSpineCardWidth(img);
        }
      });
    });
    return;
  }

  sortedBooks.forEach((book, i) => {
    const card = createBookCardElement(book, i, false);
    grid.appendChild(card);
  });
}

function enableSpineShelfWheel(rowEl) {
  if (!rowEl) return;
  rowEl.addEventListener('wheel', (e) => {
    // 가로 스크롤할 내용이 없으면 세로 스크롤 이벤트 그대로 상위로 통과
    if (rowEl.scrollWidth <= rowEl.clientWidth + 2) {
      return;
    }
    // 세로 휠 이동량이 더 클 때
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      const atLeft = rowEl.scrollLeft <= 0;
      const atRight = rowEl.scrollLeft + rowEl.clientWidth >= rowEl.scrollWidth - 2;
      // 끝에 닿았으면 상하 페이지 스크롤 허용
      if ((e.deltaY < 0 && atLeft) || (e.deltaY > 0 && atRight)) {
        return;
      }
      e.preventDefault();
      rowEl.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

function handleQuickAddBook() {
  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 구글 로그인을 진행해주세요.');
    loginWithGoogle();
    return;
  }
  openAddModal();
}

async function downloadMonthShelfImage(ymKey, monthLabel) {
  let targetBooks = [];
  if (ymKey === '기타') {
    targetBooks = books.filter(b => {
      if (!b.date) return true;
      const d = new Date(b.date);
      return isNaN(d.getFullYear()) || isNaN(d.getMonth());
    });
  } else {
    targetBooks = books.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (isNaN(y) || isNaN(m)) return false;
      return `${y}-${String(m).padStart(2, '0')}` === ymKey;
    });
  }

  targetBooks.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  if (!targetBooks.length) {
    toast('저장할 도서가 없습니다.');
    return;
  }

  const subtitle = `총 ${targetBooks.length}권 완독 · ${targetBooks.reduce((sum, b) => sum + (parseInt(b.pages, 10) || 0), 0)}페이지`;
  await generateShelfImage(targetBooks, `${monthLabel} 독서 서재`, subtitle, `8ook_${monthLabel.replace(/[^\w가-힣]/g, '_')}_책장`);
}

async function downloadYearShelfImage(yKey, yearLabel) {
  let targetBooks = [];
  if (yKey === '기타') {
    targetBooks = books.filter(b => {
      if (!b.date) return true;
      const d = new Date(b.date);
      return isNaN(d.getFullYear());
    });
  } else {
    targetBooks = books.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return String(d.getFullYear()) === yKey;
    });
  }

  targetBooks.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  if (!targetBooks.length) {
    toast('저장할 도서가 없습니다.');
    return;
  }

  const subtitle = `총 ${targetBooks.length}권 완독 · ${targetBooks.reduce((sum, b) => sum + (parseInt(b.pages, 10) || 0), 0)}페이지`;
  await generateShelfImage(targetBooks, `${yearLabel} 독서 서재`, subtitle, `8ook_${yearLabel.replace(/[^\w가-힣]/g, '_')}_책장`);
}

async function downloadStarsShelfImage() {
  const targetBooks = books.filter(b => b.rating === 5);
  targetBooks.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  if (!targetBooks.length) {
    toast('저장할 인생작 도서가 없습니다.');
    return;
  }

  const subtitle = `나만의 인생작 (★ 5점 컬렉션) · 총 ${targetBooks.length}권 완독`;
  await generateShelfImage(targetBooks, '인생작 명예의 전당 (8ook Collection)', subtitle, '8ook_인생작_책장');
}

async function generateShelfImage(targetBooks, shelfTitle, subtitle, filename) {
  toast('인스타그램용 책장 이미지를 생성하는 중입니다...');

  try {
    const dpr = 2;

    // 1. 책등 이미지 사전 로드 및 종횡비(aspect) 계산
    const loadedItems = await Promise.all(targetBooks.map(book => {
      const spineImgUrl = book.spineCover || book.spine || getSpineImageUrl(book.cover);
      if (!spineImgUrl) {
        const rawW = getSpineWidth(book.pages);
        return Promise.resolve({ book, img: null, aspect: rawW / 351 });
      }

      return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        let proxyUrl = spineImgUrl;
        if (!spineImgUrl.startsWith('data:') && !spineImgUrl.startsWith('blob:')) {
          proxyUrl = 'https://wsrv.nl/?url=' + encodeURIComponent(spineImgUrl);
        }

        const onDone = (loadedImg) => {
          if (loadedImg && loadedImg.naturalWidth && loadedImg.naturalHeight) {
            const aspect = loadedImg.naturalWidth / loadedImg.naturalHeight;
            // 실물 책등 비율 안전 제한: 0.08 ~ 0.32
            const clampedAspect = Math.max(0.08, Math.min(0.32, aspect));
            resolve({ book, img: loadedImg, aspect: clampedAspect });
          } else {
            const rawW = getSpineWidth(book.pages);
            resolve({ book, img: null, aspect: rawW / 351 });
          }
        };

        img.onload = () => onDone(img);
        img.onerror = () => {
          const fallbackImg = new Image();
          fallbackImg.crossOrigin = 'anonymous';
          fallbackImg.onload = () => onDone(fallbackImg);
          fallbackImg.onerror = () => onDone(null);
          fallbackImg.src = spineImgUrl;
        };
        img.src = proxyUrl;
      });
    }));

    // 2. 인스타그램용 1:1 완벽 정사각형 규격 (1080 x 1080)
    const S = 1080;
    const count = loadedItems.length;
    const sumAspect = loadedItems.reduce((acc, item) => acc + item.aspect, 0);

    // 미니멀 헤더/푸터 여백
    const paddingX = Math.round(S * 0.06); // 약 65px
    const topMargin = Math.round(S * 0.10); // 약 108px
    const bottomMargin = Math.round(S * 0.08); // 약 86px

    const availW = S - paddingX * 2; // 약 950px
    const availH = S - topMargin - bottomMargin; // 약 886px

    // 책 간격
    const gap = Math.max(3, Math.round(S * 0.0035));

    // 책장을 최대한 크게(Maximize) 하기 위한 bookH 계산:
    const maxHByWidth = (availW - (count - 1) * gap) / sumAspect;
    const maxHByHeight = availH * 0.94; // 약 830px

    let bookH = Math.min(maxHByWidth, maxHByHeight);
    if (count <= 3) {
      bookH = Math.min(820, maxHByHeight);
    } else if (bookH > 820) {
      bookH = 820;
    }

    // 각 책의 최종 너비 계산
    const itemsWithWidth = loadedItems.map(item => ({
      ...item,
      width: Math.round(item.aspect * bookH)
    }));

    const totalBooksW = itemsWithWidth.reduce((acc, item) => acc + item.width, 0) + (count - 1) * gap;

    // 1:1 정사각형 캔버스 생성
    const canvas = document.createElement('canvas');
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 3. 배경 그리기 (책장 배경과 동일한 색상 그라데이션 - 웜 베이지 & 크라프트 아이보리)
    const bgGrad = ctx.createLinearGradient(0, 0, 0, S);
    bgGrad.addColorStop(0, '#f7f4ee');
    bgGrad.addColorStop(0.5, '#f3eee5');
    bgGrad.addColorStop(1, '#eae3d7');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, S, S);

    // 은은한 우드 선샤인 앰비언트 글로우
    const glow = ctx.createRadialGradient(S * 0.82, 0, 10, S * 0.82, 0, S * 0.7);
    glow.addColorStop(0, 'rgba(140, 98, 57, 0.06)');
    glow.addColorStop(1, 'rgba(245, 240, 232, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);

    // 4. 인스타그램 감성 미니멀 헤더
    let displayTitle = shelfTitle;
    const ymMatch = shelfTitle.match(/(\d{4})년\s*(\d{1,2})월/);
    const yMatch = shelfTitle.match(/(\d{4})년/);
    if (ymMatch) {
      displayTitle = `${ymMatch[1]}. ${String(ymMatch[2]).padStart(2, '0')}`;
    } else if (yMatch) {
      displayTitle = `${yMatch[1]} Bookshelf`;
    } else if (shelfTitle.includes('인생작')) {
      displayTitle = 'My Favorites';
    }

    // 상단 좌측: 감성 타이포그래피 (딥 에스프레소 차콜)
    ctx.fillStyle = '#231d17';
    ctx.font = `600 21px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Noto Serif KR", serif`;
    ctx.fillText(displayTitle, paddingX, 62);

    // 상단 우측: 미니멀한 8ook. 로고 (우드 크라프트 브라운)
    ctx.fillStyle = '#8c6239';
    ctx.font = `800 21px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText('8ook.', S - paddingX, 62);
    ctx.textAlign = 'left';

    // 5. 책등 렌더링 (화면 정중앙에 최대 크기로 배치)
    const scale = bookH / 351;
    let curX = Math.round((S - totalBooksW) / 2);
    // 수직 중앙 정렬: 상단 헤더와 하단 푸터 사이의 완벽한 중앙 배치
    const startY = Math.round(topMargin + (availH - bookH) / 2);

    // 책장 바닥 라인 및 은은한 선반 그림자
    const shelfBaseY = startY + bookH;
    const shadowGrad = ctx.createLinearGradient(0, shelfBaseY, 0, shelfBaseY + 18 * scale);
    shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.14)');
    shadowGrad.addColorStop(0.35, 'rgba(0, 0, 0, 0.04)');
    shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(curX - 20 * scale, shelfBaseY, totalBooksW + 40 * scale, 18 * scale);

    itemsWithWidth.forEach(item => {
      const { book, img, width: w } = item;

      const drawCardPath = () => {
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(curX, startY, w, bookH, [3 * scale, 3 * scale, 0, 0]);
        } else {
          ctx.rect(curX, startY, w, bookH);
        }
      };

      if (img) {
        ctx.save();
        drawCardPath();
        ctx.clip();
        ctx.drawImage(img, curX, startY, w, bookH);

        const shadeGrad = ctx.createLinearGradient(curX, 0, curX + w, 0);
        shadeGrad.addColorStop(0, 'rgba(0, 0, 0, 0.18)');
        shadeGrad.addColorStop(0.2, 'rgba(255, 255, 255, 0.08)');
        shadeGrad.addColorStop(0.8, 'rgba(0, 0, 0, 0.02)');
        shadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
        ctx.fillStyle = shadeGrad;
        ctx.fillRect(curX, startY, w, bookH);
        ctx.restore();
      } else {
        const theme = getSpineTheme(book);
        ctx.save();
        drawCardPath();
        ctx.clip();

        ctx.fillStyle = theme.bg || '#1e1e2d';
        ctx.fillRect(curX, startY, w, bookH);

        const tagW = Math.round(24 * scale);
        const tagH = Math.round(15 * scale);
        ctx.fillStyle = theme.tagBg || '#8c6239';
        ctx.fillRect(curX + (w - tagW) / 2, startY + 2 * scale, tagW, tagH);
        ctx.fillStyle = theme.tagText || '#ffffff';
        ctx.font = `bold ${Math.round(8 * scale)}px "Noto Sans KR", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('8ook', curX + w / 2, startY + 13 * scale);

        const title = book.title || '';
        let titleFontSize = 13 * scale;
        let lineSpacing = 16 * scale;
        if (title.length > 15) {
          titleFontSize = 10.5 * scale;
          lineSpacing = 13 * scale;
        } else if (title.length > 10) {
          titleFontSize = 11.5 * scale;
          lineSpacing = 14.5 * scale;
        }

        ctx.fillStyle = theme.text || '#ffffff';
        ctx.font = `bold ${titleFontSize}px "Noto Serif KR", Batang, serif`;
        ctx.textAlign = 'center';

        let textY = startY + 28 * scale;
        const maxTextY = startY + 250 * scale;
        for (let c = 0; c < title.length; c++) {
          if (textY > maxTextY) {
            ctx.fillText('…', curX + w / 2, textY);
            break;
          }
          ctx.fillText(title[c], curX + w / 2, textY);
          textY += lineSpacing;
        }

        const author = book.author || '';
        if (author) {
          ctx.fillStyle = theme.authorColor || 'rgba(255,255,255,0.6)';
          ctx.font = `${Math.round(10 * scale)}px "Noto Serif KR", Batang, serif`;
          let authorY = startY + 270 * scale;
          ctx.fillText('✻', curX + w / 2, authorY);
          authorY += 12 * scale;
          for (let c = 0; c < Math.min(author.length, 5); c++) {
            ctx.fillText(author[c], curX + w / 2, authorY);
            authorY += 12 * scale;
          }
        }

        ctx.strokeStyle = theme.text || '#ffffff';
        ctx.lineWidth = Math.max(1, 1 * scale);
        ctx.beginPath();
        ctx.arc(curX + w / 2, startY + bookH - 24 * scale, 6 * scale, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = theme.text || '#ffffff';
        ctx.font = `bold ${Math.round(8 * scale)}px "Noto Serif KR", serif`;
        ctx.fillText('8ook', curX + w / 2, startY + bookH - 8 * scale);

        const spineShade = ctx.createLinearGradient(curX, 0, curX + w, 0);
        spineShade.addColorStop(0, 'rgba(255,255,255,0.14)');
        spineShade.addColorStop(0.5, 'rgba(0,0,0,0)');
        spineShade.addColorStop(1, 'rgba(0,0,0,0.28)');
        ctx.fillStyle = spineShade;
        ctx.fillRect(curX, startY, w, bookH);

        ctx.restore();
      }

      // 별점 5점 뱃지
      if (book.rating === 5) {
        ctx.save();
        const starX = curX + w / 2;
        const starY = startY + 16 * scale;
        const starR = 9.5 * scale;

        const starGrad = ctx.createRadialGradient(starX - 2 * scale, starY - 2 * scale, 1, starX, starY, starR);
        starGrad.addColorStop(0, '#fbbf24');
        starGrad.addColorStop(1, '#b45309');
        ctx.fillStyle = starGrad;
        ctx.beginPath();
        ctx.arc(starX, starY, starR, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 0.8 * scale;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(10.5 * scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', starX, starY + 0.5 * scale);
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
      }

      curX += w + gap;
    });

    // 6. 하단: 인스타그램 감성 미니멀 워터마크
    ctx.fillStyle = 'rgba(24, 24, 27, 0.40)';
    ctx.font = `500 12px -apple-system, BlinkMacSystemFont, "Noto Sans KR", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${count} books read`, S / 2, S - 36);
    ctx.textAlign = 'left';

    // 7. PNG 다운로드 실행
    canvas.toBlob(blob => {
      if (!blob) {
        toast('이미지 변환에 실패했습니다.');
        return;
      }
      const blobUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.href = blobUrl;
      downloadLink.download = `${filename}.png`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(blobUrl);
      toast(`${shelfTitle} 이미지가 저장되었습니다!`);
    }, 'image/png');

  } catch (err) {
    console.error('Failed to generate shelf image:', err);
    toast('책장 이미지 생성 중 오류가 발생했습니다.');
  }
}

function createMonthDivider(month) {
  const div = document.createElement('div');
  div.className = 'spine-month-divider';
  div.setAttribute('title', `${month}월 완독`);
  div.innerHTML = `
    <div class="month-tab-badge">
      <span class="month-num">${month}</span>
      <span class="month-txt">월</span>
    </div>
    <div class="month-divider-stem"></div>
  `;
  return div;
}

function createBookCardElement(book, i, isSpineMode) {
  const card = document.createElement('div');
  card.className = `book-card${isSpineMode ? ' spine-mode' : ''}${book.rating === 5 ? ' five-stars' : ''}`;
  card.style.animationDelay = ((i + 1) * 0.03) + 's';
  card.setAttribute('data-id', book.id);
  const hasPages = Boolean(book.pages && parseInt(book.pages, 10) > 0);
  card.setAttribute('data-has-pages', hasPages ? 'true' : 'false');
  if (hasPages) {
    card.setAttribute('data-pages', String(book.pages));
  }

  let imgPart = '';
  if (book.cover) {
    imgPart = `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}"
      onerror="this.outerHTML='<div class=\\'book-card-placeholder\\'><span class=\\'placeholder-title\\'>${esc(book.title)}</span></div>'">`;
  } else {
    imgPart = `<div class="book-card-placeholder">
      <span class="placeholder-title">${esc(book.title)}</span>
    </div>`;
  }

  const sentence = book.sentence
    ? `<div class="ov-sentence">${esc(book.sentence)}</div>` : '';
  const kingStarBadge = book.rating === 5
    ? `<div class="king-star-badge" title="인생작 (별점 5점)">★</div>` : '';
  const spineGoldStar = book.rating === 5
    ? `<div class="spine-gold-star" title="인생작 (별점 5점)">★</div>` : '';

  if (isSpineMode) {
    const spineW = getSpineWidth(book.pages);
    card.style.width = spineW + 'px';
    card.style.setProperty('--spine-w', spineW + 'px');

    const theme = getSpineTheme(book);
    const titleLen = (book.title || '').length;
    let titleStyleExtra = '';
    if (titleLen > 15) {
      titleStyleExtra = 'font-size: 12.5px; letter-spacing: 1px;';
    } else if (titleLen > 10) {
      titleStyleExtra = 'font-size: 13.5px; letter-spacing: 1.2px;';
    }

    const spineImgUrl = book.spineCover || book.spine || getSpineImageUrl(book.cover);

    const realSpineTag = spineImgUrl
      ? `<img class="spine-real-img" src="${esc(spineImgUrl)}" alt="${esc(book.title)}" onload="adjustSpineCardWidth(this)" onerror="
          if (!this.dataset.tried1 && this.src.includes('/Spine/')) {
            this.dataset.tried1 = 'true';
            this.src = this.src.replace('/Spine/', '/spine/');
          } else {
            this.classList.add('hide-real');
            const fb = this.parentElement ? this.parentElement.querySelector('.spine-custom-view') : null;
            if (fb) fb.classList.add('show-fallback');
          }
        ">`
      : '';

    card.innerHTML = `
      <div class="spine-3d-wrapper">
        <div class="spine-face">
          ${realSpineTag}
          <div class="spine-custom-view${spineImgUrl ? '' : ' show-fallback'}" style="background: ${theme.bg}; color: ${theme.text} !important; border-color: ${theme.border};">
            <div class="spine-series-tag" style="background: ${theme.tagBg}; color: ${theme.tagText} !important;">
              <span>8ook</span>
            </div>
            <div class="spine-title-wrap">
              <span class="spine-title-serif" style="color: ${theme.text} !important; ${theme.isLight ? 'text-shadow: none;' : ''} ${titleStyleExtra}">${esc(book.title)}</span>
            </div>
            <div class="spine-author-wrap">
              <span class="spine-author-serif" style="color: ${theme.authorColor} !important;">✻ ${esc(book.author || '작자 미상')}</span>
            </div>
            <div class="spine-publisher-emblem" style="color: ${theme.text} !important;">
              <div class="emblem-fig" style="border-color: ${theme.text} !important;"></div>
              <span class="publisher-name" style="color: ${theme.text} !important;">8ook</span>
            </div>
          </div>
          ${spineGoldStar}
        </div>
        <div class="cover-face">
          ${imgPart}
          ${kingStarBadge}
          <div class="book-hover-overlay">
            <div class="ov-title">${esc(book.title)}</div>
            <div class="ov-author">${esc(book.author||'')}</div>
            ${sentence}
            ${book.rating ? `<div class="ov-stars">${starsPlain(book.rating)}</div>` : ''}
          </div>
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      if (isTouch) {
        if (!card.classList.contains('is-hovered')) {
          e.stopPropagation();
          document.querySelectorAll('.book-card.spine-mode.is-hovered').forEach(c => {
            if (c !== card) c.classList.remove('is-hovered');
          });
          card.classList.add('is-hovered');
          return;
        }
      }
      showDetail(book.id);
    });
  } else {
    card.innerHTML = `
      ${imgPart}
      ${kingStarBadge}
      <div class="book-hover-overlay">
        <div class="ov-title">${esc(book.title)}</div>
        <div class="ov-author">${esc(book.author||'')}</div>
        ${sentence}
        ${book.rating ? `<div class="ov-stars">${starsPlain(book.rating)}</div>` : ''}
      </div>
    `;

    card.addEventListener('click', () => {
      showDetail(book.id);
    });
  }

  return card;
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
        onerror="this.outerHTML='<div class=\\'detail-thumb-placeholder\\'>8ook</div>'">`
    : `<div class="detail-thumb-placeholder">8ook</div>`;

  const chips = [];
  if (book.pages) chips.push(`<div class="chip">${Number(book.pages).toLocaleString()}p</div>`);
  if (book.date)  chips.push(`<div class="chip">${fmtDate(book.date)}</div>`);
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
          <button class="btn btn-ghost btn-sm" onclick="openEditModal('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:4px; height:22px; line-height:1;">편집</button>
          <button class="btn btn-danger btn-sm" onclick="doDeleteBook('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:22px; line-height:1;">삭제</button>
        </div>
      </div>
      ${book.sentence ? `<div class="detail-sentence">${esc(book.sentence)}</div>` : ''}
    </div>

    <div class="scraps-sec">
      <div class="scraps-hdr" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:10px; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="scraps-htitle">스크랩 문장</div>
          <button class="btn btn-ghost btn-sm" onclick="openScrapModal('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:12px; height:22px; line-height:1;">+ 추가</button>
        </div>
        <div class="scraps-badge" id="scrap-badge">${scrapCount} / 100</div>
      </div>
      <div class="scrap-list" id="scrap-list">${scrapsHtml}</div>
      ${scrapCount === 0
        ? `<div class="scraps-empty">아직 스크랩된 문장이 없습니다.<br>
           <small style="font-size:11px;">상단의 "+ 추가" 버튼으로 문장을 기록해보세요</small></div>`
        : ''}
    </div>
  `;

  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');
  document.getElementById('view-detail').classList.add('show');
  document.getElementById('back-btn').classList.add('show');
  document.getElementById('community-nav-btn').style.display = 'none';
  document.getElementById('view-label').textContent = book.title;
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
  document.getElementById('ocr-result').value = scrap.text;
  document.getElementById('sc-page-ocr').value = scrap.page || '';
  document.getElementById('sc-memo-ocr').value = scrap.memo || '';

  document.getElementById('scrap-modal-title').textContent = '스크랩 수정';
  document.getElementById('scrap-save-btn').textContent = '스크랩 저장';

  switchTab('manual');
  openModal('scrap-modal');
}

function showGallery() {
  closeAppMenu();
  document.getElementById('view-gallery').style.display = '';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');
  document.getElementById('back-btn').classList.remove('show');
  const vl = document.getElementById('view-label');
  if (vl) vl.style.display = 'none';
  currentBookId = null;
  renderGallery();
}

function handleGallerySearch() {
  renderGallery();
}

function clearGallerySearch() {
  const input = document.getElementById('gallery-search-input');
  if (input) {
    input.value = '';
    input.focus();
  }
  renderGallery();
}

function showStats() {
  closeAppMenu();
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.add('show');
  document.getElementById('view-community').classList.remove('show');
  document.getElementById('back-btn').classList.add('show');
  const vl = document.getElementById('view-label');
  if (vl) {
    vl.style.display = 'inline-block';
    vl.textContent = '독서 통계';
  }
  showRandomQuote();
  updateSidebar();
}

/* ==============================================
   BOOK MODAL
============================================== */
let modalCover = '';
let modalSpineCover = '';

function openAddModal() {
  editingBookId = null;
  currentRating = 0;
  modalCover = '';
  modalSpineCover = '';
  document.getElementById('book-modal-ttl').textContent = '책 추가';
  document.getElementById('bk-title').value = '';
  document.getElementById('bk-author').value = '';
  document.getElementById('bk-pages').value = '';
  document.getElementById('bk-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('bk-sentence').value = '';
  document.getElementById('bk-img-url').value = '';
  document.getElementById('bk-img-file').value = '';
  document.getElementById('bk-spine-url').value = '';
  document.getElementById('bk-spine-file').value = '';
  document.getElementById('bk-kw1').value = '';
  document.getElementById('bk-kw2').value = '';
  document.getElementById('bk-kw3').value = '';
  hideSearchResults();
  resetPrev();
  resetSpinePrev();
  const spineEl = document.getElementById('spine-prev');
  if (spineEl) { spineEl.style.width = '44px'; spineEl.style.minWidth = '44px'; }
  updateStarBtns(0);
  openModal('book-modal');
}

async function openEditModal(id, focusKeywords = false) {
  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 구글 로그인을 진행해주세요.');
    loginWithGoogle();
    return;
  }

  const b = books.find(x => x.id === id);
  if (!b) return;
  editingBookId = id;
  currentRating = b.rating || 0;
  modalCover = b.cover || '';
  modalSpineCover = b.spineCover || b.spine || getSpineImageUrl(b.cover) || '';

  document.getElementById('book-modal-ttl').textContent = '책 정보 수정';
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

  if (modalSpineCover && !modalSpineCover.startsWith('data:')) {
    document.getElementById('bk-spine-url').value = modalSpineCover;
  } else {
    document.getElementById('bk-spine-url').value = '';
  }

  hideSearchResults();
  if (b.cover) setPrev(b.cover); else resetPrev();
  const editSpineEl = document.getElementById('spine-prev');
  if (editSpineEl) {
    const p = parseInt(b.pages, 10) || 280;
    let w = Math.round(getSpineWidth(p) * 0.49);
    if (w < 20) w = 20;
    if (w > 56) w = 56;
    editSpineEl.style.width = w + 'px';
    editSpineEl.style.minWidth = w + 'px';
  }
  if (modalSpineCover) setSpinePrev(modalSpineCover); else resetSpinePrev();
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

function onSpineUrlInput(v) {
  if (!v) { resetSpinePrev(); modalSpineCover = ''; return; }
  modalSpineCover = v;
  setSpinePrev(v);
}

function onSpineFileSelect(inp) {
  const f = inp.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    modalSpineCover = e.target.result;
    setSpinePrev(e.target.result);
    document.getElementById('bk-spine-url').value = '';
  };
  r.readAsDataURL(f);
}

function setPrev(src) {
  if (!src) { resetPrev(); return; }
  const el = document.getElementById('book-prev');
  if (!el) return;
  el.innerHTML =
    `<img src="${getSafeImageUrl(src)}" style="width:100%; height:100%; object-fit:cover; display:block;" onerror="this.parentElement.innerHTML='<div class=\\'img-prev-ph\\'><span style=\\'font-size:10px; color:var(--text-300);\\'>표지 오류</span></div>'">`;
}

function resetPrev() {
  const el = document.getElementById('book-prev');
  if (el) el.innerHTML =
    `<div class="img-prev-ph"><span style="font-size:11px; letter-spacing:0.5px; color:var(--text-300);">앞표지</span></div>`;
}

function setSpinePrev(src) {
  if (!src) {
    resetSpinePrev();
    return;
  }
  const el = document.getElementById('spine-prev');
  if (!el) return;
  el.innerHTML =
    `<img src="${getSafeImageUrl(src)}" style="width:100%; height:100%; object-fit:fill; display:block;" onerror="
      if (!this.dataset.tried1 && this.src.includes('/Spine/')) {
        this.dataset.tried1 = 'true';
        this.src = this.src.replace('/Spine/', '/spine/');
      } else {
        this.parentElement.innerHTML='<div class=\\'img-prev-ph spine-ph\\'><span style=\\'font-size:10px; writing-mode:vertical-rl; letter-spacing:1px; color:var(--text-300);\\'>기본 책등</span></div>';
      }
    ">`;
}

function resetSpinePrev() {
  const el = document.getElementById('spine-prev');
  if (el) el.innerHTML =
    `<div class="img-prev-ph spine-ph"><span style="font-size:10px; writing-mode:vertical-rl; letter-spacing:1px; color:var(--text-300);">책등</span></div>`;
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
  if (!title) { toast('도서 제목을 입력해주세요'); return; }

  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
      return;
    }
  }

  const data = {
    title,
    author:     document.getElementById('bk-author').value.trim(),
    pages:      parseInt(document.getElementById('bk-pages').value) || 0,
    date:       document.getElementById('bk-date').value,
    sentence:   document.getElementById('bk-sentence').value.trim(),
    cover:      modalCover,
    spineCover: modalSpineCover,
    rating:     currentRating,
    keywords:   [
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
          let { error } = await supabaseClient
            .from('books')
            .update(updatedBook)
            .eq('id', editingBookId)
            .eq('user_id', user.id);
          
          if (error && (error.code === 'PGRST204' || String(error.message).includes('spineCover'))) {
            const { spineCover, ...safeBook } = updatedBook;
            const res = await supabaseClient
              .from('books')
              .update(safeBook)
              .eq('id', editingBookId)
              .eq('user_id', user.id);
            error = res.error;
          }
          if (error) throw error;
        }
        books[idx] = updatedBook;
        toast('도서 정보가 수정되었습니다');
      }
    } else {
      data.id = uid();
      data.scraps = [];
      data.created_at = new Date().toISOString();
      if (supabaseClient && user) {
        data.user_id = user.id;
        let { error } = await supabaseClient
          .from('books')
          .insert([data]);
        
        if (error && (error.code === 'PGRST204' || String(error.message).includes('spineCover'))) {
          const { spineCover, ...safeData } = data;
          const res = await supabaseClient
            .from('books')
            .insert([safeData]);
          error = res.error;
        }
        if (error) throw error;
      }
      books.unshift(data);
      toast('도서가 추가되었습니다');
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
    toast('저장 실패: ' + err.message);
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
      toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
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
    toast('도서가 삭제되었습니다');
    showGallery();
    updateSidebar();
  } catch (err) {
    console.error(err);
    toast('삭제 실패: ' + err.message);
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

    window[cbName] = function(arg1, arg2) {
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

  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 검색 중...</div>`;

  runAladinJsonp(query, key, results);
}

function searchAladinByIsbn(isbn) {
  const key = getApiKey();
  const results = document.getElementById('aladin-results');
  results.classList.add('show');
  results.innerHTML = `<div class="search-loading"><span class="spin"></span> 바코드로 도서 검색 중...</div>`;

  runAladinLookUpJsonp(isbn, key, results);
}

function runAladinLookUpJsonp(isbn, key, results) {
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

  window[cbName] = function(arg1, arg2) {
    delete window[cbName];
    script.remove();
    const data = (typeof arg1 === 'boolean' || typeof arg1 === 'number') ? arg2 : arg1;
    if (data && data.item && data.item.length > 0) {
      handleAladinResults(data.item);
    } else {
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
      window[cbName10] = function(tArg1, tArg2) {
        delete window[cbName10];
        script10.remove();
        const data10 = (typeof tArg1 === 'boolean' || typeof tArg1 === 'number') ? tArg2 : tArg1;
        if (data10 && data10.item && data10.item.length > 0) {
          handleAladinResults(data10.item);
        } else {
          results.innerHTML = `<div class="search-empty">바코드로 도서를 찾을 수 없습니다. (ISBN: ${isbn})</div>`;
        }
      };
      script10.onerror = function() {
        delete window[cbName10];
        script10.remove();
        results.innerHTML = `<div class="search-empty">바코드로 도서를 찾을 수 없습니다. (ISBN: ${isbn})</div>`;
      };
      document.body.appendChild(script10);
    }
  };

  script.onerror = function() {
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
            toast(`바코드 인식 완료: ${barcode}`);
            searchAladinByIsbn(barcode);
          })
          .catch(err => {
            results.innerHTML = `<div class="search-empty">바코드를 인식하지 못했습니다. 책 뒷면의 바코드가 선명하게 보이도록 다시 촬영해 주세요.</div>`;
          });
      };
      orientedImg.src = orientedDataUrl;
    };
    tempImg.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ============================================================
/* ============================================================
   BARCODE SCANNER ENGINE & MODAL LOGIC (NEXT-GEN)
   - 싱글톤 Native BarcodeDetector (하드웨어 가속 우선)
   - 최적화된 ZXing 고대비 이미지 전처리 폴백
   - ISBN-13 (978/979) 체크섬 검증 & 도서 바코드 우선 매칭
   - 손전등(Torch), 줌(Zoom 1x/2x), 탭 투 포커스 지원
   - 앨범 사진 선택 바코드 인식 지원
   - 실시간 트래킹 박스 오버레이 & 사운드/햅틱 피드백
   ============================================================ */
let barcodeStream = null;
let barcodeScanLoop = null;
let barcodeCurrentFacing = 'environment';
let barcodeAutoScanningActive = true;
let nativeBarcodeDetectorInstance = null;
let sharedZXingReaderInstance = null;
let isBarcodeTorchOn = false;
let barcodeCurrentZoom = 1;
let barcodeSupportedZoomRange = null;
let barcodeHasTorch = false;

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
  } catch (_) {}
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
  barcodeCurrentZoom = 1;
  _initBarcodeEngines();
  _startBarcodeCamera(barcodeCurrentFacing);
  _setupTapToFocus();
}

function closeBarcodeScannerModal() {
  _stopBarcodeCamera();
  const modal = document.getElementById('barcode-scanner-modal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function _initBarcodeEngines() {
  if (!nativeBarcodeDetectorInstance && 'BarcodeDetector' in window) {
    try {
      nativeBarcodeDetectorInstance = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
      });
    } catch (e) {
      console.warn('Native BarcodeDetector init error:', e);
      nativeBarcodeDetectorInstance = null;
    }
  }
  if (!sharedZXingReaderInstance && typeof ZXing !== 'undefined') {
    try {
      sharedZXingReaderInstance = new ZXing.BrowserMultiFormatReader();
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
        } catch (_) {}
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
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      
      // Torch
      barcodeHasTorch = !!caps.torch;
      const torchBtn = document.getElementById('barcode-torch-btn');
      if (torchBtn) torchBtn.style.display = barcodeHasTorch ? 'flex' : 'none';

      // Zoom
      if (caps.zoom) {
        barcodeSupportedZoomRange = caps.zoom;
        const zoomBtn = document.getElementById('barcode-zoom-btn');
        if (zoomBtn) zoomBtn.style.display = 'flex';
      }
    }

    _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
    _startBarcodeScanLoop();
  } catch (err) {
    console.warn('Barcode camera error:', err);
    _setBarcodeScannerStatus('카메라 오류', '#ef4444');
    toast('카메라를 열 수 없습니다. 사진 선택으로 대체합니다.');
    setTimeout(() => {
      closeBarcodeScannerModal();
      document.getElementById('barcode-album-input')?.click();
    }, 1200);
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
  if (!barcodeStream || !barcodeSupportedZoomRange) return;
  const track = barcodeStream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return;

  try {
    const minZoom = barcodeSupportedZoomRange.min || 1;
    const maxZoom = barcodeSupportedZoomRange.max || 2;
    barcodeCurrentZoom = (barcodeCurrentZoom === 1) ? Math.min(2, maxZoom) : 1;

    await track.applyConstraints({
      advanced: [{ zoom: barcodeCurrentZoom }]
    });
    const btn = document.getElementById('barcode-zoom-btn');
    if (btn) {
      btn.textContent = barcodeCurrentZoom + 'x';
      btn.style.background = barcodeCurrentZoom > 1 ? '#c99365' : 'rgba(0,0,0,0.6)';
      btn.style.color = barcodeCurrentZoom > 1 ? '#000' : '#fff';
    }
  } catch (err) {
    console.warn('Zoom toggle error:', err);
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

function _startBarcodeScanLoop() {
  const video = document.getElementById('barcode-video');
  if (!video) return;

  let lastScanTime = 0;
  const scanInterval = 65; // ~15 FPS analysis rate for silky smooth UI & minimal CPU drain

  async function loop(now) {
    if (!barcodeStream || !barcodeAutoScanningActive) return;

    if (now - lastScanTime >= scanInterval && video.readyState >= 2) {
      lastScanTime = now;

      // ── Path 1: Native BarcodeDetector (Zero-copy GPU Hardware Accelerated) ──
      if (nativeBarcodeDetectorInstance) {
        try {
          const barcodes = await nativeBarcodeDetectorInstance.detect(video);
          if (barcodes && barcodes.length > 0) {
            const rawCodes = barcodes.map(b => b.rawValue);
            const bestCode = pickBestBookBarcode(rawCodes);
            if (bestCode) {
              const matchedBarcodeObj = barcodes.find(b => b.rawValue === bestCode) || barcodes[0];
              if (matchedBarcodeObj.cornerPoints) {
                _drawTrackingBox(matchedBarcodeObj.cornerPoints, video);
              }
              barcodeAutoScanningActive = false;
              _onBarcodeDetected(bestCode);
              return;
            }
          }
        } catch (_) {}
      }

      // ── Path 2: Optimized ZXing Fallback with Adaptive Contrast ──
      if (sharedZXingReaderInstance && barcodeAutoScanningActive) {
        try {
          const decoded = await _zxingScanFromVideoCrop(video);
          if (decoded) {
            barcodeAutoScanningActive = false;
            _onBarcodeDetected(decoded);
            return;
          }
        } catch (_) {}
      }
    }

    barcodeScanLoop = requestAnimationFrame(loop);
  }

  barcodeScanLoop = requestAnimationFrame(loop);
}

// Cropped & Enhanced ZXing Decode
async function _zxingScanFromVideoCrop(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Viewport guide frame mapping
  const renderW = video.clientWidth  || 480;
  const renderH = video.clientHeight || 640;
  const videoAR = vw / vh;
  const renderAR = renderW / renderH;

  let srcX = 0, srcY = 0, srcW = vw, srcH = vh;
  if (videoAR > renderAR) {
    srcW = vh * renderAR;
    srcX = (vw - srcW) / 2;
  } else {
    srcH = vw / renderAR;
    srcY = (vh - srcH) / 2;
  }

  const scaleX = srcW / renderW;
  const scaleY = srcH / renderH;

  const guideW = 280, guideH = 140;
  const gx = (renderW - guideW) / 2;
  const gy = (renderH - guideH) / 2;

  const margin = 40;
  const cropX = Math.max(0, srcX + (gx - margin) * scaleX);
  const cropY = Math.max(0, srcY + (gy - margin) * scaleY);
  const cropW = Math.min(vw - cropX, (guideW + margin * 2) * scaleX);
  const cropH = Math.min(vh - cropY, (guideH + margin * 2) * scaleY);

  if (cropW <= 20 || cropH <= 20) return null;

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // 1. Direct Try
  try {
    const res = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
    if (res && res.text) return res.text;
  } catch (_) {}

  // 2. High-contrast enhancement for shadows & low-light barcodes
  try {
    const imgData = ctx.getImageData(0, 0, cropW, cropH);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      const val = gray < 120 ? Math.max(0, gray * 0.6) : Math.min(255, gray * 1.4);
      d[i] = val; d[i+1] = val; d[i+2] = val;
    }
    ctx.putImageData(imgData, 0, 0);
    const res2 = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
    if (res2 && res2.text) return res2.text;
  } catch (_) {}

  return null;
}

function _onBarcodeDetected(rawCode) {
  if (barcodeScanLoop) {
    cancelAnimationFrame(barcodeScanLoop);
    clearTimeout(barcodeScanLoop);
    barcodeScanLoop = null;
  }
  barcodeAutoScanningActive = false;

  const cleanCode = String(rawCode).replace(/[^0-9Xx]/g, '');

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
  }, 600);
}

// Manual Capture Button Action
async function triggerBarcodeCapture() {
  const video = document.getElementById('barcode-video');
  if (!video || !barcodeStream) return;

  barcodeAutoScanningActive = false;
  if (barcodeScanLoop) {
    cancelAnimationFrame(barcodeScanLoop);
    clearTimeout(barcodeScanLoop);
    barcodeScanLoop = null;
  }

  _setBarcodeScannerStatus('분석 중...', '#f59e0b');

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  let detectedCode = null;

  // 1. Native detector on full frame
  if (nativeBarcodeDetectorInstance) {
    try {
      const barcodes = await nativeBarcodeDetectorInstance.detect(canvas);
      if (barcodes && barcodes.length > 0) {
        detectedCode = pickBestBookBarcode(barcodes.map(b => b.rawValue));
      }
    } catch (_) {}
  }

  // 2. ZXing on full frame
  if (!detectedCode && sharedZXingReaderInstance) {
    try {
      const res = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
      if (res && res.text) detectedCode = res.text;
    } catch (_) {}
  }

  // 3. ZXing on cropped center
  if (!detectedCode && sharedZXingReaderInstance) {
    try {
      detectedCode = await _zxingScanFromVideoCrop(video);
    } catch (_) {}
  }

  if (detectedCode) {
    _onBarcodeDetected(detectedCode);
  } else {
    _setBarcodeScannerStatus('미인식 — 재시도', '#ef4444');
    const gt = document.getElementById('barcode-guide-text');
    if (gt) gt.innerHTML = '바코드를 <strong style="color:#c99365;">박스 안</strong>에 맞추고 다시 촬영해주세요';

    setTimeout(() => {
      if (!barcodeStream) return;
      _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
      if (gt) gt.innerHTML = '도서 뒷면 바코드를 <strong style="color:#c99365;">박스 안</strong>에 맞춰주세요';
      barcodeAutoScanningActive = true;
      _startBarcodeScanLoop();
    }, 1800);
  }
}

// Album Photo Select Handler
function handleBarcodeAlbumSelect(input) {
  const file = input.files[0];
  if (!file) return;

  _setBarcodeScannerStatus('사진 분석 중...', '#f59e0b');
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = async function() {
      // Bake orientation & draw to canvas
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      _initBarcodeEngines();
      let foundCode = null;

      // Try Native detector first
      if (nativeBarcodeDetectorInstance) {
        try {
          const barcodes = await nativeBarcodeDetectorInstance.detect(canvas);
          if (barcodes && barcodes.length > 0) {
            foundCode = pickBestBookBarcode(barcodes.map(b => b.rawValue));
          }
        } catch (_) {}
      }

      // Try ZXing
      if (!foundCode && sharedZXingReaderInstance) {
        try {
          const res = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
          if (res && res.text) foundCode = res.text;
        } catch (_) {}
      }

      // Try with contrast stretch
      if (!foundCode && sharedZXingReaderInstance) {
        try {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
            const val = gray < 128 ? Math.max(0, gray * 0.6) : Math.min(255, gray * 1.4);
            d[i] = val; d[i+1] = val; d[i+2] = val;
          }
          ctx.putImageData(imgData, 0, 0);
          const res2 = await sharedZXingReaderInstance.decodeFromCanvas(canvas);
          if (res2 && res2.text) foundCode = res2.text;
        } catch (_) {}
      }

      if (foundCode) {
        _onBarcodeDetected(foundCode);
      } else {
        toast('사진에서 바코드를 찾을 수 없습니다. 선명한 사진으로 다시 시도해주세요.');
        _setBarcodeScannerStatus('자동 스캔 중...', '#34d399');
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function switchBarcodeCamera() {
  barcodeCurrentFacing = (barcodeCurrentFacing === 'environment') ? 'user' : 'environment';
  _startBarcodeCamera(barcodeCurrentFacing);
}

function runAladinJsonp(query, key, results) {
  const cbName = '_aladinCb_' + (++aladinCallbackCounter);
  const script = document.createElement('script');
  
  const params = new URLSearchParams({
    ttbkey: key,
    Query: query,
    QueryType: 'Keyword',
    MaxResults: '18',
    start: '1',
    SearchTarget: 'Book',
    output: 'JS',
    Cover: 'Big',
    OptResult: 'subInfo',
    callback: cbName
  });

  script.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${params}`;

  window[cbName] = function(arg1, arg2) {
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
        MaxResults: '18',
        start: '1',
        SearchTarget: 'Book',
        output: 'JS',
        Cover: 'Big',
        OptResult: 'subInfo',
        callback: cbNameTitle
      });
      scriptTitle.src = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?${paramsTitle}`;
      window[cbNameTitle] = function(tArg1, tArg2) {
        delete window[cbNameTitle];
        scriptTitle.remove();
        const dataTitle = (typeof tArg1 === 'boolean' || typeof tArg1 === 'number') ? tArg2 : tArg1;
        handleAladinResults(dataTitle);
      };
      scriptTitle.onerror = function() {
        delete window[cbNameTitle];
        scriptTitle.remove();
        results.innerHTML = `<div class="search-empty">검색 결과가 없거나 네트워크 오류가 발생했습니다.</div>`;
      };
      document.body.appendChild(scriptTitle);
    }
  };

  script.onerror = function() {
    delete window[cbName];
    script.remove();
    results.innerHTML = `<div class="search-empty">검색 실패 — 네트워크 상태를 확인해주세요.</div>`;
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
                     (item.bookinfo ? (item.bookinfo.itemPage || item.bookinfo.itempage) : null) ||
                     item.itemPage || item.itempage || '';
      let pages = pagesVal ? String(pagesVal).replace(/[^0-9]/g, '') : '';
      let author = item.author || '';
      let cleanAuthor = author.replace(/\s*\((지은이|옮긴이|역자|저자|글|그림|편저|지음)\)/g, '');
      let cover = (item.cover || '').replace('/coversum/', '/cover500/').replace('/cover200/', '/cover500/');
      return {
        title: item.title || '',
        author: cleanAuthor,
        cover: cover,
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
      document.getElementById('bk-spine-url').value = spineUrl;
      setSpinePrev(spineUrl);
    } else {
      modalSpineCover = '';
      document.getElementById('bk-spine-url').value = '';
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
}


/* ==============================================
   SCRAP MODAL
============================================== */
async function openScrapModal(id) {
  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 구글 로그인을 진행해주세요.');
    loginWithGoogle();
    return;
  }

  const book = books.find(b => b.id === id);
  if (!book) return;
  if ((book.scraps||[]).length >= 100) {
    toast('스크랩은 최대 100개까지 가능합니다'); return;
  }
  currentScrapBookId = id;
  editingScrapId = null;

  document.getElementById('scrap-modal-title').textContent = '문장 스크랩';
  document.getElementById('scrap-save-btn').textContent = '스크랩 저장';

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

  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
    return;
  }
  const user = currentUser;

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

  if (!text) { toast('문장을 입력해주세요'); return; }

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
      toast('스크랩은 최대 100개까지 가능합니다'); return;
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
    toast(editingScrapId ? '스크랩이 수정되었습니다' : '문장이 스크랩되었습니다');
    if (currentBookId === currentScrapBookId) showDetail(currentBookId);
  } catch (err) {
    console.error(err);
    toast('스크랩 저장 실패: ' + err.message);
  }
}

async function doDeleteScrap(bookId, scrapId) {
  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
    return;
  }
  const user = currentUser;

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
    toast('스크랩이 삭제되었습니다');
    showDetail(bookId);
  } catch (err) {
    console.error(err);
    toast('스크랩 삭제 실패: ' + err.message);
  }
}

/* ==============================================
   OCR
============================================== */
let ocrLinesData = [];

function resetOcrWrap() {
  document.getElementById('ocr-wrap').innerHTML = `
    <div class="ocr-ph">
      <span class="ocr-ph-icon" style="font-size:11px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:var(--text-300);">PHOTO OCR</span>
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
      statusEl.innerHTML = '분석 완료. 사진에서 스크랩할 문장을 직접 선택하세요.';
      document.getElementById('ocr-ctrl-btns').style.display = 'flex';
      renderOcrOverlays();
    } else {
      statusEl.innerHTML = '인식된 텍스트가 없습니다. 다른 사진을 시도하거나 직접 입력해주세요.';
    }
    
    setTimeout(() => { statusEl.style.display = 'none'; }, 4500);
  } catch(err) {
    console.error(err);
    if (scanLine) scanLine.classList.remove('scanning');
    statusEl.innerHTML = '분석 실패. 다시 시도해주세요.';
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
    
    title.textContent = '월별 독서량';
  } else {
    btnYear.style.background = 'var(--violet)';
    btnYear.style.color = '#fff';
    btnYear.style.border = 'none';
    
    btnMonth.style.background = 'var(--glass)';
    btnMonth.style.color = 'var(--text-300)';
    btnMonth.style.border = '1px solid var(--border)';
    
    title.textContent = '연도별 독서량';
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
      toast('내 서재로 이동');
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
      toast('다음 도서');
    } else {
      // Bounce right (bounce back from right edge)
      wrap.classList.remove('bounce-left', 'bounce-right', 'slide-from-left', 'slide-from-right');
      void wrap.offsetWidth; // Force reflow
      wrap.classList.add('bounce-left'); // Pulling left to bounce back from right
      toast('마지막 도서입니다');
    }
  } else if (direction === 'prev') {
    if (idx > 0) {
      showDetail(sorted[idx - 1].id, 'prev');
      toast('이전 도서');
    } else {
      // Bounce left (bounce back from left edge)
      wrap.classList.remove('bounce-left', 'bounce-right', 'slide-from-left', 'slide-from-right');
      void wrap.offsetWidth; // Force reflow
      wrap.classList.add('bounce-right'); // Pulling right to bounce back from left
      toast('첫 번째 도서입니다');
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

galleryScroll.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    pinchDist0 = pinchD(e);
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
}, { passive: true });

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
      toast('내 서재로 이동');
    } else {
      // Bounce left (dragged left on the rightmost page)
      const wrap = document.querySelector('.community-wrap');
      if (wrap) {
        wrap.classList.remove('bounce-left', 'bounce-right');
        void wrap.offsetWidth;
        wrap.classList.add('bounce-left');
      }
      toast('마지막 페이지입니다.');
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
      toast('내 서재로 이동');
    } else {
      // Bounce right (dragged right on the leftmost page)
      const wrap = document.querySelector('.stats-wrap');
      if (wrap) {
        wrap.classList.remove('bounce-left', 'bounce-right');
        void wrap.offsetWidth;
        wrap.classList.add('bounce-right');
      }
      toast('첫 번째 페이지입니다.');
    }
  }
  // Swipe up: Go back to Gallery, Swipe down: Refresh quote
  if (Math.abs(diffY) > 70 && Math.abs(diffY) > Math.abs(diffX)) {
    if (statsEl.scrollTop <= 5) {
      if (diffY < 0) {
        showGallery();
        toast('내 서재로 이동');
      } else {
        showRandomQuote();
        toast('오늘의 한 문장 새로고침');
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
============================================= */
loadTheme();
(async () => {
  if (supabaseClient) {
    const urlParams = new URLSearchParams(window.location.search);
    const hashStr = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const hashParams = new URLSearchParams(hashStr);

    const code = urlParams.get('code');
    const authError = urlParams.get('error') || urlParams.get('error_code') || hashParams.get('error') || hashParams.get('error_code');

    // 1. OAuth Code 교환 (PKCE Flow)
    if (code) {
      try {
        console.log('[Auth] Exchanging OAuth code for session...');
        const { data, error } = await supabaseClient.auth.exchangeCodeForSession(code);
        if (error) {
          console.error('[Auth] Exchange code error:', error);
          if (error.message?.includes('code verifier') || error.message?.includes('invalid request')) {
            setTimeout(() => {
              toast('모바일 보안 설정으로 로그인 인증이 만료되었습니다. 다시 시도해주세요.', 6000);
            }, 300);
          }
        } else if (data?.session) {
          currentUser = data.session.user;
          updateAuthUI(data.session);
          console.log('[Auth] Successfully logged in as:', currentUser.email);
        }
      } catch (err) {
        console.error('[Auth] Unexpected error during code exchange:', err);
      }
      // URL에서 code 파라미터 정리
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    } 
    // 2. Hash Access Token 확인 (Implicit Flow fallback)
    else if (hashStr.includes('access_token=') || hashStr.includes('refresh_token=')) {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session && session.user) {
          currentUser = session.user;
          updateAuthUI(session);
        }
      } catch (err) {
        console.error('[Auth] Hash session parse error:', err);
      }
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
    // 3. 에러 발생 시 처리
    else if (authError) {
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      if (!currentUser) {
        const errorDescription = urlParams.get('error_description') || hashParams.get('error_description') || '로그인 인증이 완료되지 않았습니다.';
        let userMsg = `로그인 오류: ${errorDescription}`;
        if (errorDescription.includes('state') || authError.includes('state')) {
          userMsg = `로그인 안내: 브라우저 보안 또는 인앱 브라우저 제한으로 세션이 만료되었습니다. 사파리(Safari)나 크롬(Chrome) 일반 탭에서 다시 로그인해주세요.`;
        }
        setTimeout(() => {
          toast(userMsg, 7000);
        }, 500);
      }
    }

    // 4. 일반 세션 확인 및 복구
    if (!currentUser) {
      await checkAuth();
    }
  }

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
      cover: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%238c6239"/><stop offset="100%" stop-color="%23c97a2b"/></linearGradient></defs><rect width="400" height="600" fill="url(%23g)"/><rect x="20" y="20" width="360" height="560" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2" rx="10"/><circle cx="200" cy="180" r="60" fill="rgba(255,255,255,0.15)"/><text x="200" y="195" fill="white" font-size="38" font-weight="700" text-anchor="middle" font-family="serif" font-style="italic">8ook.</text><text x="200" y="320" fill="white" font-size="28" font-weight="bold" text-anchor="middle" font-family="sans-serif">8ook. 이용 가이드</text><text x="200" y="370" fill="rgba(255,255,255,0.8)" font-size="16" text-anchor="middle" font-family="sans-serif">나만의 스마트한 독서 일기</text><line x1="100" y1="420" x2="300" y2="420" stroke="rgba(255,255,255,0.4)" stroke-width="1"/><text x="200" y="470" fill="white" font-size="14" font-weight="500" text-anchor="middle" font-family="sans-serif">책 기록 • 문장 스크랩 • 독서 통계</text><text x="200" y="530" fill="rgba(255,255,255,0.6)" font-size="12" text-anchor="middle" font-family="sans-serif">© 8ook Team</text></svg>',
      rating: 5,
      sentence: '독서 기록, 문장 스크랩, 완독 통계 및 독서 수다 피드까지! 8ook를 100% 활용하는 상세 가이드북입니다.',
      scraps: [
        {
          id: 'g1',
          text: '구글 계정으로 로그인하시면 Supabase 클라우드 데이터베이스와 자동으로 연동됩니다. 로그인 시 소중한 독서 기록이 실시간으로 안전하게 동기화 및 보존됩니다.',
          page: 1,
          memo: '클라우드 동기화 안내'
        },
        {
          id: 'g2',
          text: '도서 추가 모달에서 제목으로 검색하여 알라딘 도서 정보를 가져오거나, 모바일 카메라로 바코드를 촬영해보세요. 표지 이미지, 저자, 페이지 수 등 모든 정보가 자동으로 채워집니다.',
          page: 2,
          memo: '간편한 도서 등록 기능'
        },
        {
          id: 'g3',
          text: '도서 상세 화면에서 스크랩을 추가할 때 "사진 OCR" 탭을 선택하고 책 페이지를 촬영해보세요. 고성능 OCR 엔진이 이미지 속의 한글 및 영어 텍스트를 인식하여 타이핑 없이 터치 한 번으로 문장을 추출해 줍니다.',
          page: 3,
          memo: 'OCR 문장 스크랩 사용법'
        },
        {
          id: 'g4',
          text: '상단 "통계" 메뉴를 클릭하면 완독한 도서 수, 총 페이지 수, 총 스크랩 수는 물론 월별/연도별 시각화 차트와 어떤 날에 책을 끝마쳤는지 알려주는 완독 달력을 한눈에 볼 수 있습니다.',
          page: 4,
          memo: '완독 달력 & 독서 통계 대시보드'
        },
        {
          id: 'g5',
          text: '상단 "커뮤니티" 메뉴에서는 내가 입력한 키워드들이 모여 만드는 관심 분야 워드 클라우드가 제공됩니다. 또한 다른 독자들과 감상을 나누는 실시간 독서 수다 SNS 피드를 통해 소통할 수 있습니다.',
          page: 5,
          memo: '키워드 클라우드 & 커뮤니티 피드'
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
  if (!supabaseClient) { toast('Supabase가 연결되지 않았습니다'); return; }
  
  if (window.location.protocol === 'file:') {
    alert('구글 로그인은 로컬 파일(file://...) 경로에서는 동작하지 않습니다.\nVS Code의 Live Server 등을 사용해 http://localhost:... 주소로 실행하거나, GitHub Pages에 배포 완료 후 테스트해주세요.');
    return;
  }

  // 모바일 인앱 브라우저 (카카오톡, 네이버, 인스타그램, 페이스북, 라인 등) 감지
  const ua = navigator.userAgent || navigator.vendor || window.opera || '';
  const isInApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line/i.test(ua);
  if (isInApp) {
    const currentUrl = window.location.href;
    if (/KAKAOTALK/i.test(ua)) {
      // 카카오톡 외부 브라우저(Safari/Chrome) 강제 호출 스킴
      location.href = `kakaotalk://web/openExternalApp?url=${encodeURIComponent(currentUrl)}`;
      return;
    } else {
      alert('카카오톡, 네이버, 인스타그램 등 인앱 브라우저에서는 구글 보안 정책상 로그인이 차단됩니다.\n\n화면 우측 상단이나 하단의 메뉴(⋯)를 눌러 [Safari로 열기] 또는 [기본 브라우저로 열기]로 접속해주세요.');
      return;
    }
  }

  // 현재 호스팅 경로 기준 리다이렉트 URL 정규화 (파라미터 및 해시 제거)
  let redirectUrl = window.location.origin + window.location.pathname;
  if (!redirectUrl.endsWith('/') && !redirectUrl.endsWith('.html')) {
    redirectUrl += '/';
  }

  toast('구글 로그인으로 연결 중...', 2500);

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectUrl,
      queryParams: {
        access_type: 'offline'
        // 'select_account'를 생략하여 모바일에서 반복적인 2단계 인증 루프 방지
      }
    }
  });
  if (error) { 
    console.error('[Auth] signInWithOAuth error:', error); 
    toast(`로그인 오류: ${error.message || '연결에 실패했습니다'}`); 
  }
}

async function logout() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) { console.error(error); toast('로그아웃 실패'); }
}

async function checkAuth() {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session && session.user) {
      currentUser = session.user;
      updateAuthUI(session);
    } else {
      // 탭 닫힘 복원: Refresh Token을 통한 백그라운드 자동 세션 복구
      const { data: refreshData } = await supabaseClient.auth.refreshSession();
      if (refreshData && refreshData.session) {
        currentUser = refreshData.session.user;
        updateAuthUI(refreshData.session);
      } else {
        currentUser = null;
        updateAuthUI(null);
      }
    }
  } catch (err) {
    console.warn("Auth session check error:", err);
  }
}

function updateAuthUI(session) {
  const loggedInDiv = document.getElementById('menu-user-logged-in');
  const loggedOutDiv = document.getElementById('menu-user-logged-out');
  const usernameSpan = document.getElementById('auth-username');
  const shortUsernameSpan = document.getElementById('auth-username-short');
  const headerChip = document.getElementById('header-user-chip');

  if (session && session.user) {
    currentUser = session.user;
    if (loggedInDiv) loggedInDiv.style.display = 'block';
    if (loggedOutDiv) loggedOutDiv.style.display = 'none';
    const metadata = session.user.user_metadata;
    const fullName = (metadata && metadata.full_name) || session.user.email || '사용자';
    if (usernameSpan) usernameSpan.textContent = fullName;
    if (shortUsernameSpan) shortUsernameSpan.textContent = fullName.split(' ')[0] || fullName;
    if (headerChip) headerChip.style.display = 'inline-flex';
  } else {
    currentUser = null;
    if (loggedInDiv) loggedInDiv.style.display = 'none';
    if (loggedOutDiv) loggedOutDiv.style.display = 'block';
    if (usernameSpan) usernameSpan.textContent = '';
    if (headerChip) headerChip.style.display = 'none';
  }
}

function toggleAppMenu() {
  const drawer = document.getElementById('app-menu-drawer');
  const backdrop = document.getElementById('app-menu-backdrop');
  const btn = document.getElementById('main-menu-btn');
  if (!drawer) return;
  const isOpen = drawer.classList.contains('open');
  if (isOpen) {
    closeAppMenu();
  } else {
    drawer.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    if (btn) btn.classList.add('active');
  }
}

function closeAppMenu() {
  const drawer = document.getElementById('app-menu-drawer');
  const backdrop = document.getElementById('app-menu-backdrop');
  const btn = document.getElementById('main-menu-btn');
  if (drawer) drawer.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  if (btn) btn.classList.remove('active');
}

// Close drawer on ESC key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAppMenu();
  }
});

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    const prevUser = currentUser;
    currentUser = session?.user || null;
    updateAuthUI(session);
    // Reload data on auth change to apply RLS
    if (['SIGNED_IN', 'SIGNED_OUT', 'INITIAL_SESSION', 'TOKEN_REFRESHED'].includes(event)) {
      if (event === 'INITIAL_SESSION' && prevUser?.id === currentUser?.id) {
        return;
      }
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
    avatar: '지',
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
    avatar: '문',
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
    avatar: '감',
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
    { username: '책벌레99', avatar: '책', rating: 5, comment: '최근에 읽은 책 중에 가장 흡입력이 있습니다. 강력 추천해요!' },
    { username: '이서평', avatar: '이', rating: 4, comment: '문장들이 마음에 깊이 남습니다. 여운이 깊은 이야기네요.' },
    { username: '김지혜', avatar: '김', rating: 4, comment: '생각할 거리를 많이 던져주는 훌륭한 작가의 작품입니다.' }
  ],
  '지적 대화를 위한 넓고 얕은 지식 1': [
    { username: '지식탐험가', avatar: '지', rating: 5, comment: '지적 대화를 위해 이보다 명쾌하게 기본 교양을 설명한 책은 없다.' },
    { username: '채사장팬', avatar: '채', rating: 5, comment: '팟캐스트 듣는 느낌! 심오한 개념들이 한눈에 정리됩니다.' },
    { username: '교양입문자', avatar: '교', rating: 4, comment: '역사, 경제, 정치, 사회를 하나의 흐름으로 꿰뚫어줍니다.' }
  ],
  '채식주의자': [
    { username: '문학소녀', avatar: '문', rating: 5, comment: '폭력과 인간의 본성에 대한 서늘한 시선. 부커상이 아깝지 않은 명작.' },
    { username: '고요한밤', avatar: '고', rating: 4, comment: '읽는 내내 숨이 막힐 것 같은 몰입감과 깊은 묘사가 인상적입니다.' },
    { username: '가시나무', avatar: '가', rating: 5, comment: '어떤 상처는 너무 깊어 채식이라는 극단적 침묵으로 뿜어져 나온다.' }
  ],
  '아몬드': [
    { username: '감성수집가', avatar: '감', rating: 5, comment: '감정을 느끼지 못하는 소년의 성장기가 가슴을 찡하게 울립니다.' },
    { username: '감동리뷰', avatar: '리', rating: 5, comment: '타인의 감정에 공감한다는 것이 얼마나 아름답고 중요한지 깨닫게 해줌.' },
    { username: '도토리', avatar: '도', rating: 4, comment: '청소년 소설이지만 어른들이 꼭 읽어봐야 할 힐링과 성찰의 책.' }
  ]
};

function showCommunity() {
  closeAppMenu();
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.add('show');
  document.getElementById('back-btn').classList.add('show');
  const vl = document.getElementById('view-label');
  if (vl) {
    vl.style.display = 'inline-block';
    vl.textContent = '커뮤니티';
  }
  renderCommunityFeed();
  renderWordCloud();
}

function filterGalleryByKeyword(kw) {
  currentGalleryFilter = kw;
  showGallery();
  toast(`'#${kw}' 키워드 검색 결과`);
}

function clearGalleryFilter() {
  currentGalleryFilter = null;
  showGallery();
  toast('도서 필터가 해제되었습니다.');
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
    container.innerHTML = `<div style="font-size:12px; color:var(--text-400); padding: 20px; text-align:center;">아직 등록된 도서 키워드가 없습니다.<br><small style="font-size:10px; margin-top:4px; display:inline-block;">도서 정보 편집에서 키워드를 등록해보세요.</small></div>`;
    return;
  }

  const freq = {};
  allKeywords.forEach(k => {
    freq[k] = (freq[k] || 0) + 1;
  });

  let uniqueKws = Object.keys(freq);
  const isMobile = window.innerWidth <= 640;
  if (isMobile && uniqueKws.length > 30) {
    uniqueKws = uniqueKws.sort(() => 0.5 - Math.random()).slice(0, 30);
  }

  const counts = uniqueKws.map(kw => freq[kw]);
  const minCount = counts.length ? Math.min(...counts) : 1;
  const maxCount = counts.length ? Math.max(...counts) : 1;

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
    span.textContent = kw; // No '#' symbol
    span.style.fontSize = `${fontSize}px`;
    span.style.color = color;
    span.style.fontWeight = count > 1 ? '800' : '600';
    span.style.cursor = 'pointer';
    span.style.transition = 'transform 0.2s ease, text-shadow 0.2s ease';
    span.style.padding = '2px 6px';
    
    // Organic layout: random rotation (-6, 0, 6deg) and clean margins to prevent overlapping collisions
    const rotateVal = (Math.floor(Math.random() * 3) - 1) * 6;
    span.style.transform = `rotate(${rotateVal}deg)`;
    span.style.margin = '2px 4px'; 
    span.style.lineHeight = '1.2';
    span.style.display = 'inline-block';
    span.style.position = 'relative';
    span.style.userSelect = 'none';
    
    span.onmouseover = () => {
      span.style.transform = `scale(1.25) rotate(${rotateVal}deg)`;
      span.style.textShadow = `0 0 12px ${color}`;
      span.style.zIndex = '10';
    };
    span.onmouseout = () => {
      span.style.transform = `scale(1) rotate(${rotateVal}deg)`;
      span.style.textShadow = 'none';
      span.style.zIndex = '1';
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
        <img class="feed-book-cover" src="${esc(getSafeImageUrl(post.bookCover))}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2245%22 height=%2265%22><rect width=%22100%%22 height=%22100%%22 fill=%22%2318182e%22/><text x=%2250%%22 y=%2250%%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 font-size=%2210%22 fill=%22%23999%22 font-family=%22sans-serif%22>BOOK</text></svg>'">
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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:2px;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><span>공감 (${post.likes})</span>
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
    toast("책장에 도서가 있어야 소감을 쓸 수 있습니다. 먼저 도서를 등록해주세요.");
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
  if (!text) { toast("한줄평을 입력해주세요."); return; }

  const book = books.find(b => b.id === bkId);
  if (!book) return;

  const newPost = {
    id: 'feed_' + Date.now(),
    username: document.getElementById('auth-username').textContent || '익명 독자',
    avatar: 'B',
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
  toast("피드가 등록되었습니다.");
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
      toast("실시간 카메라를 사용할 수 없어 파일 선택 모드로 전환합니다.");
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
      ctx.strokeStyle = 'rgba(140, 98, 57, 0.15)';
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
      ctx.strokeStyle = 'rgba(140, 98, 57, 0.5)';
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
      grad.addColorStop(0.5, 'rgba(140, 98, 57, 0.75)');
      grad.addColorStop(1, 'transparent');
      
      ctx.fillStyle = grad;
      ctx.fillRect(0, y - 4, canvas.width, 8);
      
      ctx.strokeStyle = 'rgba(140, 98, 57, 0.35)';
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
  canvas.style.backgroundColor = 'rgba(140, 98, 57, 0.35)';
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
      toast("표지 테두리 인식 실패");
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
  toast(`테두리 감지 완료: ${detectedBooks.length}권의 책을 찾았습니다.`);
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
      boxEl.style.boxShadow = '0 0 10px rgba(140, 98, 57, 0.4)';
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
    labelEl.innerHTML = `${esc(book.title)} ${isSelected ? ' [선택됨]' : ''}`;
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
          avatar: 'B',
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
  toast("도서 정보가 책장 폼에 기입되었습니다.");
}

/* ==============================================
   EXPORT TO GOOGLE SHEETS (CSV)
============================================== */
function openExportModal() {
  const periodSelect = document.getElementById('export-period-select');
  if (periodSelect) {
    periodSelect.value = 'all';
  }
  const customWrap = document.getElementById('export-custom-date-wrap');
  if (customWrap) {
    customWrap.style.display = 'none';
  }

  // Clear date inputs when opening
  const startDateInp = document.getElementById('export-start-date');
  const endDateInp = document.getElementById('export-end-date');
  if (startDateInp) startDateInp.value = '';
  if (endDateInp) endDateInp.value = '';
  
  // Set current year/month options dynamically
  const now = new Date();
  const yearOpt = periodSelect ? periodSelect.querySelector('option[value="year"]') : null;
  const monthOpt = periodSelect ? periodSelect.querySelector('option[value="month"]') : null;
  if (yearOpt) yearOpt.textContent = `올해 (${now.getFullYear()}년)`;
  if (monthOpt) monthOpt.textContent = `이번 달 (${now.getMonth()+1}월)`;

  updateExportSummary();
  openModal('export-modal');
}

function handleExportPeriodChange() {
  const periodSelect = document.getElementById('export-period-select');
  const period = periodSelect ? periodSelect.value : 'all';
  const customWrap = document.getElementById('export-custom-date-wrap');
  
  if (customWrap) {
    if (period === 'custom') {
      customWrap.style.setProperty('display', 'flex', 'important');
    } else {
      customWrap.style.setProperty('display', 'none', 'important');
    }
  }
  updateExportSummary();
}

function getFilteredExportBooks() {
  if (!books) return [];
  const period = document.getElementById('export-period-select')?.value || 'all';
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();

  return books.filter(b => {
    if (period === 'all') return true;
    if (!b.date) return false;

    const bDate = new Date(b.date);
    if (isNaN(bDate.getTime())) return false;

    if (period === 'year') {
      return bDate.getFullYear() === curYear;
    } else if (period === 'month') {
      return bDate.getFullYear() === curYear && bDate.getMonth() === curMonth;
    } else if (period === 'custom') {
      const startVal = document.getElementById('export-start-date')?.value;
      const endVal = document.getElementById('export-end-date')?.value;
      
      if (startVal) {
        const startDate = new Date(startVal);
        startDate.setHours(0,0,0,0);
        if (bDate < startDate) return false;
      }
      if (endVal) {
        const endDate = new Date(endVal);
        endDate.setHours(23,59,59,999);
        if (bDate > endDate) return false;
      }
      return true;
    }
    return true;
  });
}

function updateExportSummary() {
  const summaryEl = document.getElementById('export-count-summary');
  if (summaryEl) {
    const filtered = getFilteredExportBooks();
    summaryEl.innerHTML = `내보낼 항목: <strong>총 ${filtered.length}권의 책</strong> (전체 ${books.length}권 중)`;
  }
}

function exportToGoogleSheetsCSV() {
  const exportBooks = getFilteredExportBooks();
  if (!exportBooks || exportBooks.length === 0) {
    toast('선택한 기간 조건에 해당하는 독서 데이터가 없습니다.');
    return;
  }

  const headers = ['번호', '제목', '저자', '읽은 날짜', '평점', '페이지 수', '키워드', '한줄 감상평'];
  
  const escapeCSVField = (field) => {
    if (field === null || field === undefined) return '""';
    const str = String(field).replace(/"/g, '""');
    return `"${str}"`;
  };

  const totalCount = exportBooks.length;

  const rows = exportBooks.map((b, index) => {
    const seqNum = totalCount - index; // 역순 일련번호
    const numericRating = Math.max(0, Math.min(5, Number(b.rating) || 0));
    const title = b.title || '';
    const author = b.author || '';
    const date = b.date || '';
    const starRating = '★'.repeat(numericRating) + '☆'.repeat(5 - numericRating);
    
    const pages = b.pages || 0;
    const keywords = Array.isArray(b.keywords) ? b.keywords.join(', ') : (b.keywords || '');
    const sentence = b.sentence || '';

    return [
      escapeCSVField(seqNum),
      escapeCSVField(title),
      escapeCSVField(author),
      escapeCSVField(date),
      escapeCSVField(starRating),
      escapeCSVField(pages),
      escapeCSVField(keywords),
      escapeCSVField(sentence)
    ].join(',');
  });

  const csvContent = [headers.map(escapeCSVField).join(','), ...rows].join('\r\n');
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const filename = `8ook_reading_log_${dateStr}.csv`;

  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  closeModal('export-modal');
  toast(`선택한 기간의 ${exportBooks.length}권 독서 기록이 다운로드되었습니다.`);
}
