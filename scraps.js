'use strict';

/* Scrap CRUD, archive/search view, inline memo, and quote copy helpers. */

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

  currentScrapTags = [];
  renderScrapModalTags();
  updateRecommendedHashtags();
  openModal('scrap-modal');
  setTimeout(() => {
    const el = document.getElementById('sc-text');
    if (el) el.focus();
  }, 100);
}

function closeScrapModal() {
  closeModal('scrap-modal');
}

async function saveScrap() {
  const book = books.find(b => b.id === currentScrapBookId);
  if (!book) return;

  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
    return;
  }
  const user = currentUser;

  const rawText = document.getElementById('sc-text').value.trim();
  const text = sanitizeUnmatchedSmartQuotes(rawText);
  const rawPage = (document.getElementById('sc-page').value || '').trim();
  const parsedPage = parseInt(rawPage.replace(/^[^\d]*/, ''), 10);
  const page = isNaN(parsedPage) ? 0 : parsedPage;
  const rawMemo = document.getElementById('sc-memo').value.trim();
  const memo = sanitizeUnmatchedSmartQuotes(rawMemo);

  if (!text) { toast('문장을 입력해주세요'); return; }

  if (!book.scraps) book.scraps = [];

  const tags = currentScrapTags.slice();

  // [지속 학습] 최종 저장된 문장과 태그들의 연관 관계를 학습 모델에 영구 반영
  const currentBook = book;
  tags.forEach(t => trainTagAssociation(text, t, currentBook));

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
  saveCurrentGalleryScroll();
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
  currentScrapSortOrder = 'date'; // 진입 시 기본 완독일순 정렬

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
      if (scrap.memo && scrap.memo.includes('노션 완독책장')) return;
      if (scrap.text && (scrap.text.includes('blog.naver.com/zzine315') || scrap.text.includes('zzine315'))) return;
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

  const allTabBtn = document.getElementById('scraps-tab-all-btn');
  const randomTabBtn = document.getElementById('scraps-tab-random-btn');
  if (allTabBtn) {
    if (currentScrapSortOrder === 'date' && !currentScrapFilterTag && !currentScrapSearchQuery) {
      allTabBtn.classList.add('active');
    } else {
      allTabBtn.classList.remove('active');
    }
  }
  if (randomTabBtn) {
    if (currentScrapSortOrder === 'random') {
      randomTabBtn.classList.add('active');
    } else {
      randomTabBtn.classList.remove('active');
    }
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
      <button type="button" class="scrap-filter-pill ${currentScrapFilterTag === tag ? 'active' : ''}" ${libraryEventAttrs('filterScrapsByTag', [tag])}>
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

  // Sort items: 완독일(book.date) 최신순 또는 랜덤 섞기
  if (currentScrapSortOrder === 'random') {
    filtered.sort((a, b) => getScrapRandomOrder(a.scrap.id) - getScrapRandomOrder(b.scrap.id));
  } else {
    // 기본 정렬: 도서 완독일(book.date) 최신순 (내림차순 타임스탬프 비교)
    filtered.sort((a, b) => {
      const timeA = parseBookDateTimestamp(a.book && a.book.date);
      const timeB = parseBookDateTimestamp(b.book && b.book.date);

      // 완독일이 있는 책이 없는 책보다 우선
      if (timeA > 0 && timeB === 0) return -1;
      if (timeA === 0 && timeB > 0) return 1;

      // 둘 다 완독일이 있으면 최신 완독일 우선 (내림차순)
      if (timeA !== timeB) {
        return timeB - timeA;
      }

      // 완독일이 같거나 둘 다 없는 경우:
      // 1) 동일한 책인 경우: 페이지 번호 오름차순 -> 스크랩 등록 시각
      if (a.book && b.book && a.book.id === b.book.id) {
        const pageA = parseInt(a.scrap.page, 10);
        const pageB = parseInt(b.scrap.page, 10);
        if (!isNaN(pageA) && !isNaN(pageB) && pageA !== pageB) {
          return pageA - pageB;
        }
        const tA = parseBookDateTimestamp(a.scrap.at || a.scrap.created_at);
        const tB = parseBookDateTimestamp(b.scrap.at || b.scrap.created_at);
        if (tA !== tB) return tB - tA;
      }

      // 2) 서로 다른 책인 경우 책 제목 가나다순
      const titleA = (a.book && a.book.title) || '';
      const titleB = (b.book && b.book.title) || '';
      if (titleA !== titleB) return titleA.localeCompare(titleB, 'ko');

      return String(a.scrap.id || '').localeCompare(String(b.scrap.id || ''));
    });
  }

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

  const renderArchiveCard = (item, idx) => {
    const { book, scrap } = item;
    const tags = scrap.tags || scrap.keywords || [];
    const coverHtml = book.cover
      ? `<img src="${esc(getSafeImageUrl(book.cover))}" class="scrap-card-cover" alt="${esc(book.title)}" ${libraryEventAttrs('showDetail', [book.id])} onerror="handleScrapCoverError(this)">`
      : `<div class="scrap-card-cover-placeholder" ${libraryEventAttrs('showDetail', [book.id])}>8ook</div>`;

    const tagsHtml = tags.map(t => {
      const cleanT = t.replace(/^#/, '');
      const isSelected = currentScrapFilterTag && currentScrapFilterTag.toLowerCase() === cleanT.toLowerCase();
      return `<span class="scrap-tag-chip" style="${isSelected ? 'background:var(--violet); color:#fff; border-color:var(--violet);' : ''}" ${libraryEventAttrs('filterScrapsByTag', [cleanT])} title="#${esc(cleanT)} 필터">#${highlight(cleanT)}</span>`;
    }).join('');

    const memoHtml = scrap.memo
      ? `<div class="comm-scrap-memo-wrap"><div class="comm-scrap-memo">${highlight(scrap.memo)}</div></div>`
      : '';

    const bookTitleParts = splitBookTitle(book);
    const bookMainTitle = bookTitleParts.main || book.title;

    return `
      <div class="scrap-card-full" id="archive-sc-${esc(scrap.id)}" style="order:${idx};">
        <div class="scrap-card-header">
          ${coverHtml}
          <div class="scrap-card-meta">
            <div class="scrap-card-title" ${libraryEventAttrs('showDetail', [book.id])}>${esc(bookMainTitle)}</div>
            <div class="scrap-card-sub">
              <span>${esc(book.author || '저자 미상')}</span>
              ${book.date ? `<span title="도서 완독일">• 완독 ${esc(fmtDate(book.date))}</span>` : (scrap.at ? `<span>• ${esc(fmtDate(scrap.at.slice(0, 10)))}</span>` : '')}
              ${scrap.page ? `<span>• p.${esc(scrap.page)}</span>` : ''}
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
            <button class="btn btn-ghost btn-sm" ${libraryEventAttrs('copyScrapQuoteText', [scrap.text || '', bookMainTitle || '', book.author || ''])} title="문장 복사" style="padding:2px 8px; font-size:11px; height:24px; border-radius:4px;">
              복사
            </button>
            <button class="btn btn-ghost btn-sm" ${libraryEventAttrs('downloadScrapShareImage', [scrap.text || '', bookMainTitle || '', book.author || '', scrap.page || '', scrap.memo || '', tags])} title="SNS용 1:1 이미지 다운로드" style="padding:2px 8px; font-size:11px; height:24px; border-radius:4px; color:var(--violet);">
              이미지
            </button>
            <button class="btn btn-ghost btn-sm" ${libraryEventAttrs('openInlineScrapMemo', [book.id,scrap.id])} title="이 문장에 내 생각 추가" style="padding:2px 8px; font-size:11px; height:24px; border-radius:4px; color:var(--violet);">
              ${scrap.memo ? '내 생각 수정' : '내 생각 추가'}
            </button>
            <button class="btn btn-ghost btn-sm" ${libraryEventAttrs('editScrap', [book.id,scrap.id])} style="padding:2px 6px; font-size:10px; height:24px; border-radius:4px;">
              수정
            </button>
            <button class="btn btn-danger btn-sm" ${libraryEventAttrs('doDeleteScrap', [book.id,scrap.id])} style="padding:2px 6px; font-size:10px; height:24px; border-radius:4px; background:rgba(239,68,68,.08); border:none; color:#f87171;">
              삭제
            </button>
          </div>
        </div>
      </div>
    `;
  };

  if (filtered.length <= 1) {
    listEl.innerHTML = filtered.map((item, idx) => renderArchiveCard(item, idx)).join('');
  } else {
    const col0 = [];
    const col1 = [];
    filtered.forEach((item, idx) => {
      if (idx % 2 === 0) col0.push(renderArchiveCard(item, idx));
      else col1.push(renderArchiveCard(item, idx));
    });
    listEl.innerHTML = `
      <div class="scraps-archive-col">${col0.join('')}</div>
      <div class="scraps-archive-col">${col1.join('')}</div>
    `;
  }
}

function openInlineScrapMemo(bookId, scrapId) {
  const card = document.getElementById(`archive-sc-${scrapId}`);
  if (!card) return;

  const existingBox = document.getElementById(`inline-memo-box-${scrapId}`);
  if (existingBox) {
    const textarea = document.getElementById(`inline-memo-input-${scrapId}`);
    if (textarea) textarea.focus();
    return;
  }

  const book = books.find(b => b.id === bookId);
  const scrap = book ? (book.scraps || []).find(s => s.id === scrapId) : null;
  const currentMemo = scrap ? (scrap.memo || '') : '';

  const memoWrap = card.querySelector('.comm-scrap-memo-wrap');
  if (memoWrap) memoWrap.style.display = 'none';

  const box = document.createElement('div');
  box.className = 'scrap-inline-memo-box';
  box.id = `inline-memo-box-${scrapId}`;
  box.innerHTML = `
    <textarea class="scrap-inline-memo-input" id="inline-memo-input-${esc(scrapId)}" placeholder="이 문장을 읽고 든 생각이나 감상을 기록해보세요..." rows="2">${esc(currentMemo)}</textarea>
    <div class="scrap-inline-memo-actions">
      <button type="button" class="btn btn-ghost btn-sm" ${libraryEventAttrs('cancelInlineScrapMemo', [scrapId])} style="padding:2px 8px; font-size:11px; height:24px; border-radius:4px;">취소</button>
      <button type="button" class="btn btn-sm" ${libraryEventAttrs('saveInlineScrapMemo', [bookId, scrapId])} style="padding:2px 10px; font-size:11px; height:24px; border-radius:4px; background:var(--violet); color:#fff; border:none; cursor:pointer;">저장</button>
    </div>
  `;

  const footer = card.querySelector('.scrap-card-footer');
  if (footer) {
    card.insertBefore(box, footer);
  } else {
    card.appendChild(box);
  }

  const textarea = document.getElementById(`inline-memo-input-${scrapId}`);
  if (textarea) {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveInlineScrapMemo(bookId, scrapId);
      }
    });
  }
}

