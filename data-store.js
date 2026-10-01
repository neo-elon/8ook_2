'use strict';

/* ==============================================
   STORAGE & GUIDE HELPERS
============================================== */
function isLikeRecord(book) {
  if (!book) return false;
  return book.title === '__like__' || (typeof book.id === 'string' && book.id.startsWith('like_'));
}

function isCommentRecord(book) {
  if (!book) return false;
  return book.title === '__comment__' || (typeof book.id === 'string' && book.id.startsWith('cmt_'));
}

function isProfileRecord(book) {
  if (!book) return false;
  return book.title === '__profile__' || (typeof book.id === 'string' && book.id.startsWith('prof_'));
}

function isGuideBook(book) {
  if (!book) return false;
  return book.id === '8ook_user_guide' ||
    (typeof book.title === 'string' && book.title.includes('8ook. 이용 가이드')) ||
    (typeof book.author === 'string' && book.author.includes('8ook 제작팀'));
}

function isOhaUser(user) {
  if (!user) return false;
  const uid = user.id ? String(user.id) : '';
  const email = (user.email || '').toLowerCase();
  return uid === '7396cf84-8b75-4617-a050-5ed974fcbe02' || email.includes('thejs2050');
}

function isNeoUser(user) {
  if (!user) return false;
  const uid = user.id ? String(user.id) : '';
  const email = (user.email || '').toLowerCase();
  return uid === '1df9f1ae-d5bf-4076-bd1d-b3f32916b216' ||
    uid === 'f2432e6e-0481-4e8e-a516-213bd12434f9' ||
    email.includes('parkyangkyu') ||
    email.includes('neo_elon') ||
    email.includes('neo');
}

function saveData() {
  // Supabase is the only source of truth for personal libraries.
  markGalleryDirty();
}

async function loadData() {
  loadCommunityCommentsFromStorage();
  if (!supabaseClient || !currentUser) {
    // Logged-out/guest view is intentionally isolated from any previously
    // imported or cached library data. Show only the built-in user guide.
    books = [];
    ensureUserGuideBook();
    bootstrapTagLearningFromLibrary();
    fetchCommunityLikes();
    initCommunityLikesChannel();
    fetchCommunityComments();
    initCommunityCommentsChannel();
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
    const remoteBooks = rawRemoteBooks.filter(b => !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));
    if (remoteBooks.length > 0 && 'spineCover' in remoteBooks[0]) {
      dbSupportsSpineCover = true;
    }

    books = remoteBooks;

    // 로그인 계정인 경우 가이드북 정리
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

    // Supabase 원격 DB가 단일 진실 공급원(SSOT)이므로 정적 데이터셋으로 사용자의 최신 수정/삭제 사항을 덮어쓰지 않음

    books.forEach(b => cleanBookScraps(b));
    ensureUserGuideBook();
    saveData();
    bootstrapTagLearningFromLibrary();
    fetchCommunityLikes();
    initCommunityLikesChannel();
    fetchCommunityComments();
    initCommunityCommentsChannel();
    preheatSpineCache();
  } catch (e) {
    console.error('Supabase load error:', e);
    // Signed-in libraries use Supabase as the sole source of truth.
    books = [];
    toast('서재 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', 3500);
    bootstrapTagLearningFromLibrary();
    fetchCommunityLikes();
    initCommunityLikesChannel();
    fetchCommunityComments();
    initCommunityCommentsChannel();
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
