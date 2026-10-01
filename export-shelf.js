'use strict';

/* Shelf image export helpers. */

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