function cancelInlineScrapMemo(scrapId) {
  const box = document.getElementById(`inline-memo-box-${scrapId}`);
  if (box) box.remove();
  const card = document.getElementById(`archive-sc-${scrapId}`);
  if (card) {
    const memoWrap = card.querySelector('.comm-scrap-memo-wrap');
    if (memoWrap) memoWrap.style.display = '';
  }
}

async function saveInlineScrapMemo(bookId, scrapId) {
  const input = document.getElementById(`inline-memo-input-${scrapId}`);
  if (!input) return;
  const newMemo = input.value.trim();

  if (supabaseClient && !currentUser) {
    toast('로그인이 필요합니다. 먼저 로그인 해주세요.');
    return;
  }

  const book = books.find(b => b.id === bookId);
  if (!book) return;

  const nowIso = new Date().toISOString();
  const updatedScraps = (book.scraps || []).map(s =>
    s.id === scrapId ? { ...s, memo: newMemo, updated_at: nowIso } : s
  );

  try {
    if (supabaseClient && currentUser) {
      const { error } = await supabaseClient
        .from('books')
        .update({ scraps: updatedScraps })
        .eq('id', bookId)
        .eq('user_id', currentUser.id);
      if (error) throw error;
    }

    book.scraps = updatedScraps;
    saveData();
    toast(newMemo ? '생각이 저장되었습니다.' : '생각이 삭제되었습니다.');

    if (currentBookId === bookId && document.getElementById('view-detail').classList.contains('show')) {
      showDetail(bookId);
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
    toast('생각 저장 실패: ' + err.message);
  }
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
