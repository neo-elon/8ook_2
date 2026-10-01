'use strict';

/* Scrap hashtag rules and adaptive tag learning engine. */

const SCRAP_THEME_RULES = [
  { tag: '위로', words: ['위로', '지친', '힘든', '상처', '토닥', '괜찮아', '눈물', '아픔', '치유', '견디', '쓰러', '안식', '평온', '토닥토닥'] },
  { tag: '인생', words: ['인생', '삶', '살아', '생애', '존재', '세상', '운명', '세월', '어른', '여정', '인간'] },
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
  { tag: '명언', words: ['명언', '격언', '교훈', '잠언', '좌우명', '한줄'] },
  { tag: '사유', words: ['사유', '고찰', '질문', '의문', '탐구', '의미', '헤아려', '성찰'] },
  { tag: '기억', words: ['기억', '추억', '흔적', '간직', '잊혀', '잊지', '회상'] },
  { tag: '온기', words: ['온기', '따스', '포근', '체온', '햇살', '위안', '다정함'] }
];

// 한국어 형태소 정제: 불용어 및 조사 박리를 통한 순수 명사형 추출
const KOREAN_STOPWORDS = new Set([
  '그리고', '하지만', '그러나', '또한', '때문에', '그래서', '그래도', '그러므로', '그런데',
  '우리는', '우리가', '우리', '나는', '내가', '나의', '나를', '너는', '네가', '너의', '너를',
  '그는', '그가', '그의', '그를', '그녀는', '그녀가', '그녀의', '그녀를', '그들은', '그들의',
  '이것', '저것', '그것', '이것은', '저것은', '그것은', '이것을', '저것을', '그것을',
  '여기', '저기', '거기', '어디', '누구', '무엇', '어떤', '모든', '아무런', '이러한', '저러한', '그러한',
  '매우', '가장', '너무', '정말', '진짜', '다시', '이미', '벌써', '항상', '언제나', '가끔', '자주',
  '스스로', '서로', '오직', '다만', '함께', '같이', '그냥', '마치', '어쩌면', '아마', '결국', '비로소',
  '점점', '더욱', '훨씬', '조금', '많이', '하나', '둘', '셋', '처음', '마지막',
  '있다', '없다', '같다', '된다', '한다', '했다', '이다', '아니다', '보다', '가다', '오다',
  '있는', '없는', '같은', '되는', '하는', '했던', '통해', '대해', '위해',
  '것', '수', '때', '줄', '바', '뿐', '체', '양', '척', '만', '데', '이', '적', '점', '개'
]);

const KOREAN_PARTICLE_PATTERNS = [
  /^(.*?)(에게서는|에게서도|에게서|에서는|에서도|으로부터|이라고는|이라도|이라는|이라는건|이면서|이지만|이거나|이었던|이었다|이었다고)$/,
  /^(.*?)(에게는|에게도|에서는|에서도|으로는|으로도|이라고|이라는|이라며|이어서|이므로|이기에|스럽다|스러운|스러움|다움|답다)$/,
  /^(.*?)(에는|에도|에서|에게|으로|로써|로서|부터|까지|마저|조차|처럼|만큼|보다|이나|이란|이라|이다|이며|이죠)$/,
  /^(.*?)(하고는|하고|하며|하면|하여|하지|하게|하는|하던|해도|해서|했다|했던|된다|되는|되어|되면|되고|돼서|인듯)$/,
  /^(.*?)(은|는|이|가|을|를|의|에|로|와|과|도|만|서|들|랑)$/
];

