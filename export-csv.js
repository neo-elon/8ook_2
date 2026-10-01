'use strict';

/* CSV export UI and download helpers. Relies on shared classic-script app globals. */

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
    let str = String(field);
    // Keep spreadsheet formulas inert, including after leading whitespace/control characters.
    if (/^[\s\u0000-\u001F]*[=+\-@]|^[\t\r\n]/.test(str)) {
      str = "'" + str;
    }
    str = str.replace(/"/g, '""');
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
