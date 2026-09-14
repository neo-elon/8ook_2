'use strict';

// Sync dynamic viewport height for iPadOS / iOS Safari & Chrome
function syncAppHeight() {
  const vh = window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${vh}px`);
}
window.addEventListener('resize', syncAppHeight, { passive: true });
window.addEventListener('orientationchange', syncAppHeight, { passive: true });
syncAppHeight();

// Supabase Configuration
const supabaseUrl = 'https://guaimwzlmdacerpvsxxw.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1YWltd3psbWRhY2VycHZzeHh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODM1NDIsImV4cCI6MjA5NjY1OTU0Mn0.zF8A_Ul3Y5aIPjZcVTYIj1gUkConuQ-b9eO7EjnoWUE';

// In-memory fallback cache for privacy/strict tracking prevention modes
const memoryStore = {};

// Clean Storage Adapter (LocalStorage + SessionStorage + In-Memory Fallback)
// Avoids document.cookie writes that trigger browser "Tracking Prevention blocked access to storage"
const persistentStorage = {
  getItem: (key) => {
    try {
      const val = localStorage.getItem(key);
      if (val !== null) return val;
    } catch (e) { }

    try {
      const val = sessionStorage.getItem(key);
      if (val !== null) {
        try { localStorage.setItem(key, val); } catch (e) { }
        return val;
      }
    } catch (e) { }

    return memoryStore[key] || null;
  },
  setItem: (key, value) => {
    memoryStore[key] = value;
    try { localStorage.setItem(key, value); } catch (e) { }
    try { sessionStorage.setItem(key, value); } catch (e) { }
  },
  removeItem: (key) => {
    delete memoryStore[key];
    try { localStorage.removeItem(key); } catch (e) { }
    try { sessionStorage.removeItem(key); } catch (e) { }
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
        flowType: 'implicit'
      }
    });
  } else {
    console.warn("Supabase SDK not loaded. Operating in LocalStorage-only mode.");
  }
} catch (e) {
  console.error("Supabase initialization failed:", e);
}

// Database schema detection flags
let dbSupportsSpineCover = false;
let dbSupportsIsPublic = (function () {
  try {
    return localStorage.getItem('rj_db_supports_is_public') !== 'false';
  } catch (e) {
    return false;
  }
})();

function handleSupabaseSchemaError(err) {
  if (!err) return false;
  let changed = false;
  const msg = (String(err.message || '') + ' ' + String(err.details || '')).toLowerCase();
  if (err.code === 'PGRST204' || msg.includes('is_public')) {
    dbSupportsIsPublic = false;
    try { localStorage.setItem('rj_db_supports_is_public', 'false'); } catch (e) {}
    changed = true;
  }
  if (err.code === 'PGRST204' || msg.includes('spinecover')) {
    dbSupportsSpineCover = false;
    changed = true;
  }
  return changed;
}

function sanitizeBookForSupabase(bookObj) {
  const allowed = [
    'id', 'user_id', 'title', 'author', 'pages', 'date',
    'sentence', 'cover', 'rating', 'scraps', 'keywords', 'created_at'
  ];
  if (dbSupportsSpineCover) {
    allowed.push('spineCover');
  }
  if (dbSupportsIsPublic) {
    allowed.push('is_public');
  }
  const clean = {};
  for (const k of allowed) {
    if (bookObj && bookObj[k] !== undefined) {
      clean[k] = bookObj[k];
    }
  }
  return clean;
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
  user_id uuid default auth.uid(),
  is_public boolean default true
);

-- 기존 테이블에 spineCover 및 is_public 컬럼이 없다면 추가
alter table books add column if not exists "spineCover" text;
alter table books add column if not exists is_public boolean default true;

alter table books enable row level security;

-- Drop existing policies if any to recreate
drop policy if exists "Allow public read" on books;
drop policy if exists "Allow public insert" on books;
drop policy if exists "Allow public update" on books;
drop policy if exists "Allow public delete" on books;
drop policy if exists "Allow individual read" on books;
drop policy if exists "Allow individual insert" on books;
drop policy if exists "Allow individual update" on books;
drop policy if exists "Allow individual delete" on books;

-- 모든 사용자(커뮤니티)가 도서를 조회할 수 있도록 SELECT 정책 허용 (수정/삭제/등록은 본인만)
create policy "Allow public read" on books for select using (true);
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
let currentAladinSort = 'Accuracy';
let currentAladinQuery = '';

/* ==============================================
   STORAGE & GUIDE HELPERS
============================================== */
function isLikeRecord(book) {
  if (!book) return false;
  return book.title === '__like__' || (typeof book.id === 'string' && book.id.startsWith('like_'));
}

function isGuideBook(book) {
  if (!book) return false;
  return book.id === '8ook_user_guide' ||
    (typeof book.title === 'string' && book.title.includes('8ook. 이용 가이드')) ||
    (typeof book.author === 'string' && book.author.includes('8ook 제작팀'));
}

function saveData() {
  try {
    if (currentUser) {
      // 로그인 사용자 로컬 저장소에는 이용 가이드북 및 좋아요 레코드를 저장하지 않음
      const userBooks = books.filter(b => !isGuideBook(b) && !isLikeRecord(b));
      localStorage.setItem(`rj_books_${currentUser.id}`, JSON.stringify(userBooks));
    } else {
      const guestBooks = books.filter(b => !isLikeRecord(b));
      localStorage.setItem('rj_books', JSON.stringify(guestBooks));
    }
  } catch (e) { }
}

async function loadData() {
  let localBooks = [];
  try {
    const key = currentUser ? `rj_books_${currentUser.id}` : 'rj_books';
    const d = localStorage.getItem(key);
    if (d) localBooks = JSON.parse(d);
  } catch (e) { }

  if (currentUser) {
    localBooks = localBooks.filter(b => !isGuideBook(b) && !isLikeRecord(b)).map(b => {
      if (b.id && b.id.startsWith('notion_') && !b.id.endsWith('_' + currentUser.id)) {
        const pageIdPart = b.id.substring(7, 39);
        return { ...b, id: 'notion_' + pageIdPart + '_' + currentUser.id };
      }
      return b;
    });
  } else {
    localBooks = localBooks.filter(b => !isLikeRecord(b));
  }

  if (!supabaseClient || !currentUser) {
    books = localBooks;
    books.forEach(b => cleanBookScraps(b));
    ensureUserGuideBook();
    saveData();
    fetchCommunityLikes();
    initCommunityLikesChannel();
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

    const rawRemoteBooks = data || [];
    const remoteBooks = rawRemoteBooks.filter(b => !isLikeRecord(b));
    if (remoteBooks.length > 0 && 'spineCover' in remoteBooks[0]) {
      dbSupportsSpineCover = true;
    }

    // Migration: If Supabase is empty but we have local guest books, upload them to Supabase (이용 가이드북 제외)
    const guestBooksStr = localStorage.getItem('rj_books');
    let guestBooks = [];
    if (guestBooksStr) {
      try { guestBooks = JSON.parse(guestBooksStr); } catch (e) { }
    }
    const userGuestBooks = guestBooks.filter(b => !isGuideBook(b) && !isLikeRecord(b));

    if (remoteBooks.length === 0 && userGuestBooks.length > 0) {
      const booksToUpload = userGuestBooks.map(b => {
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
      const payloadToUpload = booksToUpload.map(b => sanitizeBookForSupabase(b));
      let { error: syncError } = await supabaseClient
        .from('books')
        .upsert(payloadToUpload, { onConflict: 'id' });
      if (syncError && handleSupabaseSchemaError(syncError)) {
        const safePayload = booksToUpload.map(b => sanitizeBookForSupabase(b));
        const res = await supabaseClient
          .from('books')
          .upsert(safePayload, { onConflict: 'id' });
        syncError = res.error;
      }
      if (!syncError) {
        books = booksToUpload;
        toast('기존 로컬 책장 데이터를 Supabase에 동기화했습니다.');
        // Clear guest books so we don't sync them again next time
        try { localStorage.removeItem('rj_books'); } catch (e) { }
      } else {
        console.error('Failed to sync local books to Supabase:', syncError);
        books = remoteBooks;
      }
    } else {
      books = remoteBooks;
    }

    // 로그인 계정인 경우 Supabase 또는 books 배열에 잘못 들어간 이용 가이드북이 있다면 완전 정리 (좋아요 레코드 제외)
    if (currentUser) {
      const guideBooksInRemote = books.filter(b => isGuideBook(b));
      if (guideBooksInRemote.length > 0) {
        const guideIdsToDelete = guideBooksInRemote.map(b => b.id);
        books = books.filter(b => !isGuideBook(b));
        if (supabaseClient && currentUser.id) {
          supabaseClient.from('books').delete().in('id', guideIdsToDelete).eq('user_id', currentUser.id).then(() => {
            console.log('Cleaned up guide books from Supabase:', guideIdsToDelete);
          }).catch(err => console.warn('Guide cleanup error:', err));
        }
      } else {
        books = books.filter(b => !isGuideBook(b));
      }
    }

    books.forEach(b => cleanBookScraps(b));
    ensureUserGuideBook();
    saveData();
    fetchCommunityLikes();
    initCommunityLikesChannel();
  } catch (e) {
    console.error('Supabase load error, using local storage backup:', e);
    books = currentUser ? localBooks.filter(b => !isGuideBook(b) && !isLikeRecord(b)) : localBooks.filter(b => !isLikeRecord(b));
    books.forEach(b => cleanBookScraps(b));
    ensureUserGuideBook();
    saveData();
    fetchCommunityLikes();
    initCommunityLikesChannel();
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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ==============================================
   HELPERS
============================================== */
function decodeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function esc(s) {
  if (!s) return '';
  const decoded = decodeHtml(s);
  return String(decoded)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function starsHtml(n, size) {
  let h = '';
  for (let i = 1; i <= 5; i++) {
    const on = i <= (n || 0);
    h += `<span class="detail-star${on ? ' on' : ''}" style="color:${on ? 'var(--amber)' : 'var(--star-off)'};font-size:${size || 20}px">${on ? '★' : '☆'}</span>`;
  }
  return h;
}

function starsPlain(n) {
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= (n || 0) ? '⭐' : '·';
  return s;
}

function toast(msg, dur = 2600) {
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
  } catch (e) {
    return 'spine-month';
  }
}

let galleryViewMode = (function () {
  try {
    const m = localStorage.getItem('rj_gallery_view_mode');
    if (m === 'spine') return 'spine-month';
    return m || 'spine-month';
  } catch (e) {
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

function parseTitleParts(bookOrTitle) {
  return splitBookTitle(bookOrTitle);
}

function splitBookTitle(bookOrTitle) {
  if (!bookOrTitle) return { main: '', sub: '' };
  let titleStr = '';
  let subStr = '';

  if (typeof bookOrTitle === 'object') {
    titleStr = (bookOrTitle.title || '').trim();
    subStr = (bookOrTitle.subtitle || '').trim();
  } else {
    titleStr = String(bookOrTitle).trim();
  }

  titleStr = decodeHtml(titleStr);
  subStr = decodeHtml(subStr);

  if (subStr) {
    return { main: titleStr, sub: subStr };
  }

  // Common title - subtitle delimiters: " - ", " – ", " — ", " : ", ": "
  const delimiterMatch = titleStr.match(/^(.*?)(?:\s+[-–—]\s+|\s*[:：]\s+)(.+)$/);
  if (delimiterMatch && delimiterMatch[1].trim() && delimiterMatch[2].trim()) {
    return {
      main: delimiterMatch[1].trim(),
      sub: delimiterMatch[2].trim()
    };
  }

  // Bracketed subtitle at the end: e.g. "제목 <부제>", "제목 〈부제〉", "제목 《부제》"
  const bracketMatch = titleStr.match(/^(.*?)\s+([<〈《][^>〉》]+[>〉》])$/);
  if (bracketMatch && bracketMatch[1].trim() && bracketMatch[2].trim()) {
    return {
      main: bracketMatch[1].trim(),
      sub: bracketMatch[2].trim()
    };
  }

  return { main: titleStr, sub: '' };
}

// ==============================================
// Cover Color Extraction & Hardcover Spine Theme
// ==============================================
const SPINE_COVER_CACHE_KEY = 'rj_spine_cover_theme_cache_v1';
let spineCoverThemeCache = {};
try {
  const saved = localStorage.getItem(SPINE_COVER_CACHE_KEY);
  if (saved) spineCoverThemeCache = JSON.parse(saved);
} catch (e) {
  spineCoverThemeCache = {};
}

let _saveSpineCacheTimer = null;
function scheduleSaveSpineCache() {
  if (_saveSpineCacheTimer) clearTimeout(_saveSpineCacheTimer);
  _saveSpineCacheTimer = setTimeout(() => {
    try {
      localStorage.setItem(SPINE_COVER_CACHE_KEY, JSON.stringify(spineCoverThemeCache));
    } catch (e) { }
  }, 800);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function generateHardcoverThemeFromRgb(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const avgLum = (max + min) / 2;
  const chroma = max - min;

  // 1. Archival Antique Vellum / Cream Paper (밝은 미색 또는 백색 표지)
  if (avgLum >= 195 && chroma < 42) {
    const [h, s] = rgbToHsl(r, g, b);
    const sat = Math.max(8, Math.min(s, 24));
    return {
      bg: `linear-gradient(180deg, hsl(${h || 40}, ${sat}%, 91%) 0%, hsl(${h || 40}, ${sat}%, 84%) 50%, hsl(${h || 40}, ${sat + 4}%, 75%) 100%)`,
      solidBg: `hsl(${h || 40}, ${sat}%, 84%)`,
      isLight: true,
      text: '#1a1815',
      authorColor: '#4d463d'
    };
  }

  // 2. Luxury Hardcover Leather (앞표지의 고유 색채를 머금은 고급 양장본 가죽 그라데이션)
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = Math.max(26, Math.min(s, 56));
  const lBase = Math.round(14 + (l / 100) * 10); // 14% ~ 24% 깊이 있는 가죽 톤
  const lTop = Math.min(lBase + 7, 32);
  const lBottom = Math.max(lBase - 6, 7);

  return {
    bg: `linear-gradient(180deg, hsl(${h}, ${sat}%, ${lTop}%) 0%, hsl(${h}, ${sat}%, ${lBase}%) 50%, hsl(${h}, ${Math.min(sat + 6, 62)}%, ${lBottom}%) 100%)`,
    solidBg: `hsl(${h}, ${sat}%, ${lBase}%)`,
    isLight: false,
    text: '#f7ecd8',
    authorColor: '#dbc7a8'
  };
}

function getSpineCoverTheme(book) {
  if (!book) return null;
  const key = book.id || book.cover;
  if (key && spineCoverThemeCache[key]) {
    return spineCoverThemeCache[key];
  }
  return null;
}

function extractCoverTheme(book, callback) {
  if (!book || !book.cover) return;
  const key = book.id || book.cover;
  if (spineCoverThemeCache[key]) {
    if (callback) callback(spineCoverThemeCache[key]);
    return;
  }

  const coverUrl = getSafeImageUrl(book.cover);
  if (!coverUrl) return;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      const w = 24;
      const h = 36;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const natW = img.naturalWidth || img.width || 100;
      const natH = img.naturalHeight || img.height || 150;
      // 앞표지의 좌측 35% 영역 (책등과 맞닿는 힌지 부분)에서 대표 컬러 샘플링
      const sampleW = Math.max(1, Math.floor(natW * 0.35));
      ctx.drawImage(img, 0, 0, sampleW, natH, 0, 0, w, h);

      const imgData = ctx.getImageData(0, 0, w, h).data;
      let totalWeight = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;

      for (let i = 0; i < imgData.length; i += 4) {
        if (imgData[i + 3] < 128) continue;
        const r = imgData[i];
        const g = imgData[i + 1];
        const b = imgData[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lum = (max + min) / 2;
        const chroma = max - min;

        let weight = 1;
        if (lum < 15 || lum > 250) {
          weight = 0.1;
        } else if (chroma > 20) {
          weight = 2 + (chroma / 255) * 3;
        }

        rSum += r * weight;
        gSum += g * weight;
        bSum += b * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        const r = Math.round(rSum / totalWeight);
        const g = Math.round(gSum / totalWeight);
        const b = Math.round(bSum / totalWeight);
        const theme = generateHardcoverThemeFromRgb(r, g, b);
        spineCoverThemeCache[key] = theme;
        scheduleSaveSpineCache();
        if (callback) callback(theme);
      }
    } catch (e) {
      // CORS or canvas error; fallback remains
    }
  };
  img.onerror = () => {
    // image load error
  };
  img.src = coverUrl;
}

window.clearSpineCoverCache = function() {
  try { localStorage.removeItem(SPINE_COVER_CACHE_KEY); } catch (e) { }
  spineCoverThemeCache = {};
  if (typeof renderGallery === 'function') renderGallery();
};

function getSpineTheme(book) {
  if (book) {
    const customTheme = getSpineCoverTheme(book);
    if (customTheme) return customTheme;
  }
  const spineThemes = [
    {
      // 1. Royal Midnight Navy Leather
      bg: 'linear-gradient(180deg, #1b2838 0%, #141f2d 50%, #0d151f 100%)',
      solidBg: '#141f2d',
      text: '#f6ecdc',
      authorColor: '#decab0',
      isLight: false
    },
    {
      // 2. British Library Forest Green Leather
      bg: 'linear-gradient(180deg, #1d3527 0%, #15261c 50%, #0d1812 100%)',
      solidBg: '#15261c',
      text: '#f5edd8',
      authorColor: '#c8dbcd',
      isLight: false
    },
    {
      // 3. Antique Burgundy Wine Leather
      bg: 'linear-gradient(180deg, #44171d 0%, #310f13 50%, #20070a 100%)',
      solidBg: '#310f13',
      text: '#fcefd8',
      authorColor: '#e5b8bf',
      isLight: false
    },
    {
      // 4. Saddle Cognac Moroccan Leather
      bg: 'linear-gradient(180deg, #58341e 0%, #412312 50%, #2c160a 100%)',
      solidBg: '#412312',
      text: '#faebd0',
      authorColor: '#dec1a0',
      isLight: false
    },
    {
      // 5. Archival Antique Vellum / Heavy Cloth
      bg: 'linear-gradient(180deg, #ede6d6 0%, #ded5be 50%, #cbbe9f 100%)',
      solidBg: '#ded5be',
      text: '#1a1815',
      authorColor: '#4d463d',
      isLight: true
    },
    {
      // 6. Obsidian Charcoal Bookcloth
      bg: 'linear-gradient(180deg, #222429 0%, #18191d 50%, #101114 100%)',
      solidBg: '#18191d',
      text: '#f4ebd8',
      authorColor: '#a8abb3',
      isLight: false
    }
  ];
  let hash = 0;
  const str = (book ? (book.title || '') + (book.id || '') : '');
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % spineThemes.length;
  return spineThemes[idx];
}

function setGalleryViewMode(mode) {
  if (mode === 'spine') mode = 'spine-month';
  galleryViewMode = mode;
  try { localStorage.setItem('rj_gallery_view_mode', mode); } catch (e) { }
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
  const card = e.target.closest('.book-card');
  if (!card) {
    document.querySelectorAll('.book-card.is-hovered').forEach(c => {
      c.classList.remove('is-hovered');
    });
  }
});

/* ==============================================
   GALLERY
============================================== */
function getShelfTotalPages(booksList) {
  if (!booksList || !booksList.length) return 0;
  return booksList.reduce((sum, b) => {
    const p = parseInt(b.pages, 10);
    if (!isNaN(p) && p > 0) return sum + p;
    const w = getSpineWidth(b.pages);
    return sum + Math.max(100, Math.round((w - 18) / 0.055 / 10) * 10);
  }, 0);
}

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
    const starBooks = books.filter(b => b.rating === 5);
    const starCount = starBooks.length;
    const starPages = getShelfTotalPages(starBooks);
    const starsBanner = document.createElement('div');
    starsBanner.className = 'stars-shelf-banner';
    starsBanner.style.cssText = 'grid-column: 1 / -1; width: 100%; background: linear-gradient(135deg, rgba(201, 122, 43, 0.12) 0%, rgba(166, 96, 30, 0.05) 100%); border: 1px solid rgba(201, 122, 43, 0.3); border-radius: var(--radius-md); padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--text-100); margin-bottom: 8px; box-sizing: border-box;';
    starsBanner.innerHTML = `
      <span style="display:flex; align-items:center; gap:8px;">
        <strong>인생작 책장</strong>
        <span style="font-size:11px; opacity:0.8; color:var(--amber);">(★ 5.0)</span>
        <span class="shelf-year-count" style="margin-left:2px; font-weight:700; color:var(--amber); background:rgba(201,122,43,0.15);">${starCount}권 · ${starPages.toLocaleString()}p</span>
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
  if (currentUser) {
    displayBooks = displayBooks.filter(b => !isGuideBook(b));
  }
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
      const scrapMatch = b.scraps && b.scraps.some(s => {
        const textMatch = s.text && s.text.toLowerCase().includes(searchQuery);
        const memoMatch = s.memo && s.memo.toLowerCase().includes(searchQuery);
        const tagMatch = (s.tags || s.keywords || []).some(t => t.toLowerCase().includes(searchQuery) || ('#' + t.toLowerCase()).includes(searchQuery));
        return textMatch || memoMatch || tagMatch;
      });
      return titleMatch || authorMatch || keywordMatch || sentenceMatch || scrapMatch;
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
      empty.querySelector('.empty-p').innerHTML = '위의 <strong>책 추가(＋)</strong> 버튼을 눌러 책을 추가하세요.';
    }
  } else {
    empty.classList.remove('show');
  }

  const sortedBooks = [...displayBooks].sort((a, b) => {
    if (isGuideBook(a)) return -1;
    if (isGuideBook(b)) return 1;
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
        const yearPages = getShelfTotalPages(booksInYear);
        yearSection.setAttribute('data-label', yearLabel);
        yearSection.setAttribute('data-ym', yKey);

        const header = document.createElement('div');
        header.className = 'shelf-year-header';
        header.innerHTML = `
          <div class="shelf-year-badge">
            <span class="shelf-year-title">${yearLabel}</span>
            <span class="shelf-year-count">${booksInYear.length}권 · ${yearPages.toLocaleString()}p</span>
            <button class="shelf-download-btn" onclick="downloadYearShelfImage('${esc(yKey)}', '${esc(yearLabel)}')" title="${esc(yearLabel)} 책장 이미지 저장" aria-label="책장 이미지 저장" style="color:var(--text-300); opacity:0.8;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v12"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
              </svg>
            </button>
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
        updateShelfScrollTrackerVisibility();
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
      const monthPages = getShelfTotalPages(booksInMonth);
      monthSection.setAttribute('data-label', monthLabel);
      monthSection.setAttribute('data-ym', ymKey);

      const header = document.createElement('div');
      header.className = 'shelf-year-header';
      header.innerHTML = `
        <div class="shelf-year-badge">
          <span class="shelf-year-title">${monthLabel}</span>
          <span class="shelf-year-count">${booksInMonth.length}권 · ${monthPages.toLocaleString()}p</span>
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
      updateShelfScrollTrackerVisibility();
    });
    return;
  }

  sortedBooks.forEach((book, i) => {
    const card = createBookCardElement(book, i, false);
    grid.appendChild(card);
  });
  requestAnimationFrame(() => {
    updateShelfScrollTrackerVisibility();
  });
}

