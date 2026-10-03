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
    console.warn("Supabase SDK not loaded. Personal library loading is unavailable.");
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
create policy "Allow public read" on books for select using (user_id = auth.uid() OR is_public IS TRUE);
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
let calDate = new Date();
let gridMin = window.innerWidth <= 640 ? 140 : 170;
let zoomTimer = null;
let sidebarOpen = false;
let isDarkTheme = false;
let chartMode = 'month';
let statsPeriod = 'all';
let editingScrapId = null;
let currentGalleryFilter = null;
let isGalleryDirty = true;
let savedGalleryScrollTop = 0;

function markGalleryDirty() {
  isGalleryDirty = true;
}

function clearGalleryFilter() {
  currentGalleryFilter = null;
  savedGalleryScrollTop = 0;
  markGalleryDirty();
  renderGallery();
}

function setGalleryFilter(tag) {
  currentGalleryFilter = tag ? tag.replace(/^#/, '').trim() : null;
  savedGalleryScrollTop = 0;
  markGalleryDirty();
  renderGallery();
}

function saveCurrentGalleryScroll() {
  const scrollEl = document.getElementById('gallery-scroll');
  if (scrollEl && scrollEl.scrollTop > 0) {
    savedGalleryScrollTop = scrollEl.scrollTop;
  }
}

// Community State
let remoteCommunityBooks = [];
let communityLikesMap = new Map();
let commLikesChannel = null;
let localLikeBroadcast = null;
let communityCommentsMap = new Map(); // bookId -> [ { id, bookId, userId, nickname, text, createdAt } ]
let commCommentsChannel = null;
let localCommentBroadcast = null;
let currentCommunityTab = 'books';
let communityBooksLimit = 10;
let communityPopularBooksLimit = 10;
let isCommunityBooksLoading = false;
let isCommunityPopularLoading = false;
let communityBooksObserver = null;
let communityPopularObserver = null;

// Aladin
let aladinSearchTimer = null;
let aladinCallbackCounter = 0;
let aladinSearchResults = [];
let currentAladinSort = 'Accuracy';
let currentAladinQuery = '';


/* ==============================================
   HELPERS
============================================== */


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
  if (!url || typeof url !== 'string') return '';
  url = url.trim();
  if (!url) return '';

  // Non-HTTP relative image paths (e.g., local filenames like "스크린샷 ...png")
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('/') && !url.startsWith('attachment:')) {
    return '';
  }

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

  // Handle pstatic.net/shopping-phinf blocked by browser tracking prevention (ERR_BLOCKED_BY_CLIENT)
  if (url.includes('pstatic.net') || url.includes('shopping-phinf')) {
    return '';
  }

  return url;
}


function formatCompletionDate(dateValue) {
  if (!dateValue) return '';
  const raw = String(dateValue).trim();
  const match = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!match) return raw;
  return `${match[1]}.${match[2].padStart(2, '0')}.${match[3].padStart(2, '0')}`;
}

function coverMetaHtml(book) {
  const rating = book.rating ? `<div class="ov-stars">${starsPlain(book.rating)}</div>` : '<div class="ov-stars ov-stars-empty"></div>';
  const completionDate = formatCompletionDate(book.date);
  const date = completionDate ? `<div class="ov-completion-date">${esc(completionDate)}</div>` : '';
  return `<div class="ov-meta-row">${rating}${date}</div>`;
}


function starsHtml(n, size) {
  let h = '';
  for (let i = 1; i <= 5; i++) {
    const on = i <= (n || 0);
    h += `<span class="detail-star${on ? ' on' : ''}" style="color:${on ? 'var(--amber)' : 'var(--star-off)'};font-size:${size || 20}px">${on ? '★' : '☆'}</span>`;
  }
  return h;
}


function toast(msg, dur = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), dur);
}

/* ==============================================
   THEME (레퍼런스 톤 단일 테마 고정) & ACCESSIBILITY
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

/* ── 큰글자 모드 (가독성 향상 모드) ── */
function loadLargeTextMode() {
  const isLarge = localStorage.getItem('rj_large_text_mode') === 'true';
  applyLargeTextMode(isLarge, false);
}

function applyLargeTextMode(enabled, showToast = false) {
  if (enabled) {
    document.documentElement.classList.add('large-text-mode');
    document.body.classList.add('large-text-mode');
  } else {
    document.documentElement.classList.remove('large-text-mode');
    document.body.classList.remove('large-text-mode');
  }

  syncLargeTextUI();

  if (showToast) {
    toast(enabled ? '큰글자 모드를 켰습니다. (글씨가 크게 표시됩니다)' : '큰글자 모드를 껐습니다. (기본 크기로 복원)');
  }
}

function syncLargeTextUI() {
  const isLarge = document.body.classList.contains('large-text-mode');
  const btn = document.getElementById('large-text-nav-btn');
  if (btn) {
    btn.setAttribute('aria-checked', isLarge ? 'true' : 'false');
  }
  const badge = document.getElementById('large-text-badge');
  if (badge) {
    badge.textContent = isLarge ? 'ON' : 'OFF';
    badge.classList.toggle('active', isLarge);
  }
}

