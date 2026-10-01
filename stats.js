'use strict';

/* Reading statistics, chart, random quote, and calendar rendering. */

function updateSidebar() {
  const now = new Date();
  let filteredBooks = currentUser ? books.filter(b => !isGuideBook(b)) : books;

  if (statsPeriod === 'year') {
    filteredBooks = filteredBooks.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return d.getFullYear() === now.getFullYear();
    });
  } else if (statsPeriod === 'month') {
    filteredBooks = filteredBooks.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
  }

  const total = filteredBooks.length;
  const pages = filteredBooks.reduce((s, b) => s + (b.pages || 0), 0);
  const scraps = filteredBooks.reduce((s, b) => s + ((b.scraps || []).length), 0);

  const formatStatNum = (n) => {
    if (n >= 10000) {
      return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return n.toLocaleString();
  };

  const setStatEl = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.classList.remove('compact', 'extra-compact');
    if (val.length >= 6) {
      el.classList.add('extra-compact');
    } else if (val.length >= 5) {
      el.classList.add('compact');
    }
  };

  setStatEl('stat-books', total.toLocaleString());
  setStatEl('stat-pages', formatStatNum(pages));
  setStatEl('stat-scraps', formatStatNum(scraps));

  renderChart();
  renderCal();
}

function showRandomQuote() {
  const card = document.getElementById('random-quote-card');
  const textEl = document.getElementById('random-quote-text');
  const bookEl = document.getElementById('random-quote-book');

  // Collect all scraps
  const allScraps = [];
  const sourceBooks = currentUser ? books.filter(b => !isGuideBook(b)) : books;
  sourceBooks.forEach(book => {
    if (book.scraps && book.scraps.length) {
      book.scraps.forEach(s => {
        allScraps.push({
          text: s.text,
          page: s.page,
          bookTitle: book.title,
          bookAuthor: book.author
        });
      });
    }
  });

  if (allScraps.length === 0) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');

  // Trigger fluid refresh animation
  card.classList.add('refresh-anim');
  setTimeout(() => {
    const randIdx = Math.floor(Math.random() * allScraps.length);
    const quote = allScraps[randIdx];

    textEl.textContent = quote.text;
    let sourceText = `— ${quote.bookTitle}`;
    if (quote.bookAuthor) sourceText += ` (${quote.bookAuthor})`;
    if (quote.page) sourceText += `, p.${quote.page}`;
    bookEl.textContent = sourceText;

    card.classList.remove('refresh-anim');
  }, 180);
}

function switchStatsPeriod(period) {
  statsPeriod = period;
  const btnAll = document.getElementById('stats-btn-all');
  const btnYear = document.getElementById('stats-btn-year');
  const btnMonth = document.getElementById('stats-btn-month');

  [btnAll, btnYear, btnMonth].forEach(btn => {
    if (btn) {
      btn.style.background = 'var(--glass)';
      btn.style.color = 'var(--text-300)';
      btn.style.border = '1px solid var(--border)';
    }
  });

  let activeBtn = btnAll;
  if (period === 'year') activeBtn = btnYear;
  if (period === 'month') activeBtn = btnMonth;

  if (activeBtn) {
    activeBtn.style.background = 'var(--violet)';
    activeBtn.style.color = '#fff';
    activeBtn.style.border = 'none';
  }

  updateSidebar();
}

function renderChart() {
  const chart = document.getElementById('monthly-chart');
  chart.innerHTML = '';

  const now = new Date();
  const dataPoints = [];

  if (chartMode === 'month') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      dataPoints.push({
        lbl: (d.getMonth() + 1) + '월',
        match: (bDate) => bDate.getFullYear() === d.getFullYear() && bDate.getMonth() === d.getMonth()
      });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const yearVal = now.getFullYear() - i;
      dataPoints.push({
        lbl: yearVal + '년',
        match: (bDate) => bDate.getFullYear() === yearVal
      });
    }
  }

  const counts = dataPoints.map(dp =>
    books.filter(b => {
      if (!b.date) return false;
      const d = new Date(b.date);
      return dp.match(d);
    }).length
  );

  const maxC = Math.max(...counts, 1);

  dataPoints.forEach((dp, i) => {
    const pct = (counts[i] / maxC) * 70;
    const g = document.createElement('div');
    g.className = 'bar-group';
    g.innerHTML = `
      <span style="font-size:9px; color:var(--text-300); font-weight:500; margin-bottom:-2px;">${counts[i]}</span>
      <div class="bar-col" style="height:${pct}%" data-tip="${dp.lbl}: ${counts[i]}권"></div>
      <div class="bar-lbl">${dp.lbl}</div>
    `;
    chart.appendChild(g);
  });
}

function switchChartMode(mode) {
  chartMode = mode;
  const btnMonth = document.getElementById('chart-btn-month');
  const btnYear = document.getElementById('chart-btn-year');
  const title = document.getElementById('chart-title');

  if (mode === 'month') {
    btnMonth.style.background = 'var(--violet)';
    btnMonth.style.color = '#fff';
    btnMonth.style.border = 'none';

    btnYear.style.background = 'var(--glass)';
    btnYear.style.color = 'var(--text-300)';
    btnYear.style.border = '1px solid var(--border)';

    title.textContent = '월별 독서량';
  } else {
    btnYear.style.background = 'var(--violet)';
    btnYear.style.color = '#fff';
    btnYear.style.border = 'none';

    btnMonth.style.background = 'var(--glass)';
    btnMonth.style.color = 'var(--text-300)';
    btnMonth.style.border = '1px solid var(--border)';

    title.textContent = '연도별 독서량';
  }
  renderChart();
}

/* ==============================================
   MINI CALENDAR
============================================== */
function renderCal() {
  const y = calDate.getFullYear();
  const m = calDate.getMonth();
  document.getElementById('cal-lbl').textContent = `${y}. ${m + 1}`;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  ['일', '월', '화', '수', '목', '금', '토'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-dn';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  const dayMap = {};
  books.forEach(book => {
    if (!book.date) return;
    const d = new Date(book.date);
    if (d.getFullYear() === y && d.getMonth() === m) {
      const day = d.getDate();
      if (!dayMap[day]) dayMap[day] = [];
      dayMap[day].push(book);
    }
  });

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'cal-d empty';
    grid.appendChild(el);
  }

  const today = new Date();
  for (let d = 1; d <= daysInMonth; d++) {
    const el = document.createElement('div');
    el.className = 'cal-d';
    el.textContent = d;

    if (dayMap[d]) {
      el.classList.add('has-book');
      el.title = dayMap[d].map(b => b.title).join(', ');
      const booksOnDay = dayMap[d];
      el.addEventListener('click', () => {
        if (booksOnDay.length >= 1) {
          showDetail(booksOnDay[0].id);
        }
      });
    }

    if (today.getFullYear() === y && today.getMonth() === m && today.getDate() === d) {
      el.classList.add('today');
    }
    grid.appendChild(el);
  }
}

document.getElementById('cal-prev').addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
  renderCal();
});
document.getElementById('cal-next').addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
  renderCal();
});

/* ==============================================
   SIDEBAR TOGGLE (STATS NAVIGATION)
============================================== */
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  showStats();
});