function enableSpineShelfWheel(rowEl) {
  if (!rowEl) return;

  // 1. 마우스 드래그 가로 스크롤 (책장 안에서 가로 이동을 자유롭게 조작)
  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;
  let hasMoved = false;

  rowEl.addEventListener('mousedown', (e) => {
    // 버튼, 링크 등 클릭 시 드래그 제외
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return;
    isDown = true;
    hasMoved = false;
    startX = e.pageX - rowEl.offsetLeft;
    scrollLeft = rowEl.scrollLeft;
  });

  const onMouseUpOrLeave = () => {
    if (isDown) {
      isDown = false;
      rowEl.style.cursor = 'grab';
    }
  };

  window.addEventListener('mouseup', onMouseUpOrLeave);
  rowEl.addEventListener('mouseleave', onMouseUpOrLeave);

  rowEl.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    const x = e.pageX - rowEl.offsetLeft;
    const walk = (x - startX) * 1.3;
    if (Math.abs(walk) > 4) {
      hasMoved = true;
      rowEl.style.cursor = 'grabbing';
      rowEl.scrollLeft = scrollLeft - walk;
    }
  });

  // 드래그 중 책 카드가 잘못 열리지 않도록 클릭 이벤트 캡처 방지
  rowEl.addEventListener('click', (e) => {
    if (hasMoved) {
      e.stopPropagation();
      e.preventDefault();
      hasMoved = false;
    }
  }, true);

  // 2. 휠 이벤트:
  // - Shift 키를 누르고 있거나 가로 휠/터치패드(deltaX)인 경우: 책장 가로 스크롤
  // - 일반 세로 휠(deltaY): 상위 전체 화면(#gallery-scroll)의 자연스러운 세로 스크롤로 통과
  rowEl.addEventListener('wheel', (e) => {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      if (rowEl.scrollWidth > rowEl.clientWidth) {
        const delta = e.shiftKey ? e.deltaY : e.deltaX;
        rowEl.scrollLeft += delta;
        e.preventDefault();
      }
    }
    // 일반 세로 휠(deltaY)은 브라우저 기본 세로 스크롤(#gallery-scroll)에 맡김
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

  await generateShelfImage(targetBooks, monthLabel, `${targetBooks.length}권`, `8ook_${monthLabel.replace(/[^\w가-힣]/g, '_')}_책장`);
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

  await generateShelfImage(targetBooks, yearLabel, `${targetBooks.length}권`, `8ook_${yearLabel.replace(/[^\w가-힣]/g, '_')}_책장`);
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

  await generateShelfImage(targetBooks, '인생작', `${targetBooks.length}권`, '8ook_인생작_책장');
}

