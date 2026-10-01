'use strict';

/* ==============================================
   INIT
============================================= */
loadTheme();
loadLargeTextMode();
loadTagLearningModel();
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
  syncNicknameUI();
  preheatSpineCache();

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
