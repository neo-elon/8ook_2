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
  markGalleryDirty();
  try {
    if (currentUser) {
      // 로그인 사용자 로컬 저장소 (가이드북/좋아요/댓글/프로필 레코드 제외)
      const userBooks = books.filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));
      localStorage.setItem(`rj_books_${currentUser.id}`, JSON.stringify(userBooks));
    } else {
      const guestBooks = books.filter(b => !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));
      localStorage.setItem('rj_books', JSON.stringify(guestBooks));
    }
  } catch (e) { }
}

async function loadData() {
  loadCommunityCommentsFromStorage();
  let localBooks = [];
  try {
    const key = currentUser ? `rj_books_${currentUser.id}` : 'rj_books';
    const d = localStorage.getItem(key);
    if (d) localBooks = JSON.parse(d);
  } catch (e) { }

  // 1. 로컬 저장소에서 가이드북, 좋아요 레코드 등 제외
  localBooks = localBooks.filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));


  if (!supabaseClient || !currentUser) {
    // Logged-out/guest view is intentionally isolated from any previously
    // imported or cached library data. Show only the built-in user guide.
    // Do not delete localStorage here: legacy guest data may still be needed
    // for migration after the user signs in.
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

    // Migration: If Supabase is empty but we have local guest books, upload them to Supabase
    const guestBooksStr = localStorage.getItem('rj_books');
    let guestBooks = [];
    if (guestBooksStr) {
      try { guestBooks = JSON.parse(guestBooksStr); } catch (e) { }
    }
    const userGuestBooks = guestBooks.filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b));

    if (remoteBooks.length === 0 && userGuestBooks.length > 0) {
      const booksToUpload = userGuestBooks.map(b => {
        return { ...b, id: uid(), user_id: currentUser.id };
      });
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
        try { localStorage.removeItem('rj_books'); } catch (e) { }
      } else {
        console.error('Failed to sync local books to Supabase:', syncError);
        books = remoteBooks;
      }
    } else {
      books = remoteBooks;
    }

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

    // 1회성 마이그레이션: 임시 계정(f2432e6e) 잔여 도서를 현재 계정으로 병합 후 삭제
    if (isNeoUser(currentUser) && supabaseClient) {
      const TEMP_UID = 'f2432e6e-0481-4e8e-a516-213bd12434f9';
      const migrationDone = localStorage.getItem('_db_migration_temp_done_v2');
      if (!migrationDone) {
        try {
          const { data: tempBooks } = await supabaseClient.from('books').select('*').eq('user_id', TEMP_UID);
          if (tempBooks && tempBooks.length > 0) {
            const existingTitles = new Set(books.map(b => (b.title || '').trim().toLowerCase()));
            for (const tb of tempBooks) {
              const tNorm = (tb.title || '').trim().toLowerCase();
              if (!existingTitles.has(tNorm)) {
                // 고유 도서: 현재 계정으로 이관
                const { error: upErr } = await supabaseClient.from('books').update({ user_id: currentUser.id }).eq('id', tb.id).eq('user_id', TEMP_UID);
                if (!upErr) {
                  tb.user_id = currentUser.id;
                  books.push(tb);
                  existingTitles.add(tNorm);
                  console.log('[Migration] Transferred:', tb.title);
                }
              } else {
                // 중복 도서: 삭제
                await supabaseClient.from('books').delete().eq('id', tb.id).eq('user_id', TEMP_UID);
                console.log('[Migration] Deleted duplicate:', tb.title);
              }
            }
            // null user_id 고아 레코드 정리
            const { data: orphans } = await supabaseClient.from('books').select('id').is('user_id', null);
            if (orphans && orphans.length > 0) {
              for (const o of orphans) {
                await supabaseClient.from('books').delete().eq('id', o.id).is('user_id', null);
              }
              console.log('[Migration] Cleaned', orphans.length, 'orphan records');
            }
            toast('서재 계정 통합 완료!', 2500);
          }
          localStorage.setItem('_db_migration_temp_done_v2', '1');
        } catch (migErr) {
          console.warn('[Migration] Error:', migErr);
        }
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
    console.error('Supabase load error, using local storage backup:', e);
    books = (currentUser ? localBooks.filter(b => !isGuideBook(b) && !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b)) : localBooks.filter(b => !isLikeRecord(b) && !isCommentRecord(b) && !isProfileRecord(b)));
    books.forEach(b => cleanBookScraps(b));
    ensureUserGuideBook();
    saveData();
    bootstrapTagLearningFromLibrary();
    fetchCommunityLikes();
    initCommunityLikesChannel();
    fetchCommunityComments();
    initCommunityCommentsChannel();
    preheatSpineCache();
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
