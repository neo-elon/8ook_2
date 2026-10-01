'use strict';

/* Supabase authentication and app-menu session UI. */

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

  try {
    toast('구글 로그인으로 연결 중...', 2500);

    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl
      }
    });
    if (error) {
      console.error('[Auth] signInWithOAuth error:', error);
      toast(`로그인 오류: ${error.message || '연결에 실패했습니다'}`);
    } else if (data && data.url) {
      window.location.href = data.url;
    }
  } catch (authErr) {
    console.error('[Auth] signInWithOAuth exception:', authErr);
    toast(`로그인 연결 실패: ${authErr.message || authErr}`);
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
    const currentNick = getUserNickname();
    if (shortUsernameSpan) {
      shortUsernameSpan.innerHTML = `<span class="header-user-at" style="color:var(--violet); font-weight:600; margin-right:1px;">@</span>${esc(currentNick)}`;
    }
    if (headerChip) headerChip.style.display = 'inline-flex';
    if (googleLoginBtn) googleLoginBtn.style.display = 'none';
    syncNicknameUI();
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
    syncLargeTextUI();
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

window.toggleAppMenu = toggleAppMenu;
window.closeAppMenu = closeAppMenu;

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
        syncNicknameUI();
        if (typeof renderCommunityBooks === 'function') renderCommunityBooks();
        if (typeof renderCommunityScraps === 'function') renderCommunityScraps();
      });
    }
  });
}