function normalizeToNoun(rawWord) {
  if (!rawWord) return null;
  let word = rawWord.trim().replace(/[^\w가-힣]/g, '');
  if (word.length < 2 || word.length > 6) return null;

  if (KOREAN_STOPWORDS.has(word)) return null;

  // 동사/형용사 대표 종결 어미로 끝나면 명사 추출 또는 배제
  if (/(하다|되다|있다|없다|같다|이다|했다|됐다|였다|렸다|는다|ㄴ다|었다|았다|겠다|군요|네요|구나|니다|시오|세요|지요|게요|까요|래요|던가|거든)$/.test(word)) {
    const stem = word.replace(/(하다|되다|있다|없다|했다|됐다|이다)$/, '');
    if (stem.length >= 2 && !KOREAN_STOPWORDS.has(stem) && !/(하|되|있|없|같|이)$/.test(stem)) {
      word = stem;
    } else {
      return null;
    }
  }

  // 조사 및 어미 단계적 박리 (최대 2단계)
  for (let i = 0; i < 2; i++) {
    for (const pat of KOREAN_PARTICLE_PATTERNS) {
      const match = word.match(pat);
      if (match && match[1] && match[1].length >= 2) {
        const candidate = match[1];
        if (!KOREAN_STOPWORDS.has(candidate)) {
          word = candidate;
          break;
        }
      }
    }
  }

  if (KOREAN_STOPWORDS.has(word)) return null;
  if (word.length < 2 || word.length > 5) return null;

  // 비명사형 활용 어미 잔여물 배제 (예: ~고, ~며, ~면, ~서 등)
  if (/(고|며|면|서|게|지|던|듯|록|자|아|어|여|인|된|한|할|일)$/.test(word)) {
    const allowedEndings = new Set(['희망', '열정', '통찰', '진실', '현실', '본질', '결실', '인연', '순간', '인간', '시간', '자연', '시선', '내면', '사유', '여유', '자유', '치유', '공유', '이유']);
    if (!allowedEndings.has(word)) {
      return null;
    }
  }

  return word;
}

/* ==============================================
   ADAPTIVE TAG LEARNING ENGINE (지속 학습 추천 엔진)
============================================== */
const TAG_LEARNING_STORAGE_KEY = '8ook_tag_learning_model_v1';

let tagLearningModel = {
  wordTagWeights: {},   // { [noun]: { [tag]: count } }
  tagPairs: {},         // { [tagA]: { [tagB]: count } }
  authorTagWeights: {}, // { [author]: { [tag]: count } }
  userTagFreq: {},      // { [tag]: { count, lastUsed } }
  initialized: false
};

function loadTagLearningModel() {
  try {
    const raw = localStorage.getItem(TAG_LEARNING_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        tagLearningModel = {
          wordTagWeights: parsed.wordTagWeights || {},
          tagPairs: parsed.tagPairs || {},
          authorTagWeights: parsed.authorTagWeights || {},
          userTagFreq: parsed.userTagFreq || {},
          initialized: true
        };
      }
    }
  } catch (e) {
    console.warn('Failed to load tag learning model:', e);
  }
}

function saveTagLearningModel() {
  try {
    localStorage.setItem(TAG_LEARNING_STORAGE_KEY, JSON.stringify(tagLearningModel));
  } catch (e) {
    cleanupTagLearningModel();
  }
}

function cleanupTagLearningModel() {
  try {
    for (const word in tagLearningModel.wordTagWeights) {
      const tags = tagLearningModel.wordTagWeights[word];
      for (const t in tags) {
        if (tags[t] <= 1) delete tags[t];
      }
      if (Object.keys(tags).length === 0) delete tagLearningModel.wordTagWeights[word];
    }
    localStorage.setItem(TAG_LEARNING_STORAGE_KEY, JSON.stringify(tagLearningModel));
  } catch (e) {}
}

