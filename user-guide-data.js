'use strict';

/* Pure factory for the built-in 8ook user guide book. */

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

      <text x="-75" y="134" fill="#4d3e28" font-size="11" font-weight="600" font-family="'Noto Sans KR', sans-serif">3. 감동적인 문장 수집</text>
      <text x="-70" y="148" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 페이지별 인상 깊은 구절</text>
      <text x="-70" y="160" fill="#6f5e43" font-size="9" font-family="'Noto Sans KR', sans-serif">• 나만의 생각 메모 &amp; 감상</text>

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
    sentence: '3D 양장본 서가, 나만의 문장 수집, 독서 캘린더와 클라우드 동기화까지 — 8ook를 100% 누리는 완벽 가이드',
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
        text: '책을 읽다 마음에 드는 구절을 발견했다면 도서 상세 화면에서 "문장 추가"를 눌러 기억하고 싶은 문장과 나만의 생각 메모, 읽은 쪽수(p.), #해시태그를 함께 기록해 보세요. 차곡차곡 모인 문장들은 나만의 소중한 지적 자산이 됩니다.',
        page: 3,
        memo: '나만의 문장 수집 & 생각 메모',
        tags: ['문장수집', '생각메모', '인용구']
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
