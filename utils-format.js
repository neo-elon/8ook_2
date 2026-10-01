'use strict';

/* Shared pure formatting helpers. Keep classic-script globals for legacy callers. */

function decodeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function parseBookDateTimestamp(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  // 1. Match YYYY, MM, DD (handles "2024. 3. 5.", "2024-03-05", "2024/3/5", etc.)
  const m = str.match(/(\d{4})[^\d]+(\d{1,2})[^\d]+(\d{1,2})/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    const dt = new Date(y, mo, d);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  // 2. Year and Month only: "2024. 3" or "2024-03"
  const ym = str.match(/(\d{4})[^\d]+(\d{1,2})/);
  if (ym) {
    const y = parseInt(ym[1], 10);
    const mo = parseInt(ym[2], 10) - 1;
    const dt = new Date(y, mo, 1);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  // 3. Year only: "2024"
  const yOnly = str.match(/^(\d{4})$/);
  if (yOnly) {
    const dt = new Date(parseInt(yOnly[1], 10), 0, 1);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  // 4. Fallback to standard Date parse
  const t = new Date(str).getTime();
  return isNaN(t) ? 0 : t;
}

function starsPlain(n) {
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= (n || 0) ? '⭐' : '·';
  return s;
}

function parseTitleParts(bookOrTitle) {
  return splitBookTitle(bookOrTitle);
}

function splitBookTitle(bookOrTitle) {
  if (!bookOrTitle) return { main: '', sub: '' };
  let titleStr = '';
  let subStr = '';

  if (typeof bookOrTitle === 'object') {
    titleStr = (bookOrTitle.title || '').trim();
    subStr = (bookOrTitle.subtitle || '').trim();
  } else {
    titleStr = String(bookOrTitle).trim();
  }

  titleStr = decodeHtml(titleStr);
  subStr = decodeHtml(subStr);

  if (subStr) {
    return { main: titleStr, sub: subStr };
  }

  // Common title - subtitle delimiters: " - ", " – ", " — ", " : ", ": "
  const delimiterMatch = titleStr.match(/^(.*?)(?:\s+[-–—]\s+|\s*[:：]\s+)(.+)$/);
  if (delimiterMatch && delimiterMatch[1].trim() && delimiterMatch[2].trim()) {
    return {
      main: delimiterMatch[1].trim(),
      sub: delimiterMatch[2].trim()
    };
  }

  // Bracketed subtitle at the end: e.g. "제목 <부제>", "제목 〈부제〉", "제목 《부제》"
  const bracketMatch = titleStr.match(/^(.*?)\s+([<〈《][^>〉》]+[>〉》])$/);
  if (bracketMatch && bracketMatch[1].trim() && bracketMatch[2].trim()) {
    return {
      main: bracketMatch[1].trim(),
      sub: bracketMatch[2].trim()
    };
  }

  return { main: titleStr, sub: '' };
}
