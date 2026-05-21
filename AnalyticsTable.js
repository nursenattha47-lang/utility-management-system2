/**
 * ============================================================
 * AnalyticsTable.js — Analytics Table Engine
 * UtilityManager | PHASE 4E — Analytics Tables
 * ============================================================
 * Provides all 7 analytics table types:
 *   1. MonthlyComparisonTable   — YoY monthly breakdown
 *   2. YearlyComparisonTable    — Year-over-year summary
 *   3. SiteRankingTable         — (delegates to RankingTable.js)
 *   4. ElectricityRankingTable  — (delegates to RankingTable.js)
 *   5. WaterRankingTable        — (delegates to RankingTable.js)
 *   6. AbnormalUsageTable       — anomaly records with severity
 *   7. OutstandingBillsTable    — unpaid / overdue bills
 * ============================================================
 * Shared features (all tables):
 *   - Sortable columns (click header to sort, click again to flip)
 *   - Responsive layout (priority columns hidden on mobile)
 *   - Sticky table headers within scrollable containers
 *   - Client-side pagination (configurable page size)
 *   - Lightweight DOM rendering — no virtual DOM, no framework
 *   - Large dataset support (virtualise via page slicing)
 *   - Search / filter integration
 *   - CSV export
 *   - Skeleton loading state
 *   - FilterService subscriber hook
 * ============================================================
 * Dependencies:
 *   - TableStyles.css    (must be loaded in <head>)
 *   - RankingTable.js    (for tables 3–5)
 *   - FilterService.js   (optional — subscribe to filter changes)
 * ============================================================
 * Usage:
 *
 *   // Initialise all tables
 *   const tables = AnalyticsTables.init({
 *     monthly:     '#tblMonthly',
 *     yearly:      '#tblYearly',
 *     anomaly:     '#tblAbnormal',
 *     outstanding: '#tblOutstanding',
 *   });
 *
 *   // Feed data
 *   tables.setData({ bills, sites, meters, anomalies, payments });
 *
 *   // Subscribe to FilterService (optional)
 *   FilterService.subscribe(({ results, filters }) => {
 *     tables.setData({ bills: results, sites, meters, anomalies });
 *   });
 *
 * ============================================================
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   SHARED UTILITIES
───────────────────────────────────────────────────────────── */

const MONTHS_TH = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
];

const MONTHS_SHORT = [
  'ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
  'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.',
];