async function generateShelfImage(targetBooks, shelfTitle, subtitle, filename) {
  toast('책장 이미지 저장 중');

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
            // 실물 책등 비율 안전 제한: 0.07 ~ 0.35
            const clampedAspect = Math.max(0.07, Math.min(0.35, aspect));
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

    // 2. 1:1 정사각형 비율 유지 및 여백 최소화 레이아웃 계산
    const totalPages = getShelfTotalPages(targetBooks);
    const count = loadedItems.length;
    const gap = 2; // 책 사이 실물처럼 밀착

    // 1:1 정사각형 규격 (기본 1080x1080)
    let S = 1080;
    const paddingX = 32;
    const headerH = 56; // 상단 헤더 공간
    const bottomMargin = 24; // 하단 선반 바닥 그림자 공간

    const availW = S - paddingX * 2;
    const availH = S - headerH - bottomMargin;

    const sumAspect = loadedItems.reduce((acc, item) => acc + item.aspect, 0);

    // 책 높이: 1:1 정사각형 안에서 세로를 최대한 꽉 채우도록 계산
    let bookH = Math.floor((availW - (count - 1) * gap) / (sumAspect || 1));
    if (bookH > availH) {
      bookH = availH;
    }
    if (bookH < 350) bookH = 350;

    const scale = bookH / 351;

    // 각 책의 너비 계산 (실제 종횡비 반영, 최소 두께 보장)
    const itemsWithWidth = loadedItems.map(item => {
      let w = Math.round(item.aspect * bookH);
      if (w < Math.round(28 * scale)) w = Math.round(28 * scale);
      return { ...item, width: w };
    });

    const totalBooksW = itemsWithWidth.reduce((acc, item) => acc + item.width, 0) + (count - 1) * gap;

    // 만약 책 권수가 매우 많아 총 너비가 1080을 초과하면, 1:1 정사각형 비율을 엄격히 유지하며 S를 확장
    if (totalBooksW + paddingX * 2 > S) {
      S = totalBooksW + paddingX * 2;
    }

    // 1:1 정사각형 중앙 정렬 (가로)
    const booksStartX = Math.max(paddingX, Math.round((S - totalBooksW) / 2));

    // 바닥 선반에 책 접지 (세로: 상단 여백 최소화하고 선반 바닥에 자연스럽게 밀착)
    const shelfBaseY = S - bottomMargin;
    const startY = shelfBaseY - bookH;

    // 1:1 정사각형 고해상도 캔버스 생성 (가로 = 세로 = S, 완벽한 1:1 비율)
    const canvas = document.createElement('canvas');
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 3. 배경 그리기 (서재 배경과 일치하는 내추럴 웜 베이지 그라데이션)
    const bgGrad = ctx.createLinearGradient(0, 0, 0, S);
    bgGrad.addColorStop(0, '#f9f6f1');
    bgGrad.addColorStop(0.45, '#f4eee5');
    bgGrad.addColorStop(1, '#ece4d8');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, S, S);

    // 4. 상단 타이틀 헤더 렌더링 ([2026년 9월 7권 · 2,450p ────────])
    let titleText = shelfTitle;
    const ymMatch = shelfTitle.match(/(\d{4}년\s*\d{1,2}월)/);
    const yMatch = shelfTitle.match(/(\d{4}년)/);
    if (ymMatch) {
      titleText = ymMatch[1];
    } else if (yMatch) {
      titleText = yMatch[1];
    } else if (shelfTitle.includes('인생작')) {
      titleText = '인생작';
    } else if (shelfTitle.includes('미정')) {
      titleText = '완독일 미정';
    }

    const countText = totalPages > 0 ? `${count}권 · ${totalPages.toLocaleString()}p` : `${count}권`;

    ctx.save();
    const titleY = Math.max(28, Math.min(36, Math.round(startY * 0.52)));

    // 제목 텍스트 (볼드 차콜 블랙)
    ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif';
    ctx.fillStyle = '#1c1917';
    ctx.textBaseline = 'middle';
    ctx.fillText(titleText, paddingX, titleY);
    const titleMetrics = ctx.measureText(titleText);

    // 권수 및 총 페이지수 텍스트 (그레이시 톤)
    const countX = paddingX + titleMetrics.width + 10;
    ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif';
    ctx.fillStyle = '#78716c';
    ctx.fillText(countText, countX, titleY);
    const countMetrics = ctx.measureText(countText);

    // 우측 페이드아웃 구분선
    const lineStartX = countX + countMetrics.width + 14;
    const lineEndX = S - paddingX;
    if (lineEndX > lineStartX) {
      const lineGrad = ctx.createLinearGradient(lineStartX, 0, lineEndX, 0);
      lineGrad.addColorStop(0, 'rgba(0, 0, 0, 0.10)');
      lineGrad.addColorStop(0.65, 'rgba(0, 0, 0, 0.03)');
      lineGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lineStartX, titleY);
      ctx.lineTo(lineEndX, titleY);
      ctx.stroke();
    }
    ctx.restore();

    // 5. 책등 및 바닥 선반 렌더링
    let curX = booksStartX;

    // 책장 바닥 접점 그림자
    const contactGrad = ctx.createLinearGradient(0, shelfBaseY, 0, shelfBaseY + 3 * scale);
    contactGrad.addColorStop(0, 'rgba(0, 0, 0, 0.08)');
    contactGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = contactGrad;
    ctx.fillRect(booksStartX - 4, shelfBaseY, totalBooksW + 8, 3 * scale);

    itemsWithWidth.forEach(item => {
      const { book, img, width: w } = item;

      const drawCardPath = () => {
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(curX, startY, w, bookH, [2 * scale, 2 * scale, 0, 0]);
        } else {
          ctx.rect(curX, startY, w, bookH);
        }
      };

      if (img) {
        ctx.save();
        drawCardPath();
        ctx.clip();
        ctx.drawImage(img, curX, startY, w, bookH);
        ctx.restore();
      } else {
        // 대체 표지 책등 (알라딘 이미지 없을 때)
        const theme = getSpineTheme(book);
        ctx.save();
        drawCardPath();
        ctx.clip();

        ctx.fillStyle = theme.solidBg || '#1e1e2d';
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

        ctx.restore();
      }

      // 6. 별점 5점 (인생작) 골드 스타 뱃지 렌더링
      if (book.rating === 5) {
        ctx.save();
        const starX = curX + w / 2;
        const starY = startY + 20 * scale;
        const starR = 11 * scale;

        ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
        ctx.shadowBlur = 2 * scale;
        ctx.shadowOffsetY = 1 * scale;

        const starGrad = ctx.createRadialGradient(starX - 2.5 * scale, starY - 2.5 * scale, 1, starX, starY, starR);
        starGrad.addColorStop(0, '#ffd700');
        starGrad.addColorStop(0.7, '#ffae00');
        starGrad.addColorStop(1, '#d48800');
        ctx.fillStyle = starGrad;
        ctx.beginPath();
        ctx.arc(starX, starY, starR, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#fff5cc';
        ctx.lineWidth = 1.2 * scale;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(11 * scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', starX, starY + 0.5 * scale);
        ctx.restore();
      }

      curX += w + gap;
    });

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
      toast(`${titleText} 책장 이미지가 저장되었습니다!`);
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
  if (isSpineMode) {
    card.style.animation = 'none';
    card.style.animationDelay = '0s';
  } else {
    // 일반 갤러리 모드에서도 최대 0.2초까지만 가볍게 순차 적용
    card.style.animationDelay = (Math.min(i, 8) * 0.025) + 's';
  }
  card.setAttribute('data-id', book.id);
  const hasPages = Boolean(book.pages && parseInt(book.pages, 10) > 0);
  card.setAttribute('data-has-pages', hasPages ? 'true' : 'false');
  if (hasPages) {
    card.setAttribute('data-pages', String(book.pages));
  }

  const titleParts = splitBookTitle(book);

  let imgPart = '';
  if (book.cover) {
    imgPart = `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}" data-title="${esc(book.title)}" crossorigin="anonymous" onerror="handleCoverError(this)">`;
  } else {
    imgPart = `<div class="book-card-placeholder">
      <span class="placeholder-title">${esc(book.title)}</span>
    </div>`;
  }

  const sentence = book.sentence
    ? `<div class="ov-sentence">${esc(book.sentence)}</div>` : '';
  const kingStarBadge = book.rating === 5
    ? `<div class="king-star-badge wax-seal-badge" title="인생작 (별점 5점)">
        <div class="wax-seal-core">
          <span class="wax-seal-num">5</span><span class="wax-seal-star">★</span>
        </div>
      </div>` : '';
  const spineWaxSeal = book.rating === 5
    ? `<div class="spine-wax-seal" title="인생작 (별점 5점)">
        <div class="wax-seal-core">
          <span class="wax-seal-num">5</span><span class="wax-seal-star">★</span>
        </div>
      </div>` : '';

  const isGuideCard = isGuideBook(book);

  if (isSpineMode) {
    const spineW = isGuideCard ? 240 : getSpineWidth(book.pages);
    card.style.width = spineW + 'px';
    card.style.setProperty('--spine-w', spineW + 'px');
    if (isGuideCard) {
      card.classList.add('guide-spread-card', 'is-hovered');
    }

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
      ? `<img class="spine-real-img" src="${esc(spineImgUrl)}" alt="${esc(book.title)}" onload="adjustSpineCardWidth(this)" onerror="handleRealSpineError(this)">`
      : '';

    card.innerHTML = `
      <div class="spine-3d-wrapper">
        <div class="spine-face">
          ${realSpineTag}
          <div class="spine-custom-view${spineImgUrl ? '' : ' show-fallback'}${theme.isLight ? ' spine-light-vellum' : ''}" style="background: ${theme.bg};">
            <div class="spine-headband top"></div>
            <div class="spine-leather-grain"></div>
            <div class="spine-volume-shading"></div>

            <div class="spine-top-fillet">
              <div class="spine-gilt-rule"></div>
              <div class="spine-series-tag"><span>8ook</span></div>
              <div class="spine-gilt-rule"></div>
            </div>

            <div class="spine-raised-rib"></div>

            <div class="spine-title-wrap">
              <span class="spine-title-serif" style="${titleStyleExtra}">${esc(book.title)}</span>
            </div>

            <div class="spine-raised-rib"></div>

            <div class="spine-author-wrap">
              <span class="spine-author-serif">✻ ${esc(book.author || '작자 미상')}</span>
            </div>

            <div class="spine-raised-rib"></div>

            <div class="spine-publisher-emblem">
              <div class="emblem-fig"></div>
              <span class="publisher-name">8ook</span>
            </div>

            <div class="spine-headband bottom"></div>
          </div>
          ${spineWaxSeal}
        </div>
        <div class="cover-face">
          ${isGuideCard ? '<div class="guide-ribbon-badge">📖 이용 가이드</div>' : ''}
          ${imgPart}
          ${kingStarBadge}
          <div class="book-hover-overlay">
            <div class="ov-title">
              <div class="ov-main-title">${esc(titleParts.main)}</div>
              ${titleParts.sub ? `<div class="ov-sub-title">${esc(titleParts.sub)}</div>` : ''}
            </div>
            <div class="ov-author">${esc(book.author || '')}</div>
            ${sentence}
            ${book.rating ? `<div class="ov-stars">${starsPlain(book.rating)}</div>` : ''}
            ${isGuideCard ? '<div class="ov-tap-guide" style="opacity:1;">클릭하여 이용 가이드 읽기 ➔</div>' : ''}
          </div>
        </div>
      </div>
    `;

    // 앞표지 기반 양장본 테마 비동기 추출 및 동적 반영
    if (!getSpineCoverTheme(book) && book.cover) {
      extractCoverTheme(book, (newTheme) => {
        const customView = card.querySelector('.spine-custom-view');
        if (customView) {
          customView.style.background = newTheme.bg;
          if (newTheme.isLight) {
            customView.classList.add('spine-light-vellum');
          } else {
            customView.classList.remove('spine-light-vellum');
          }
        }
      });
    }

    card.addEventListener('mousemove', (e) => {
      if (isGuideCard) {
        card.title = '8ook. 이용 가이드 (클릭하여 읽기)';
        return;
      }
      const isHovered = card.matches(':hover');
      const isClassHovered = card.classList.contains('is-hovered');
      const isClosed = card.classList.contains('is-closed');
      const isCoverOpen = (isHovered || isClassHovered) && !isClosed;
      if (isCoverOpen) {
        const rect = card.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        if (relativeY < rect.height / 2) {
          card.title = '클릭하여 표지 닫기';
        } else {
          card.title = '클릭하여 서평 보기';
        }
      } else {
        card.title = book.title || '';
      }
    });

    card.addEventListener('click', (e) => {
      // 이용가이드 카드는 클릭 시 바로 상세 가이드로 이동
      if (isGuideCard) {
        showDetail(book.id);
        return;
      }

      // 1. 현재 앞표지가 열려 있는 상태인지 판별
      const isHovered = card.matches(':hover');
      const isClassHovered = card.classList.contains('is-hovered');
      const isClosed = card.classList.contains('is-closed');
      const isCoverOpen = (isHovered || isClassHovered) && !isClosed;

      // 아직 앞표지가 닫혀 있는 책등 상태일 때: 클릭 시 앞표지 열기
      if (!isCoverOpen) {
        e.stopPropagation();
        document.querySelectorAll('.book-card.spine-mode.is-hovered:not(.guide-spread-card)').forEach(c => {
          if (c !== card) {
            c.classList.remove('is-hovered');
            c.classList.remove('is-closed');
          }
        });
        card.classList.remove('is-closed');
        card.classList.add('is-hovered');
        return;
      }

      // 2. 앞표지가 열려 있는 상태에서 클릭했을 때:
      const rect = card.getBoundingClientRect();
      const clientY = (e.clientY !== undefined) ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      const relativeY = clientY - rect.top;
      const isTopPart = relativeY < (rect.height / 2);

      if (isTopPart) {
        // 윗부분 클릭: 앞표지 닫기
        e.stopPropagation();
        card.classList.remove('is-hovered');
        card.classList.add('is-closed');
      } else {
        // 아랫부분 클릭: 서평(도서 상세) 페이지로 이동
        showDetail(book.id);
      }
    });

    card.addEventListener('mouseleave', () => {
      if (!isGuideCard) {
        card.classList.remove('is-closed');
        card.classList.remove('is-hovered');
      }
      card.title = book.title || '';
    });
  } else {
    card.innerHTML = `
      ${isGuideCard ? '<div class="guide-ribbon-badge">📖 이용 가이드</div>' : ''}
      ${imgPart}
      ${kingStarBadge}
      <div class="book-hover-overlay">
        <div class="ov-title">
          <div class="ov-main-title">${esc(titleParts.main)}</div>
          ${titleParts.sub ? `<div class="ov-sub-title">${esc(titleParts.sub)}</div>` : ''}
        </div>
        <div class="ov-author">${esc(book.author || '')}</div>
        ${sentence}
        ${book.rating ? `<div class="ov-stars">${starsPlain(book.rating)}</div>` : ''}
        <div class="ov-tap-guide">${isGuideCard ? '클릭하여 이용 가이드 읽기 ➔' : '한 번 더 탭하면 서평으로 이동 →'}</div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (isGuideCard) {
        showDetail(book.id);
        return;
      }
      const isMobile = window.matchMedia('(hover: none), (pointer: coarse), (max-width: 768px)').matches || e.pointerType === 'touch';

      if (isMobile) {
        // 모바일/터치 환경: 첫 번째 탭이면 요약(오버레이) 표시, 이미 열린 상태(두 번째 탭)면 서평 상세로 이동
        if (!card.classList.contains('is-hovered')) {
          e.stopPropagation();
          document.querySelectorAll('.book-card.is-hovered').forEach(c => {
            if (c !== card) c.classList.remove('is-hovered');
          });
          card.classList.add('is-hovered');
          return;
        }
      }

      // 데스크톱 클릭이거나 모바일 두 번째 클릭 시 서평 페이지로 이동
      card.classList.remove('is-hovered');
      showDetail(book.id);
    });
  }

  return card;
}

function cleanBookScraps(book) {
  if (!book || !book.scraps || !Array.isArray(book.scraps) || book.scraps.length === 0) return;
  const initialLen = book.scraps.length;
  const targetSentence = (book.sentence || '').trim().toLowerCase();

  book.scraps = book.scraps.filter(s => {
    const sText = (s.text || '').trim().toLowerCase();
    // 1. 나만의 한 문장(sentence)과 동일한 문장은 스크랩에서 제거
    if (targetSentence && (sText === targetSentence || sText.replace(/\s+/g, '') === targetSentence.replace(/\s+/g, ''))) {
      return false;
    }
    // 2. One Message / One Action / 원메시지 / 원액션 / 후기링크 관련 메모 및 태그인 경우 제거
    const memo = (s.memo || '').toLowerCase();
    const tags = (s.tags || []).map(t => String(t).toLowerCase());
    if (memo.includes('one message') || memo.includes('원메시지') ||
        memo.includes('one action') || memo.includes('원액션') || memo.includes('독서후기 원문') || memo.includes('후기 원문')) {
      return false;
    }
    if (tags.some(t => t.includes('onemessage') || t.includes('oneaction') || t.includes('후기링크') || t.includes('원메시지') || t.includes('원액션'))) {
      return false;
    }
    return true;
  });

  return book.scraps.length !== initialLen;
}

/* ==============================================
   DETAIL VIEW
============================================== */
function showDetail(id, direction = null, pushHistory = true) {
  let book = books.find(b => b.id === id);
  if (!book && typeof window !== 'undefined' && window.NEO_BOOKS_131) {
    book = window.NEO_BOOKS_131.find(b => b.id === id);
  }
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
    ? `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}" onerror="handleDetailThumbError(this)">`
    : `<div class="detail-thumb-placeholder">8ook</div>`;

  const chips = [];
  if (book.pages) chips.push(`<div class="chip">${Number(book.pages).toLocaleString()}p</div>`);
  if (book.date) chips.push(`<div class="chip">${fmtDate(book.date)}</div>`);
  if (book.is_public === false) {
    chips.push(`<div class="chip" style="background:rgba(239,68,68,0.15); color:#f87171; border-color:rgba(239,68,68,0.3);" title="내 서재에만 보이고 커뮤니티에는 비공개됩니다">🔒 비공개</div>`);
  }
  const scrapCount = (book.scraps || []).length;

  const kwHtml = (book.keywords && book.keywords.length)
    ? `<div class="meta-chips" style="margin-top:6px;">${book.keywords.map(k => `<button type="button" class="kw-chip" onclick="openEditModal('${book.id}', true)">#${esc(k)}</button>`).join('')}</div>`
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
      <div class="detail-rating-row" style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div class="detail-stars">${starsHtml(book.rating, 22)}</div>
        <div class="detail-book-actions" style="display:flex; gap:6px; align-items:center;">
          ${isGuideDetail
            ? `<button class="btn btn-ghost btn-sm" onclick="showDetail('8ook_user_guide'); toast('가이드가 최신 상태로 갱신되었습니다');" style="padding:2px 8px; font-size:11px; border-radius:4px; height:22px; line-height:1; color:#d4af37; border-color:rgba(212,175,55,0.4);">가이드 최신화</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="openEditModal('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:4px; height:22px; line-height:1;">편집</button>
               <button class="btn btn-danger btn-sm" onclick="doDeleteBook('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:22px; line-height:1;">삭제</button>`
          }
        </div>
      </div>
      ${book.sentence ? `<div class="detail-sentence">${esc(book.sentence)}</div>` : ''}
    </div>

    <div class="scraps-sec">
      <div class="scraps-hdr" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:10px; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="scraps-htitle">${isGuideDetail ? '상세 가이드 챕터' : '수집한 문장'}</div>
          ${isGuideDetail ? '' : `
            <button class="btn btn-ghost btn-sm" onclick="openScrapModal('${book.id}')" style="padding:2px 8px; font-size:11px; border-radius:12px; height:22px; line-height:1;">+ 추가</button>
            <button class="btn btn-ghost btn-sm" onclick="copyBookForBlog('${book.id}')" title="블로그 포스팅용으로 도서 정보와 수집한 문장 전체를 복사합니다" style="padding:2px 8px; font-size:11px; border-radius:12px; height:22px; line-height:1;">📋 내용 복사</button>
          `}
        </div>
        <div class="scraps-badge" id="scrap-badge">${scrapCount} ${isGuideDetail ? '챕터' : '/ 100'}</div>
      </div>
      <div class="scrap-list" id="scrap-list">${scrapsHtml}</div>
      ${!isGuideDetail && scrapCount === 0
      ? `<div class="scraps-empty">아직 수집한 문장이 없습니다.<br>
           <small style="font-size:11px;">상단이나 아래의 "+ 문장 추가" 버튼으로 문장을 기록해보세요</small></div>`
      : ''}
      ${!isGuideDetail ? `
      <div class="scraps-bottom-action">
        <button type="button" class="scrap-add-bottom-btn" onclick="openScrapModal('${book.id}')">
          <span style="font-size:15px; font-weight:700; color:var(--lavender); line-height:1;">＋</span>
          <span>문장 추가</span>
        </button>
        <button type="button" class="scrap-copy-bottom-btn" onclick="copyBookForBlog('${book.id}')" title="블로그 포스팅용으로 도서 정보와 수집한 문장 전체를 복사합니다">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--lavender); flex-shrink:0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span>내용 복사하기</span>
        </button>
      </div>` : ''}
    </div>
  `;

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

function buildScrapsHtml(book) {
  cleanBookScraps(book);
  if (!book.scraps || !book.scraps.length) return '';
  const isGuide = isGuideBook(book);
  const sortedScraps = [...book.scraps].sort((a, b) => (a.page || 0) - (b.page || 0));

  return sortedScraps.map(s => {
    const tags = s.tags || s.keywords || [];
    const tagsHtml = tags.length
      ? `<div class="scrap-tags-row" style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
           ${tags.map(t => `<span class="scrap-tag-chip" onclick="showScraps('${esc(t)}')" title="#${esc(t)} 해시태그 문장 모아보기">#${esc(t)}</span>`).join('')}
         </div>`
      : '';
    return `
    <div class="scrap-item" id="sc-${s.id}">
      <div class="scrap-quote">${esc(s.text)}</div>
      ${s.memo ? `<div class="comm-scrap-memo-wrap"><div class="comm-scrap-memo">${esc(s.memo)}</div></div>` : ''}
      ${tagsHtml}
      <div class="scrap-foot" style="display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; width:100%; margin-top:4px;">
        ${s.page ? `<span class="scrap-page">p.${s.page}</span>` : ''}
        <div class="scrap-actions" style="margin-left:auto; display:flex; gap:6px;">
          <button class="btn btn-ghost btn-sm" onclick="copyScrapQuoteText('${esc(s.text.replace(/'/g, "\\'"))}', '${esc(book.title.replace(/'/g, "\\'"))}', '${esc((book.author || '').replace(/'/g, "\\'"))}')" style="padding:2px 6px; font-size:10px; border-radius:4px; height:22px; line-height:1;" title="문장 복사">복사</button>
          ${isGuide ? '' : `
          <button class="btn btn-ghost btn-sm" onclick="editScrap('${book.id}','${s.id}')" style="padding:2px 6px; font-size:10px; border-radius:4px; height:22px; line-height:1;">수정</button>
          <button class="btn btn-danger btn-sm" onclick="doDeleteScrap('${book.id}','${s.id}')" style="padding:2px 6px; font-size:10px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171; height:22px; line-height:1;">삭제</button>
          `}
        </div>
      </div>
    </div>
  `}).join('');
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

  currentScrapTags = (scrap.tags || scrap.keywords || []).slice();
  renderScrapModalTags();

  document.getElementById('scrap-modal-title').textContent = '스크랩 수정';
  document.getElementById('scrap-save-btn').textContent = '스크랩 저장';

  switchTab('manual');
  openModal('scrap-modal');
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

  renderGallery();
}

function handleGallerySearch() {
  const input = document.getElementById('gallery-search-input');
  const clearBtn = document.getElementById('gallery-search-clear');
  if (clearBtn) {
    clearBtn.style.display = input && input.value ? 'block' : 'none';
  }
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
  renderGallery();
}

function showStats(pushHistory = true) {
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

/* ==============================================
   BOOK MODAL
============================================== */
let modalCover = '';
let modalSpineCover = '';

function updateCommVisibilityBadge(isPublic) {
  const badge = document.getElementById('comm-visibility-badge');
  if (!badge) return;
  if (isPublic) {
    badge.textContent = '공개';
    badge.style.background = 'rgba(140, 98, 57, 0.12)';
    badge.style.color = '#8c6239';
  } else {
    badge.textContent = '비공개';
    badge.style.background = 'rgba(35, 29, 23, 0.08)';
    badge.style.color = 'var(--text-400, rgba(35, 29, 23, 0.4))';
  }
}

function openBookModal() {
  openAddModal();
}

function openAddModal() {
  editingBookId = null;
  currentRating = 0;
  modalCover = '';
  modalSpineCover = '';
  document.getElementById('book-modal-ttl').textContent = '책 추가';
  const titleEl = document.getElementById('bk-title');
  if (titleEl) titleEl.value = '';
  const subEl = document.getElementById('bk-subtitle');
  if (subEl) subEl.value = '';
  document.getElementById('bk-author').value = '';
  document.getElementById('bk-pages').value = '';
  document.getElementById('bk-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('bk-sentence').value = '';
  document.getElementById('bk-img-url').value = '';
  document.getElementById('bk-img-file').value = '';
  document.getElementById('bk-spine-url').value = '';
  document.getElementById('bk-spine-file').value = '';
  document.getElementById('bk-kw1').value = '';
  document.getElementById('bk-kw2').value = '';
  document.getElementById('bk-kw3').value = '';
  const pubEl = document.getElementById('bk-is-public');
  if (pubEl) {
    pubEl.checked = true;
    updateCommVisibilityBadge(true);
  }
  hideSearchResults();
  resetPrev();
  resetSpinePrev();
  const spineEl = document.getElementById('spine-prev');
  if (spineEl) { spineEl.style.width = '44px'; spineEl.style.minWidth = '44px'; }
  updateStarBtns(0);
  openModal('book-modal');

  const modal = document.getElementById('book-modal');
  if (modal) {
    modal.scrollTop = 0;
    const box = modal.querySelector('.modal-box');
    if (box) box.scrollTop = 0;
  }
  setTimeout(() => {
    const box = document.querySelector('#book-modal .modal-box');
    if (box) box.scrollTop = 0;
    if (titleEl) titleEl.focus();
  }, 50);
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
  const titleParts = splitBookTitle(b);
  const titleEl = document.getElementById('bk-title');
  if (titleEl) titleEl.value = titleParts.main;
  const editSubEl = document.getElementById('bk-subtitle');
  if (editSubEl) editSubEl.value = titleParts.sub;
  document.getElementById('bk-author').value = b.author || '';
  document.getElementById('bk-pages').value = b.pages || '';
  document.getElementById('bk-date').value = b.date || '';
  document.getElementById('bk-sentence').value = b.sentence || '';

  const kws = b.keywords || [];
  document.getElementById('bk-kw1').value = kws[0] || '';
  document.getElementById('bk-kw2').value = kws[1] || '';
  document.getElementById('bk-kw3').value = kws[2] || '';

  const pubEl = document.getElementById('bk-is-public');
  if (pubEl) {
    const isPub = b.is_public !== false;
    pubEl.checked = isPub;
    updateCommVisibilityBadge(isPub);
  }

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

  const modal = document.getElementById('book-modal');
  if (modal) {
    modal.scrollTop = 0;
    const box = modal.querySelector('.modal-box');
    if (box) box.scrollTop = 0;
  }
  setTimeout(() => {
    const box = document.querySelector('#book-modal .modal-box');
    if (box) box.scrollTop = 0;
    if (focusKeywords) {
      const kw = document.getElementById('bk-kw1');
      if (kw) { kw.focus(); kw.select(); }
    } else {
      if (titleEl) titleEl.focus();
    }
  }, 50);
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
    `<img src="${getSafeImageUrl(src)}" style="width:100%; height:100%; object-fit:cover; display:block;" onerror="handlePrevError(this)">`;
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
    `<img src="${getSafeImageUrl(src)}" style="width:100%; height:100%; object-fit:fill; display:block;" onerror="handleSpinePrevError(this)">`;
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
  const rawTitle = document.getElementById('bk-title').value.trim();
  if (!rawTitle) { toast('도서 제목을 입력해주세요'); return; }
  const subInputEl = document.getElementById('bk-subtitle');
  const rawSubtitle = subInputEl ? subInputEl.value.trim() : '';
  const title = rawSubtitle ? `${rawTitle} - ${rawSubtitle}` : rawTitle;

  let user = null;
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    user = session?.user;
    if (!user) {
      toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
      return;
    }
  }

  const pubInputEl = document.getElementById('bk-is-public');
  const is_public = pubInputEl ? pubInputEl.checked : true;

  const data = {
    title,
    author: document.getElementById('bk-author').value.trim(),
    pages: parseInt(document.getElementById('bk-pages').value) || 0,
    date: document.getElementById('bk-date').value,
    sentence: document.getElementById('bk-sentence').value.trim(),
    cover: modalCover,
    spineCover: modalSpineCover,
    rating: currentRating,
    is_public,
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
          const payload = sanitizeBookForSupabase(updatedBook);
          let { error } = await supabaseClient
            .from('books')
            .update(payload)
            .eq('id', editingBookId)
            .eq('user_id', user.id);

          if (error && handleSupabaseSchemaError(error)) {
            const safeBook = sanitizeBookForSupabase(updatedBook);
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
        const payload = sanitizeBookForSupabase(data);
        let { error } = await supabaseClient
          .from('books')
          .insert([payload]);

        if (error && handleSupabaseSchemaError(error)) {
          const safeData = sanitizeBookForSupabase(data);
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
    if (typeof renderCommunityBooks === 'function') renderCommunityBooks();
    if (typeof renderCommunityScraps === 'function') renderCommunityScraps();

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
    if (typeof renderCommunityBooks === 'function') renderCommunityBooks();
    if (typeof renderCommunityScraps === 'function') renderCommunityScraps();
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
            results.innerHTML = `<div class="search-empty">바코드로 도서를 찾을 수 없습니다. (ISBN: ${isbn})<br><span style="font-size:12px; opacity:0.8; margin-top:6px; display:inline-block;">도서 제목이나 저자명으로 직접 검색해 보세요.</span></div>`;
          }
        };
        scriptKw.onerror = function () {
          delete window[cbNameKw];
          scriptKw.remove();
          results.innerHTML = `<div class="search-empty">바코드로 도서를 찾을 수 없습니다. (ISBN: ${isbn})</div>`;
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
        const g = data[i + 1];
        const b = data[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;

        // Boost contrast (stretch darks and lights)
        let val = gray;
        if (gray < 128) {
          val = Math.max(0, gray * 0.65);
        } else {
          val = Math.min(255, gray * 1.35);
        }

        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }

      ctx.putImageData(imgData, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
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
            } catch (_) { }
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
            } catch (_) { }
          }

          // ── Tier 3: ZXing Legacy Fallback with Center Crop ──
          if (!detected && sharedZXingReaderInstance && (frameCounter % 2 === 0)) {
            try {
              const cropCanvas = _getCroppedCanvas(video);
              if (cropCanvas) {
                const res = await sharedZXingReaderInstance.decodeFromCanvas(cropCanvas);
                if (res && res.text) {
                  detected = { code: res.text };
                }
              }
            } catch (_) { }
          }

          if (detected && detected.code) {
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
        // Continue loop
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
        <div class="search-item-meta">${esc(publisher)}${pubDate ? ' · ' + pubDate : ''}${pages ? ' · ' + pages + 'p' : ''}</div>
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

function getScrapRandomOrder(scrapId) {
  if (scrapsShuffleOrder[scrapId] === undefined) {
    scrapsShuffleOrder[scrapId] = Math.random();
  }
  return scrapsShuffleOrder[scrapId];
}

function reshuffleScraps() {
  scrapsShuffleOrder = {};
  renderScrapsArchive();
}

const SCRAP_THEME_RULES = [
  { tag: '위로', words: ['위로', '지친', '힘든', '상처', '토닥', '괜찮아', '눈물', '아픔', '치유', '견디', '쓰러', '안식', '평온'] },
  { tag: '인생', words: ['인생', '삶', '살아', '생애', '존재', '세상', '운명', '세월', '어른', '여정'] },
  { tag: '사랑', words: ['사랑', '연인', '그리움', '설렘', '좋아하', '애정', '가슴', '다정', '연애', '품', '온기'] },
  { tag: '이별', words: ['이별', '헤어', '떠나', '상실', '빈자리', '그리워', '슬픔', '추억', '안녕', '마지막'] },
  { tag: '성장', words: ['성장', '배움', '노력', '도전', '변화', '발전', '스스로', '성숙', '나아가', '실패', '극복'] },
  { tag: '마음', words: ['마음', '심장', '감정', '진심', '내면', '마음속', '기분', '의식', '시선'] },
  { tag: '시간', words: ['시간', '순간', '영원', '과거', '미래', '현재', '오늘', '어제', '찰나', '기억', '시절'] },
  { tag: '행복', words: ['행복', '기쁨', '미소', '웃음', '따뜻', '환희', '소소한', '감사', '평화', '만족'] },
  { tag: '용기', words: ['용기', '두려움', '결심', '당당', '망설', '포기', '시작', '한걸음', '자신감', '의지'] },
  { tag: '자유', words: ['자유', '얽매', '해방', '날개', '구속', '선택', '독립', '홀로', '벗어나'] },
  { tag: '관계', words: ['관계', '사람', '친구', '타인', '인간', '인연', '이해', '배려', '공감', '대화'] },
  { tag: '고독', words: ['고독', '외로움', '혼자', '침묵', '고요', '쓸쓸', '혼자만'] },
  { tag: '불안', words: ['불안', '걱정', '고민', '방황', '흔들', '불확실', '혼란', '초조', '두려운'] },
  { tag: '희망', words: ['희망', '빛', '꿈', '내일', '바람', '기대', '피어나', '별', '새벽'] },
  { tag: '습관', words: ['습관', '루틴', '매일', '반복', '기록', '태도', '실천', '몰입', '집중'] },
  { tag: '독서', words: ['독서', '책', '문장', '글', '단어', '사유', '생각', '언어', '작가', '페이지'] },
  { tag: '지혜', words: ['지혜', '철학', '깨달음', '진리', '통찰', '본질', '깊이', '배움', '가치'] },
  { tag: '성공', words: ['성공', '목표', '성취', '열정', '동기', '결과', '실행', '승리', '도약'] },
  { tag: '죽음', words: ['죽음', '유한', '소멸', '끝', '생명', '유한함', '필멸'] },
  { tag: '명언', words: ['명언', '격언', '교훈', '잠언', '좌우명', '한줄'] }
];

function renderScrapModalTags() {
  const container = document.getElementById('scrap-tag-pills-list');
  const countLabel = document.getElementById('scrap-tags-count-label');
  if (countLabel) {
    countLabel.textContent = `${currentScrapTags.length}개 등록됨`;
  }
  if (!container) return;

  container.innerHTML = currentScrapTags.map(tag => `
    <span class="scrap-tag-pill">
      #${esc(tag)}
      <button type="button" class="scrap-tag-pill-del" onclick="removeScrapTag('${esc(tag)}')" aria-label="삭제">×</button>
    </span>
  `).join('');

  updateRecommendedHashtags();
}

function addScrapTag(tag) {
  if (!tag) return;
  const cleanTag = tag.trim().replace(/^#+/, '').replace(/\s+/g, '').replace(/[,\'\"`]/g, '');
  if (!cleanTag) return;
  if (currentScrapTags.length >= 10) {
    toast('해시태그는 최대 10개까지 추가할 수 있습니다');
    return;
  }
  if (!currentScrapTags.includes(cleanTag)) {
    currentScrapTags.push(cleanTag);
    renderScrapModalTags();
  }
  const input = document.getElementById('sc-tag-input');
  if (input) input.value = '';
}