function toggleLargeTextMode() {
  const current = document.body.classList.contains('large-text-mode');
  const next = !current;
  try {
    localStorage.setItem('rj_large_text_mode', next ? 'true' : 'false');
  } catch (e) { }
  applyLargeTextMode(next, true);
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
  const h = 351; // 1.3배 세로 높이
  const ratio = img.naturalWidth / img.naturalHeight;
  const src = img.getAttribute('src') || img.src;

  // YES24 SIDE URLs also return a wide generic "image preparing" placeholder.
  // Reject cover-like images and fall back to the Aladin spine (or generated spine).
  if (src && src.includes('image.yes24.com/') && src.includes('/SIDE/') && ratio > 0.45) {
    spineImgStatusCache[src] = { status: 'fail' };
    scheduleSaveSpineStatusCache();

    const bookId = card ? card.getAttribute('data-id') : '';
    const book = Array.isArray(books) ? books.find(b => String(b.id) === String(bookId)) : null;
    const aladinFallback = book ? getSpineImageUrl(book.cover) : '';
    if (aladinFallback && aladinFallback !== src) {
      img.src = aladinFallback;
      return;
    }

    img.style.display = 'none';
    const fallback = card ? card.querySelector('.spine-custom-view') : null;
    if (fallback) fallback.classList.add('show-fallback');
    return;
  }

  // 실제 불러온 원본 이미지의 가로/세로 비율 100% 그대로 적용
  let w = Math.round(h * ratio);
  if (w < 16) w = 16;
  if (card) {
    card.style.width = w + 'px';
    card.style.setProperty('--spine-w', w + 'px');
  }
  if (src && !src.startsWith('data:')) {
    spineImgStatusCache[src] = { status: 'ok', width: w };
    scheduleSaveSpineStatusCache();
  }
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


// ==============================================
// Cover Color Extraction & Modern Paperback Spine Theme (Minimal Shadow)
// ==============================================
const SPINE_COVER_CACHE_KEY = 'rj_spine_paperback_theme_cache_v4';
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

// Persistent cache for spine image availability & measured width
// Format: { [url]: { status: 'ok' | 'fail', width?: number } }
const SPINE_IMG_STATUS_CACHE_KEY = 'rj_spine_img_status_cache_v2';
let spineImgStatusCache = {};
try {
  const savedStatus = localStorage.getItem(SPINE_IMG_STATUS_CACHE_KEY);
  if (savedStatus) spineImgStatusCache = JSON.parse(savedStatus);
} catch (e) {
  spineImgStatusCache = {};
}

let _saveSpineStatusTimer = null;
function scheduleSaveSpineStatusCache() {
  if (_saveSpineStatusTimer) clearTimeout(_saveSpineStatusTimer);
  _saveSpineStatusTimer = setTimeout(() => {
    try {
      localStorage.setItem(SPINE_IMG_STATUS_CACHE_KEY, JSON.stringify(spineImgStatusCache));
    } catch (e) { }
  }, 1000);
}

function preheatSpineCache() {
  if (!Array.isArray(books) || books.length === 0) return;
  const toCheck = [];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    if (isGuideBook(b)) continue;
    const url = b.spineCover || b.spine || getSpineImageUrl(b.cover);
    if (url && !url.startsWith('data:') && !spineImgStatusCache[url]) {
      toCheck.push(url);
    }
  }
  if (toCheck.length === 0) return;

  let idx = 0;
  function checkNext() {
    if (idx >= toCheck.length) return;
    const batch = toCheck.slice(idx, idx + 4);
    idx += 4;
    batch.forEach(url => {
      if (spineImgStatusCache[url]) return;
      const testImg = new Image();
      testImg.onload = () => {
        if (testImg.naturalWidth && testImg.naturalHeight) {
          const ratio = testImg.naturalWidth / testImg.naturalHeight;
          const isYes24Side = url.includes('image.yes24.com/') && url.includes('/SIDE/');
          if (isYes24Side && ratio > 0.45) {
            spineImgStatusCache[url] = { status: 'fail' };
          } else {
            const w = Math.max(16, Math.round(351 * ratio));
            spineImgStatusCache[url] = { status: 'ok', width: w };
          }
        } else {
          spineImgStatusCache[url] = { status: 'fail' };
        }
        scheduleSaveSpineStatusCache();
      };
      testImg.onerror = () => {
        spineImgStatusCache[url] = { status: 'fail' };
        scheduleSaveSpineStatusCache();
      };
      testImg.src = url;
    });
    setTimeout(checkNext, 250);
  }
  setTimeout(checkNext, 800);
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

function generatePaperbackThemeFromRgb(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const avgLum = (max + min) / 2;
  const chroma = max - min;

  // 1. Off-white / Cream Minimalist Paperback (밝은 표지 or 무채색 연회색/미색 표지)
  if (avgLum >= 195 || (avgLum >= 175 && chroma < 35)) {
    const [h, s] = rgbToHsl(r, g, b);
    const sat = Math.max(4, Math.min(s, 20));
    return {
      bg: `linear-gradient(180deg, hsl(${h || 40}, ${sat}%, 94%) 0%, hsl(${h || 40}, ${sat}%, 90%) 50%, hsl(${h || 40}, ${sat}%, 86%) 100%)`,
      solidBg: `hsl(${h || 40}, ${sat}%, 90%)`,
      isLight: true,
      text: '#1f2429',
      authorColor: '#5c6470'
    };
  }

  // 2. Modern Matte Paperback (표지 고유의 세련되고 차분한 매트 페이퍼백 컬러 - 그림자 최소화)
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = Math.max(25, Math.min(s, 62));
  const lBase = Math.max(28, Math.min(Math.round(26 + (l / 100) * 20), 48));
  const lTop = Math.min(lBase + 3, 51);
  const lBottom = Math.max(lBase - 3, 25);

  return {
    bg: `linear-gradient(180deg, hsl(${h}, ${sat}%, ${lTop}%) 0%, hsl(${h}, ${sat}%, ${lBase}%) 50%, hsl(${h}, ${sat}%, ${lBottom}%) 100%)`,
    solidBg: `hsl(${h}, ${sat}%, ${lBase}%)`,
    isLight: false,
    text: '#ffffff',
    authorColor: 'rgba(255, 255, 255, 0.82)'
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
        const theme = generatePaperbackThemeFromRgb(r, g, b);
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
      // 1. Nordic Sage / Eucalyptus (차분한 북유럽 세이지)
      bg: 'linear-gradient(180deg, #445f54 0%, #3a5148 50%, #31453d 100%)',
      solidBg: '#3a5148',
      text: '#f7faf8',
      authorColor: '#b8ccc2',
      isLight: false
    },
    {
      // 2. Warm Terracotta Clay (따뜻한 테라코타 클레이)
      bg: 'linear-gradient(180deg, #9b533d 0%, #884733 50%, #763c2b 100%)',
      solidBg: '#884733',
      text: '#fffaf8',
      authorColor: '#e8c0b2',
      isLight: false
    },
    {
      // 3. Deep Slate Marine (단정한 슬레이트 마린)
      bg: 'linear-gradient(180deg, #2c3f57 0%, #243448 50%, #1e2b3c 100%)',
      solidBg: '#243448',
      text: '#f6f9fd',
      authorColor: '#abc0d6',
      isLight: false
    },
    {
      // 4. Sandstone Cream Paper (미니멀 크림 페이퍼백)
      bg: 'linear-gradient(180deg, #f3ede4 0%, #ebe2d5 50%, #e2d7c8 100%)',
      solidBg: '#ebe2d5',
      text: '#22252a',
      authorColor: '#686c73',
      isLight: true
    },
    {
      // 5. Honey Amber / Ochre (따스한 허니 앰버)
      bg: 'linear-gradient(180deg, #a7702c 0%, #946224 50%, #82541d 100%)',
      solidBg: '#946224',
      text: '#fffefb',
      authorColor: '#f1d6b0',
      isLight: false
    },
    {
      // 6. Charcoal Slate (모던 차콜 슬레이트)
      bg: 'linear-gradient(180deg, #33363e 0%, #2a2c33 50%, #222429 100%)',
      solidBg: '#2a2c33',
      text: '#f8f9fa',
      authorColor: '#abb0bc',
      isLight: false
    },
    {
      // 7. Dusty Rosewood (감각적인 더스티 로즈우드)
      bg: 'linear-gradient(180deg, #704759 0%, #603c4c 50%, #523241 100%)',
      solidBg: '#603c4c',
      text: '#fdf7fa',
      authorColor: '#d8b6c5',
      isLight: false
    },
    {
      // 8. Klein Cobalt (선명한 클라인 코발트)
      bg: 'linear-gradient(180deg, #27528d 0%, #1f4477 50%, #183761 100%)',
      solidBg: '#1f4477',
      text: '#f8fbff',
      authorColor: '#b7d4fa',
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
  savedGalleryScrollTop = 0;
  markGalleryDirty();
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
  isGalleryDirty = false;

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
          if (img.complete) {
            if (img.naturalWidth > 0) {
              adjustSpineCardWidth(img);
            } else {
              handleRealSpineError(img);
            }
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
          if (img.complete) {
            if (img.naturalWidth > 0) {
              adjustSpineCardWidth(img);
            } else {
              handleRealSpineError(img);
            }
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
        if (img.complete) {
          if (img.naturalWidth > 0) {
            adjustSpineCardWidth(img);
          } else {
            handleRealSpineError(img);
          }
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
    imgPart = `<img src="${esc(getSafeImageUrl(book.cover))}" alt="${esc(book.title)}" data-title="${esc(book.title)}" loading="lazy" decoding="async" onerror="handleCoverError(this)">`;
  } else {
    imgPart = `<div class="book-card-placeholder">
      <span class="placeholder-title">${esc(book.title)}</span>
    </div>`;
  }

  const sentence = book.sentence
    ? `<div class="ov-sentence">${esc(book.sentence)}</div>` : '';
  const kingStarBadge = book.rating === 5
    ? `<div class="king-star-badge wax-seal-badge">
        <div class="wax-seal-core">
          <span class="wax-seal-num">5</span><span class="wax-seal-star">★</span>
        </div>
      </div>` : '';
  const spineWaxSeal = book.rating === 5
    ? `<div class="spine-wax-seal">
        <div class="wax-seal-core">
          <span class="wax-seal-num">5</span><span class="wax-seal-star">★</span>
        </div>
      </div>` : '';

  const isGuideCard = isGuideBook(book);
  if (book.rating === 5) {
    card.classList.add('five-stars');
  }

  if (isSpineMode) {
    const spineImgUrl = isGuideCard ? '' : (book.spineCover || book.spine || getSpineImageUrl(book.cover));
    const cachedSpine = (spineImgUrl && !spineImgUrl.startsWith('data:')) ? spineImgStatusCache[spineImgUrl] : null;

    let spineW = isGuideCard ? 240 : getSpineWidth(book.pages);
    if (cachedSpine && cachedSpine.status === 'ok' && cachedSpine.width) {
      spineW = cachedSpine.width;
    }
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

    const shouldRenderRealSpine = Boolean(spineImgUrl && (!cachedSpine || cachedSpine.status !== 'fail'));
    const isKnownOk = Boolean(cachedSpine && cachedSpine.status === 'ok');
    const isResolvingRealSpine = Boolean(shouldRenderRealSpine && !isKnownOk);

    const realSpineTag = shouldRenderRealSpine
      ? `<img class="spine-real-img${isKnownOk ? ' is-ready' : ''}" src="${esc(spineImgUrl)}" alt="" loading="eager" decoding="async" onload="this.classList.add('is-ready'); adjustSpineCardWidth(this)" onerror="handleRealSpineError(this)">`
      : '';

    // If a real spine is expected, render an empty slot until the image is ready.
    // Only books with no usable real spine should show the generated fallback.
    const showFallbackClass = shouldRenderRealSpine ? '' : ' show-fallback';

    card.innerHTML = `
      <div class="spine-3d-wrapper">
        <div class="spine-face">
          ${realSpineTag}
          <div class="spine-custom-view${showFallbackClass}${theme.isLight ? ' spine-light-paper' : ''}" style="background: ${theme.bg};">
            <div class="spine-paperback-crease"></div>

            <div class="spine-paperback-header">
              <span class="spine-paperback-badge">8ook.</span>
            </div>

            <div class="spine-title-wrap">
              <span class="spine-title-modern" style="${titleStyleExtra}">${esc(book.title)}</span>
            </div>

            <div class="spine-author-wrap">
              <span class="spine-author-modern">${esc(book.author || '8ook 클럽')}</span>
            </div>

            <div class="spine-paperback-footer">
              <div class="spine-barcode-mark">
                <i></i><i></i><i></i><i></i><i></i>
              </div>
            </div>
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
            ${coverMetaHtml(book)}
            ${isGuideCard ? '<div class="ov-tap-guide" style="opacity:1;">클릭하여 이용 가이드 읽기 ➔</div>' : ''}
          </div>
        </div>
      </div>
    `;

    // 앞표지 기반 모던 페이퍼백 테마 비동기 추출 및 동적 반영
    if (!getSpineCoverTheme(book) && book.cover) {
      extractCoverTheme(book, (newTheme) => {
        const customView = card.querySelector('.spine-custom-view');
        if (customView) {
          customView.style.background = newTheme.bg;
          if (newTheme.isLight) {
            customView.classList.add('spine-light-paper');
          } else {
            customView.classList.remove('spine-light-paper');
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
        ${coverMetaHtml(book)}
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
  if (!book || !book.scraps || !Array.isArray(book.scraps)) return false;
  const initialLen = book.scraps.length;

  book.scraps = book.scraps.map((s, idx) => {
    if (typeof s === 'string') {
      const trimmed = s.trim();
      if (!trimmed) return null;
      return {
        id: 'sc_' + (book.id || 'b') + '_' + idx + '_' + Math.random().toString(36).slice(2, 7),
        text: trimmed,
        page: null,
        memo: '',
        tags: []
      };
    }
    if (typeof s === 'object' && s !== null) {
      const textVal = typeof s.text === 'string' ? s.text.trim() : (typeof s.quote === 'string' ? s.quote.trim() : '');
      if (!textVal) return null;
      return {
        id: s.id || ('sc_' + (book.id || 'b') + '_' + idx + '_' + Math.random().toString(36).slice(2, 7)),
        text: textVal,
        page: (s.page !== undefined && s.page !== null && s.page !== '') ? Number(s.page) || s.page : null,
        memo: typeof s.memo === 'string' ? s.memo : '',
        tags: Array.isArray(s.tags) ? s.tags : (Array.isArray(s.keywords) ? s.keywords : [])
      };
    }
    return null;
  }).filter(Boolean);

  return book.scraps.length !== initialLen;
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


function setPrev(src) {
  if (!src) { resetPrev(); return; }
  const el = document.getElementById('book-prev');
  if (!el) return;
  const img = document.createElement('img');
  img.style.cssText = "width:100%; height:100%; object-fit:cover; display:block;";
  img.onerror = () => handlePrevError(img);
  img.src = getSafeImageUrl(src);
  el.replaceChildren(img);
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
  const img = document.createElement('img');
  img.style.cssText = "width:100%; height:100%; object-fit:fill; display:block;";
  img.onerror = () => handleSpinePrevError(img);
  img.src = getSafeImageUrl(src);
  el.replaceChildren(img);
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

async function getBookWriteContext() {
  const client = supabaseClient;
  try {
    if (!client || typeof client.from !== 'function' ||
        typeof client.auth?.getSession !== 'function') {
      throw new Error('Supabase client is unavailable');
    }
    const { data, error } = await client.auth.getSession();
    if (error || !data) throw error || new Error('Auth session could not be checked');
    const user = data.session?.user;
    if (!user?.id) {
      toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
      return null;
    }
    return { client, user };
  } catch (err) {
    console.error('Book write connection check failed:', err);
    toast('서버 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    return null;
  }
}

async function saveBook() {
  const rawTitle = document.getElementById('bk-title').value.trim();
  if (!rawTitle) { toast('도서 제목을 입력해주세요'); return; }
  const subInputEl = document.getElementById('bk-subtitle');
  const rawSubtitle = subInputEl ? subInputEl.value.trim() : '';
  const title = rawSubtitle ? `${rawTitle} - ${rawSubtitle}` : rawTitle;

  const context = await getBookWriteContext();
  if (!context) return;
  const { client, user } = context;

  const pubInputEl = document.getElementById('bk-is-public');
  const is_public = pubInputEl ? pubInputEl.checked : true;

  const data = {
    title,
    author: document.getElementById('bk-author').value.trim(),
    pages: parseInt(document.getElementById('bk-pages').value) || 0,
    date: document.getElementById('bk-date').value,
    sentence: typeof sanitizeUnmatchedSmartQuotes === 'function'
      ? sanitizeUnmatchedSmartQuotes(document.getElementById('bk-sentence').value.trim())
      : document.getElementById('bk-sentence').value.trim(),
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
      if (idx === -1) throw new Error('수정할 도서를 찾을 수 없습니다.');
      const updatedBook = { ...books[idx], ...data, user_id: user.id };
      const payload = sanitizeBookForSupabase(updatedBook);
      let { error } = await client
        .from('books')
        .update(payload)
        .eq('id', editingBookId)
        .eq('user_id', user.id)
        .select('id').single();

      if (error && handleSupabaseSchemaError(error)) {
        const safeBook = sanitizeBookForSupabase(updatedBook);
        const res = await client
          .from('books')
          .update(safeBook)
          .eq('id', editingBookId)
          .eq('user_id', user.id)
          .select('id').single();
        error = res.error;
      }
      if (error) throw error;
      books[idx] = updatedBook;
      toast('도서 정보가 수정되었습니다');
    } else {
      data.id = uid();
      data.scraps = [];
      data.created_at = new Date().toISOString();
      data.user_id = user.id;
      const payload = sanitizeBookForSupabase(data);
      let { error } = await client
        .from('books')
        .insert([payload]).select('id').single();

      if (error && handleSupabaseSchemaError(error)) {
        const safeData = sanitizeBookForSupabase(data);
        const res = await client
          .from('books')
          .insert([safeData]).select('id').single();
        error = res.error;
      }
      if (error) throw error;
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
  const context = await getBookWriteContext();
  if (!context) return;
  const { client, user } = context;

  if (!confirm('이 책을 삭제할까요?')) return;
  try {
    const { error } = await client
      .from('books')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id').single();
    if (error) throw error;

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

/* ==============================================
   BLOG COVER GENERATOR (2번 커스텀 블로그 포맷)
   - 1:1 정사각형 캔버스 (800x800)
   - 배경: 원본 표지 cover 채움 + 흑백(Grayscale) 및 어둡게 처리 + 비네팅
   - 중앙: 원본 비율 유지 도서 표지 + 깊은 그림자(Drop Shadow) + 깔끔한 테두리
============================================== */


/* ==============================================
   SIDEBAR / STATS
============================================== */

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
   SMART PUNCTUATION: AUTO-ELLIPSIS (...) -> (…)
============================================== */
let isReplacingEllipsis = false;

function handleEllipsisAutoConvert(e) {
  if (isReplacingEllipsis) return;
  if (e.isComposing) return;

  const target = e.target;
  if (!target || !target.tagName) return;
  const tag = target.tagName.toLowerCase();
  if (tag !== 'textarea' && tag !== 'input') return;
  if (target.readOnly || target.disabled) return;
  if (target.type === 'number' || target.type === 'password' || target.type === 'file' || target.type === 'date') return;
  if (target.id === 'db-sql-code') return;

  const pos = target.selectionStart;
  if (typeof pos !== 'number' || pos < 3) return;

  const val = target.value;
  const last3 = val.slice(pos - 3, pos);
  if (last3 === '...' || last3 === '。。。') {
    isReplacingEllipsis = true;
    try {
      const start = pos - 3;
      const end = pos;
      let replaced = false;

      if (document.execCommand) {
        target.setSelectionRange(start, end);
        replaced = document.execCommand('insertText', false, '…');
      }

      if (!replaced) {
        const before = val.slice(0, start);
        const after = val.slice(end);
        target.value = before + '…' + after;
        const newPos = start + 1;
        target.setSelectionRange(newPos, newPos);
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (err) {
      console.warn('Ellipsis replace error:', err);
    } finally {
      isReplacingEllipsis = false;
    }
  }
}

function handleSentencePaste(e) {
  const target = e.target;
  if (!target || !target.tagName) return;
  const tag = target.tagName.toLowerCase();
  if (tag !== 'textarea' && tag !== 'input') return;
  if (target.readOnly || target.disabled || target.id === 'db-sql-code') return;

  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;
  const pastedText = clipboardData.getData('text');
  if (!pastedText || (!pastedText.includes('...') && !pastedText.includes('。。。'))) return;

  const isSentenceField = target.id === 'sc-text' || target.id === 'sc-memo' || target.id === 'bk-sentence' || tag === 'textarea';
  if (!isSentenceField) return;

  e.preventDefault();
  const converted = pastedText.replace(/\.{3}/g, '…').replace(/。{3}/g, '…');
  let pasted = false;

  if (document.execCommand) {
    pasted = document.execCommand('insertText', false, converted);
  }

  if (!pasted) {
    const start = target.selectionStart || 0;
    const end = target.selectionEnd || 0;
    const val = target.value;
    target.value = val.slice(0, start) + converted + val.slice(end);
    const newPos = start + converted.length;
    target.setSelectionRange(newPos, newPos);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

document.addEventListener('input', handleEllipsisAutoConvert, true);
document.addEventListener('paste', handleSentencePaste, true);


/* ==============================================
   OFFICIAL 8OOK USER GUIDE (펼쳐진 가이드북 & 상세 설명)
============================================== */


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

/* ==============================================
   BOOKCLUB NICKNAME SYSTEM
   - Default: Random 6-char (lowercase english + numbers)
   - Max 3 changes allowed
   - Instagram style: a-z, 0-9, _, . (3~20 chars)
============================================== */
const MAX_NICKNAME_CHANGES = 3;

function generateDefaultNickname() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 6; i++) {
      res += chars[bytes[i] % chars.length];
    }
  } else {
    for (let i = 0; i < 6; i++) {
      res += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return res;
}

// 구글 계정 고유의 결정적 6자리 기본 닉네임 생성
function getDefaultNicknameForUser(user) {
  if (!user) return generateDefaultNickname();
  if (isOhaUser(user)) return hashStringToNickname('user_owner_oha');
  // Neo 사용자 또는 사용자가 설정했던 닉네임 di31om 유지
  if (user.id === '1df9f1ae-d5bf-4076-bd1d-b3f32916b216') return 'di31om';
  return hashStringToNickname('user_' + user.id);
}

function getUserNickname() {
  // 1. 구글 계정으로 로그인한 상태인 경우:
  if (currentUser && currentUser.id) {
    // 1-1. Supabase 클라우드 auth user_metadata에 저장된 변경 닉네임 최우선 적용
    if (currentUser.user_metadata && currentUser.user_metadata.nickname) {
      let cloudNick = String(currentUser.user_metadata.nickname).trim().toLowerCase();
      if (cloudNick === 'curator_neo') cloudNick = 'di31om';
      if (cloudNick) {
        try { localStorage.setItem(`rj_user_nickname_${currentUser.id}`, cloudNick); } catch (e) {}
        return cloudNick;
      }
    }

    // 1-2. 현재 로그인 계정 전용 로컬 저장소 확인
    try {
      let accountNick = localStorage.getItem(`rj_user_nickname_${currentUser.id}`);
      if (accountNick && accountNick.trim()) {
        accountNick = accountNick.trim().toLowerCase();
        if (accountNick === 'curator_neo') accountNick = 'di31om';
        return accountNick;
      }
    } catch (e) {}

    // 1-3. 기존 기기에서 설정했던 레거시 닉네임 중 유저가 직접 수정한 닉네임(di31om 등) 마이그레이션
    try {
      const legacyNick = localStorage.getItem('rj_user_nickname');
      if (legacyNick && legacyNick.trim()) {
        let clean = legacyNick.trim().toLowerCase();
        if (clean === 'curator_neo') clean = 'di31om';
        if (clean === 'di31om' || (getNicknameChangeCount() > 0 && !clean.match(/^[a-z0-9]{6}$/))) {
          localStorage.setItem(`rj_user_nickname_${currentUser.id}`, clean);
          return clean;
        }
      }
    } catch (e) {}

    // 1-4. 최초 랜덤 부여: 구글 계정당 오직 하나로 통일된 결정적 6자리 닉네임 부여
    const defaultNick = getDefaultNicknameForUser(currentUser);
    try {
      localStorage.setItem(`rj_user_nickname_${currentUser.id}`, defaultNick);
    } catch (e) {}
    return defaultNick;
  }

  // 2. 비로그인(게스트) 상태인 경우:
  let guestNick = '';
  try {
    guestNick = localStorage.getItem('rj_guest_nickname') || localStorage.getItem('rj_user_nickname') || '';
  } catch (e) {}

  if (!guestNick) {
    guestNick = generateDefaultNickname();
    try {
      localStorage.setItem('rj_guest_nickname', guestNick);
    } catch (e) {}
  }
  return guestNick.toLowerCase();
}

function getNicknameChangeCount() {
  if (currentUser && currentUser.id) {
    if (currentUser.user_metadata && currentUser.user_metadata.nickname_change_count !== undefined) {
      const parsed = parseInt(currentUser.user_metadata.nickname_change_count, 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    try {
      const raw = localStorage.getItem(`rj_nickname_change_count_${currentUser.id}`);
      if (raw !== null) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
      }
    } catch (e) {}
  }
  try {
    const raw = localStorage.getItem('rj_nickname_change_count');
    if (raw !== null) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
  } catch (e) {}
  return 0;
}

function setNicknameChangeCount(cnt) {
  try {
    if (currentUser && currentUser.id) {
      localStorage.setItem(`rj_nickname_change_count_${currentUser.id}`, String(cnt));
    }
    localStorage.setItem('rj_nickname_change_count', String(cnt));
  } catch (e) {}
}

function getNicknameChangesLeft() {
  const cnt = getNicknameChangeCount();
  return Math.max(0, MAX_NICKNAME_CHANGES - cnt);
}

function validateNickname(nick) {
  if (!nick) return { valid: false, message: '닉네임을 입력해주세요.' };
  const clean = String(nick).trim().toLowerCase();
  if (clean.length < 3) return { valid: false, message: '닉네임은 최소 3자 이상이어야 합니다.' };
  if (clean.length > 20) return { valid: false, message: '닉네임은 최대 20자까지 가능합니다.' };
  
  if (!/^[a-z0-9._]+$/.test(clean)) {
    return { valid: false, message: '영문 소문자, 숫자, 밑줄(_), 마침표(.)만 사용할 수 있습니다.' };
  }
  if (!/[a-z0-9]/.test(clean)) {
    return { valid: false, message: '영문자 또는 숫자가 1자 이상 포함되어야 합니다.' };
  }
  if (clean.startsWith('.') || clean.endsWith('.')) {
    return { valid: false, message: '마침표(.)로 시작하거나 끝날 수 없습니다.' };
  }
  if (clean.includes('..')) {
    return { valid: false, message: '마침표(..)는 연속해서 사용할 수 없습니다.' };
  }
  return { valid: true, clean };
}

function syncNicknameUI() {
  const currentNick = getUserNickname();
  const left = getNicknameChangesLeft();

  // 0. 최상단 헤더 칩 (@독서가 닉네임)
  const shortUsernameSpan = document.getElementById('auth-username-short');
  if (shortUsernameSpan) {
    shortUsernameSpan.innerHTML = `<span class="header-user-at" style="color:var(--violet); font-weight:600; margin-right:1px;">@</span>${esc(currentNick)}`;
  }

  // 1. 북클럽 헤더 칩
  const commNickDisplay = document.getElementById('comm-my-nickname-display');
  if (commNickDisplay) commNickDisplay.textContent = currentNick;

  const commChangeBtn = document.getElementById('comm-profile-change-btn');
  if (commChangeBtn) {
    commChangeBtn.textContent = left > 0 ? `변경 (${left}회)` : '변경 완료';
    commChangeBtn.classList.toggle('disabled', left <= 0);
  }

  // 2. 사이드 메뉴(Drawer)
  const menuNickDisplay = document.getElementById('menu-nickname-display');
  if (menuNickDisplay) menuNickDisplay.textContent = currentNick;

  const menuBadge = document.getElementById('menu-nickname-change-badge');
  if (menuBadge) {
    menuBadge.textContent = left > 0 ? `변경 (${left}회)` : '완료 (0회)';
    menuBadge.classList.toggle('disabled', left <= 0);
  }
  const menuChangeBtn = document.getElementById('menu-nickname-change-btn');
  if (menuChangeBtn) {
    menuChangeBtn.classList.toggle('disabled', left <= 0);
  }

  // 3. 모달 내부
  const modalCurrVal = document.getElementById('nick-modal-curr-val');
  if (modalCurrVal) modalCurrVal.textContent = currentNick;

  const modalCountTag = document.getElementById('nick-modal-change-count');
  if (modalCountTag) {
    modalCountTag.textContent = left > 0 ? `남은 변경 횟수: ${left}회` : '변경 횟수 소진 (0/3)';
    modalCountTag.classList.toggle('depleted', left <= 0);
  }

  const saveBtn = document.getElementById('nick-modal-save-btn');
  const inputEl = document.getElementById('nick-modal-input');
  if (saveBtn) saveBtn.disabled = (left <= 0);
  if (inputEl) {
    if (left <= 0) {
      inputEl.disabled = true;
      inputEl.placeholder = '더 이상 변경할 수 없습니다 (3/3회 소진)';
    } else {
      inputEl.disabled = false;
      inputEl.placeholder = '새 닉네임 입력 (3~20자)';
    }
  }
}

function openNicknameModal(event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  syncNicknameUI();
  const inputEl = document.getElementById('nick-modal-input');
  const hintEl = document.getElementById('nick-modal-hint');
  if (inputEl) {
    inputEl.value = '';
  }
  if (hintEl) {
    hintEl.textContent = '인스타그램처럼 영문 소문자, 숫자, 밑줄(_), 마침표(.)를 사용할 수 있습니다.';
    hintEl.className = 'nickname-hint-msg';
  }
  openModal('nickname-modal');
  setTimeout(() => {
    if (inputEl && !inputEl.disabled) inputEl.focus();
  }, 100);
}

function handleNicknameInputChange(el) {
  if (!el) return;
  // 소문자 및 허용 문자 변환
  el.value = el.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
  const val = el.value;
  const hintEl = document.getElementById('nick-modal-hint');
  const saveBtn = document.getElementById('nick-modal-save-btn');
  if (!hintEl) return;

  if (!val) {
    hintEl.textContent = '인스타그램처럼 영문 소문자, 숫자, 밑줄(_), 마침표(.)를 사용할 수 있습니다.';
    hintEl.className = 'nickname-hint-msg';
    if (saveBtn && getNicknameChangesLeft() > 0) saveBtn.disabled = false;
    return;
  }

  const check = validateNickname(val);
  if (!check.valid) {
    hintEl.textContent = check.message;
    hintEl.className = 'nickname-hint-msg error';
  } else {
    const current = getUserNickname();
    if (check.clean === current) {
      hintEl.textContent = '현재 사용 중인 닉네임과 동일합니다.';
      hintEl.className = 'nickname-hint-msg warn';
    } else {
      hintEl.textContent = `사용 가능한 멋진 닉네임입니다! (@${check.clean})`;
      hintEl.className = 'nickname-hint-msg success';
    }
  }
}

async function submitNicknameChange() {
  const left = getNicknameChangesLeft();
  if (left <= 0) {
    toast('닉네임 변경 가능 횟수(최대 3회)를 모두 소진했습니다.');
    return;
  }

  const inputEl = document.getElementById('nick-modal-input');
  if (!inputEl) return;
  const raw = inputEl.value;
  const check = validateNickname(raw);
  if (!check.valid) {
    toast(check.message);
    return;
  }

  const newNick = check.clean;
  const currentNick = getUserNickname();
  if (newNick === currentNick) {
    toast('현재 닉네임과 동일합니다.');
    return;
  }

  const newCount = getNicknameChangeCount() + 1;
  setNicknameChangeCount(newCount);
  try {
    if (currentUser && currentUser.id) {
      localStorage.setItem(`rj_user_nickname_${currentUser.id}`, newNick);
    }
    localStorage.setItem('rj_user_nickname', newNick);
  } catch (e) {}

  if (supabaseClient && currentUser) {
    try {
      const { data, error } = await supabaseClient.auth.updateUser({
        data: {
          nickname: newNick,
          nickname_change_count: newCount
        }
      });
      if (!error && data && data.user) {
        currentUser = data.user;
      } else if (currentUser.user_metadata) {
        currentUser.user_metadata.nickname = newNick;
        currentUser.user_metadata.nickname_change_count = newCount;
      }
    } catch (e) {
      console.warn('Failed to sync nickname to Supabase user_metadata:', e);
    }
  }

  syncNicknameUI();
  closeModal('nickname-modal');
  toast(`북클럽 닉네임이 @${newNick} (으)로 변경되었습니다! (남은 변경: ${Math.max(0, MAX_NICKNAME_CHANGES - newCount)}회)`);

  // 북클럽 피드 즉시 다시 렌더링하여 닉네임 갱신
  if (typeof renderCommunityBooks === 'function') renderCommunityBooks();
  if (typeof renderCommunityScraps === 'function') renderCommunityScraps();
}

/* ==============================================
   USER PROFILE & 3 REPRESENTATIVE BOOKS (프로필 & 나를 나타내는 책 3권)
============================================== */
let currentProfileTarget = null; // { nickname, userId, isMe }
let currentEditingRepSlot = null; // 0, 1, 2
const communityRepBooksMap = new Map(); // nickname -> [book1, book2, book3]

function getUserRepBooksStorageKey(nickname, userId) {
  const normNick = String(nickname || '').trim().replace(/^@/, '');
  return '8ook_rep_books_' + (userId || normNick);
}

function hasBookReviewText(book) {
  if (!book) return false;
  return Boolean(String(book.sentence || book.review || book.oneLineReview || '').trim());
}

function getBookSentenceCount(book) {
  if (!book) return 0;
  const scrapsCount = Array.isArray(book.scraps) ? book.scraps.length : 0;
  return scrapsCount + (hasBookReviewText(book) ? 1 : 0);
}

function getValidRepBooks(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(b => b && b.title).slice(0, 3);
}

function getUserRepBooks(nickname, userId) {
  const normNick = String(nickname || '').trim().replace(/^@/, '');
  const isMe = (currentUser && userId === currentUser.id) || normNick === getUserNickname();

  // 1. Try local storage
  try {
    const key = getUserRepBooksStorageKey(normNick, userId);
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const validRepBooks = getValidRepBooks(parsed);
      if (validRepBooks.length > 0) {
        return validRepBooks;
      }
    }
  } catch (e) {}

  // 2. Try in-memory community map
  if (communityRepBooksMap.has(normNick)) {
    const validRepBooks = getValidRepBooks(communityRepBooksMap.get(normNick));
    if (validRepBooks.length > 0) return validRepBooks;
  }
  if (userId && communityRepBooksMap.has(userId)) {
    const validRepBooks = getValidRepBooks(communityRepBooksMap.get(userId));
    if (validRepBooks.length > 0) return validRepBooks;
  }

  // 3. Fallback: generate default 3 books from the user's library
  let candidateBooks = [];
  if (isMe) {
    candidateBooks = (Array.isArray(books) ? books : []).filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));
  } else {
    const all = getAllCommunityBooks();
    candidateBooks = all.filter(b => {
      const bNick = b.nickname || (b._ownerId && resolveCommunityBookOwner(b, b._source));
      return bNick === normNick || b.user_id === userId;
    });
  }

  // Prioritize books with cover image and high rating
  const sorted = [...candidateBooks].sort((a, b) => {
    const aHasCover = (a.cover && !a.cover.includes('data:image/svg')) ? 1 : 0;
    const bHasCover = (b.cover && !b.cover.includes('data:image/svg')) ? 1 : 0;
    if (bHasCover !== aHasCover) return bHasCover - aHasCover;
    const aHasReview = hasBookReviewText(a) ? 1 : 0;
    const bHasReview = hasBookReviewText(b) ? 1 : 0;
    if (bHasReview !== aHasReview) return bHasReview - aHasReview;
    return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
  });

  const repList = sorted.slice(0, 3).map(b => ({
    id: b.id,
    title: b.title,
    cover: b.cover || '',
    author: b.author || ''
  }));

  // Cache for future lookups
  communityRepBooksMap.set(normNick, repList);
  if (userId) communityRepBooksMap.set(userId, repList);
  if (isMe && repList.length > 0) {
    try {
      localStorage.setItem(getUserRepBooksStorageKey(normNick, userId), JSON.stringify(repList));
    } catch (e) {}
  }

  return repList;
}

function openUserProfileCard(rawNickname, rawUserId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const cleanNick = String(rawNickname || '').trim().replace(/^@/, '');
  if (!cleanNick) return;

  const myNick = getUserNickname();
  const isMe = cleanNick === myNick || (currentUser && rawUserId === currentUser.id);
  const userId = isMe && currentUser ? currentUser.id : rawUserId;

  currentProfileTarget = { nickname: cleanNick, userId, isMe };

  // Set modal texts
  const nickEl = document.getElementById('prof-card-nick');
  if (nickEl) nickEl.textContent = '@' + cleanNick;

  const myBadgeEl = document.getElementById('prof-card-my-badge');
  if (myBadgeEl) myBadgeEl.style.display = isMe ? 'inline-block' : 'none';

  const subtitleEl = document.getElementById('prof-card-subtitle');
  if (subtitleEl) subtitleEl.textContent = isMe ? '나의 독서 프로필' : '8ook 북클럽 독서가';

  const titleEl = document.getElementById('prof-card-modal-title');
  if (titleEl) titleEl.textContent = isMe ? '나의 독서 프로필' : `${cleanNick}님의 프로필`;

  const editHintEl = document.getElementById('prof-rep-edit-hint');
  if (editHintEl) editHintEl.style.display = isMe ? 'inline-block' : 'none';

  const editBtn = document.getElementById('prof-card-edit-btn');
  if (editBtn) editBtn.style.display = isMe ? 'inline-block' : 'none';

  // Calculate statistics
  let userBooks = [];
  let userScrapsCount = 0;
  if (isMe) {
    userBooks = (Array.isArray(books) ? books : []).filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));
    userBooks.forEach(b => {
      userScrapsCount += getBookSentenceCount(b);
    });
  } else {
    const all = getAllCommunityBooks();
    userBooks = all.filter(b => {
      const bNick = b.nickname || (b._ownerId && resolveCommunityBookOwner(b, b._source));
      return bNick === cleanNick || b.user_id === userId;
    });
    userBooks.forEach(b => {
      userScrapsCount += getBookSentenceCount(b);
    });
  }

  const booksCountEl = document.getElementById('prof-stat-books-count');
  if (booksCountEl) booksCountEl.textContent = String(userBooks.length) + '권';

  const scrapsCountEl = document.getElementById('prof-stat-scraps-count');
  if (scrapsCountEl) scrapsCountEl.textContent = String(userScrapsCount) + '개';

  // Render 3 Representative Books
  renderProfileRepBooksGrid();

  // Close picker if open
  closeProfileBookPicker();

  openModal('user-profile-modal');
}

// Community values are data, never JavaScript source. Do not decode HTML entities here.
function communityEventAttrs(action, args, eventName = 'onclick') {
  const encoded = JSON.stringify(args.map(value => value == null ? '' : String(value))).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  const eventType = eventName === 'onkeydown' ? 'keydown' : 'click';
  return `data-community-${eventType}="${action}" data-community-args="${encoded}"`;
}

function handleCommunityDelegatedEvent(event) {
  const element = event.target.closest?.(`[data-community-${event.type}]`);
  if (!element) return;
  const actions = {
    showDetail: args => showDetail(...args),
    handleProfileBookClick: args => handleProfileBookClick(...args),
    openUserProfileCard: args => openUserProfileCard(...args, event),
    toggleBookCommentsSection: args => toggleBookCommentsSection(...args, event),
    toggleCommunityBookLike: args => toggleCommunityBookLike(...args, element, event),
    handleCommentKeyDown: args => handleCommentKeyDown(event, ...args),
    submitBookComment: args => submitBookComment(...args),
    toggleReplyInput: args => toggleReplyInput(...args),
    deleteBookComment: args => deleteBookComment(...args, event),
    handleReplyKeyDown: args => handleReplyKeyDown(event, ...args),
    submitBookReply: args => submitBookReply(...args),
    copyCommunityQuote: args => copyCommunityQuote(...args),
    toggleCommunityLike: args => toggleCommunityLike(...args, element, event),
  };
  const action = element.getAttribute(`data-community-${event.type}`);
  if (!Object.prototype.hasOwnProperty.call(actions, action)) return;
  actions[action](JSON.parse(element.getAttribute('data-community-args')));
}

document.addEventListener('click', handleCommunityDelegatedEvent);
document.addEventListener('keydown', handleCommunityDelegatedEvent);

function renderProfileRepBooksGrid() {
  const container = document.getElementById('prof-rep-books-grid');
  if (!container || !currentProfileTarget) return;

  const { nickname, userId, isMe } = currentProfileTarget;
  const repList = getUserRepBooks(nickname, userId);

  let html = '';
  for (let i = 0; i < 3; i++) {
    const b = repList[i];
    if (b && b.title) {
      const coverUrl = b.cover || '';
      const hasCover = coverUrl && !coverUrl.includes('data:image/svg');
      const clickAction = isMe ? `onclick="openProfileBookPicker(${i})"` : `${communityEventAttrs('handleProfileBookClick', [b.id], 'onclick')}` ;
      const cursorTitle = isMe ? '클릭하여 책 변경' : `${esc(b.title)} 상세보기`;

      html += `
        <div class="profile-rep-slot" ${clickAction} title="${cursorTitle}">
          <span class="profile-rep-slot-badge">${i + 1}</span>
          <div class="profile-rep-cover-wrap">
            ${hasCover
              ? `<img src="${esc(coverUrl)}" class="profile-rep-cover-img" alt="${esc(b.title)}" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'80\\' height=\\'120\\' viewBox=\\'0 0 80 120\\'><rect width=\\'80\\' height=\\'120\\' fill=\\'%23e8ded5\\'/><text x=\\'50%\\' y=\\'50%\\' dominant-baseline=\\'middle\\' text-anchor=\\'middle\\' fill=\\'%238c6239\\' font-size=\\'11\\' font-weight=\\'bold\\'>8ook</text></svg>';">`
              : `<div class="profile-rep-slot-empty"><span class="profile-rep-slot-empty-icon">📖</span><span class="profile-rep-slot-empty-text">8ook</span></div>`
            }
            ${isMe ? `<div class="profile-rep-slot-edit-overlay"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> 변경</div>` : ''}
          </div>
          <div class="profile-rep-slot-title" title="${esc(b.title)}">${esc(b.title)}</div>
        </div>
      `;
    } else {
      // Empty slot
      const clickAction = isMe ? `onclick="openProfileBookPicker(${i})"` : '';
      const cursorTitle = isMe ? '클릭하여 대표 책 추가' : '등록된 책 없음';
      html += `
        <div class="profile-rep-slot" ${clickAction} title="${cursorTitle}">
          <span class="profile-rep-slot-badge">${i + 1}</span>
          <div class="profile-rep-cover-wrap profile-rep-slot-empty">
            <span class="profile-rep-slot-empty-icon">${isMe ? '+' : '📖'}</span>
            <span class="profile-rep-slot-empty-text">${isMe ? '책 선택' : '미등록'}</span>
          </div>
          <div class="profile-rep-slot-title" style="color:var(--text-400); font-weight:normal;">${isMe ? '대표 책 등록' : '-'}</div>
        </div>
      `;
    }
  }
  container.innerHTML = html;
}

function handleProfileBookClick(bookId) {
  if (!bookId) return;
  closeModal('user-profile-modal');
  if (typeof showDetail === 'function') {
    showDetail(bookId);
  }
}

function startEditProfileRepBooks() {
  openProfileBookPicker(0);
}

function openProfileBookPicker(slotIndex) {
  if (!currentProfileTarget || !currentProfileTarget.isMe) return;
  currentEditingRepSlot = slotIndex;

  const wrap = document.getElementById('prof-book-picker-wrap');
  if (!wrap) return;
  wrap.style.display = 'block';

  const titleEl = document.getElementById('prof-picker-slot-title');
  if (titleEl) titleEl.textContent = `${slotIndex + 1}번 대표 책 선택`;

  const searchInput = document.getElementById('prof-picker-search-input');
  if (searchInput) {
    searchInput.value = '';
    searchInput.focus();
  }

  filterProfileBookPicker();
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeProfileBookPicker() {
  currentEditingRepSlot = null;
  const wrap = document.getElementById('prof-book-picker-wrap');
  if (wrap) wrap.style.display = 'none';
}

function filterProfileBookPicker() {
  const listEl = document.getElementById('prof-picker-list');
  if (!listEl) return;

  const searchInput = document.getElementById('prof-picker-search-input');
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

  const userBooks = (Array.isArray(books) ? books : []).filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));

  const filtered = userBooks.filter(b => {
    if (!query) return true;
    const t = (b.title || '').toLowerCase();
    const a = (b.author || '').toLowerCase();
    return t.includes(query) || a.includes(query);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="padding:16px; text-align:center; font-size:12px; color:var(--text-400);">검색 결과가 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(b => {
    const coverUrl = b.cover || '';
    const hasCover = coverUrl && !coverUrl.includes('data:image/svg');
    return `
      <div class="profile-picker-item" ${libraryEventAttrs('selectRepBookForSlot', [currentEditingRepSlot, b.id])}>
        ${hasCover
          ? `<img src="${esc(coverUrl)}" class="profile-picker-thumb" referrerpolicy="no-referrer" alt="" onerror="this.style.display='none';">`
          : `<div class="profile-picker-thumb" style="display:flex; align-items:center; justify-content:center; background:rgba(140,98,57,0.1); font-size:9px; color:var(--text-400);">8ook</div>`
        }
        <div class="profile-picker-item-info">
          <span class="profile-picker-item-title">${esc(b.title)}</span>
          <span class="profile-picker-item-author">${esc(b.author || '저자 미상')} ${b.rating ? `• ★${esc(b.rating)}` : ''}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function selectRepBookForSlot(slotIndex, bookId) {
  if (slotIndex === null || slotIndex === undefined) slotIndex = 0;
  if (!currentProfileTarget || !currentProfileTarget.isMe) return;

  const b = (Array.isArray(books) ? books : []).find(item => item.id === bookId);
  if (!b) return;

  const { nickname, userId } = currentProfileTarget;
  const repList = getUserRepBooks(nickname, userId);

  repList[slotIndex] = {
    id: b.id,
    title: b.title,
    cover: b.cover || '',
    author: b.author || ''
  };

  // 1. Save locally
  const key = getUserRepBooksStorageKey(nickname, userId);
  try {
    localStorage.setItem(key, JSON.stringify(repList));
  } catch (e) {}
  communityRepBooksMap.set(nickname, repList);
  if (userId) communityRepBooksMap.set(userId, repList);

  // 2. Update UI
  renderProfileRepBooksGrid();
  closeProfileBookPicker();
  toast(`"${b.title}" 이(가) ${slotIndex + 1}번 대표 도서로 등록되었습니다 📚`);

  // 3. Sync to Supabase Cloud
  if (currentUser && supabaseClient) {
    try {
      await supabaseClient.auth.updateUser({
        data: { rep_books: repList }
      });

      await supabaseClient.from('books').upsert({
        id: 'prof_' + currentUser.id,
        user_id: currentUser.id,
        title: '__profile__',
        author: nickname,
        sentence: JSON.stringify(repList),
        keywords: [nickname],
        created_at: new Date().toISOString(),
        is_public: true
      });
    } catch (err) {
      console.warn('[Profile Sync] Error:', err);
    }
  }
}

async function fetchCommunityProfiles() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('books')
      .select('id, user_id, author, sentence, keywords')
      .eq('title', '__profile__');

    if (!error && Array.isArray(data)) {
      data.forEach(row => {
        if (!row.author || !row.sentence) return;
        try {
          const parsed = JSON.parse(row.sentence);
          if (Array.isArray(parsed)) {
            communityRepBooksMap.set(row.author, parsed);
            if (row.user_id) {
              communityRepBooksMap.set(row.user_id, parsed);
            }
          }
        } catch (e) {}
      });
    }
  } catch (e) {
    console.warn('Failed to fetch community profiles:', e);
  }
}

window.openUserProfileCard = openUserProfileCard;

// 일관된 6자리 닉네임 매핑 함수
function hashStringToNickname(str) {
  if (!str) return generateDefaultNickname();
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  let combined = Math.abs(h1 ^ h2);
  let res = '';
  for (let i = 0; i < 6; i++) {
    res += chars[combined % chars.length];
    combined = Math.floor(combined / chars.length) ^ (h2 >>> (i * 4));
    combined = Math.abs(combined);
  }
  return res.slice(0, 6);
}

function getCommunityItemOwnerNickname(item, source = '') {
  if (!item) return { nickname: generateDefaultNickname(), isMe: false };

  const effSource = source || item._source || '';
  const ownerId = item._ownerId || resolveCommunityBookOwner(item, effSource);

  // 내가 작성한 도서인지 판별
  const isMine = (effSource === 'local') ||
                 (ownerId === 'user_local') ||
                 (ownerId === 'user_owner_neo') ||
                 (currentUser && item.user_id && (String(item.user_id) === String(currentUser.id) || String(item.user_id) === 'f2432e6e-0481-4e8e-a516-213bd12434f9' || String(item.user_id) === '1df9f1ae-d5bf-4076-bd1d-b3f32916b216')) ||
                 (currentUser && currentUser.id && ownerId === ('user_' + currentUser.id)) ||
                 (item.id && Array.isArray(books) && books.some(b => String(b.id) === String(item.id)));

  if (isMine) {
    return { nickname: getUserNickname(), isMe: true };
  }

  if (item.nickname && typeof item.nickname === 'string' && item.nickname.trim()) {
    const customNick = item.nickname.trim().toLowerCase();
    if (customNick === 'curator_neo') {
      return { nickname: 'di31om', isMe: false };
    }
    return { nickname: customNick, isMe: false };
  }

  // Neo account records use the account nickname.
  if (ownerId === 'user_owner_neo' || String(item.user_id) === '1df9f1ae-d5bf-4076-bd1d-b3f32916b216' || String(item.user_id) === 'f2432e6e-0481-4e8e-a516-213bd12434f9') {
    const isNeo = currentUser && isNeoUser(currentUser);
    return { nickname: isNeo ? getUserNickname() : 'di31om', isMe: !!isNeo };
  }

  // 그 외: '독서가 1인당 1닉네임' 완전 일치를 위해 오직 정규화된 ownerId만을 시드로 사용!
  const nick = hashStringToNickname(String(ownerId));
  return { nickname: nick, isMe: false };
}

window.openNicknameModal = openNicknameModal;
window.submitNicknameChange = submitNicknameChange;
window.handleNicknameInputChange = handleNicknameInputChange;
window.getUserNickname = getUserNickname;
window.getNicknameChangesLeft = getNicknameChangesLeft;
window.validateNickname = validateNickname;
window.syncNicknameUI = syncNicknameUI;

/* ==============================================
   COMMUNITY JS LOGIC
   ============================================== */

let currentFeedRating = 5;

/* ==============================================
   COMMUNITY LOGIC (Books & Scraps)
   ============================================== */

const SEED_COMMUNITY_BOOKS = [];

const SEED_COMMUNITY_SCRAPS = [];

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
  return parseBookDateTimestamp(val);
}

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
  // Cross-tab BroadcastChannel
  if (localLikeBroadcast) {
    try {
      localLikeBroadcast.postMessage(payload);
    } catch (e) {}
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


function searchAladinByQuery(query) {
  openAddModal();
  document.getElementById('bk-title').value = query;
  searchAladin();
}