function _fmt(n, decimals = 2) {
  if (n == null || n === '' || isNaN(Number(n))) return '–';
  return Number(n).toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function _compact(n) {
  if (n == null || isNaN(n)) return '–';
  const v = Number(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K';
  return _fmt(v, 0);
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _pct(a, b) {
  if (!b || isNaN(b)) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function _deltaHtml(pctVal) {
  if (pctVal == null || isNaN(pctVal)) return '<span class="at-delta at-delta--flat">–</span>';
  const cls   = pctVal > 0 ? 'at-delta--up' : pctVal < 0 ? 'at-delta--down' : 'at-delta--flat';
  const arrow = pctVal > 0 ? '▲' : pctVal < 0 ? '▼' : '–';
  const sign  = pctVal > 0 ? '+' : '';
  return `<span class="at-delta ${cls}"><span class="at-delta__arrow">${arrow}</span>${sign}${Math.abs(pctVal).toFixed(1)}%</span>`;
}

function _badgeHtml(status) {
  const map = {
    PAID:           ['at-badge--paid',           'ชำระแล้ว'],
    APPROVED:       ['at-badge--approved',        'อนุมัติแล้ว'],
    PENDING_REVIEW: ['at-badge--pending-review',  'รอตรวจสอบ'],
    PENDING:        ['at-badge--pending',          'รอดำเนินการ'],
    OVERDUE:        ['at-badge--overdue',          'เลยกำหนด'],
    CANCELLED:      ['at-badge--cancelled',        'ยกเลิก'],
  };
  const [cls, label] = map[status] || ['at-badge--pending', status || '–'];
  return `<span class="at-badge ${cls}">${_esc(label)}</span>`;
}

function _severityBadge(sev) {
  const map = {
    HIGH:   ['at-badge--high',   'HIGH'],
    MEDIUM: ['at-badge--medium', 'MEDIUM'],
    LOW:    ['at-badge--low',    'LOW'],
  };
  const [cls, label] = map[sev] || ['at-badge--low', sev || '–'];
  return `<span class="at-badge ${cls}">${_esc(label)}</span>`;
}

function _sortIcon(col, sortKey, sortDir) {
  const active = col === sortKey;
  return `<span class="at-sort-icon">
    <span class="at-sort-icon__up"   style="${active && sortDir==='asc'  ? 'opacity:1;color:var(--accent)' : ''}"></span>
    <span class="at-sort-icon__down" style="${active && sortDir==='desc' ? 'opacity:1;color:var(--accent)' : ''}"></span>
  </span>`;
}

function _buildPageButtons(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [1];
  if (current > 3) pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

function _exportCSV(headers, rows, filename) {
  const lines = [headers.join(','), ...rows];
  const blob  = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `${filename}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function _skeletonHTML(cols, rows = 6) {
  const widths = ['medium','long','short','medium','num','num','num'];
  return `<tbody>${
    Array.from({length: rows}).map(() =>
      `<tr class="at-skeleton-row">${
        Array.from({length: cols}).map((_,c) =>
          `<td><div class="at-skeleton-cell at-skeleton-cell--${widths[c%widths.length] === 'num' ? 'num' : widths[c%widths.length]}"></div></td>`
        ).join('')
      }</tr>`
    ).join('')
  }</tbody>`;
}

/** Base class shared by all 7 table types */
class _BaseTable {
  constructor(opts) {
    this._containerId = opts.containerId;
    this._title       = opts.title || 'Analytics Table';
    this._icon        = opts.icon  || '';
    this._iconVariant = opts.iconVariant || 'blue';
    this._pageSize    = opts.pageSize || 25;
    this._showExport  = opts.showExport !== false;

    this._sortKey  = opts.defaultSort || '';
    this._sortDir  = 'desc';
    this._page     = 1;
    this._search   = '';

    this._allRows  = [];
    this._filtered = [];

    this._rendered = false;

    this._onSort   = this._onSort.bind(this);
    this._onPage   = this._onPage.bind(this);
    this._onSearch = this._onSearch.bind(this);
    this._onExport = this._onExport.bind(this);
  }

  /* Subclasses implement these */
  _processData(data)          { return []; }
  _buildHeaderCells()         { return ''; }
  _buildRow(row, idx)         { return ''; }
  _csvHeaders()               { return []; }
  _csvRow(row)                { return []; }

  _container() { return document.querySelector(this._containerId); }

  setData(data) {
    this._allRows  = this._processData(data);
    this._filtered = [...this._allRows];
    this._page     = 1;
    if (!this._rendered) { this._buildShell(); this._rendered = true; }
    this._render();
  }

  setLoading(on) {
    const wrap = this._container()?.querySelector('[data-role="tableWrap"]');
    if (wrap && on) {
      const colCount = this._buildHeaderCells().split('<th').length - 1 || 6;
      wrap.innerHTML = `<table class="at-table"><thead><tr>${this._buildHeaderCells()}</tr></thead>${_skeletonHTML(colCount)}</table>`;
    }
  }

  _buildShell() {
    const host = this._container();
    if (!host) { console.warn(`[AnalyticsTable] Not found: ${this._containerId}`); return; }

    const iconCls = `at-panel__title-icon--${this._iconVariant}`;

    host.innerHTML = `
      <div class="at-panel">
        <div class="at-panel__header">
          <div class="at-panel__title">
            <span class="at-panel__title-icon ${iconCls}" aria-hidden="true">${this._icon}</span>
            ${_esc(this._title)}
          </div>
          <div class="at-panel__actions">
            <span class="at-count-chip" data-role="countChip">–</span>
            ${this._showExport ? `<button class="at-btn" data-role="export">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 10v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              CSV
            </button>` : ''}
          </div>
        </div>
        <div class="at-toolbar">
          <div class="at-search-wrap">
            <span class="at-search-wrap__icon">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M10 10l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            </span>
            <input class="at-search" type="search" placeholder="ค้นหา…" data-role="search" aria-label="ค้นหา"/>
          </div>
          <div class="at-toolbar__right">
            <select class="at-pagesize" data-role="pagesize" aria-label="แถวต่อหน้า">
              <option value="10">10</option>
              <option value="25" selected>25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
        <div class="at-table-container" data-role="tableWrap">
          <table class="at-table" role="grid">
            <thead><tr data-role="thead">${this._buildHeaderCells()}</tr></thead>
            <tbody data-role="tbody"></tbody>
          </table>
        </div>
        <div class="at-pagination" data-role="pagination"></div>
      </div>
    `;

    host.querySelector('[data-role="search"]').addEventListener('input', this._onSearch);
    host.querySelector('[data-role="pagesize"]').addEventListener('change', e => {
      this._pageSize = parseInt(e.target.value);
      this._page = 1;
      this._render();
    });
    this._wireSort(host);
    if (this._showExport) host.querySelector('[data-role="export"]')?.addEventListener('click', this._onExport);
  }

  _wireSort(host) {
    (host || this._container())?.querySelectorAll('th.sortable').forEach(th =>
      th.addEventListener('click', this._onSort)
    );
  }

  _render() {
    const host = this._container();
    if (!host) return;

    // Search
    const q = this._search.trim().toLowerCase();
    this._filtered = q ? this._allRows.filter(r => this._searchMatch(r, q)) : [...this._allRows];

    // Sort
    if (this._sortKey) {
      this._filtered.sort((a, b) => {
        const av = a[this._sortKey], bv = b[this._sortKey];
        const dir = this._sortDir === 'asc' ? 1 : -1;
        if (typeof av === 'string') return dir * av.localeCompare(bv, 'th');
        return dir * ((av ?? 0) - (bv ?? 0));
      });
    }

    const total      = this._filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / this._pageSize));
    if (this._page > totalPages) this._page = totalPages;

    const start = (this._page - 1) * this._pageSize;
    const end   = Math.min(start + this._pageSize, total);
    const page  = this._filtered.slice(start, end);

    // Count chip
    const chip = host.querySelector('[data-role="countChip"]');
    if (chip) { chip.textContent = `${total} รายการ`; chip.classList.toggle('has-data', total > 0); }

    // Header (sort icons)
    const thead = host.querySelector('[data-role="thead"]');
    if (thead) { thead.innerHTML = this._buildHeaderCells(); this._wireSort(host); }

    // Body
    const tbody = host.querySelector('[data-role="tbody"]');
    if (!tbody) return;
    tbody.innerHTML = total === 0 ? _emptyState() : page.map((r, i) => this._buildRow(r, start + i)).join('');

    // Pagination
    this._renderPagination(host, start + 1, end, total, totalPages);
  }

  _renderPagination(host, start, end, total, totalPages) {
    const el = host.querySelector('[data-role="pagination"]');
    if (!el) return;

    const pages  = _buildPageButtons(this._page, totalPages);
    const btnHtml = pages.map(p => {
      if (p === '…') return `<span class="at-page-btn at-page-btn--ellipsis">…</span>`;
      const active = p === this._page ? 'at-page-btn--active' : '';
      return `<button class="at-page-btn ${active}" data-pg="${p}" ${p === this._page ? 'aria-current="page"' : ''}>${p}</button>`;
    }).join('');

    el.innerHTML = `
      <span class="at-pagination__info">แสดง <span>${start}–${end}</span> จาก <span>${total}</span></span>
      <div class="at-pagination__controls">
        <button class="at-page-btn" data-pg="${this._page-1}" ${this._page<=1?'disabled':''} aria-label="ก่อนหน้า">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M7.5 9L4.5 6l3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        ${btnHtml}
        <button class="at-page-btn" data-pg="${this._page+1}" ${this._page>=totalPages?'disabled':''} aria-label="ถัดไป">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 9L7.5 6l-3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    `;
    el.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', this._onPage));
  }

  _searchMatch(row, q) {
    return Object.values(row).some(v => String(v ?? '').toLowerCase().includes(q));
  }

  _onSearch(e) { this._search = e.target.value; this._page = 1; this._render(); }
  _onSort(e) {
    const col = e.currentTarget.dataset.sort;
    if (!col) return;
    if (this._sortKey === col) { this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc'; }
    else { this._sortKey = col; this._sortDir = 'desc'; }
    this._page = 1; this._render();
  }
  _onPage(e) {
    const pg = parseInt(e.currentTarget.dataset.pg);
    if (!pg || isNaN(pg)) return;
    const max = Math.max(1, Math.ceil(this._filtered.length / this._pageSize));
    if (pg < 1 || pg > max) return;
    this._page = pg;
    this._render();
    this._container()?.querySelector('.at-table-container')?.scrollTo({top:0, behavior:'smooth'});
  }
  _onExport() {
    _exportCSV(this._csvHeaders(), this._filtered.map(r => this._csvRow(r)), this._title.replace(/\s+/g,'_'));
  }
}

function _emptyState() {
  return `<tr><td colspan="20">
    <div class="at-empty">
      <div class="at-empty__icon">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 7v5M11 15h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="1.4"/></svg>
      </div>
      <div class="at-empty__title">ไม่พบข้อมูล</div>
      <div class="at-empty__sub">ลองเปลี่ยนตัวกรองหรือคำค้นหา</div>
    </div>
  </td></tr>`;
}


/* ═══════════════════════════════════════════════════════════
   TABLE 1 — MonthlyComparisonTable
   Compares each month across two years (current vs previous)
═══════════════════════════════════════════════════════════ */

class MonthlyComparisonTable extends _BaseTable {
  constructor(opts = {}) {
    super({
      containerId:  opts.containerId  || '#tblMonthly',
      title:        opts.title        || 'เปรียบเทียบรายเดือน',
      iconVariant:  'blue',
      icon: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
        <path d="M1 6h12" stroke="currentColor" stroke-width="1.3"/>
        <path d="M4 1v2M10 1v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>`,
      defaultSort:  'monthNum',
      ...opts,
    });
    this._yearA = opts.yearA || '';
    this._yearB = opts.yearB || '';
  }

  _processData({ bills = [] }) {
    // Determine the two most recent years
    const years = [...new Set(bills.map(b => String(b.bill_year)))].sort().reverse();
    this._yearA = years[0] || String(new Date().getFullYear());
    this._yearB = years[1] || String(parseInt(this._yearA) - 1);

    const byMonth = {};
    for (let m = 1; m <= 12; m++) {
      byMonth[m] = { monthNum: m, monthName: MONTHS_SHORT[m-1],
        electricity_a: 0, water_a: 0, total_a: 0,
        electricity_b: 0, water_b: 0, total_b: 0,
        delta: null, billCount_a: 0, billCount_b: 0,
      };
    }

    bills.forEach(b => {
      const y  = String(b.bill_year);
      const m  = parseInt(b.bill_month);
      const mt = (b.meter_type || '').toUpperCase();
      const amt = parseFloat(b.amount_total || 0);
      if (!byMonth[m]) return;
      if (y === this._yearA) {
        byMonth[m].total_a += amt;
        if (mt === 'ELECTRICITY') byMonth[m].electricity_a += amt;
        if (mt === 'WATER')       byMonth[m].water_a += amt;
        byMonth[m].billCount_a++;
      } else if (y === this._yearB) {
        byMonth[m].total_b += amt;
        if (mt === 'ELECTRICITY') byMonth[m].electricity_b += amt;
        if (mt === 'WATER')       byMonth[m].water_b += amt;
        byMonth[m].billCount_b++;
      }
    });

    return Object.values(byMonth).map(r => ({
      ...r,
      delta: _pct(r.total_a, r.total_b),
    }));
  }

  _buildHeaderCells() {
    const s = (k) => _sortIcon(k, this._sortKey, this._sortDir);
    return `
      <th class="sortable" data-sort="monthNum">
        <span class="at-th-inner">เดือน ${s('monthNum')}</span>
      </th>
      <th class="at-col--num sortable" data-sort="electricity_a">
        <span class="at-th-inner">ไฟฟ้า ${_esc(this._yearA)} (฿) ${s('electricity_a')}</span>
      </th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="water_a">
        <span class="at-th-inner">น้ำ ${_esc(this._yearA)} (฿) ${s('water_a')}</span>
      </th>
      <th class="at-col--num sortable" data-sort="total_a">
        <span class="at-th-inner">รวม ${_esc(this._yearA)} (฿) ${s('total_a')}</span>
      </th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="total_b">
        <span class="at-th-inner">รวม ${_esc(this._yearB)} (฿) ${s('total_b')}</span>
      </th>
      <th class="at-col--num sortable" data-sort="delta">
        <span class="at-th-inner">เปลี่ยนแปลง ${s('delta')}</span>
      </th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="billCount_a">
        <span class="at-th-inner">จำนวนบิล ${s('billCount_a')}</span>
      </th>
    `;
  }

  _buildRow(r) {
    return `<tr>
      <td><span class="at-cell-primary">${_esc(r.monthName)}</span></td>
      <td class="at-col--num"><span class="at-cell-mono">฿${_compact(r.electricity_a)}</span></td>
      <td class="at-col--num at-col--hide-mobile"><span class="at-cell-mono">฿${_compact(r.water_a)}</span></td>
      <td class="at-col--num"><span class="at-cell-currency"><span class="at-currency-unit">฿</span>${_compact(r.total_a)}</span></td>
      <td class="at-col--num at-col--hide-mobile"><span class="at-cell-mono">฿${_compact(r.total_b)}</span></td>
      <td class="at-col--num">${_deltaHtml(r.delta)}</td>
      <td class="at-col--num at-col--hide-mobile"><span class="at-cell-mono">${r.billCount_a}</span></td>
    </tr>`;
  }

  _csvHeaders() { return ['เดือน',`ไฟฟ้า_${this._yearA}`,`น้ำ_${this._yearA}`,`รวม_${this._yearA}`,`รวม_${this._yearB}`,'เปลี่ยนแปลง_%','จำนวนบิล']; }
  _csvRow(r)    { return [r.monthName, r.electricity_a.toFixed(2), r.water_a.toFixed(2), r.total_a.toFixed(2), r.total_b.toFixed(2), r.delta != null ? r.delta.toFixed(1)+'%' : '', r.billCount_a]; }
}


/* ═══════════════════════════════════════════════════════════
   TABLE 2 — YearlyComparisonTable
   Year-over-year summary, one row per year
═══════════════════════════════════════════════════════════ */

class YearlyComparisonTable extends _BaseTable {
  constructor(opts = {}) {
    super({
      containerId: opts.containerId || '#tblYearly',
      title:       opts.title       || 'เปรียบเทียบรายปี',
      iconVariant: 'blue',
      icon: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 10l2.5-3.5 2 2 2.5-4 2.5 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 13h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".4"/>
      </svg>`,
      defaultSort: 'year',
      ...opts,
    });
  }

  _processData({ bills = [] }) {
    const byYear = {};
    bills.forEach(b => {
      const y  = String(b.bill_year || '');
      if (!y) return;
      const mt  = (b.meter_type || '').toUpperCase();
      const amt = parseFloat(b.amount_total || 0);
      const u   = parseFloat(b.units_used   || 0);
      if (!byYear[y]) byYear[y] = { year: y, electricity: 0, water: 0, gas: 0, internet: 0, total: 0, totalUnits: 0, billCount: 0 };
      byYear[y].total      += amt;
      byYear[y].totalUnits += u;
      byYear[y].billCount  += 1;
      if (mt === 'ELECTRICITY') byYear[y].electricity += amt;
      if (mt === 'WATER')       byYear[y].water       += amt;
      if (mt === 'GAS')         byYear[y].gas         += amt;
      if (mt === 'INTERNET')    byYear[y].internet    += amt;
    });

    const rows = Object.values(byYear).sort((a, b) => b.year.localeCompare(a.year));

    // Compute YoY delta
    return rows.map((r, i) => ({
      ...r,
      delta: i < rows.length - 1 ? _pct(r.total, rows[i+1].total) : null,
      avgPerBill: r.billCount > 0 ? r.total / r.billCount : 0,
    }));
  }

  _buildHeaderCells() {
    const s = (k) => _sortIcon(k, this._sortKey, this._sortDir);
    return `
      <th class="sortable" data-sort="year"><span class="at-th-inner">ปีงบประมาณ ${s('year')}</span></th>
      <th class="at-col--num sortable" data-sort="electricity"><span class="at-th-inner">ไฟฟ้า (฿) ${s('electricity')}</span></th>
      <th class="at-col--num sortable" data-sort="water"><span class="at-th-inner">น้ำ (฿) ${s('water')}</span></th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="gas"><span class="at-th-inner">แก๊ส (฿) ${s('gas')}</span></th>
      <th class="at-col--num sortable" data-sort="total"><span class="at-th-inner">ยอดรวม (฿) ${s('total')}</span></th>
      <th class="at-col--num sortable" data-sort="delta"><span class="at-th-inner">เทียบปีก่อน ${s('delta')}</span></th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="billCount"><span class="at-th-inner">จำนวนบิล ${s('billCount')}</span></th>
    `;
  }

  _buildRow(r) {
    return `<tr>
      <td><span class="at-cell-primary">${_esc(r.year)}</span></td>
      <td class="at-col--num"><span class="at-cell-mono">฿${_compact(r.electricity)}</span></td>
      <td class="at-col--num"><span class="at-cell-mono">฿${_compact(r.water)}</span></td>
      <td class="at-col--num at-col--hide-mobile"><span class="at-cell-mono">฿${_compact(r.gas)}</span></td>
      <td class="at-col--num"><span class="at-cell-currency"><span class="at-currency-unit">฿</span>${_compact(r.total)}</span></td>
      <td class="at-col--num">${_deltaHtml(r.delta)}</td>
      <td class="at-col--num at-col--hide-mobile"><span class="at-cell-mono">${r.billCount}</span></td>
    </tr>`;
  }

  _csvHeaders() { return ['ปี','ไฟฟ้า','น้ำ','แก๊ส','รวม','เทียบปีก่อน_%','จำนวนบิล']; }
  _csvRow(r)    { return [r.year, r.electricity.toFixed(2), r.water.toFixed(2), r.gas.toFixed(2), r.total.toFixed(2), r.delta != null ? r.delta.toFixed(1) : '', r.billCount]; }
}


/* ═══════════════════════════════════════════════════════════
   TABLE 6 — AbnormalUsageTable
   Anomaly records with severity, type, and site info
═══════════════════════════════════════════════════════════ */

class AbnormalUsageTable extends _BaseTable {
  constructor(opts = {}) {
    super({
      containerId: opts.containerId || '#tblAbnormal',
      title:       opts.title       || 'การใช้พลังงานผิดปกติ',
      iconVariant: 'red',
      icon: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1.5L13 12H1L7 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        <path d="M7 5.5v3M7 10h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>`,
      defaultSort: 'severity',
      ...opts,
    });
  }

  _processData({ anomalies = [], sites = [], meters = [] }) {
    const siteMap   = {};
    const meterMap  = {};
    sites.forEach(s   => siteMap[s.site_id]    = s.site_name  || s.site_id);
    meters.forEach(m  => meterMap[m.meter_id]  = m);

    const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

    return anomalies.map(a => {
      const meter = meterMap[a.meter_id] || {};
      const month = parseInt(a.bill_month) - 1;
      const label = MONTHS_SHORT[month] ?? a.bill_month;
      return {
        anomaly_id:  a.anomaly_id || '',
        siteName:    siteMap[a.site_id || meter.site_id] || a.site_id || '–',
        siteId:      a.site_id || meter.site_id || '',
        meterId:     a.meter_id || '',
        meterType:   (meter.meter_type || a.meter_type || '').toUpperCase(),
        period:      `${label} ${a.bill_year || ''}`,
        periodSort:  `${a.bill_year}-${String(a.bill_month).padStart(2,'0')}`,
        anomalyType: a.anomaly_type || a.type || '',
        severity:    (a.severity || 'LOW').toUpperCase(),
        severityNum: SEV_ORDER[(a.severity || 'LOW').toUpperCase()] ?? 9,
        message:     a.message || '',
        value:       parseFloat(a.value || 0),
        prevValue:   parseFloat(a.prev_value || 0),
        avg6m:       parseFloat(a.avg6m || 0),
        delta:       a.prev_value > 0 ? _pct(parseFloat(a.value||0), parseFloat(a.prev_value||0)) : null,
      };
    });
  }

  _buildHeaderCells() {
    const s = (k) => _sortIcon(k, this._sortKey, this._sortDir);
    return `
      <th class="sortable" data-sort="severityNum"><span class="at-th-inner">ความรุนแรง ${s('severityNum')}</span></th>
      <th class="sortable" data-sort="siteName"><span class="at-th-inner">สถานที่ ${s('siteName')}</span></th>
      <th class="sortable at-col--hide-mobile" data-sort="meterType"><span class="at-th-inner">ประเภท ${s('meterType')}</span></th>
      <th class="sortable" data-sort="period"><span class="at-th-inner">งวด ${s('periodSort')}</span></th>
      <th class="sortable at-col--hide-mobile" data-sort="anomalyType"><span class="at-th-inner">ประเภทผิดปกติ ${s('anomalyType')}</span></th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="value"><span class="at-th-inner">ยอด (฿) ${s('value')}</span></th>
      <th class="at-col--num sortable" data-sort="delta"><span class="at-th-inner">เปลี่ยนแปลง ${s('delta')}</span></th>
      <th class="at-col--hide-mobile">รายละเอียด</th>
    `;
  }

  _buildRow(r) {
    const meterCls = r.meterType === 'WATER' ? 'water' : r.meterType === 'ELECTRICITY' ? 'electricity' : 'low';
    const meterLabel = { ELECTRICITY: 'ไฟฟ้า', WATER: 'น้ำ', GAS: 'แก๊ส', INTERNET: 'เน็ต' }[r.meterType] || r.meterType;
    const rowCls = r.severity === 'HIGH' ? 'at-row--high' : r.severity === 'MEDIUM' ? 'at-row--medium' : '';
    return `<tr class="${rowCls}">
      <td>${_severityBadge(r.severity)}</td>
      <td>
        <div class="at-cell-primary">${_esc(r.siteName)}</div>
        <div class="at-cell-sub">${_esc(r.meterId)}</div>
      </td>
      <td class="at-col--hide-mobile"><span class="at-badge at-badge--${meterCls}">${_esc(meterLabel)}</span></td>
      <td><span class="at-cell-mono">${_esc(r.period)}</span></td>
      <td class="at-col--hide-mobile"><span class="at-cell-mono" style="font-size:0.78rem">${_esc(r.anomalyType)}</span></td>
      <td class="at-col--num at-col--hide-mobile"><span class="at-cell-currency"><span class="at-currency-unit">฿</span>${_compact(r.value)}</span></td>
      <td class="at-col--num">${_deltaHtml(r.delta)}</td>
      <td class="at-col--hide-mobile" style="max-width:200px;font-size:0.78rem;color:var(--text-muted)">${_esc(r.message)}</td>
    </tr>`;
  }

  _csvHeaders() { return ['ความรุนแรง','สถานที่','ประเภทมิเตอร์','งวด','ประเภทผิดปกติ','ยอด','เปลี่ยนแปลง_%','รายละเอียด']; }
  _csvRow(r) {
    return [r.severity, r.siteName, r.meterType, r.period, r.anomalyType, r.value.toFixed(2),
      r.delta != null ? r.delta.toFixed(1) : '', `"${r.message}"`];
  }
}


/* ═══════════════════════════════════════════════════════════
   TABLE 7 — OutstandingBillsTable
   Unpaid / overdue bills, sortable by due date or amount
═══════════════════════════════════════════════════════════ */

class OutstandingBillsTable extends _BaseTable {
  constructor(opts = {}) {
    super({
      containerId: opts.containerId || '#tblOutstanding',
      title:       opts.title       || 'บิลค้างชำระ',
      iconVariant: 'red',
      icon: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 1h10a1 1 0 011 1v10a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/>
        <path d="M4 5h6M4 7h4M4 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>
      </svg>`,
      defaultSort: 'daysOverdue',
      ...opts,
    });
    this._today = new Date();
  }

  _processData({ bills = [], sites = [] }) {
    const siteMap = {};
    sites.forEach(s => siteMap[s.site_id] = s.site_name || s.site_id);

    const OUTSTANDING_STATUSES = ['APPROVED', 'PENDING_REVIEW', 'PENDING', 'OVERDUE'];
    const today = this._today;

    return bills
      .filter(b => OUTSTANDING_STATUSES.includes(b.bill_status))
      .map(b => {
        const dueDate   = b.due_date ? new Date(b.due_date) : null;
        const daysLeft  = dueDate ? Math.round((dueDate - today) / 86400000) : null;
        const isOverdue = b.bill_status === 'OVERDUE' || (daysLeft !== null && daysLeft < 0);
        const daysOverdue = isOverdue && daysLeft !== null ? -daysLeft : 0;
        const monthNum  = parseInt(b.bill_month) - 1;
        return {
          bill_id:      b.bill_id     || '',
          siteName:     siteMap[b.site_id] || b.site_id || '–',
          siteId:       b.site_id    || '',
          meterType:    (b.meter_type || '').toUpperCase(),
          period:       `${MONTHS_SHORT[monthNum] ?? b.bill_month} ${b.bill_year || ''}`,
          periodSort:   `${b.bill_year}-${String(b.bill_month).padStart(2,'0')}`,
          amount:       parseFloat(b.amount_total || 0),
          status:       b.bill_status || 'PENDING',
          dueDate:      b.due_date   || '',
          dueDateFmt:   dueDate ? dueDate.toLocaleDateString('th-TH') : '–',
          daysLeft:     daysLeft,
          daysOverdue:  daysOverdue,
          isOverdue,
        };
      })
      .sort((a, b) => b.daysOverdue - a.daysOverdue || b.amount - a.amount);
  }

  _buildHeaderCells() {
    const s = (k) => _sortIcon(k, this._sortKey, this._sortDir);
    return `
      <th class="sortable" data-sort="status"><span class="at-th-inner">สถานะ ${s('status')}</span></th>
      <th class="sortable" data-sort="siteName"><span class="at-th-inner">สถานที่ ${s('siteName')}</span></th>
      <th class="sortable at-col--hide-mobile" data-sort="meterType"><span class="at-th-inner">ประเภท ${s('meterType')}</span></th>
      <th class="sortable at-col--hide-mobile" data-sort="periodSort"><span class="at-th-inner">งวด ${s('periodSort')}</span></th>
      <th class="at-col--num sortable" data-sort="amount"><span class="at-th-inner">ยอดค้าง (฿) ${s('amount')}</span></th>
      <th class="sortable" data-sort="dueDate"><span class="at-th-inner">ครบกำหนด ${s('dueDate')}</span></th>
      <th class="at-col--num sortable" data-sort="daysOverdue"><span class="at-th-inner">เลยกำหนด (วัน) ${s('daysOverdue')}</span></th>
    `;
  }

  _buildRow(r) {
    const meterCls   = r.meterType === 'WATER' ? 'water' : r.meterType === 'ELECTRICITY' ? 'electricity' : 'low';
    const meterLabel = { ELECTRICITY: 'ไฟฟ้า', WATER: 'น้ำ', GAS: 'แก๊ส', INTERNET: 'เน็ต' }[r.meterType] || r.meterType || '–';
    const rowCls     = r.isOverdue ? 'at-row--overdue' : '';
    const overdueHtml = r.daysOverdue > 0
      ? `<span class="at-badge at-badge--overdue">+${r.daysOverdue} วัน</span>`
      : r.daysLeft !== null && r.daysLeft <= 7
        ? `<span class="at-badge at-badge--pending">${r.daysLeft} วัน</span>`
        : `<span class="at-cell-mono" style="color:var(--text-muted)">${r.daysLeft !== null ? r.daysLeft + ' วัน' : '–'}</span>`;

    return `<tr class="${rowCls}">
      <td>${_badgeHtml(r.status)}</td>
      <td>
        <div class="at-cell-primary">${_esc(r.siteName)}</div>
        <div class="at-cell-sub">${_esc(r.bill_id)}</div>
      </td>
      <td class="at-col--hide-mobile"><span class="at-badge at-badge--${meterCls}">${_esc(meterLabel)}</span></td>
      <td class="at-col--hide-mobile"><span class="at-cell-mono">${_esc(r.period)}</span></td>
      <td class="at-col--num"><span class="at-cell-currency"><span class="at-currency-unit">฿</span>${_compact(r.amount)}</span></td>
      <td><span class="at-cell-mono">${_esc(r.dueDateFmt)}</span></td>
      <td class="at-col--num">${overdueHtml}</td>
    </tr>`;
  }

  _csvHeaders() { return ['สถานะ','สถานที่','ประเภท','งวด','ยอดค้าง','ครบกำหนด','เลยกำหนด_วัน']; }
  _csvRow(r) { return [r.status, r.siteName, r.meterType, r.period, r.amount.toFixed(2), r.dueDateFmt, r.daysOverdue]; }
}


/* ═══════════════════════════════════════════════════════════
   CONTROLLER — AnalyticsTables
   Manages all 7 tables as one unit
═══════════════════════════════════════════════════════════ */

const AnalyticsTables = (() => {

  /** Registered table instances */
  const _instances = new Map();

  /**
   * Initialise analytics tables.
   * @param {Object} opts — map of tableId → containerId selector
   * @param {string} [opts.monthly]      — selector for monthly comparison
   * @param {string} [opts.yearly]       — selector for yearly comparison
   * @param {string} [opts.siteRank]     — selector for site ranking
   * @param {string} [opts.electricity]  — selector for electricity ranking
   * @param {string} [opts.water]        — selector for water ranking
   * @param {string} [opts.anomaly]      — selector for abnormal usage
   * @param {string} [opts.outstanding]  — selector for outstanding bills
   * @param {Object} [tableOpts]         — per-table options (pageSize, etc.)
   * @returns {Object} controller
   */
  function init(opts = {}, tableOpts = {}) {
    if (opts.monthly) {
      _instances.set('monthly', new MonthlyComparisonTable({
        containerId: opts.monthly,
        ...(tableOpts.monthly || {}),
      }));
    }
    if (opts.yearly) {
      _instances.set('yearly', new YearlyComparisonTable({
        containerId: opts.yearly,
        ...(tableOpts.yearly || {}),
      }));
    }
    if (opts.siteRank && window.createSiteRankingTable) {
      _instances.set('siteRank', window.createSiteRankingTable(opts.siteRank, tableOpts.siteRank || {}));
    }
    if (opts.electricity && window.createElectricityRankingTable) {
      _instances.set('electricity', window.createElectricityRankingTable(opts.electricity, tableOpts.electricity || {}));
    }
    if (opts.water && window.createWaterRankingTable) {
      _instances.set('water', window.createWaterRankingTable(opts.water, tableOpts.water || {}));
    }
    if (opts.anomaly) {
      _instances.set('anomaly', new AbnormalUsageTable({
        containerId: opts.anomaly,
        ...(tableOpts.anomaly || {}),
      }));
    }
    if (opts.outstanding) {
      _instances.set('outstanding', new OutstandingBillsTable({
        containerId: opts.outstanding,
        ...(tableOpts.outstanding || {}),
      }));
    }

    return controller;
  }

  /**
   * Feed data to all active tables.
   * @param {Object} data
   * @param {Array}  data.bills
   * @param {Array}  data.sites
   * @param {Array}  data.meters
   * @param {Array}  data.anomalies
   */
  function setData(data = {}) {
    const { bills = [], sites = [], meters = [], anomalies = [] } = data;

    _instances.get('monthly')?.setData({ bills, sites, meters });
    _instances.get('yearly')?.setData({ bills, sites, meters });

    // RankingTable API uses setData(bills, sites, meters)
    _instances.get('siteRank')?.setData(bills, sites, meters);
    _instances.get('electricity')?.setData(bills, sites, meters);
    _instances.get('water')?.setData(bills, sites, meters);

    _instances.get('anomaly')?.setData({ anomalies, sites, meters });
    _instances.get('outstanding')?.setData({ bills, sites });
  }

  /**
   * Show skeleton loading state on all tables.
   */
  function setLoading(on = true) {
    _instances.forEach(t => t.setLoading?.(on));
  }

  /**
   * Subscribe to FilterService.
   * @param {Object} FilterService — FilterService instance
   */
  function subscribeToFilter(FilterService, extraData = {}) {
    FilterService.subscribe(({ results }) => {
      setData({ bills: results, ...extraData });
    });
  }

  /**
   * Get a specific table instance by key.
   * Keys: 'monthly' | 'yearly' | 'siteRank' | 'electricity' | 'water' | 'anomaly' | 'outstanding'
   * @param {string} key
   * @returns {_BaseTable|RankingTable}
   */
  function get(key) { return _instances.get(key); }

  const controller = Object.freeze({ init, setData, setLoading, subscribeToFilter, get });
  return controller;
})();


/* ─────────────────────────────────────────────────────────────
   EXPORTS
───────────────────────────────────────────────────────────── */

// ESM
export {
  AnalyticsTables,
  MonthlyComparisonTable,
  YearlyComparisonTable,
  AbnormalUsageTable,
  OutstandingBillsTable,
};

// CJS / inline script
if (typeof window !== 'undefined') {
  window.AnalyticsTables         = AnalyticsTables;
  window.MonthlyComparisonTable  = MonthlyComparisonTable;
  window.YearlyComparisonTable   = YearlyComparisonTable;
  window.AbnormalUsageTable      = AbnormalUsageTable;
  window.OutstandingBillsTable   = OutstandingBillsTable;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AnalyticsTables,
    MonthlyComparisonTable,
    YearlyComparisonTable,
    AbnormalUsageTable,
    OutstandingBillsTable,
  };
}