function removeScrapTag(tag) {
  currentScrapTags = currentScrapTags.filter(t => t !== tag);
  renderScrapModalTags();
}

function handleScrapTagKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value;
    if (val) addScrapTag(val);
  } else if (e.key === 'Backspace' && !e.target.value && currentScrapTags.length > 0) {
    currentScrapTags.pop();
    renderScrapModalTags();
  }
}

function getRecommendedHashtags(text, book) {
  const recommendations = new Set();
  const currentText = (text || '').trim();

  // 1. Theme dictionary matching
  if (currentText) {
    SCRAP_THEME_RULES.forEach(rule => {
      if (rule.words.some(w => currentText.includes(w))) {
        recommendations.add(rule.tag);
      }
    });

    // 2. Extract salient words (2~5 characters)
    const words = currentText.replace(/[^\w가-힣\s]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2 && w.length <= 5);

    const wordFreq = {};
    words.forEach(w => {
      if (/^(그리고|하지만|그러나|또한|때문에|그래서|그것은|우리는|나는|너는|그는|그녀는|어떤|모든|매우|가장|너무|다시|그렇게|이것|저것)$/.test(w)) return;
      wordFreq[w] = (wordFreq[w] || 0) + 1;
    });

    Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([w]) => recommendations.add(w));
  }

  // 3. Current book keywords
  if (book && book.keywords && Array.isArray(book.keywords)) {
    book.keywords.forEach(k => {
      if (k && k.trim()) recommendations.add(k.trim());
    });
  }

  // 4. User's top scrap tags from library
  const userTagFreq = {};
  books.forEach(b => {
    (b.scraps || []).forEach(s => {
      const tags = s.tags || s.keywords || [];
      tags.forEach(t => {
        if (t) userTagFreq[t] = (userTagFreq[t] || 0) + 1;
      });
    });
  });

  Object.entries(userTagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([t]) => recommendations.add(t));

  // Fallbacks
  ['위로', '인생', '성장', '사랑', '명언', '사유'].forEach(defTag => {
    recommendations.add(defTag);
  });

  return Array.from(recommendations)
    .filter(tag => !currentScrapTags.includes(tag))
    .slice(0, 7);
}

let recDebounceTimer = null;
function updateRecommendedHashtags() {
  clearTimeout(recDebounceTimer);
  recDebounceTimer = setTimeout(() => {
    const textEl = currentScrapTab === 'manual'
      ? document.getElementById('sc-text')
      : document.getElementById('ocr-result');
    const text = textEl ? textEl.value : '';
    const book = books.find(b => b.id === currentScrapBookId);
    const recs = getRecommendedHashtags(text, book);

    const chipsContainer = document.getElementById('scrap-rec-chips-list');
    if (!chipsContainer) return;

    if (recs.length === 0) {
      chipsContainer.innerHTML = `<span style="font-size:11px; color:var(--text-400);">추천할 새로운 해시태그가 없습니다.</span>`;
      return;
    }

    chipsContainer.innerHTML = recs.map(tag => `
      <button type="button" class="scrap-rec-chip" onclick="addScrapTag('${esc(tag)}')" title="#${esc(tag)} 추가">
        <span class="rec-plus">+</span> #${esc(tag)}
      </button>
    `).join('');
  }, 100);
}

async function openScrapModal(id) {
  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 구글 로그인을 진행해주세요.');
    loginWithGoogle();
    return;
  }

  const book = books.find(b => b.id === id);
  if (!book) return;
  if ((book.scraps || []).length >= 100) {
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

  currentScrapTags = [];
  renderScrapModalTags();

  resetOcrWrap();
  switchTab('manual');
  openModal('scrap-modal');
}

function closeScrapModal() {
  closeModal('scrap-modal');
}

function switchTab(tab) {
  currentScrapTab = tab;
  ['manual', 'photo'].forEach(t => {
    document.getElementById('stab-' + t).classList.toggle('on', t === tab);
    document.getElementById('sbody-' + t).classList.toggle('on', t === tab);
  });
  updateRecommendedHashtags();
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

  const tags = currentScrapTags.slice();

  let updatedScraps;
  const nowIso = new Date().toISOString();
  if (editingScrapId) {
    updatedScraps = book.scraps.map(s =>
      s.id === editingScrapId
        ? { ...s, text, page, memo, tags, at: nowIso, updated_at: nowIso }
        : s
    );
  } else {
    if (book.scraps.length >= 100) {
      toast('스크랩은 최대 100개까지 가능합니다'); return;
    }
    updatedScraps = [...book.scraps, { id: uid(), text, page, memo, tags, at: nowIso, created_at: nowIso }];
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
    if (currentBookId === currentScrapBookId && document.getElementById('view-detail').classList.contains('show')) {
      showDetail(currentBookId);
    }
    const scrapsView = document.getElementById('view-scraps');
    if (scrapsView && scrapsView.classList.contains('show')) {
      renderScrapsArchive();
    }
    if (typeof renderCommunityScraps === 'function') {
      renderCommunityScraps();
    }
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
  const updatedScraps = (book.scraps || []).filter(s => s.id !== scrapId);

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
    if (currentBookId === bookId && document.getElementById('view-detail').classList.contains('show')) {
      showDetail(bookId);
    }
    const scrapsView = document.getElementById('view-scraps');
    if (scrapsView && scrapsView.classList.contains('show')) {
      renderScrapsArchive();
    }
  } catch (err) {
    console.error(err);
    toast('스크랩 삭제 실패: ' + err.message);
  }
}

/* ==============================================
   SCRAPS ARCHIVE & SEARCH VIEW
============================================== */
function showScraps(filterTag = null, searchQuery = '', pushHistory = true) {
  document.body.classList.remove('page-detail');
  closeAppMenu();
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  document.getElementById('view-community').classList.remove('show');

  const scrapsView = document.getElementById('view-scraps');
  if (scrapsView) scrapsView.classList.add('show');

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
    vl.textContent = '문장 보관함';
  }

  if (pushHistory && window.history && window.history.pushState) {
    if (!window.history.state || window.history.state.view !== 'scraps') {
      window.history.pushState({ view: 'scraps', tag: filterTag || '' }, '', '#scraps');
    }
  }

  currentScrapFilterTag = filterTag ? filterTag.replace(/^#/, '').trim() : null;
  currentScrapSearchQuery = searchQuery ? searchQuery.trim() : '';
  scrapsShuffleOrder = {}; // Always randomize order when entering scraps archive view

  const searchInput = document.getElementById('scraps-archive-search-input');
  if (searchInput) {
    searchInput.value = currentScrapSearchQuery;
  }
  const clearBtn = document.getElementById('scraps-archive-search-clear');
  if (clearBtn) {
    clearBtn.style.display = currentScrapSearchQuery ? 'flex' : 'none';
  }

  renderScrapsArchive();
}

function handleScrapArchiveSearch() {
  const input = document.getElementById('scraps-archive-search-input');
  currentScrapSearchQuery = (input ? input.value : '').trim();
  const clearBtn = document.getElementById('scraps-archive-search-clear');
  if (clearBtn) {
    clearBtn.style.display = currentScrapSearchQuery ? 'flex' : 'none';
  }
  renderScrapsArchive();
}

