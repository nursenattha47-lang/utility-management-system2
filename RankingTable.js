/**
 * ============================================================
 * RankingTable.js — Ranked Table Component
 * UtilityManager | PHASE 4E — Analytics Tables
 * ============================================================
 * Provides:
 *   - Site ranking table  (by total spend)
 *   - Highest electricity usage table
 *   - Highest water usage table
 * All three share one reusable class: RankingTable
 * ============================================================
 * Dependencies:
 *   - TableStyles.css (must be loaded in page)
 *   - FilterService.js (optional — for live filter updates)
 * ============================================================
 * Usage:
 *
 *   const siteRank = new RankingTable({
 *     containerId:  '#siteRankingTable',
 *     title:        'Site Ranking',
 *     meterType:    null,       // null = all types (spend)
 *     metric:       'amount',   // 'amount' | 'units'
 *     pageSize:     10,
 *   });
 *   siteRank.setData(bills, sites, meters);
 *
 *   const elecTop = new RankingTable({
 *     containerId:  '#highElecTable',
 *     title:        'Highest Electricity Usage',
 *     meterType:    'ELECTRICITY',
 *     metric:       'units',
 *     pageSize:     10,
 *   });
 *
 * ============================================================
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */

const MONTHS_TH = [
  'ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
  'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.',
];

const METER_TYPE_LABEL = {
  ELECTRICITY: 'ไฟฟ้า',
  WATER:       'น้ำ',
  GAS:         'แก๊ส',
  INTERNET:    'อินเทอร์เน็ต',
};

const METER_TYPE_CLASS = {
  ELECTRICITY: 'electricity',
  WATER:       'water',
  GAS:         'amber',
  INTERNET:    'low',
};

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */

function _fmt(n) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtUnits(n) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