// 문장 및 도서 정보와 사용자가 직접 추가한 태그를 실시간 연관 학습
function trainTagAssociation(sentenceText, tag, book) {
  if (!tag) return;
  const cleanTag = tag.trim().replace(/^#+/, '').replace(/\s+/g, '');
  if (!cleanTag) return;

  const now = Date.now();
  // 1. 사용자 직접 태그 사용 빈도 및 최신 사용 시각 기록
  if (!tagLearningModel.userTagFreq[cleanTag]) {
    tagLearningModel.userTagFreq[cleanTag] = { count: 0, lastUsed: now };
  }
  tagLearningModel.userTagFreq[cleanTag].count += 1;
  tagLearningModel.userTagFreq[cleanTag].lastUsed = now;

  // 2. 문장 내 핵심 명사들과의 연관 가중치 강화
  if (sentenceText) {
    const tokens = sentenceText
      .replace(/[^\w가-힣\s]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(Boolean);

    const nouns = new Set();
    tokens.forEach(tok => {
      const n = normalizeToNoun(tok);
      if (n && n !== cleanTag && n.length >= 2) nouns.add(n);
    });

    nouns.forEach(noun => {
      if (!tagLearningModel.wordTagWeights[noun]) {
        tagLearningModel.wordTagWeights[noun] = {};
      }
      tagLearningModel.wordTagWeights[noun][cleanTag] = (tagLearningModel.wordTagWeights[noun][cleanTag] || 0) + 1;
    });
  }

  // 3. 도서 저자와 태그 간 연관 가중치
  if (book && book.author) {
    const normAuthor = book.author.trim();
    if (normAuthor && normAuthor !== '저자 미상') {
      if (!tagLearningModel.authorTagWeights[normAuthor]) {
        tagLearningModel.authorTagWeights[normAuthor] = {};
      }
      tagLearningModel.authorTagWeights[normAuthor][cleanTag] = (tagLearningModel.authorTagWeights[normAuthor][cleanTag] || 0) + 1;
    }
  }

  // 4. 함께 등록된 태그들 간의 동시 출현(Co-occurrence) 가중치
  if (Array.isArray(currentScrapTags) && currentScrapTags.length > 0) {
    currentScrapTags.forEach(otherTag => {
      if (otherTag && otherTag !== cleanTag) {
        if (!tagLearningModel.tagPairs[otherTag]) tagLearningModel.tagPairs[otherTag] = {};
        if (!tagLearningModel.tagPairs[cleanTag]) tagLearningModel.tagPairs[cleanTag] = {};
        tagLearningModel.tagPairs[otherTag][cleanTag] = (tagLearningModel.tagPairs[otherTag][cleanTag] || 0) + 1;
        tagLearningModel.tagPairs[cleanTag][otherTag] = (tagLearningModel.tagPairs[cleanTag][otherTag] || 0) + 1;
      }
    });
  }

  saveTagLearningModel();
}

// 기존 서재의 모든 스크랩 데이터를 학습 모델에 초기 반영
function bootstrapTagLearningFromLibrary() {
  if (tagLearningModel.initialized && Object.keys(tagLearningModel.userTagFreq).length > 0) {
    return;
  }
  if (!Array.isArray(books) || books.length === 0) return;

  books.forEach(b => {
    (b.scraps || []).forEach(s => {
      const tags = s.tags || s.keywords || [];
      const text = s.text || '';
      tags.forEach(t => {
        trainTagAssociation(text, t, b);
      });
    });
  });
  tagLearningModel.initialized = true;
  saveTagLearningModel();
}

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
      <button type="button" class="scrap-tag-pill-del" ${libraryEventAttrs('removeScrapTag', [tag])} aria-label="삭제">×</button>
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

    // [지속 학습] 사용자가 직접 추가한 태그를 실시간 학습 반영!
    const textEl = document.getElementById('sc-text');
    const text = textEl ? textEl.value.trim() : '';
    const book = books.find(b => b.id === currentScrapBookId);
    trainTagAssociation(text, cleanTag, book);
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
  const currentText = (text || '').trim();
  if (!currentText) return [];

  const scoreMap = new Map();
  const addScore = (tag, points) => {
    if (!tag) return;
    const clean = tag.trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!clean || clean.length < 2 || clean.length > 8) return;
    scoreMap.set(clean, (scoreMap.get(clean) || 0) + points);
  };

  // 문장에서 명사형 어휘 정밀 추출
  const tokens = currentText
    .replace(/[^\w가-힣\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean);

  const sentenceNouns = new Set();
  tokens.forEach(tok => {
    const n = normalizeToNoun(tok);
    if (n && n.length >= 2 && n.length <= 5) {
      sentenceNouns.add(n);
      addScore(n, 12); // 문장 내 직접 등장한 핵심 명사 기본 점수
    }
  });

  // 1. [학습 엔진] 문장 내 단어 -> 사용자가 과거에 직접 매칭했던 태그 연관 가중치 (최고 우선순위!)
  sentenceNouns.forEach(noun => {
    const associations = tagLearningModel.wordTagWeights[noun];
    if (associations) {
      for (const [tag, count] of Object.entries(associations)) {
        addScore(tag, count * 22);
      }
    }
  });

  // 2. [학습 엔진] 해당 저자의 도서에서 사용자가 자주 쓰는 태그 가중치
  if (book && book.author && book.author !== '저자 미상') {
    const authorTags = tagLearningModel.authorTagWeights[book.author.trim()];
    if (authorTags) {
      for (const [tag, count] of Object.entries(authorTags)) {
        addScore(tag, count * 16);
      }
    }
  }

  // 3. [학습 엔진] 현재 선택된 태그들과의 동시 출현(Co-occurrence) 가중치
  if (Array.isArray(currentScrapTags) && currentScrapTags.length > 0) {
    currentScrapTags.forEach(curTag => {
      const pairs = tagLearningModel.tagPairs[curTag];
      if (pairs) {
        for (const [tag, count] of Object.entries(pairs)) {
          addScore(tag, count * 14);
        }
      }
    });
  }

  // 4. [학습 엔진] 사용자의 전반적인 태그 사용 빈도 및 최신성 가중치
  const now = Date.now();
  for (const [tag, info] of Object.entries(tagLearningModel.userTagFreq)) {
    const daysAgo = (now - (info.lastUsed || now)) / (1000 * 60 * 60 * 24);
    const recencyMultiplier = daysAgo < 3 ? 1.6 : (daysAgo < 14 ? 1.25 : 1.0);
    addScore(tag, Math.min(30, info.count * 3.5 * recencyMultiplier));
  }

  // 5. 테마 사전 매칭 (문맥 감지 기본 명사)
  SCRAP_THEME_RULES.forEach(rule => {
    if (rule.words.some(w => currentText.includes(w))) {
      addScore(rule.tag, 15);
    }
  });

  // 6. 현재 도서 키워드
  if (book && book.keywords && Array.isArray(book.keywords)) {
    book.keywords.forEach(k => {
      const n = normalizeToNoun(k);
      if (n) addScore(n, 10);
    });
  }

  // 7. 기본 폴백 태그 (부족할 경우 대비)
  ['인생', '위로', '성장', '사랑', '행복', '독서', '마음', '사유'].forEach(defTag => {
    addScore(defTag, 2);
  });

  // 이미 선택된 태그 제외 후 점수 내림차순 정렬하여 상위 7개 추천
  const sortedTags = Array.from(scoreMap.entries())
    .filter(([tag]) => !currentScrapTags.includes(tag))
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
    .slice(0, 7);

  return sortedTags;
}

let recDebounceTimer = null;
function updateRecommendedHashtags(immediate = false) {
  clearTimeout(recDebounceTimer);
  const run = () => {
    const textEl = document.getElementById('sc-text');
    const text = textEl ? textEl.value.trim() : '';
    const chipsContainer = document.getElementById('scrap-rec-chips-list');
    if (!chipsContainer) return;

    if (!text) {
      chipsContainer.innerHTML = `<span style="font-size:11px; color:var(--text-400);">문장을 입력한 후 다음 필드로 이동하면 맞춤 명사형 태그를 추천합니다.</span>`;
      return;
    }

    const book = books.find(b => b.id === currentScrapBookId);
    const recs = getRecommendedHashtags(text, book);

    if (recs.length === 0) {
      chipsContainer.innerHTML = `<span style="font-size:11px; color:var(--text-400);">추천할 새로운 해시태그가 없습니다.</span>`;
      return;
    }

    chipsContainer.innerHTML = recs.map(tag => `
      <button type="button" class="scrap-rec-chip" tabindex="-1" ${libraryEventAttrs('addScrapTag', [tag])} title="#${esc(tag)} 추가">
        <span class="rec-plus">+</span> #${esc(tag)}
      </button>
    `).join('');
  };

  if (immediate) {
    run();
  } else {
    recDebounceTimer = setTimeout(run, 30);
  }
}