function clearScrapArchiveSearch() {
  const input = document.getElementById('scraps-archive-search-input');
  if (input) {
    input.value = '';
    input.focus();
  }
  currentScrapSearchQuery = '';
  const clearBtn = document.getElementById('scraps-archive-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderScrapsArchive();
}

function filterScrapsByTag(tag) {
  const cleanTag = tag ? tag.replace(/^#/, '').trim() : null;
  if (currentScrapFilterTag === cleanTag) {
    currentScrapFilterTag = null;
  } else {
    currentScrapFilterTag = cleanTag;
  }
  renderScrapsArchive();
}

function renderScrapsArchive() {
  const listEl = document.getElementById('scraps-archive-list');
  const emptyEl = document.getElementById('scraps-empty-state');
  const totalCountEl = document.getElementById('scraps-total-count');
  const tagsContainer = document.getElementById('scraps-hashtags-chips');
  const activeIndicator = document.getElementById('scraps-tag-active-indicator');
  if (!listEl) return;

  const allItems = [];
  const tagCounts = {};
  let totalScrapsCount = 0;

  const sourceBooks = currentUser ? books.filter(b => !isGuideBook(b)) : books;
  sourceBooks.forEach(book => {
    (book.scraps || []).forEach(scrap => {
      totalScrapsCount++;
      const tags = scrap.tags || scrap.keywords || [];
      tags.forEach(t => {
        const cleanT = (t || '').trim().replace(/^#/, '');
        if (cleanT) {
          tagCounts[cleanT] = (tagCounts[cleanT] || 0) + 1;
        }
      });
      allItems.push({ book, scrap });
    });
  });

  if (totalCountEl) {
    totalCountEl.textContent = totalScrapsCount;
  }

  // Render Hashtags filter pills
  if (tagsContainer) {
    const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
    const allPill = `
      <button type="button" class="scrap-filter-pill ${!currentScrapFilterTag ? 'active' : ''}" onclick="filterScrapsByTag(null)">
        전체 <span class="scrap-filter-count">${totalScrapsCount}</span>
      </button>
    `;
    const tagPills = sortedTags.map(([tag, count]) => `
      <button type="button" class="scrap-filter-pill ${currentScrapFilterTag === tag ? 'active' : ''}" onclick="filterScrapsByTag('${esc(tag)}')">
        #${esc(tag)} <span class="scrap-filter-count">${count}</span>
      </button>
    `).join('');

    tagsContainer.innerHTML = allPill + tagPills;
  }

  if (activeIndicator) {
    activeIndicator.textContent = currentScrapFilterTag
      ? `#${currentScrapFilterTag} 해시태그 필터링 중`
      : (currentScrapSearchQuery ? `"${currentScrapSearchQuery}" 검색 결과` : '전체 문장 보기');
  }

  // Filter items
  let filtered = allItems;

  if (currentScrapFilterTag) {
    const targetTag = currentScrapFilterTag.toLowerCase();
    filtered = filtered.filter(item => {
      const tags = item.scrap.tags || item.scrap.keywords || [];
      return tags.some(t => t.replace(/^#/, '').toLowerCase() === targetTag);
    });
  }

  if (currentScrapSearchQuery) {
    const q = currentScrapSearchQuery.toLowerCase();
    const cleanQ = q.replace(/^#/, '');
    filtered = filtered.filter(item => {
      const textMatch = item.scrap.text && item.scrap.text.toLowerCase().includes(q);
      const memoMatch = item.scrap.memo && item.scrap.memo.toLowerCase().includes(q);
      const tags = item.scrap.tags || item.scrap.keywords || [];
      const tagMatch = tags.some(t => {
        const lowerT = t.toLowerCase();
        return lowerT.includes(cleanQ) || ('#' + lowerT).includes(q);
      });
      return textMatch || memoMatch || tagMatch;
    });
  }

  // Sort entirely in random order
  filtered.sort((a, b) => getScrapRandomOrder(a.scrap.id) - getScrapRandomOrder(b.scrap.id));

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = 'block';
      const emptyTitle = document.getElementById('scraps-empty-title');
      const emptyDesc = document.getElementById('scraps-empty-desc');
      if (currentScrapSearchQuery || currentScrapFilterTag) {
        if (emptyTitle) emptyTitle.textContent = '검색 조건에 맞는 문장이 없습니다';
        if (emptyDesc) emptyDesc.innerHTML = '다른 검색어나 해시태그를 선택해보세요.<br><button class="btn btn-ghost btn-sm" onclick="clearScrapArchiveSearch(); filterScrapsByTag(null);" style="margin-top:10px;">전체 문장 보기</button>';
      } else {
        if (emptyTitle) emptyTitle.textContent = '수집한 문장이 없습니다';
        if (emptyDesc) emptyDesc.textContent = '도서 상세 화면에서 "+ 추가"를 눌러 인상 깊은 문장을 기록하고 해시태그를 달아보세요.';
      }
    }
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  const highlight = (str) => {
    if (!str) return '';
    if (!currentScrapSearchQuery) return esc(str);
    const escaped = esc(str);
    const cleanQ = esc(currentScrapSearchQuery.replace(/^#/, ''));
    if (!cleanQ) return escaped;
    const regex = new RegExp(`(${cleanQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
  };

  listEl.innerHTML = filtered.map(item => {
    const { book, scrap } = item;
    const tags = scrap.tags || scrap.keywords || [];
    const coverHtml = book.cover
      ? `<img src="${esc(getSafeImageUrl(book.cover))}" class="scrap-card-cover" alt="${esc(book.title)}" onclick="showDetail('${book.id}')" onerror="handleScrapCoverError(this)">`
      : `<div class="scrap-card-cover-placeholder" onclick="showDetail('${book.id}')">8ook</div>`;

    const tagsHtml = tags.map(t => {
      const cleanT = t.replace(/^#/, '');
      const isSelected = currentScrapFilterTag && currentScrapFilterTag.toLowerCase() === cleanT.toLowerCase();
      return `<span class="scrap-tag-chip" style="${isSelected ? 'background:var(--violet); color:#fff; border-color:var(--violet);' : ''}" onclick="filterScrapsByTag('${esc(cleanT)}')" title="#${esc(cleanT)} 필터">#${highlight(cleanT)}</span>`;
    }).join('');

    const memoHtml = scrap.memo
      ? `<div class="comm-scrap-memo-wrap"><div class="comm-scrap-memo">${highlight(scrap.memo)}</div></div>`
      : '';

    const bookTitleParts = splitBookTitle(book);
    const bookMainTitle = bookTitleParts.main || book.title;

    return `
      <div class="scrap-card-full" id="archive-sc-${scrap.id}">
        <div class="scrap-card-header">
          ${coverHtml}
          <div class="scrap-card-meta">
            <div class="scrap-card-title" onclick="showDetail('${book.id}')" title="도서 상세 보기">${esc(bookMainTitle)}</div>
            <div class="scrap-card-sub">
              <span>${esc(book.author || '저자 미상')}</span>
              ${scrap.page ? `<span>• p.${scrap.page}</span>` : ''}
              ${scrap.at ? `<span>• ${fmtDate(scrap.at.slice(0, 10))}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="scrap-card-body">
          ${highlight(scrap.text)}
        </div>

        ${memoHtml}

        <div class="scrap-card-footer">
          <div class="scrap-card-tags">
            ${tagsHtml}
          </div>
          <div class="scrap-card-actions">
            <button class="btn btn-ghost btn-sm" onclick="copyScrapQuoteText('${esc(scrap.text.replace(/'/g, "\\'"))}', '${esc(bookMainTitle.replace(/'/g, "\\'"))}', '${esc((book.author || '').replace(/'/g, "\\'"))}')" title="문장 복사" style="padding:2px 8px; font-size:11px; height:24px; border-radius:4px;">
              복사
            </button>
            <button class="btn btn-ghost btn-sm" onclick="showDetail('${book.id}')" style="padding:2px 8px; font-size:11px; height:24px; border-radius:4px;">
              책 보기 →
            </button>
            <button class="btn btn-ghost btn-sm" onclick="editScrap('${book.id}','${scrap.id}')" style="padding:2px 6px; font-size:10px; height:24px; border-radius:4px;">
              수정
            </button>
            <button class="btn btn-danger btn-sm" onclick="doDeleteScrap('${book.id}','${scrap.id}')" style="padding:2px 6px; font-size:10px; height:24px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171;">
              삭제
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function copyScrapQuoteText(text, bookTitle, author) {
  let formatted = `“${text}”`;
  if (bookTitle) {
    formatted += `\n— 《${bookTitle}》`;
    if (author) formatted += `, ${author}`;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(formatted).then(() => {
      toast('문장이 클립보드에 복사되었습니다.');
    }).catch(() => {
      fallbackCopyText(formatted);
    });
  } else {
    fallbackCopyText(formatted);
  }
}

function fallbackCopyText(text, successMsg = '클립보드에 복사되었습니다.') {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    toast(successMsg);
  } catch (err) {
    toast('복사에 실패했습니다.');
  }
  document.body.removeChild(ta);
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

  // 1. Plain Text Format (No icons, no table)
  let plain = `[도서 정보]\n`;
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

  // 2. Rich HTML Format (No icons, no table structure)
  let html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; line-height: 1.8; color: #222; max-width: 680px; padding: 8px 0; font-size: 15px;">`;
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
      await ocrWorker.terminate().catch(() => { });
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
  } catch (err) {
    console.error(err);
    if (scanLine) scanLine.classList.remove('scanning');
    statusEl.innerHTML = '분석 실패. 다시 시도해주세요.';
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  }
}

async function onOcrLangChange() {
  if (ocrImg && ocrImg.src) {
    if (ocrWorker) {
      await ocrWorker.terminate().catch(() => { });
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
  let filteredBooks = currentUser ? books.filter(b => !isGuideBook(b)) : books;

  if (statsPeriod === 'year') {
    filteredBooks = filteredBooks.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return d.getFullYear() === now.getFullYear();
    });
  } else if (statsPeriod === 'month') {
    filteredBooks = filteredBooks.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
  }

  const total = filteredBooks.length;
  const pages = filteredBooks.reduce((s, b) => s + (b.pages || 0), 0);
  const scraps = filteredBooks.reduce((s, b) => s + ((b.scraps || []).length), 0);

  document.getElementById('stat-books').textContent = total;
  document.getElementById('stat-pages').textContent =
    pages >= 10000 ? (pages / 1000).toFixed(1) + 'k' : pages.toLocaleString();
  document.getElementById('stat-scraps').textContent =
    scraps >= 10000 ? (scraps / 1000).toFixed(1) + 'k' : scraps.toLocaleString();

  renderChart();
  renderCal();
}

function showRandomQuote() {
  const card = document.getElementById('random-quote-card');
  const textEl = document.getElementById('random-quote-text');
  const bookEl = document.getElementById('random-quote-book');

  // Collect all scraps
  const allScraps = [];
  const sourceBooks = currentUser ? books.filter(b => !isGuideBook(b)) : books;
  sourceBooks.forEach(book => {
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
  document.getElementById('cal-lbl').textContent = `${y}. ${m + 1}`;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  ['일', '월', '화', '수', '목', '금', '토'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-dn';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

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

    if (today.getFullYear() === y && today.getMonth() === m && today.getDate() === d) {
      el.classList.add('today');
    }
    grid.appendChild(el);
  }
}

document.getElementById('cal-prev').addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
  renderCal();
});
document.getElementById('cal-next').addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
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

  // Horizontal swipe: 좌우 스와이프로 이전/다음 책 이동만 유지
  if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
    if (diffX < 0) {
      navigateToAdjacentBook('next');
    } else {
      navigateToAdjacentBook('prev');
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

  // Floating Year Indicator on scroll
  // 월별/연도별 책장에서는 우측 스크롤포인트 버블이 정확한 월을 표시하므로 스크롤포인트 동기화 처리
  if (galleryViewMode === 'spine-month' || galleryViewMode === 'spine-year') {
    if (badge) badge.classList.remove('show');
    if (!isDraggingShelfTracker) {
      const maxScroll = galleryScroll.scrollHeight - galleryScroll.clientHeight;
      if (maxScroll > 10) {
        const pct = galleryScroll.scrollTop / maxScroll;
        updateShelfScrollTrackerPosition(pct, true);
      }
    }
    return;
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

/* ==============================================
   MONTH SHELF FAST SCROLL TRACKER (우측 터치 스크롤포인트)
============================================== */
let isDraggingShelfTracker = false;
let shelfBubbleTimer = null;

function getActiveMonthSectionLabel(scrollRatio) {
  const sections = document.querySelectorAll('#gallery-grid .shelf-year-section');
  if (!sections.length) return '';

  const containerRect = galleryScroll.getBoundingClientRect();
  const targetTop = containerRect.top + 120;
  let activeLabel = '';

  for (let sec of sections) {
    const rect = sec.getBoundingClientRect();
    if (rect.top <= targetTop && rect.bottom >= containerRect.top) {
      activeLabel = sec.getAttribute('data-label') || '';
    }
  }

  if (!activeLabel && sections.length > 0) {
    if (galleryScroll.scrollTop <= 15) {
      activeLabel = sections[0].getAttribute('data-label') || '';
    } else {
      const idx = Math.min(sections.length - 1, Math.floor(scrollRatio * sections.length));
      activeLabel = sections[idx].getAttribute('data-label') || '';
    }
  }

  return activeLabel;
}

function updateShelfScrollTrackerPosition(pct, showBubble = false) {
  const tracker = document.getElementById('shelf-scroll-tracker');
  const point = document.getElementById('shelf-scroll-point');
  const bubble = document.getElementById('shelf-scroll-bubble');
  if (!tracker || !point || !galleryScroll) return;

  const pointH = 48;
  const trackH = tracker.clientHeight;
  const maxTravel = Math.max(0, trackH - pointH);
  const clampedPct = Math.max(0, Math.min(1, pct));
  const y = clampedPct * maxTravel;

  point.style.transform = `translate3d(0, ${y}px, 0)`;

  if (bubble) {
    const label = getActiveMonthSectionLabel(clampedPct);
    if (label) {
      bubble.textContent = label;
      if (showBubble) {
        bubble.classList.add('show');
        clearTimeout(shelfBubbleTimer);
        if (!isDraggingShelfTracker) {
          shelfBubbleTimer = setTimeout(() => {
            bubble.classList.remove('show');
          }, 1200);
        }
      }
    }
  }
}

function updateShelfScrollTrackerVisibility() {
  const tracker = document.getElementById('shelf-scroll-tracker');
  if (!tracker || !galleryScroll) return;

  const isMonthShelf = galleryViewMode === 'spine-month' || galleryViewMode === 'spine-year';
  const hasScroll = (galleryScroll.scrollHeight - galleryScroll.clientHeight) > 30;

  if (isMonthShelf && hasScroll) {
    tracker.classList.add('active');
    const maxScroll = galleryScroll.scrollHeight - galleryScroll.clientHeight;
    const pct = maxScroll > 0 ? galleryScroll.scrollTop / maxScroll : 0;
    updateShelfScrollTrackerPosition(pct, false);
  } else {
    tracker.classList.remove('active');
  }
}

function initShelfScrollTracker() {
  const tracker = document.getElementById('shelf-scroll-tracker');
  const point = document.getElementById('shelf-scroll-point');
  const bubble = document.getElementById('shelf-scroll-bubble');
  if (!tracker || !point || !galleryScroll) return;

  const pointH = 48;

  function scrollToPoint(clientY) {
    const trackRect = tracker.getBoundingClientRect();
    const trackH = trackRect.height;
    const maxTravel = Math.max(1, trackH - pointH);
    const relativeY = clientY - trackRect.top - (pointH / 2);
    const clampedY = Math.max(0, Math.min(maxTravel, relativeY));
    const pct = clampedY / maxTravel;

    const maxScroll = galleryScroll.scrollHeight - galleryScroll.clientHeight;
    galleryScroll.scrollTop = pct * maxScroll;
    updateShelfScrollTrackerPosition(pct, true);
  }

  function onPointerMove(e) {
    if (!isDraggingShelfTracker) return;
    e.preventDefault();
    scrollToPoint(e.clientY);
  }

  function onPointerUp(e) {
    if (!isDraggingShelfTracker) return;
    isDraggingShelfTracker = false;
    point.classList.remove('dragging');
    try {
      if (e.pointerId !== undefined && point.hasPointerCapture && point.hasPointerCapture(e.pointerId)) {
        point.releasePointerCapture(e.pointerId);
      }
    } catch (err) { }
    clearTimeout(shelfBubbleTimer);
    shelfBubbleTimer = setTimeout(() => {
      if (bubble) bubble.classList.remove('show');
    }, 1000);
  }

  // Pointer Down on tracker or knob (touch or left mouse)
  tracker.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingShelfTracker = true;
    point.classList.add('dragging');
    if (bubble) bubble.classList.add('show');
    try {
      if (e.pointerId !== undefined && point.setPointerCapture) {
        point.setPointerCapture(e.pointerId);
      }
    } catch (err) { }

    scrollToPoint(e.clientY);
  });

  point.addEventListener('pointermove', onPointerMove);
  point.addEventListener('pointerup', onPointerUp);
  point.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

// 스크롤포인트 트래커 초기화 및 윈도우 리사이즈 연동
initShelfScrollTracker();
window.addEventListener('resize', () => {
  updateShelfScrollTrackerVisibility();
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
  return Math.sqrt(dx * dx + dy * dy);
}

function adjustGrid(scale) {
  gridMin = Math.max(90, Math.min(320, gridMin * scale));
  const grid = document.getElementById('gallery-grid');
  grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${gridMin}px, 1fr))`;

  const hud = document.getElementById('zoom-hud');
  document.getElementById('zoom-val').textContent = Math.round((gridMin / 170) * 100);
  hud.classList.add('show');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => hud.classList.remove('show'), 1600);
}

/* ==============================================
   MODAL HELPERS
============================================== */
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('open');
    modal.scrollTop = 0;
    const box = modal.querySelector('.modal-box');
    if (box) box.scrollTop = 0;
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  if (id === 'scrap-modal') {
    if (ocrWorker) { ocrWorker.terminate().catch(() => { }); ocrWorker = null; }
    activeOcrLang = null;
    ocrImg = null; ocrSelDiv = null;
  }

  if (id === 'barcode-scanner-modal') {
    closeBarcodeScannerModal();
  }

  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('open');
    modal.scrollTop = 0;
    const box = modal.querySelector('.modal-box');
    if (box) box.scrollTop = 0;
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
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
    // 2. Hash Access Token 확인 (Implicit Flow)
    else if (hashStr.includes('access_token=') || hashStr.includes('refresh_token=')) {
      console.log('[Auth] Detected OAuth tokens in URL hash, establishing session...');
      try {
        let { data: { session } } = await supabaseClient.auth.getSession();
        if (!session || !session.user) {
          await new Promise(r => setTimeout(r, 150));
          const res = await supabaseClient.auth.getSession();
          session = res.data?.session;
        }
        if (session && session.user) {
          currentUser = session.user;
          updateAuthUI(session);
          console.log('[Auth] Implicit session established successfully:', currentUser.email);
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
        const errorDescription = urlParams.get('error_description') || hashParams.get('error_description') || '인증이 완료되지 않았습니다.';
        let userMsg = `로그인 오류 (${authError}): ${errorDescription}`;
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

  // Initialize / update the comprehensive "User Manual" book
  ensureUserGuideBook();

  renderGallery();
  updateSidebar();

  // Initialize browser history state for seamless Back/Forward button navigation
  if (typeof window !== 'undefined' && window.history && window.history.replaceState && !window.history.state) {
    window.history.replaceState({ view: 'gallery' }, '', window.location.hash || '#');
  }

  // Handle URL hash navigation on direct link load (e.g. #book=id)
  if (typeof window !== 'undefined' && window.location.hash) {
    if (window.location.hash.startsWith('#book=')) {
      const initBookId = window.location.hash.slice(6);
      if (initBookId) showDetail(initBookId, null, false);
    } else if (window.location.hash === '#community') {
      showCommunity(false);
    } else if (window.location.hash === '#stats') {
      showStats(false);
    } else if (window.location.hash.startsWith('#scraps')) {
      showScraps(null, '', false);
    }
  }
})();

// Browser popstate listener for back/forward navigation
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    const state = e.state;
    if (state && state.view === 'detail' && state.bookId) {
      showDetail(state.bookId, null, false);
    } else if (state && state.view === 'community') {
      showCommunity(false);
    } else if (state && state.view === 'stats') {
      showStats(false);
    } else if (state && state.view === 'scraps') {
      showScraps(state.tag || null, '', false);
    } else {
      showGallery(false);
    }
  });
}

/* ==============================================
   OFFICIAL 8OOK USER GUIDE (펼쳐진 가이드북 & 상세 설명)
============================================== */
function getUserGuideBook() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 700" width="480" height="700">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#191c24"/>
      <stop offset="50%" stop-color="#12141a"/>
      <stop offset="100%" stop-color="#0a0c10"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f5eacc"/>
      <stop offset="50%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#9a7407"/>
    </linearGradient>
    <linearGradient id="pageL" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e3dac8"/>
      <stop offset="12%" stop-color="#fcf9f2"/>
      <stop offset="85%" stop-color="#f6efe1"/>
      <stop offset="100%" stop-color="#d9ccb5"/>
    </linearGradient>
    <linearGradient id="pageR" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#d3c5ac"/>
      <stop offset="15%" stop-color="#f6efe1"/>
      <stop offset="88%" stop-color="#fcf9f2"/>
      <stop offset="100%" stop-color="#e3dac8"/>
    </linearGradient>
    <filter id="dropShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.55"/>
    </filter>
  </defs>

  <!-- Outer Hardcover Mat -->
  <rect width="480" height="700" fill="url(#bgGrad)"/>
  <rect x="16" y="16" width="448" height="668" rx="10" fill="none" stroke="url(#goldGrad)" stroke-width="1.5" stroke-opacity="0.4"/>
  <rect x="22" y="22" width="436" height="656" rx="8" fill="none" stroke="url(#goldGrad)" stroke-dasharray="4,4" stroke-width="1" stroke-opacity="0.25"/>

  <!-- Header Badge -->
  <g transform="translate(240, 56)">
    <rect x="-85" y="-16" width="170" height="32" rx="16" fill="#1e232d" stroke="url(#goldGrad)" stroke-width="1.2"/>
    <text x="0" y="5" fill="url(#goldGrad)" font-size="12" font-weight="700" letter-spacing="3" text-anchor="middle" font-family="'Cinzel', serif">8OOK GUIDE</text>
  </g>

  <!-- Main Title -->
  <text x="240" y="122" fill="#ffffff" font-size="28" font-weight="700" text-anchor="middle" font-family="'Noto Serif KR', serif">8ook. 이용 가이드</text>
  <text x="240" y="148" fill="#c4b79b" font-size="13" text-anchor="middle" font-family="'Noto Sans KR', sans-serif">나만의 서재를 100% 활용하는 완벽 가이드북</text>

  <!-- OPEN BOOK SPREAD (펼쳐진 양면 책 비주얼) -->
  <g transform="translate(240, 385)" filter="url(#dropShadow)">
    <!-- Outer Leather Base of the Open Book -->
    <path d="M -206,-180 C -120,-190 -20,-185 0,-175 C 20,-185 120,-190 206,-180 C 214,-179 218,-172 216,-164 L 206,174 C 204,182 196,188 188,186 C 110,175 20,180 0,192 C -20,180 -110,175 -188,186 C -196,188 -204,182 -206,174 L -216,-164 C -218,-172 -214,-179 -206,-180 Z" fill="#4a2411" stroke="#2a1307" stroke-width="3"/>

    <!-- Left Open Page -->
    <path d="M -196,-168 C -116,-176 -20,-173 -3,-164 L -3,172 C -20,163 -116,160 -192,170 C -198,171 -202,166 -201,160 L -196,-168 Z" fill="url(#pageL)"/>
    <!-- Right Open Page -->
    <path d="M 3,-164 C 20,-173 116,-176 196,-168 L 201,160 C 202,166 198,171 192,170 C 116,160 20,163 3,172 L 3,-164 Z" fill="url(#pageR)"/>

    <!-- Spine Gutter Shadow -->
    <line x1="0" y1="-168" x2="0" y2="176" stroke="rgba(60,40,20,0.45)" stroke-width="5"/>
    <line x1="0" y1="-168" x2="0" y2="176" stroke="rgba(20,10,5,0.7)" stroke-width="1.5"/>

    <!-- Golden Silk Bookmark Ribbon (가름끈) -->
    <path d="M 0,-170 Q 15,20 10,215 L 22,230 L 32,210 Q 18,20 0,-170 Z" fill="#b82734" opacity="0.9"/>

    <!-- LEFT PAGE CONTENT -->
    <g transform="translate(-100, -115)">
      <text x="0" y="0" fill="#2b2216" font-size="14" font-weight="700" text-anchor="middle" font-family="'Noto Serif KR', serif">내 서재 &amp; 등록</text>
      <line x1="-65" y1="10" x2="65" y2="10" stroke="#c2b090" stroke-width="1"/>

      <text x="-75" y="34" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">1. 3D 책등 &amp; 가상양장본</text>
      <text x="-70" y="48" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 앞표지 색상 자동 추출</text>
      <text x="-70" y="60" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 마우스 오버 시 표지 펼침</text>

      <text x="-75" y="84" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">2. 초고속 도서 등록</text>
      <text x="-70" y="98" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 알라딘 검색 자동 완성</text>
      <text x="-70" y="110" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 초고속 WASM 바코드 스캔</text>

      <text x="-75" y="134" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">3. 스마트 OCR 수집</text>
      <text x="-70" y="148" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 책 페이지 촬영 후 글자 추출</text>
      <text x="-70" y="160" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 터치로 원하는 문장만 쏙</text>

      <text x="-75" y="184" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">4. 인생작 왁스 인장</text>
      <text x="-70" y="198" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 5점 만점 수제 붉은 인장</text>
      <text x="-70" y="210" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 부제 및 긴 제목 자동 분리</text>
    </g>

    <!-- RIGHT PAGE CONTENT -->
    <g transform="translate(100, -115)">
      <text x="0" y="0" fill="#2b2216" font-size="14" font-weight="700" text-anchor="middle" font-family="'Noto Serif KR', serif">분석 &amp; 클라우드</text>
      <line x1="-65" y1="10" x2="65" y2="10" stroke="#c2b090" stroke-width="1"/>

      <text x="-75" y="34" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">5. 문장 보관함 &amp; 태그</text>
      <text x="-70" y="48" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 해시태그 기반 글귀 모아보기</text>
      <text x="-70" y="60" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 원클릭 인용구 복사 기능</text>

      <text x="-75" y="84" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">6. 독서 통계 &amp; 완독 달력</text>
      <text x="-70" y="98" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 월별/연도별 시각화 차트</text>
      <text x="-70" y="110" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 완독 날짜를 기록하는 달력</text>

      <text x="-75" y="134" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">7. 고해상도 책장 저장</text>
      <text x="-70" y="148" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 내 서재 2배수 그래픽 PNG</text>
      <text x="-70" y="160" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• SNS 및 인스타그램 공유</text>

      <text x="-75" y="184" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">8. 구글 동기화 &amp; CSV</text>
      <text x="-70" y="198" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 구글 원클릭 실시간 백업</text>
      <text x="-70" y="210" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 엑셀/스프레드시트 내보내기</text>
    </g>
  </g>

  <!-- Bottom CTA Footer -->
  <g transform="translate(240, 638)">
    <rect x="-150" y="-16" width="300" height="32" rx="16" fill="url(#goldGrad)"/>
    <text x="0" y="5" fill="#1a150c" font-size="13" font-weight="700" text-anchor="middle" font-family="'Noto Sans KR', sans-serif">터치하여 상세 가이드 읽기 ➔</text>
  </g>
</svg>`;

  const coverDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);

  return {
    id: '8ook_user_guide',
    title: '8ook. 이용 가이드 : 나만의 서재를 100% 활용하는 완벽 가이드북',
    author: '8ook 제작팀',
    pages: 18,
    date: new Date().toISOString().slice(0, 10),
    cover: coverDataUrl,
    rating: 5,
    sentence: '3D 양장본 서가, 스마트 OCR 문장 수집, 독서 캘린더와 클라우드 동기화까지 — 8ook를 100% 누리는 완벽 가이드',
    scraps: [
      {
        id: 'guide_ch1',
        text: '상단 뷰 모드(월별·연도별·별점별·표지 갤러리)를 통해 실제 서재에 책을 꽂아둔 것처럼 입체 책등을 감상할 수 있습니다. 알라딘 책등 이미지가 없는 도서도 8ook가 앞표지의 대표 색상을 자동 분석하여 고급 가죽 질감, 원통형 입체 볼륨, 헤드밴드(꽃천), 돌출 배(Raised Ribs) 및 금박 활자가 새겨진 프리미엄 가상 양장본으로 자동 변환해 줍니다. 책등에 마우스를 올리거나 모바일에서 탭하면 촤르륵 앞표지가 펼쳐집니다.',
        page: 1,
        memo: '3D 책등 서가 & 가상 양장본',
        tags: ['책장', '책등뷰', '가상양장본']
      },
      {
        id: 'guide_ch2',
        text: '하단 "+" 버튼을 눌러 새 책을 등록해보세요. 도서명이나 저자명으로 검색하면 알라딘 데이터베이스와 연동되어 표지 이미지, 출판사, 출판일, 총 페이지 수 및 책등 이미지까지 한 번에 자동 입력됩니다. 실물 도서가 있다면 "바코드 스캔" 버튼을 눌러 책 뒷면 ISBN 바코드를 비춰보세요. 고성능 WASM 바코드 엔진이 찰나의 순간에 바코드를 읽어 책 정보를 즉시 완성해 줍니다.',
        page: 2,
        memo: '초간편 도서 등록 & WASM 바코드',
        tags: ['도서등록', '바코드스캔', '알라딘검색']
      },
      {
        id: 'guide_ch3',
        text: '책을 읽다 마음에 드는 구절을 발견했다면 힘들게 타이핑하지 마세요. 도서 상세 화면에서 "문장 추가"를 누른 뒤 "사진 OCR" 탭을 선택하고 책 페이지를 촬영하면, 인공지능 텍스트 인식 엔진이 한글과 영문을 선명하게 디지털 텍스트로 추출합니다. 추출된 문장 중 간직하고 싶은 부분을 가볍게 터치하여 나만의 생각 메모, 읽은 쪽수(p.), #해시태그와 함께 보관할 수 있습니다.',
        page: 3,
        memo: '스마트 카메라 OCR 문장 수집',
        tags: ['문장수집', 'OCR인식', '인용구']
      },
      {
        id: 'guide_ch4',
        text: '도서를 클릭하면 깔끔한 서평 페이지로 이동합니다. 긴 책 제목도 주 제목과 부제로 자동 구분되어 눈에 쏙 들어오며, 이 책을 한마디로 정의하는 "대표 문장"과 별점(1~5점)을 기록할 수 있습니다. 별점 5점을 부여한 특별한 책에는 고전 명작을 인증하는 붉은색 "인생작(Wax Seal) 왁스 인장"이 영롱하게 새겨집니다. 수집한 문장은 목록 아래의 큰 버튼을 통해 언제든 손쉽게 이어서 추가할 수 있습니다.',
        page: 4,
        memo: '도서 상세 & 대표 문장 & 왁스 인장',
        tags: ['서평', '부제구분', '인생작']
      },
      {
        id: 'guide_ch5',
        text: '메뉴의 "문장 보관함"에서는 지금까지 여러 책에서 수집한 모든 글귀를 한자리에서 타임라인으로 탐색할 수 있습니다. 키워드 검색과 #해시태그 필터링으로 필요할 때 원하는 영감의 문장을 번개처럼 찾아보세요. 각 문장의 "복사" 버튼을 누르면 책 제목과 저자명이 함께 깔끔하게 정돈되어 인스타그램, 블로그, 독서 노트에 바로 붙여넣을 수 있습니다.',
        page: 5,
        memo: '수집 문장 보관함 & 클립보드 복사',
        tags: ['문장보관함', '해시태그', '문장복사']
      },
      {
        id: 'guide_ch6',
        text: '메뉴의 "독서 통계"에서는 지금까지 읽은 총 권수, 총 누적 페이지, 총 수집 문장 수를 실시간으로 집계해 줍니다. 연도별·월별 인터랙티브 막대 그래프를 통해 나의 독서 페이스를 점검할 수 있으며, 완독 달력에서는 내가 책을 마친 날짜들이 잔디처럼 초록빛으로 채워집니다. 매일 상단에 배달되는 "오늘의 랜덤 문장"을 통해 과거에 밑줄 그었던 소중한 감동을 다시 만나보세요.',
        page: 6,
        memo: '독서 통계 대시보드 & 완독 달력',
        tags: ['독서통계', '완독달력', '랜덤문장']
      },
      {
        id: 'guide_ch7',
        text: '내 손으로 직접 가꾼 서재를 아름다운 이미지로 남겨보세요. 서재 화면 상단의 "책장 저장" 버튼을 누르면 월별, 연도별, 혹은 5점 인생작 서가를 2배 고해상도 그래픽 이미지(PNG)로 자동 렌더링하여 다운로드할 수 있습니다. 스마트폰 갤러리에 저장하거나 인스타그램 스토리에 독서 결산으로 공유하기에 안성맞춤입니다.',
        page: 7,
        memo: '내 책장 고화질 이미지(PNG) 저장',
        tags: ['책장저장', '이미지내보내기', '서재공유']
      },
      {
        id: 'guide_ch8',
        text: '우측 상단의 구글(G) 버튼으로 로그인하면 Supabase 클라우드 데이터베이스와 실시간 연동되어 스마트폰, 태블릿, PC 어디서 접속하든 동일한 서재를 열람할 수 있습니다. 비로그인 상태에서도 브라우저 로컬 저장소에 안전하게 유지되며, 로그인 시 기존 기록이 클라우드로 자동 이전됩니다. "스프레드시트 내보내기" 메뉴를 이용하면 모든 도서 정보와 수집 문장을 구글 스프레드시트 및 엑셀 호환 CSV 파일로 영구 소장할 수 있습니다.',
        page: 8,
        memo: '클라우드 실시간 동기화 & 데이터 백업',
        tags: ['구글로그인', '동기화', '구글시트']
      }
    ],
    keywords: ['이용가이드', '사용법', '시작하기', '안내서', '꿀팁'],
    created_at: new Date().toISOString()
  };
}

function ensureUserGuideBook() {
  if (currentUser) {
    // 로그인 시에는 내 서재(책장)에서 완전히 제외하고 데이터베이스에서도 정리
    const guideBooks = books.filter(b => isGuideBook(b));
    if (guideBooks.length > 0) {
      const guideIds = guideBooks.map(b => b.id);
      books = books.filter(b => !isGuideBook(b));
      saveData();
      if (supabaseClient && currentUser.id) {
        supabaseClient.from('books').delete().in('id', guideIds).eq('user_id', currentUser.id).then(() => {
          console.log('Cleaned up guide books in ensureUserGuideBook:', guideIds);
        }).catch(() => {});
      }
    }
    return;
  }

  // 비로그인 게스트 환경: 중복 가이드북이 생기지 않도록 정리하고, 책장이 완전히 비어있을 때만 첫 안내용으로 책장에 노출
  const nonGuideBooks = books.filter(b => !isGuideBook(b));
  const guideBooks = books.filter(b => isGuideBook(b));
  const guideBook = getUserGuideBook();

  if (books.length === 0) {
    books = [guideBook];
    saveData();
  } else if (guideBooks.length > 0) {
    // 가이드북이 1권 이상 존재할 경우 최신 가이드북 단 1권만 유지하여 중복 방지
    books = [...nonGuideBooks, guideBook];
    saveData();
  }
}

function openUserGuide() {
  // 책장에 추가하지 않고 메뉴에서 바로 상세 가이드북을 펼쳐서 감상
  showDetail('8ook_user_guide');
}

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
      redirectTo: redirectUrl
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
  const googleLoginBtn = document.getElementById('header-google-login-btn');

  if (session && session.user) {
    currentUser = session.user;
    if (loggedInDiv) loggedInDiv.style.display = 'block';
    if (loggedOutDiv) loggedOutDiv.style.display = 'none';
    const metadata = session.user.user_metadata;
    const fullName = (metadata && metadata.full_name) || session.user.email || '사용자';
    if (usernameSpan) usernameSpan.textContent = fullName;
    if (shortUsernameSpan) shortUsernameSpan.textContent = fullName.split(' ')[0] || fullName;
    if (headerChip) headerChip.style.display = 'inline-flex';
    if (googleLoginBtn) googleLoginBtn.style.display = 'none';
  } else {
    currentUser = null;
    if (loggedInDiv) loggedInDiv.style.display = 'none';
    if (loggedOutDiv) loggedOutDiv.style.display = 'block';
    if (usernameSpan) usernameSpan.textContent = '';
    if (headerChip) headerChip.style.display = 'none';
    if (googleLoginBtn) googleLoginBtn.style.display = 'inline-flex';
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

/* ==============================================
   COMMUNITY LOGIC (Anonymous Books & Scraps)
   ============================================== */
let currentCommunityTab = 'books';

const SEED_COMMUNITY_BOOKS = [];

const SEED_COMMUNITY_SCRAPS = [
  {
    id: 'cs_1',
    text: '새는 알을 깨고 나온다. 알은 세계이다. 태어나려는 자는 하나의 세계를 파괴하지 않으면 안 된다.',
    bookTitle: '데미안',
    author: '헤르만 헤세',
    cover: 'https://image.aladin.co.kr/product/26/0/cover200/s452139198_1.jpg',
    page: 124,
    memo: '변화와 성장의 고통을 마주할 때마다 나를 지탱해 주는 문장.',
    tags: ['성장', '자아', '고전'],
    likes: 0,
    time: '15분 전'
  },
  {
    id: 'cs_2',
    text: '우리는 모두 별의 부스러기(stardust)다. 밤하늘을 바라볼 때, 우리는 우리의 고향을 보고 있는 것이다.',
    bookTitle: '코스모스',
    author: '칼 세이건',
    cover: 'https://image.aladin.co.kr/product/39676/50/cover200/k382130398_1.jpg',
    page: 382,
    memo: '광대한 우주 속에서 인간이라는 존재가 얼마나 소중하고 경이로운지.',
    tags: ['우주', '과학', '사유'],
    likes: 0,
    time: '32분 전'
  },
  {
    id: 'cs_3',
    text: '지나간 슬픔을 말하는 것이 아니라, 지금도 흐르고 있는 피를 닦아내는 마음으로 썼다.',
    bookTitle: '작별하지 않는다',
    author: '한강',
    cover: 'https://image.aladin.co.kr/product/27877/5/cover200/8954682154_3.jpg',
    page: 88,
    memo: '역사의 아픔을 가만히 보듬는 작가의 깊은 시선.',
    tags: ['문학', '위로', '기억'],
    likes: 0,
    time: '1시간 전'
  },
  {
    id: 'cs_4',
    text: '인생이란 때때로 우리로 하여금 전혀 예기치 않은 모순을 끌어안게 만든다.',
    bookTitle: '모순',
    author: '양귀자',
    cover: 'https://image.aladin.co.kr/product/2584/37/cover200/s392131969_1.jpg',
    page: 67,
    memo: '옳고 그름만으로 나눌 수 없는 삶의 입체적인 진실들.',
    tags: ['소설', '인생', '성찰'],
    likes: 0,
    time: '2시간 전'
  },
  {
    id: 'cs_5',
    text: '우리가 빛의 속도로 갈 수 없다면, 같은 우주에 존재한다 하더라도 영원히 닿지 못할지도 몰라.',
    bookTitle: '우리가 빛의 속도로 갈 수 없다면',
    author: '김초엽',
    cover: 'https://image.aladin.co.kr/product/19359/16/cover200/s722039767_1.jpg',
    page: 198,
    memo: '닿을 수 없는 거리를 넘어 전해지는 그리움의 온기.',
    tags: ['SF', '그리움', '다정함'],
    likes: 0,
    time: '2시간 전'
  },
  {
    id: 'cs_6',
    text: '인간은 패배하도록 창조된 것이 아니다. 인간은 파괴될 수는 있어도 패배할 수는 없다.',
    bookTitle: '노인과 바다',
    author: '어니스트 헤밍웨이',
    cover: 'https://image.aladin.co.kr/product/37480/63/cover200/k902032019_1.jpg',
    page: 115,
    memo: '삶의 거친 파도 앞에서도 굽히지 않는 인간의 존엄.',
    tags: ['고전', '의지', '용기'],
    likes: 0,
    time: '3시간 전'
  },
  {
    id: 'cs_7',
    text: '잠깐 머무는 여행자로서 우리는 세상에 아무것도 보태지 않고, 그저 바라볼 뿐이다.',
    bookTitle: '여행의 이유',
    author: '김영하',
    cover: 'https://image.aladin.co.kr/product/33763/31/cover200/s332036339_1.jpg',
    page: 54,
    memo: '일상의 짐을 벗어던지고 순수한 관찰자로 돌아가는 해방감.',
    tags: ['여행', '산문', '휴식'],
    likes: 0,
    time: '4시간 전'
  },
  {
    id: 'cs_8',
    text: '가장 무거운 짐은 동시에 가장 자유로운 삶의 완성에 대한 형상이기도 하다.',
    bookTitle: '참을 수 없는 존재의 가벼움',
    author: '밀란 쿤데라',
    cover: 'https://image.aladin.co.kr/product/34797/80/cover200/8937437562_1.jpg',
    page: 18,
    memo: '가벼움의 허무와 무거움의 숭고함 사이에서의 방황.',
    tags: ['철학', '문학', '존재'],
    likes: 0,
    time: '4시간 전'
  },
  {
    id: 'cs_9',
    text: '모든 발명에는 권력을 향한 내밀한 욕망이 깃들어 있었다.',
    bookTitle: '도구는 어떻게 권력이 되는가',
    author: '신무연',
    cover: 'https://image.aladin.co.kr/product/40129/94/cover200/k132131865_1.jpg',
    page: 45,
    memo: '도구는 중립적이지 않다. 권력 구조를 이해하는 새로운 렌즈.',
    tags: ['역사', '권력', '인문'],
    likes: 0,
    time: '5시간 전'
  },
  {
    id: 'cs_10',
    text: '눈에 보이지 않는 것이 가장 소중한 법이야. 마음으로 보아야만 분명하게 볼 수 있어.',
    bookTitle: '어린 왕자',
    author: '앙투안 드 생텍쥐페리',
    cover: 'https://image.aladin.co.kr/product/6853/49/cover200/8932917248_2.jpg',
    page: 92,
    memo: '언제 읽어도 마음 깊은 곳을 정화해 주는 영원한 문장.',
    tags: ['동화', '마음', '순수'],
    likes: 0,
    time: '6시간 전'
  },
  {
    id: 'cs_11',
    text: '인간은 고통을 통해서만 진정으로 성숙해지는 괴상한 존재이다.',
    bookTitle: '죄와 벌',
    author: '표도르 도스토옙스키',
    cover: 'https://image.aladin.co.kr/product/1621/17/cover200/8937462842_3.jpg',
    page: 320,
    memo: '심연을 들여다본 자만이 비로소 빛의 소중함을 깨닫는다.',
    tags: ['고전', '인간', '구원'],
    likes: 0,
    time: '7시간 전'
  },
  {
    id: 'cs_12',
    text: '겨울의 한가운데서 나는 내 안에 꺾이지 않는 여름이 있음을 깨달았다.',
    bookTitle: '여름',
    author: '알베르 카뮈',
    cover: 'https://image.aladin.co.kr/product/39656/80/cover200/k792130190_1.jpg',
    page: 72,
    memo: '어떤 절망과 시련 속에서도 결코 꺼지지 않는 생의 불꽃.',
    tags: ['산문', '희망', '철학'],
    likes: 0,
    time: '8시간 전'
  },
  {
    id: 'cs_13',
    text: '자유란 둘 더하기 둘이 넷이라고 말할 수 있는 자유이다. 그것이 허용된다면 다른 모든 것도 뒤따른다.',
    bookTitle: '1984',
    author: '조지 오웰',
    cover: 'https://image.aladin.co.kr/product/41/89/cover200/s122531356_2.jpg',
    page: 135,
    memo: '진실을 말할 권리와 생각의 독립성이 얼마나 소중한지 일깨운다.',
    tags: ['사회', '자유', '명작'],
    likes: 0,
    time: '9시간 전'
  },
  {
    id: 'cs_14',
    text: '누군가를 사랑한다는 것은, 그 사람의 가장 깊은 외로움까지 끌어안겠다는 다짐이다.',
    bookTitle: '바깥은 여름',
    author: '김애란',
    cover: 'https://image.aladin.co.kr/product/11145/47/cover200/s532932793_1.jpg',
    page: 154,
    memo: '사랑의 이면에 자리 잡은 연민과 연대의 깊이.',
    tags: ['소설', '사랑', '여운'],
    likes: 0,
    time: '10시간 전'
  },
  {
    id: 'cs_15',
    text: '상상할 수 있는 능력이 없었다면 우리는 아직도 아프리카의 초원에서 영양을 쫓고 있었을 것이다.',
    bookTitle: '사피엔스',
    author: '유발 하라리',
    cover: 'https://image.aladin.co.kr/product/31424/4/cover200/k482832219_1.jpg',
    page: 48,
    memo: '허구를 믿는 능력이야말로 인간 문명의 위대한 출발점.',
    tags: ['역사', '인류', '지성'],
    likes: 0,
    time: '12시간 전'
  },
  {
    id: 'cs_16',
    text: '어둠이 깊을수록 별은 더욱 찬란하게 빛난다.',
    bookTitle: '별 헤는 밤',
    author: '윤동주',
    cover: 'https://image.aladin.co.kr/product/8347/49/cover200/8937475103_2.jpg',
    page: 34,
    memo: '순결한 시인의 고뇌 속에서 피어난 영원한 서정.',
    tags: ['시', '별', '순수'],
    likes: 0,
    time: '14시간 전'
  },
  {
    id: 'cs_17',
    text: '나를 죽이지 못하는 고통은 나를 더욱 강하게 만든다.',
    bookTitle: '우상의 황혼',
    author: '프리드리히 니체',
    cover: 'https://image.aladin.co.kr/product/6419/39/cover200/8957334513_1.jpg',
    page: 88,
    memo: '시련 앞에서 물러서지 않고 나아가는 강인한 의지.',
    tags: ['철학', '극복', '힘'],
    likes: 0,
    time: '16시간 전'
  },
  {
    id: 'cs_18',
    text: '시간은 흐르는 것이 아니라 우리가 시간을 뚫고 걸어가는 것이다.',
    bookTitle: '시간의 향기',
    author: '한병철',
    cover: 'https://image.aladin.co.kr/product/2473/36/cover200/8932023964_1.jpg',
    page: 62,
    memo: '속도에 쫓기는 현대 사회에서 사유의 시간성을 되찾는 법.',
    tags: ['철학', '시간', '사색'],
    likes: 0,
    time: '18시간 전'
  },
  {
    id: 'cs_19',
    text: '그리하여 우리는 조류를 거스르는 배처럼, 끊임없이 과거로 밀려가면서도 앞으로 나아가는 것이다.',
    bookTitle: '위대한 개츠비',
    author: 'F. 스콧 피츠제럴드',
    cover: 'https://image.aladin.co.kr/product/41/79/cover200/s582934787_1.jpg',
    page: 252,
    memo: '손에 닿지 않는 초록 불빛을 향해 끊임없이 노를 젓는 인간의 숙명.',
    tags: ['고전', '꿈', '여운'],
    likes: 0,
    time: '20시간 전'
  },
  {
    id: 'cs_20',
    text: '살아온 기적이 살아갈 기적이 된다. 사소한 하루가 모여 하나의 온전한 삶이 된다.',
    bookTitle: '그 많던 싱아는 누가 다 먹었을까',
    author: '박완서',
    cover: 'https://image.aladin.co.kr/product/36931/7/cover200/890129690x_2.jpg',
    page: 210,
    memo: '질곡의 세월을 담담하게 통과해 낸 거목의 따스한 품.',
    tags: ['수필', '생애', '따뜻함'],
    likes: 0,
    time: '22시간 전'
  },
  {
    id: 'cs_21',
    text: '너의 내면으로 침잠하라. 그곳에서 네가 쓰지 않고는 살 수 없는지 물어보라.',
    bookTitle: '젊은 시인에게 주는 충고',
    author: '라이너 마리아 릴케',
    cover: 'https://image.aladin.co.kr/product/25056/37/cover200/k682632647_1.jpg',
    page: 25,
    memo: '타인의 시선이 아닌 오직 자기 자신과의 깊은 대면.',
    tags: ['문학', '창작', '예술'],
    likes: 0,
    time: '어제'
  },
  {
    id: 'cs_22',
    text: '한 권의 책은 우리 안의 얼어붙은 바다를 깨부수는 도끼여야 한다.',
    bookTitle: '변신',
    author: '프란츠 카프카',
    cover: 'https://image.aladin.co.kr/product/37480/50/cover200/k522032917_1.jpg',
    page: 12,
    memo: '안온함에 취해 무뎌진 감각을 날카롭게 깨우는 독서의 본령.',
    tags: ['독서', '카프카', '사유'],
    likes: 0,
    time: '어제'
  },
  {
    id: 'cs_23',
    text: '내가 어둠을 바라볼 때, 어둠 또한 나를 바라본다.',
    bookTitle: '종의 기원',
    author: '정유정',
    cover: 'https://image.aladin.co.kr/product/7492/9/cover200/8956609950_2.jpg',
    page: 180,
    memo: '금기를 넘어서는 인간의 어두운 본능에 대한 섬뜩한 질문.',
    tags: ['스릴러', '심리', '인간'],
    likes: 0,
    time: '어제'
  },
  {
    id: 'cs_24',
    text: '진정한 발견의 여정은 새로운 풍경을 찾는 것이 아니라, 새로운 눈을 갖는 것이다.',
    bookTitle: '잃어버린 시간을 찾아서',
    author: '마르셀 프루스트',
    cover: 'https://image.aladin.co.kr/product/1960/90/cover200/8937485613_1.jpg',
    page: 440,
    memo: '세상을 새롭게 감각하는 눈이야말로 독서가 우리에게 주는 가장 큰 선물.',
    tags: ['고전', '통찰', '발견'],
    likes: 0,
    time: '어제'
  },
  {
    id: 'cs_25',
    text: '기억은 기록되지 않으면 안개처럼 흩어져 버린다. 쓰는 행위만이 기억에 형태를 부여한다.',
    bookTitle: '눈먼 자들의 도시',
    author: '주제 사라마구',
    cover: 'https://image.aladin.co.kr/product/30307/98/cover200/k392839030_1.jpg',
    page: 290,
    memo: '망각의 강에서 우리가 건져 올려야 할 기록의 가치.',
    tags: ['소설', '기록', '인간'],
    likes: 0,
    time: '2일 전'
  },
  {
    id: 'cs_26',
    text: '우리가 진정으로 두려워해야 할 유일한 것은 두려움 그 자체이다.',
    bookTitle: '페스트',
    author: '알베르 카뮈',
    cover: 'https://image.aladin.co.kr/product/1126/73/cover200/s937462672_2.jpg',
    page: 175,
    memo: '재난과 혼돈 속에서도 묵묵히 자신의 자리를 지키는 이들의 연대.',
    tags: ['문학', '용기', '연대'],
    likes: 0,
    time: '2일 전'
  },
  {
    id: 'cs_27',
    text: '책 속에는 우리가 아직 가보지 못한 수만 개의 삶이 숨 쉬고 있다.',
    bookTitle: '책 읽는 뇌',
    author: '매리언 울프',
    cover: 'https://image.aladin.co.kr/product/34152/40/cover200/k022931499_1.jpg',
    page: 112,
    memo: '타인의 삶에 공감하는 기적을 일으키는 뇌의 마법.',
    tags: ['뇌과학', '독서', '공감'],
    likes: 0,
    time: '2일 전'
  },
  {
    id: 'cs_28',
    text: '침묵은 때로 어떤 화려한 웅변보다도 강렬한 울림을 지닌다.',
    bookTitle: '채식주의자',
    author: '한강',
    cover: 'https://image.aladin.co.kr/product/29137/2/cover200/8936434594_2.jpg',
    page: 145,
    memo: '말을 잃어버린 침묵 속에서 터져 나오는 존재의 절규.',
    tags: ['문학', '침묵', '한강'],
    likes: 0,
    time: '3일 전'
  },
  {
    id: 'cs_29',
    text: '행복한 가정은 모두 엇비슷하지만, 불행한 가정은 각기 다른 이유로 불행하다.',
    bookTitle: '안나 카레니나',
    author: '레프 톨스토이',
    cover: 'https://image.aladin.co.kr/product/2090/89/cover200/8937486075_3.jpg',
    page: 9,
    memo: '세계 문학사상 가장 완벽하고 강렬한 첫 문장.',
    tags: ['고전', '인생', '첫문장'],
    likes: 0,
    time: '3일 전'
  },
  {
    id: 'cs_30',
    text: '독서는 타인의 생각을 빌려 나의 생각을 직조해 내는 가장 고결한 대화이다.',
    bookTitle: '문장의 온도',
    author: '이기주',
    cover: 'https://image.aladin.co.kr/product/12985/30/cover200/k292532799_1.jpg',
    page: 78,
    memo: '책장을 넘기며 나와 마주하는 고요하고 깊은 시간.',
    tags: ['에세이', '독서', '마음'],
    likes: 0,
    time: '3일 전'
  }
];

/* ==============================================
   COMMUNITY TIME & DATA HELPERS
   ============================================== */
function formatTimeAgo(dateStr) {
  if (!dateStr) return '최근';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '최근';
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return '방금 전';
  if (diffMins < 60) return `${diffMins}분 전`;
  if (diffHours < 24) return `${diffHours}시간 전`;
  if (diffDays < 7) return `${diffDays}일 전`;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function getSafeTimestamp(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

let remoteCommunityBooks = [];
let communityLikesMap = new Map();
let commLikesChannel = null;
let localLikeBroadcast = null;

function getClientLikeId() {
  if (currentUser && currentUser.id) return currentUser.id;
  let cid = '';
  try {
    cid = localStorage.getItem('rj_client_like_id');
    if (!cid) {
      cid = 'guest_' + Math.random().toString(36).substring(2, 11);
      localStorage.setItem('rj_client_like_id', cid);
    }
  } catch (e) {
    cid = 'guest_temp';
  }
  return cid;
}

function broadcastLikeUpdate(targetId, userId, isLiked) {
  const payload = { targetId: String(targetId), userId, isLiked };
  // 1. Cross-tab BroadcastChannel
  if (localLikeBroadcast) {
    try {
      localLikeBroadcast.postMessage(payload);
    } catch (e) {}
  }
  // 2. Supabase Realtime channel
  if (commLikesChannel) {
    try {
      commLikesChannel.send({
        type: 'broadcast',
        event: 'like_update',
        payload: payload
      });
    } catch (e) {
      console.warn('Failed to broadcast like update via Supabase:', e);
    }
  }
}

async function fetchCommunityLikes() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('books')
      .select('id, user_id, author')
      .eq('title', '__like__');

    if (!error && Array.isArray(data)) {
      communityLikesMap.clear();
      data.forEach(row => {
        const targetId = row.author;
        const uId = row.user_id;
        if (targetId && uId) {
          const strTId = String(targetId);
          if (!communityLikesMap.has(strTId)) {
            communityLikesMap.set(strTId, new Set());
          }
          communityLikesMap.get(strTId).add(uId);
        }
      });
      renderCommunityBooks();
      renderCommunityScraps();
    }
  } catch (e) {
    console.warn('Failed to fetch community likes:', e);
  }
}

function initCommunityLikesChannel() {
  if (typeof BroadcastChannel !== 'undefined' && !localLikeBroadcast) {
    try {
      localLikeBroadcast = new BroadcastChannel('8ook_likes_channel');
      localLikeBroadcast.onmessage = (event) => {
        if (event && event.data) {
          applyIncomingLikeUpdate(event.data);
        }
      };
    } catch (e) {}
  }

  if (!supabaseClient || commLikesChannel) return;
  try {
    commLikesChannel = supabaseClient.channel('comm_likes_broadcast')
      .on('broadcast', { event: 'like_update' }, (payload) => {
        if (payload && payload.payload) {
          applyIncomingLikeUpdate(payload.payload);
        }
      })
      .subscribe();
  } catch (e) {
    console.warn('Realtime like channel error:', e);
  }
}

function applyIncomingLikeUpdate(payload) {
  const { targetId, userId, isLiked } = payload;
  if (!targetId || !userId) return;

  const strId = String(targetId);
  if (!communityLikesMap.has(strId)) {
    communityLikesMap.set(strId, new Set());
  }
  const set = communityLikesMap.get(strId);
  if (isLiked) {
    set.add(userId);
  } else {
    set.delete(userId);
  }

  const myId = getClientLikeId();
  const isMine = (currentUser && userId === currentUser.id) || userId === myId;

  // Update book cards in DOM
  const escapedTargetId = (window.CSS && CSS.escape) ? CSS.escape(strId) : strId;
  const bookBtns = document.querySelectorAll(`.comm-book-like-btn[data-target-id="${escapedTargetId}"], .comm-book-like-btn[onclick*="${escapedTargetId}"]`);
  bookBtns.forEach(btn => {
    const countSpan = btn.querySelector('.like-count');
    if (countSpan) countSpan.textContent = String(set.size);
    if (isMine) {
      btn.classList.toggle('liked', isLiked);
    }
  });

  // Update scrap cards in DOM
  const scrapBtns = document.querySelectorAll(`.comm-scrap-like-btn[data-target-id="${escapedTargetId}"], .comm-scrap-like-btn[onclick*="${escapedTargetId}"]`);
  scrapBtns.forEach(btn => {
    const countSpan = btn.querySelector('.like-count');
    if (countSpan) countSpan.textContent = String(set.size);
    if (isMine) {
      btn.classList.toggle('liked', isLiked);
    }
  });
}

async function fetchRemoteCommunityBooks() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('books')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (!error && Array.isArray(data)) {
      remoteCommunityBooks = data;
      renderCommunityBooks();
      renderCommunityScraps();
    }
  } catch (e) {
    console.warn('Failed to fetch remote community books:', e);
  }
}

function getAllCommunityBooks() {
  const map = new Map();

  // 1. Remote community books from Supabase across all users (공개 도서만 포함)
  if (Array.isArray(remoteCommunityBooks)) {
    remoteCommunityBooks.forEach(b => {
      if (b && !isGuideBook(b) && b.title && b.title !== '__like__' && !b.id?.startsWith('like_') && b.is_public !== false) {
        map.set(b.id, b);
      }
    });
  }

  // 2. 현재 로그인 사용자의 로컬 books (공개 도서만 병합)
  if (Array.isArray(books)) {
    books.forEach(b => {
      if (b && !isGuideBook(b) && b.title && b.title !== '__like__' && !b.id?.startsWith('like_') && b.is_public !== false) {
        if (!map.has(b.id)) {
          map.set(b.id, b);
        } else {
          // 이미 Supabase에서 온 도서라면, 스크랩 수가 더 많은 쪽(최신 수정)으로 보강
          const remoteB = map.get(b.id);
          const localScrapsCount = (b.scraps || []).length;
          const remoteScrapsCount = (remoteB.scraps || []).length;
          if (localScrapsCount > remoteScrapsCount) {
            map.set(b.id, { ...remoteB, ...b });
          }
        }
      }
    });
  }

  // 3. Shared community dataset (window.NEO_BOOKS_131) from all users
  if (typeof window !== 'undefined' && Array.isArray(window.NEO_BOOKS_131)) {
    window.NEO_BOOKS_131.forEach(b => {
      if (b && !isGuideBook(b) && b.title && b.title !== '__like__' && !b.id?.startsWith('like_') && b.is_public !== false && !map.has(b.id)) {
        map.set(b.id, b);
      }
    });
  }

  return Array.from(map.values());
}

async function showCommunity(pushHistory = true) {
  document.body.classList.remove('page-detail');
  closeAppMenu();
  document.getElementById('view-gallery').style.display = 'none';
  document.getElementById('view-detail').classList.remove('show');
  document.getElementById('view-stats').classList.remove('show');
  const scrapsView = document.getElementById('view-scraps');
  if (scrapsView) scrapsView.classList.remove('show');
  document.getElementById('view-community').classList.add('show');

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
    vl.textContent = '독서 커뮤니티';
  }

  if (pushHistory && window.history && window.history.pushState) {
    if (!window.history.state || window.history.state.view !== 'community') {
      window.history.pushState({ view: 'community' }, '', '#community');
    }
  }

  // 먼저 로컬/기존 캐시로 즉시 렌더링
  renderCommunityBooks();
  renderCommunityScraps();
  switchCommunityTab(currentCommunityTab);

  // 최신 Supabase 원격 도서 및 좋아요 데이터 비동기 페치 및 동기화 렌더링
  await Promise.all([
    fetchRemoteCommunityBooks(),
    fetchCommunityLikes()
  ]);
  initCommunityLikesChannel();
}

function switchCommunityTab(tab) {
  currentCommunityTab = tab;
  const booksBtn = document.getElementById('comm-tab-books-btn');
  const scrapsBtn = document.getElementById('comm-tab-scraps-btn');
  const booksPanel = document.getElementById('comm-books-panel');
  const scrapsPanel = document.getElementById('comm-scraps-panel');

  if (tab === 'books') {
    if (booksBtn) booksBtn.classList.add('active');
    if (scrapsBtn) scrapsBtn.classList.remove('active');
    if (booksPanel) booksPanel.classList.add('active');
    if (scrapsPanel) scrapsPanel.classList.remove('active');
  } else {
    if (booksBtn) booksBtn.classList.remove('active');
    if (scrapsBtn) scrapsBtn.classList.add('active');
    if (booksPanel) booksPanel.classList.remove('active');
    if (scrapsPanel) scrapsPanel.classList.add('active');
  }
}

function getCommunityBooksList() {
  // Return books across ALL users, sorted strictly by newest added time first (maximum 9 books)
  const allBooks = getAllCommunityBooks();

  const sorted = [...allBooks].sort((a, b) => {
    const timeA = getSafeTimestamp(a.created_at) || getSafeTimestamp(a.date);
    const timeB = getSafeTimestamp(b.created_at) || getSafeTimestamp(b.date);
    if (timeA && timeB && timeA !== timeB) return timeB - timeA;
    if (timeA && !timeB) return -1;
    if (!timeA && timeB) return 1;
    return (b.seq || 0) - (a.seq || 0);
  });

  return sorted.slice(0, 9).map((b) => {
    const titleParts = splitBookTitle(b);
    const userRating = (b.rating && Number(b.rating) > 0) ? Number(b.rating) : null;
    const userReview = (b.sentence || b.review || b.oneLineReview || '').trim();
    const rawDate = b.created_at || b.date;

    return {
      id: b.id,
      title: titleParts.main || b.title,
      subtitle: titleParts.sub || b.subtitle || '',
      author: b.author || '저자 미상',
      cover: b.cover || '',
      rating: userRating,
      review: userReview || null,
      time: formatTimeAgo(rawDate)
    };
  });
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
  if (img.onclick) ph.onclick = img.onclick;
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
  img.onerror = null;
  if (!img.dataset.tried1 && img.src.includes('/Spine/')) {
    img.dataset.tried1 = 'true';
    img.src = img.src.replace('/Spine/', '/spine/');
    return;
  }
  const parent = img.parentElement;
  if (parent) {
    parent.innerHTML = '<div class="img-prev-ph spine-ph"><span style="font-size:10px; writing-mode:vertical-rl; letter-spacing:1px; color:var(--text-300);">기본 책등</span></div>';
  }
}

function handleRealSpineError(img) {
  img.onerror = null;
  if (!img.dataset.tried1 && img.src.includes('/Spine/')) {
    img.dataset.tried1 = 'true';
    img.src = img.src.replace('/Spine/', '/spine/');
  } else {
    img.classList.add('hide-real');
    const fb = img.parentElement ? img.parentElement.querySelector('.spine-custom-view') : null;
    if (fb) fb.classList.add('show-fallback');
  }
}

function handleCommCoverError(img) {
  img.onerror = null;
  const ph = document.createElement('div');
  const isScrap = img.classList.contains('comm-scrap-cover');
  ph.className = isScrap ? 'comm-scrap-cover-placeholder' : 'comm-book-cover-placeholder';
  ph.textContent = '8ook';
  if (img.onclick) ph.onclick = img.onclick;
  img.replaceWith(ph);
}

function renderCommunityBooks() {
  const container = document.getElementById('comm-books-grid');
  if (!container) return;

  const list = getCommunityBooksList();
  const countEl = document.getElementById('comm-books-count');
  if (countEl) countEl.remove();

  const titleEl = document.getElementById('comm-books-panel-title');
  if (titleEl) {
    titleEl.textContent = '새로 추가된 책';
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 60px 20px; text-align: center; color: var(--text-300); font-size: 13.5px;">
        <div style="font-weight: 600; color: var(--text-200); margin-bottom: 4px;">아직 서재에 추가된 도서가 없습니다.</div>
        <div style="font-size: 12px; color: var(--text-400);">서재에 책을 등록하면 최근 추가된 도서로 이곳에 표시됩니다.</div>
      </div>
    `;
    return;
  }

  let storedBookLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_book_likes');
    if (raw) storedBookLikes = JSON.parse(raw);
  } catch (e) {}

  const myId = getClientLikeId();

  container.innerHTML = list.map(b => {
    const bid = String(b.id);
    const titleParts = splitBookTitle(b);
    const mainTitle = b.title && b.subtitle !== undefined ? b.title : (titleParts.main || b.title);
    const subTitle = b.subtitle !== undefined ? b.subtitle : (titleParts.sub || '');

    const coverUrl = b.cover ? getSafeImageUrl(b.cover) : '';
    const coverHtml = coverUrl
      ? `<img class="comm-book-cover" src="${esc(coverUrl)}" alt="${esc(mainTitle)}" referrerpolicy="no-referrer" decoding="async" onclick="showDetail('${esc(bid)}')" onerror="handleCommCoverError(this)">`
      : `<div class="comm-book-cover-placeholder" onclick="showDetail('${esc(bid)}')">8ook</div>`;

    const ratingHtml = (b.rating && Number(b.rating) > 0)
      ? `<div class="comm-book-rating">${'★'.repeat(Math.min(5, Math.max(1, Math.round(b.rating))))}${'☆'.repeat(Math.max(0, 5 - Math.round(b.rating)))} <span style="font-size:10px; color:var(--text-300); font-weight:600;">${Number(b.rating).toFixed(1)}</span></div>`
      : '';

    const reviewHtml = (b.review && b.review.trim())
      ? `<div class="comm-book-review" title="${esc(b.review.trim())}">“${esc(b.review.trim())}”</div>`
      : '';

    const remoteSet = communityLikesMap.get(bid) || new Set();
    const isLiked = (currentUser && remoteSet.has(currentUser.id)) || remoteSet.has(myId) || !!storedBookLikes['bk_' + bid];
    let currentLikes = remoteSet.size;
    if (isLiked && !remoteSet.has(myId) && (!currentUser || !remoteSet.has(currentUser.id))) {
      currentLikes += 1;
    }

    return `
      <div class="comm-book-card" id="comm-bk-${esc(bid)}">
        ${coverHtml}
        <div class="comm-book-info">
          <div class="comm-book-title" onclick="showDetail('${esc(bid)}')" title="${esc(mainTitle)}">${esc(mainTitle)}</div>
          <div class="comm-book-author">${esc(b.author)}</div>
          ${ratingHtml}
          ${reviewHtml}
          <div class="comm-book-meta">
            <span class="comm-book-time">${esc(b.time || '')}</span>
            <button type="button" class="comm-book-like-btn${isLiked ? ' liked' : ''}" data-target-id="${esc(bid)}" onclick="toggleCommunityBookLike('${esc(bid)}', this, event)" title="좋아요">
              <span class="comm-heart-icon">♥</span> <span class="like-count">${currentLikes}</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
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
      b.scraps.forEach(s => {
        if (!s.text || !s.text.trim()) return;
        const scrapTime = s.created_at || s.at || b.created_at || b.date;
        const rawTime = getSafeTimestamp(scrapTime);
        userScraps.push({
          id: 'us_' + (s.id || uid()),
          bookId: b.id,
          text: s.text,
          bookTitle: bMainTitle,
          author: b.author || '',
          cover: b.cover || '',
          page: s.page || null,
          memo: s.memo || '',
          tags: s.tags || s.keywords || [],
          likes: 0,
          rawTime: rawTime,
          time: formatTimeAgo(scrapTime)
        });
      });
    }
  });

  // 문장 자체의 등록 시각(rawTime) 기준으로 모든 유저에게 완벽히 동일한 최신순(내림차순) 정렬!
  userScraps.sort((a, b) => b.rawTime - a.rawTime);

  if (userScraps.length >= 30) {
    return userScraps.slice(0, 30);
  }

  const combined = [...userScraps];
  SEED_COMMUNITY_SCRAPS.forEach(ss => {
    if (combined.length < 30 && !combined.some(s => s.text === ss.text)) {
      const matched = bookByTitle.get((ss.bookTitle || '').trim().toLowerCase());
      combined.push({
        ...ss,
        bookId: matched ? matched.id : (ss.bookId || ''),
        cover: (matched && matched.cover) ? matched.cover : (ss.cover || ''),
        likes: 0
      });
    }
  });
  return combined.slice(0, 30);
}

function renderCommunityScraps() {
  const container = document.getElementById('comm-scraps-stream');
  if (!container) return;

  const list = getCommunityScrapsList();
  const countEl = document.getElementById('comm-scraps-count');
  if (countEl) countEl.remove();

  let storedLikes = {};
  try {
    const raw = localStorage.getItem('rj_community_likes');
    if (raw) storedLikes = JSON.parse(raw);
  } catch (e) {}

  const myId = getClientLikeId();

  container.innerHTML = list.map((s, idx) => {
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

    const coverUrl = s.cover ? getSafeImageUrl(s.cover) : '';
    const clickDetail = s.bookId ? `onclick="showDetail('${esc(s.bookId)}')"` : '';
    const coverHtml = coverUrl
      ? `<img class="comm-scrap-cover" src="${esc(coverUrl)}" alt="${esc(mainTitle)}" referrerpolicy="no-referrer" decoding="async" ${clickDetail} onerror="handleCommCoverError(this)">`
      : `<div class="comm-scrap-cover-placeholder" ${clickDetail}>8ook</div>`;

    return `
      <div class="comm-scrap-card" id="csc-${esc(sid)}">
        <div class="comm-scrap-body">
          ${coverHtml}
          <div class="comm-scrap-text">${esc(s.text)}</div>
          ${s.memo ? `<div class="comm-scrap-memo-wrap"><div class="comm-scrap-memo">${esc(s.memo)}</div></div>` : ''}
        </div>
        <div class="comm-scrap-footer">
          <div class="comm-scrap-title-row">
            <strong class="comm-scrap-book-title" ${clickDetail} style="${s.bookId ? 'cursor:pointer;' : ''}">《${esc(mainTitle)}》</strong>
          </div>
          <div class="comm-scrap-meta-row">
            <div class="comm-scrap-meta-left">
              ${s.author ? `<span class="comm-scrap-author">${esc(s.author)}</span>` : ''}
              ${s.page ? `<span class="comm-scrap-page">p.${s.page}</span>` : ''}
              ${tagsHtml}
            </div>
            <div class="comm-scrap-actions">
              <button class="comm-scrap-btn" onclick="copyCommunityQuote('${esc(s.text.replace(/'/g, "\\'"))}', '${esc(mainTitle.replace(/'/g, "\\'"))}', '${esc((s.author || '').replace(/'/g, "\\'"))}', '${s.page || ''}')" title="문장 복사">
                복사
              </button>
              <button type="button" class="comm-scrap-like-btn${isLiked ? ' liked' : ''}" data-target-id="${esc(sid)}" onclick="toggleCommunityLike('${esc(sid)}', this, event)" title="좋아요">
                <span class="comm-heart-icon">♥</span> <span class="like-count">${currentLikes}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
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


function searchAladinByQuery(query) {
  openAddModal();
  document.getElementById('bk-title').value = query;
  searchAladin();
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
      ctx.strokeRect(canvas.width * 0.2 - w1 / 2, canvas.height * 0.5 - h1 / 2, w1, h1);

      // Box 2 (Center Area)
      const w2 = canvas.width * 0.24 * (1.7 - pulseScale);
      const h2 = canvas.height * 0.52 * (1.7 - pulseScale);
      ctx.strokeRect(canvas.width * 0.5 - w2 / 2, canvas.height * 0.46 - h2 / 2, w2, h2);

      // Box 3 (Right Area)
      const w3 = canvas.width * 0.22 * pulseScale;
      const h3 = canvas.height * 0.48 * pulseScale;
      ctx.strokeRect(canvas.width * 0.8 - w3 / 2, canvas.height * 0.5 - h3 / 2, w3, h3);

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
      g += data[i + 1];
      b += data[i + 2];
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
  if (monthOpt) monthOpt.textContent = `이번 달 (${now.getMonth() + 1}월)`;

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
        startDate.setHours(0, 0, 0, 0);
        if (bDate < startDate) return false;
      }
      if (endVal) {
        const endDate = new Date(endVal);
        endDate.setHours(23, 59, 59, 999);
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
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
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