function _compact(n) {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _rankClass(rank) {
  if (rank === 1) return 'at-rank--1';
  if (rank === 2) return 'at-rank--2';
  if (rank === 3) return 'at-rank--3';
  return '';
}

/* Build sorted sort icon HTML */
function _sortIcon(col, sortKey, sortDir) {
  const active = col === sortKey;
  const cls    = active ? (sortDir === 'asc' ? ' sort-asc-active' : ' sort-desc-active') : '';
  return `<span class="at-sort-icon${cls}">
    <span class="at-sort-icon__up"></span>
    <span class="at-sort-icon__down"></span>
  </span>`;
}


/* ─────────────────────────────────────────────────────────────
   CLASS: RankingTable
───────────────────────────────────────────────────────────── */

class RankingTable {
  /**
   * @param {Object}  opts
   * @param {string}  opts.containerId     — selector for host element
   * @param {string}  opts.title           — panel title
   * @param {string}  [opts.titleIcon]     — inline SVG string for icon
   * @param {string}  [opts.iconVariant]   — 'blue'|'teal'|'amber'|'red'|'purple'|'gray'
   * @param {string|null} [opts.meterType] — filter ELECTRICITY|WATER|null (all)
   * @param {'amount'|'units'} [opts.metric] — primary ranking metric
   * @param {number}  [opts.pageSize]      — rows per page (default 10)
   * @param {number}  [opts.top]           — max rows to show (default 50)
   * @param {boolean} [opts.showBarChart]  — inline usage bars (default true)
   * @param {boolean} [opts.showExport]    — CSV export button (default true)
   */
  constructor(opts = {}) {
    this._containerId  = opts.containerId || '#rankingTable';
    this._title        = opts.title       || 'Ranking';
    this._titleIcon    = opts.titleIcon   || _defaultIcon();
    this._iconVariant  = opts.iconVariant || 'blue';
    this._meterType    = opts.meterType   || null;  // null = all
    this._metric       = opts.metric      || 'amount'; // 'amount' | 'units'
    this._pageSize     = opts.pageSize    || 10;
    this._top          = opts.top         || 50;
    this._showBar      = opts.showBarChart !== false;
    this._showExport   = opts.showExport  !== false;

    // Internal state
    this._allRows   = [];   // processed rows (all pages)
    this._filtered  = [];   // after search filter
    this._sortKey   = this._metric === 'amount' ? 'total' : 'totalUnits';
    this._sortDir   = 'desc';
    this._page      = 1;
    this._search    = '';
    this._maxValue  = 0;

    // Bind handlers
    this._onSearch = this._onSearch.bind(this);
    this._onSort   = this._onSort.bind(this);
    this._onPage   = this._onPage.bind(this);
    this._onExport = this._onExport.bind(this);

    this._rendered = false;
  }

  /* ────────────────────────────────────────────
     PUBLIC: setData(bills, sites, meters)
     Processes raw data and re-renders
  ──────────────────────────────────────────── */
  setData(bills = [], sites = [], meters = []) {
    this._allRows  = this._aggregate(bills, sites, meters);
    this._filtered = [...this._allRows];
    this._page     = 1;

    if (!this._rendered) {
      this._buildShell();
      this._rendered = true;
    }

    this._render();
  }

  /* ────────────────────────────────────────────
     PUBLIC: reload(bills, sites, meters)
     Alias for setData — for filter updates
  ──────────────────────────────────────────── */
  reload(bills, sites, meters) {
    this.setData(bills, sites, meters);
  }

  /* ────────────────────────────────────────────
     PUBLIC: setLoading(bool)
  ──────────────────────────────────────────── */
  setLoading(isLoading) {
    const body = this._container?.querySelector('.at-table-container');
    if (!body) return;
    if (isLoading) {
      body.innerHTML = _skeletonRows(8, 5);
    }
  }

  /* ────────────────────────────────────────────
     PRIVATE: _aggregate — summarise bills per site/meter
  ──────────────────────────────────────────── */
  _aggregate(bills, sites, meters) {
    const siteMap = {};
    const nameMap = {};
    const typeMap = {};

    // Build lookup maps
    sites.forEach(s => {
      nameMap[s.site_id] = s.site_name || s.site_code || s.site_id;
    });
    meters.forEach(m => {
      typeMap[m.meter_id] = m.meter_type || 'ELECTRICITY';
    });

    // Filter to meterType if specified
    const filteredBills = this._meterType
      ? bills.filter(b => {
          const mt = b.meter_type || typeMap[b.meter_id] || 'ELECTRICITY';
          return mt === this._meterType;
        })
      : bills.filter(b => !['CANCELLED'].includes(b.bill_status));

    // Aggregate per site
    filteredBills.forEach(b => {
      const id  = b.site_id;
      if (!id) return;
      if (!siteMap[id]) {
        siteMap[id] = {
          siteId:     id,
          siteName:   nameMap[id] || id,
          total:      0,
          totalUnits: 0,
          billCount:  0,
          avgPerBill: 0,
          meterType:  this._meterType || (b.meter_type || typeMap[b.meter_id] || ''),
          lastPeriod: '',
        };
      }
      const e   = siteMap[id];
      e.total      += parseFloat(b.amount_total || 0);
      e.totalUnits += parseFloat(b.units_used   || 0);
      e.billCount  += 1;

      // Track latest period
      const key = `${b.bill_year}-${String(b.bill_month).padStart(2,'0')}`;
      if (!e.lastPeriod || key > e.lastPeriod) {
        e.lastPeriod = key;
        e.lastAmount = parseFloat(b.amount_total || 0);
        e.lastUnits  = parseFloat(b.units_used   || 0);
      }
    });

    // Compute averages and sort
    const rows = Object.values(siteMap).map(e => ({
      ...e,
      avgPerBill: e.billCount > 0 ? e.total / e.billCount : 0,
    }));

    const key = this._sortKey;
    rows.sort((a, b) => (this._sortDir === 'desc' ? b[key] - a[key] : a[key] - b[key]));

    // Top N
    const top = rows.slice(0, this._top);

    // Set maxValue for bar rendering
    this._maxValue = top.reduce((m, r) => {
      const v = this._metric === 'amount' ? r.total : r.totalUnits;
      return Math.max(m, v);
    }, 0);

    return top;
  }

  /* ────────────────────────────────────────────
     PRIVATE: _buildShell — initial DOM scaffold
  ──────────────────────────────────────────── */
  _buildShell() {
    const host = document.querySelector(this._containerId);
    if (!host) {
      console.warn(`[RankingTable] Container not found: ${this._containerId}`);
      return;
    }
    this._container = host;

    const iconCls = `at-panel__title-icon--${this._iconVariant}`;

    host.innerHTML = `
      <div class="at-panel">
        <div class="at-panel__header">
          <div class="at-panel__title">
            <span class="at-panel__title-icon ${iconCls}" aria-hidden="true">
              ${this._titleIcon}
            </span>
            ${_esc(this._title)}
          </div>
          <div class="at-panel__actions">
            <span class="at-count-chip" data-role="countChip">–</span>
            ${this._showExport ? `<button class="at-btn" data-role="export" title="ส่งออก CSV">
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
            <input class="at-search" type="search" placeholder="ค้นหาสถานที่…" data-role="search" aria-label="ค้นหาสถานที่"/>
          </div>
          <div class="at-toolbar__right">
            <select class="at-pagesize" data-role="pagesize" aria-label="จำนวนแถวต่อหน้า">
              <option value="10">10 แถว</option>
              <option value="25">25 แถว</option>
              <option value="50">50 แถว</option>
            </select>
          </div>
        </div>

        <div class="at-table-container" data-role="tableWrap">
          <table class="at-table" role="grid" aria-label="${_esc(this._title)}">
            <thead>
              <tr>
                ${this._buildHeaderRow()}
              </tr>
            </thead>
            <tbody data-role="tbody"></tbody>
          </table>
        </div>

        <div class="at-pagination" data-role="pagination"></div>
      </div>
    `;

    // Wire events
    host.querySelector('[data-role="search"]').addEventListener('input', this._onSearch);
    host.querySelector('[data-role="pagesize"]').addEventListener('change', e => {
      this._pageSize = parseInt(e.target.value);
      this._page     = 1;
      this._render();
    });
    host.querySelectorAll('th.sortable').forEach(th =>
      th.addEventListener('click', this._onSort)
    );
    if (this._showExport) {
      host.querySelector('[data-role="export"]')?.addEventListener('click', this._onExport);
    }
  }

  /* ────────────────────────────────────────────
     PRIVATE: _buildHeaderRow
  ──────────────────────────────────────────── */
  _buildHeaderRow() {
    const si = (col) => _sortIcon(col, this._sortKey, this._sortDir);

    const isAmount = this._metric === 'amount';
    const unitLabel = this._meterType === 'WATER' ? 'หน่วย (m³)' : 'หน่วย (kWh)';

    return `
      <th class="at-col--center" style="width:46px">อันดับ</th>
      <th class="sortable" data-sort="siteName">
        <span class="at-th-inner">สถานที่ ${si('siteName')}</span>
      </th>
      ${this._meterType ? '' : `
      <th class="at-col--hide-mobile" style="width:90px">ประเภท</th>
      `}
      <th class="at-col--num sortable" data-sort="total">
        <span class="at-th-inner">ยอดรวม (฿) ${si('total')}</span>
      </th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="totalUnits">
        <span class="at-th-inner">${unitLabel} ${si('totalUnits')}</span>
      </th>
      <th class="at-col--num sortable at-col--hide-mobile" data-sort="avgPerBill">
        <span class="at-th-inner">เฉลี่ย/บิล (฿) ${si('avgPerBill')}</span>
      </th>
      <th class="at-col--num sortable" data-sort="billCount">
        <span class="at-th-inner">จำนวนบิล ${si('billCount')}</span>
      </th>
    `;
  }

  /* ────────────────────────────────────────────
     PRIVATE: _render — update table body + pagination
  ──────────────────────────────────────────── */
  _render() {
    if (!this._container) return;

    // Re-apply search filter
    const q = this._search.trim().toLowerCase();
    this._filtered = q
      ? this._allRows.filter(r => r.siteName.toLowerCase().includes(q))
      : [...this._allRows];

    // Re-sort
    this._applySort();

    const total      = this._filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / this._pageSize));
    if (this._page > totalPages) this._page = totalPages;

    const start = (this._page - 1) * this._pageSize;
    const end   = Math.min(start + this._pageSize, total);
    const page  = this._filtered.slice(start, end);

    // Update count chip
    const chip = this._container.querySelector('[data-role="countChip"]');
    if (chip) {
      chip.textContent = `${total} สถานที่`;
      chip.classList.toggle('has-data', total > 0);
    }

    // Update thead (sort icons change)
    const thead = this._container.querySelector('thead tr');
    if (thead) thead.innerHTML = this._buildHeaderRow();
    this._container.querySelectorAll('th.sortable').forEach(th =>
      th.addEventListener('click', this._onSort)
    );

    // Render rows
    const tbody = this._container.querySelector('[data-role="tbody"]');
    if (!tbody) return;

    if (total === 0) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="at-empty">
            <div class="at-empty__icon">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 7v5M11 15h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="1.4"/></svg>
            </div>
            <div class="at-empty__title">ไม่พบข้อมูล</div>
            <div class="at-empty__sub">ลองเปลี่ยนตัวกรองหรือคำค้นหา</div>
          </div>
        </td></tr>`;
    } else {
      const maxVal = this._maxValue || 1;
      tbody.innerHTML = page.map((row, idx) => this._buildRow(row, start + idx + 1, maxVal)).join('');
    }

    // Pagination
    this._renderPagination(start + 1, end, total, totalPages);
  }

  /* ────────────────────────────────────────────
     PRIVATE: _buildRow
  ──────────────────────────────────────────── */
  _buildRow(row, rank, maxVal) {
    const barPct = maxVal > 0
      ? Math.round(((this._metric === 'amount' ? row.total : row.totalUnits) / maxVal) * 100)
      : 0;
    const barCls = this._meterType === 'WATER' ? 'at-usage-bar__fill--water' : '';
    const typeCls = METER_TYPE_CLASS[row.meterType] || 'low';

    return `<tr>
      <td class="at-col--center">
        <span class="at-rank ${_rankClass(rank)}">${rank}</span>
      </td>
      <td>
        <div class="at-cell-primary">${_esc(row.siteName)}</div>
        <div class="at-cell-sub">${_esc(row.siteId)}</div>
      </td>
      ${this._meterType ? '' : `
      <td class="at-col--hide-mobile">
        <span class="at-badge at-badge--${typeCls}">
          ${_esc(METER_TYPE_LABEL[row.meterType] || row.meterType || '–')}
        </span>
      </td>
      `}
      <td class="at-col--num">
        <div class="at-bar-cell">
          ${this._showBar ? `<div class="at-usage-bar"><div class="at-usage-bar__fill ${barCls}" style="width:${barPct}%"></div></div>` : ''}
          <span class="at-cell-currency"><span class="at-currency-unit">฿</span>${_compact(row.total)}</span>
        </div>
      </td>
      <td class="at-col--num at-col--hide-mobile">
        <span class="at-cell-mono">${_fmtUnits(row.totalUnits)}</span>
      </td>
      <td class="at-col--num at-col--hide-mobile">
        <span class="at-cell-mono">฿${_compact(row.avgPerBill)}</span>
      </td>
      <td class="at-col--num">
        <span class="at-cell-mono">${row.billCount}</span>
      </td>
    </tr>`;
  }

  /* ────────────────────────────────────────────
     PRIVATE: _renderPagination
  ──────────────────────────────────────────── */
  _renderPagination(start, end, total, totalPages) {
    const el = this._container.querySelector('[data-role="pagination"]');
    if (!el) return;

    const pages  = _buildPageButtons(this._page, totalPages);
    const btnHtml = pages.map(p => {
      if (p === '…') return `<span class="at-page-btn at-page-btn--ellipsis">…</span>`;
      const active = p === this._page ? 'at-page-btn--active' : '';
      return `<button class="at-page-btn ${active}" data-pg="${p}" aria-label="หน้า ${p}" ${p === this._page ? 'aria-current="page"' : ''}>${p}</button>`;
    }).join('');

    el.innerHTML = `
      <span class="at-pagination__info">แสดง <span>${start}–${end}</span> จาก <span>${total}</span> รายการ</span>
      <div class="at-pagination__controls">
        <button class="at-page-btn" data-pg="${this._page - 1}" ${this._page <= 1 ? 'disabled' : ''} aria-label="หน้าก่อนหน้า">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M7.5 9L4.5 6l3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        ${btnHtml}
        <button class="at-page-btn" data-pg="${this._page + 1}" ${this._page >= totalPages ? 'disabled' : ''} aria-label="หน้าถัดไป">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 9L7.5 6l-3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    `;

    el.querySelectorAll('[data-pg]').forEach(btn =>
      btn.addEventListener('click', this._onPage)
    );
  }

  /* ────────────────────────────────────────────
     PRIVATE: _applySort
  ──────────────────────────────────────────── */
  _applySort() {
    const key = this._sortKey;
    const dir = this._sortDir;
    this._filtered.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'string') {
        return dir === 'asc' ? av.localeCompare(bv, 'th') : bv.localeCompare(av, 'th');
      }
      return dir === 'asc' ? av - bv : bv - av;
    });
  }

  /* ────────────────────────────────────────────
     EVENT HANDLERS
  ──────────────────────────────────────────── */
  _onSearch(e) {
    this._search = e.target.value;
    this._page   = 1;
    this._render();
  }

  _onSort(e) {
    const th  = e.currentTarget;
    const col = th.dataset.sort;
    if (!col) return;
    if (this._sortKey === col) {
      this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortKey = col;
      this._sortDir = 'desc';
    }
    this._page = 1;
    this._render();
  }

  _onPage(e) {
    const pg = parseInt(e.currentTarget.dataset.pg);
    if (!pg || isNaN(pg)) return;
    const total      = this._filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / this._pageSize));
    if (pg < 1 || pg > totalPages) return;
    this._page = pg;
    this._render();
    // Scroll table back to top on page change
    this._container?.querySelector('.at-table-container')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  _onExport() {
    _exportCSV(this._filtered, this._title);
  }
}


/* ─────────────────────────────────────────────────────────────
   SHARED HELPERS
───────────────────────────────────────────────────────────── */

/** Build pagination page number array with ellipsis */
function _buildPageButtons(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = [];
  pages.push(1);
  if (current > 3) pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) {
    pages.push(p);
  }
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

/** CSV export */
function _exportCSV(rows, title) {
  const headers = ['อันดับ','site_id','ชื่อสถานที่','ยอดรวม (฿)','หน่วยรวม','เฉลี่ย/บิล (฿)','จำนวนบิล'];
  const lines   = [headers.join(',')];
  rows.forEach((r, i) => {
    lines.push([
      i + 1,
      r.siteId,
      `"${r.siteName}"`,
      r.total.toFixed(2),
      r.totalUnits.toFixed(2),
      r.avgPerBill.toFixed(2),
      r.billCount,
    ].join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${title.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Skeleton loading rows */
function _skeletonRows(rowCount, colCount) {
  const widths = ['short','medium','long','medium','short'];
  return `<table class="at-table"><tbody>` +
    Array.from({ length: rowCount }).map(() =>
      `<tr class="at-skeleton-row">${
        Array.from({ length: colCount }).map((_, c) =>
          `<td><div class="at-skeleton-cell at-skeleton-cell--${widths[c % widths.length]}"></div></td>`
        ).join('')
      }</tr>`
    ).join('') +
    `</tbody></table>`;
}

function _defaultIcon() {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M2 11l3-4 3 2 3-5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}


/* ─────────────────────────────────────────────────────────────
   FACTORY FUNCTIONS  (convenience wrappers)
───────────────────────────────────────────────────────────── */

/**
 * Create a Site Ranking table (all types, ranked by total spend)
 * @param {string} containerId
 * @param {Object} [opts]
 * @returns {RankingTable}
 */
function createSiteRankingTable(containerId, opts = {}) {
  return new RankingTable({
    containerId,
    title:       'อันดับสถานที่ — ยอดใช้จ่ายรวม',
    iconVariant: 'blue',
    titleIcon:   `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1l1.8 3.6L13 5.3l-3 2.9.7 4.1L7 10.2l-3.7 2.1.7-4.1-3-2.9 4.2-.7L7 1z"
        stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`,
    meterType:   null,
    metric:      'amount',
    pageSize:    opts.pageSize || 10,
    top:         opts.top      || 50,
    ...opts,
  });
}

/**
 * Create a Highest Electricity Usage table
 * @param {string} containerId
 * @param {Object} [opts]
 * @returns {RankingTable}
 */
function createElectricityRankingTable(containerId, opts = {}) {
  return new RankingTable({
    containerId,
    title:       'สถานที่ใช้ไฟฟ้าสูงสุด',
    iconVariant: 'blue',
    titleIcon:   `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M8.5 1.5L3.5 7.5H7L5.5 12.5L10.5 6.5H7L8.5 1.5Z"
        stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`,
    meterType:   'ELECTRICITY',
    metric:      'units',
    pageSize:    opts.pageSize || 10,
    top:         opts.top      || 50,
    ...opts,
  });
}

/**
 * Create a Highest Water Usage table
 * @param {string} containerId
 * @param {Object} [opts]
 * @returns {RankingTable}
 */
function createWaterRankingTable(containerId, opts = {}) {
  return new RankingTable({
    containerId,
    title:       'สถานที่ใช้น้ำสูงสุด',
    iconVariant: 'teal',
    titleIcon:   `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 2C7 2 3 6.5 3 9a4 4 0 008 0c0-2.5-4-7-4-7z"
        stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`,
    meterType:   'WATER',
    metric:      'units',
    pageSize:    opts.pageSize || 10,
    top:         opts.top      || 50,
    ...opts,
  });
}


/* ─────────────────────────────────────────────────────────────
   EXPORTS
───────────────────────────────────────────────────────────── */

// ESM
export {
  RankingTable,
  createSiteRankingTable,
  createElectricityRankingTable,
  createWaterRankingTable,
};

// CJS / inline
if (typeof window !== 'undefined') {
  window.RankingTable               = RankingTable;
  window.createSiteRankingTable     = createSiteRankingTable;
  window.createElectricityRankingTable = createElectricityRankingTable;
  window.createWaterRankingTable    = createWaterRankingTable;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RankingTable,
    createSiteRankingTable,
    createElectricityRankingTable,
    createWaterRankingTable,
  };
}
