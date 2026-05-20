/**
 * ============================================================
 * Charts.js — Chart Manager & Lifecycle Engine
 * UtilityManager | PHASE 4C — Charts Module
 * ============================================================
 * Provides:
 *   - Lazy loading via IntersectionObserver (charts only render
 *     when their container scrolls into view)
 *   - Single ChartManager registry (prevents duplicate instances)
 *   - Data fetching from GAS Web App endpoints
 *   - Period filter integration (connects to #periodSelect)
 *   - Resize handler with debounce
 *   - Destroy / remount lifecycle
 *   - Graceful error & empty states
 * ============================================================
 * Dependencies:
 *   - Chart.js ≥ 4.x  (loaded from CDN before this script)
 *   - ChartConfig.js  (must be imported/loaded before Charts.js)
 * ============================================================
 * Usage (in Dashboard HTML after both scripts):
 *
 *   Charts.init({
 *     baseUrl: 'https://script.google.com/macros/s/xxxxx/exec',
 *     token:   sessionStorage.getItem('token'),
 *   });
 *
 * Or mount individual charts:
 *
 *   Charts.mount('monthlyTrend', '#chartSpend');
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// SECTION 1 — CHART REGISTRY
// Central store for all Chart.js instances.
// ─────────────────────────────────────────────────────────────

const _registry = new Map();   // id → { chart, container, config, observer }

/**
 * Register a chart instance.
 * @param {string}     id
 * @param {Chart}      chart     — Chart.js instance
 * @param {Element}    container — wrapper div
 * @param {Object}     meta      — { type, period }
 */
function _register(id, chart, container, meta = {}) {
  _registry.set(id, { chart, container, meta });
}

/**
 * Destroy and unregister a chart by id.
 * @param {string} id
 */
function _destroy(id) {
  const entry = _registry.get(id);
  if (!entry) return;
  try { entry.chart?.destroy(); } catch (_) { /* ignore */ }
  if (entry.observer) entry.observer.disconnect();
  _registry.delete(id);
}

/** Destroy all registered charts. */
function _destroyAll() {
  for (const id of _registry.keys()) _destroy(id);
}


// ─────────────────────────────────────────────────────────────
// SECTION 2 — CANVAS HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Get or create a <canvas> inside a container element.
 * Reuses existing canvas if present.
 *
 * @param {Element|string} containerOrSelector
 * @param {string}         chartId  — used as canvas id
 * @param {number}         [height] — explicit pixel height
 * @returns {{ canvas: HTMLCanvasElement, isNew: boolean }}
 */
function _getCanvas(containerOrSelector, chartId, height) {
  const container = typeof containerOrSelector === 'string'
    ? document.querySelector(containerOrSelector)
    : containerOrSelector;

  if (!container) {
    console.warn(`[Charts] Container not found: ${containerOrSelector}`);
    return { canvas: null, isNew: false };
  }

  let canvas = container.querySelector(`canvas#${chartId}`);
  let isNew  = false;

  if (!canvas) {
    // Remove placeholder content
    container.querySelectorAll('.panel__placeholder, .placeholder-bars, .donut-placeholder')
             .forEach(el => el.remove());

    canvas = document.createElement('canvas');
    canvas.id = chartId;
    canvas.style.cssText = 'display:block;width:100%;';
    if (height) canvas.style.height = height + 'px';
    container.appendChild(canvas);
    isNew = true;
  }

  return { canvas, container, isNew };
}

/**
 * Show an error state inside a container.
 * @param {Element} container
 * @param {string}  [message]
 */
function _showError(container, message = 'ไม่สามารถโหลดข้อมูลได้') {
  if (!container) return;
  container.innerHTML = `
    <div class="chart-error-state" role="alert"
         style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;gap:10px;color:var(--text-muted,#9CA3AF);padding:24px;text-align:center;">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <circle cx="18" cy="18" r="16" stroke="currentColor" stroke-width="1.5" opacity=".4"/>
        <path d="M18 11v8M18 23h.01" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <p style="font-size:0.8125rem;margin:0;">${message}</p>
    </div>`;
}

/**
 * Show a loading skeleton inside a container.
 * @param {Element} container
 */
function _showLoading(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="chart-loading-state" aria-label="กำลังโหลด..."
         style="display:flex;align-items:flex-end;gap:6px;
                height:100%;padding:24px 16px 8px;box-sizing:border-box;">
      ${Array.from({ length: 12 }, (_, i) => {
        const h = [40, 65, 50, 80, 60, 75, 45, 90, 55, 70, 85, 95][i % 12];
        const delay = (i * 0.08).toFixed(2);
        return `<div style="flex:1;height:${h}%;border-radius:3px 3px 0 0;
                            background:linear-gradient(90deg,var(--border-light,#F0EEE9) 0%,
                            var(--border,#E5E3DF) 50%,var(--border-light,#F0EEE9) 100%);
                            background-size:200% 100%;
                            animation:shimmer 1.6s ease ${delay}s infinite;"></div>`;
      }).join('')}
    </div>`;
}

/**
 * Show empty-state message inside a container.
 * @param {Element} container
 * @param {string}  [message]
 */
function _showEmpty(container, message = 'ยังไม่มีข้อมูลในช่วงเวลานี้') {
  if (!container) return;
  container.innerHTML = `
    <div class="chart-empty-state"
         style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;gap:10px;color:var(--text-muted,#9CA3AF);padding:24px;text-align:center;">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect x="6" y="4" width="24" height="28" rx="3" stroke="currentColor" stroke-width="1.5" opacity=".4"/>
        <path d="M12 13h12M12 19h12M12 25h8" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" opacity=".4"/>
      </svg>
      <p style="font-size:0.8125rem;margin:0;">${message}</p>
    </div>`;
}


// ─────────────────────────────────────────────────────────────
// SECTION 3 — LAZY LOADING (IntersectionObserver)
// ─────────────────────────────────────────────────────────────

/** Map of pending lazy mounts: container → renderFn */
const _lazyQueue = new Map();
let   _io        = null;

function _ensureObserver() {
  if (_io) return _io;

  _io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const fn = _lazyQueue.get(entry.target);
      if (fn) {
        fn();
        _lazyQueue.delete(entry.target);
        _io.unobserve(entry.target);
      }
    });
  }, {
    rootMargin: '80px 0px',   // pre-render 80px before visible
    threshold:  0,
  });

  return _io;
}

/**
 * Lazily mount a chart when its container enters the viewport.
 * Shows a loading skeleton until mount fires.
 *
 * @param {Element}  container
 * @param {Function} renderFn   — called once when visible
 */
function _lazyMount(container, renderFn) {
  if (!container) return;

  // If already visible (e.g. above-fold), render immediately
  const rect = container.getBoundingClientRect();
  if (rect.top < window.innerHeight + 80) {
    renderFn();
    return;
  }

  _showLoading(container);
  _lazyQueue.set(container, renderFn);
  _ensureObserver().observe(container);
}


// ─────────────────────────────────────────────────────────────
// SECTION 4 — RESIZE HANDLER
// ─────────────────────────────────────────────────────────────

let _resizeTimer = null;

function _onResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    _registry.forEach(({ chart }) => {
      try { chart?.resize(); } catch (_) { /* ignore */ }
    });
    // Refresh tokens in case CSS vars changed (e.g. theme switch)
    ChartConfig.tokens.refresh();
  }, 180);
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', _onResize, { passive: true });
}


// ─────────────────────────────────────────────────────────────
// SECTION 5 — DATA FETCHING
// GAS Web App ► JSON ► chart data shape
// ─────────────────────────────────────────────────────────────

let _baseUrl = '';
let _token   = '';

/**
 * Fetch data from GAS Web App.
 * @param {string} action
 * @param {Object} [params]
 * @returns {Promise<Object>}  API data payload
 */
async function _fetch(action, params = {}) {
  const qs = new URLSearchParams({ action, token: _token, ...params });
  const res = await fetch(`${_baseUrl}?${qs.toString()}`, {
    method:  'GET',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.message || 'API error');
  return json.data;
}


// ─────────────────────────────────────────────────────────────
// SECTION 6 — DATA TRANSFORMERS
// Convert GAS API responses into ChartConfig-compatible shapes.
// ─────────────────────────────────────────────────────────────

/**
 * Group bills by month and meter_type, compute monthly totals.
 * @param {Object[]} bills
 * @param {number}   [monthCount=12]
 * @returns {{ labels, electricity, water, gas, internet }}
 */
function _transformMonthly(bills, monthCount = 12) {
  const MONTHS_TH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                     'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

  // Build last N months list
  const now     = new Date();
  const periods = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d  = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m  = d.getMonth() + 1;
    const y  = d.getFullYear() + 543;
    periods.push({
      key:   `${y}-${String(m).padStart(2, '0')}`,
      label: `${MONTHS_TH[m - 1]} ${String(y).slice(-2)}`,
    });
  }

  const totals = { electricity: {}, water: {}, gas: {}, internet: {} };

  (bills || []).forEach(b => {
    const key = b.bill_period_key;
    const amt = parseFloat(b.amount_total || 0);
    const type = (b.meter_type || '').toUpperCase();
    const map = {
      ELECTRICITY: 'electricity',
      WATER:       'water',
      GAS:         'gas',
      INTERNET:    'internet',
    };
    const cat = map[type];
    if (!cat) return;
    totals[cat][key] = (totals[cat][key] || 0) + amt;
  });

  return {
    labels:      periods.map(p => p.label),
    electricity: periods.map(p => totals.electricity[p.key] || 0),
    water:       periods.map(p => totals.water[p.key]       || 0),
    gas:         periods.map(p => totals.gas[p.key]         || 0),
    internet:    periods.map(p => totals.internet[p.key]    || 0),
  };
}

/**
 * Group bills by year and meter_type.
 * @param {Object[]} bills
 * @returns {{ years, series }}
 */
function _transformYearly(bills) {
  const yearMap = {};

  (bills || []).forEach(b => {
    const y    = String(b.bill_year || '');
    const amt  = parseFloat(b.amount_total || 0);
    const type = (b.meter_type || '').toUpperCase();
    if (!y) return;
    if (!yearMap[y]) yearMap[y] = { electricity: 0, water: 0, gas: 0, internet: 0 };
    const map = { ELECTRICITY: 'electricity', WATER: 'water', GAS: 'gas', INTERNET: 'internet' };
    const cat = map[type];
    if (cat) yearMap[y][cat] += amt;
  });

  const years = Object.keys(yearMap).sort();
  return {
    years,
    series: {
      electricity: years.map(y => yearMap[y].electricity),
      water:       years.map(y => yearMap[y].water),
      gas:         years.map(y => yearMap[y].gas),
      internet:    years.map(y => yearMap[y].internet),
    },
  };
}

/**
 * Aggregate bills per site, sort descending.
 * @param {Object[]} bills
 * @param {Object[]} sites   — for display names
 * @param {number}  [top=10]
 * @returns {{ sites, amounts, avgLine }}
 */
function _transformSiteComparison(bills, sites, top = 10) {
  const siteMap = {};
  const nameMap = {};

  (sites || []).forEach(s => {
    nameMap[s.site_id] = s.site_name || s.site_code || s.site_id;
  });

  (bills || []).forEach(b => {
    const id  = b.site_id;
    const amt = parseFloat(b.amount_total || 0);
    siteMap[id] = (siteMap[id] || 0) + amt;
  });

  const sorted = Object.entries(siteMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);

  const amounts  = sorted.map(([, v]) => v);
  const avgLine  = amounts.length ? amounts.reduce((s, v) => s + v, 0) / amounts.length : 0;

  return {
    sites:   sorted.map(([id]) => nameMap[id] || id),
    amounts,
    avgLine: Math.round(avgLine),
  };
}

/**
 * Build usage trend data for a single meter.
 * @param {Object[]} bills    — filtered to single meter, sorted by period
 * @param {Object[]} anomalies — anomaly records for this meter
 * @returns {{ labels, usage, avg6m, upperBand, anomalies[] }}
 */
function _transformUsageTrend(bills, anomalies) {
  const MONTHS_TH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                     'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

  const sorted = [...(bills || [])].sort((a, b) =>
    String(a.bill_period_key).localeCompare(String(b.bill_period_key))
  );

  const labels    = sorted.map(b => {
    const m = parseInt(b.bill_month) - 1;
    const y = String(b.bill_year).slice(-2);
    return `${MONTHS_TH[m] || b.bill_month} ${y}`;
  });

  const usage = sorted.map(b => parseFloat(b.amount_total || 0));

  // Rolling 6-month average
  const avg6m = usage.map((_, i) => {
    const slice = usage.slice(Math.max(0, i - 5), i + 1);
    return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : 0;
  });

  // Upper band = avg6m × 1.30 (30% spike threshold from Config.gs)
  const upperBand = avg6m.map(v => Math.round(v * 1.30));

  // Map anomaly records to index positions
  const anomalyMarkers = (anomalies || []).flatMap(a => {
    const idx = sorted.findIndex(
      b => String(b.bill_year) === String(a.bill_year) &&
           String(b.bill_month) === String(a.bill_month)
    );
    return idx >= 0 ? [{ index: idx, severity: a.severity, type: a.anomaly_type }] : [];
  });

  return { labels, usage, avg6m, upperBand, anomalies: anomalyMarkers };
}


// ─────────────────────────────────────────────────────────────
// SECTION 7 — INDIVIDUAL CHART RENDERERS
// Each function fetches data, transforms, then mounts the chart.
// ─────────────────────────────────────────────────────────────

/**
 * Render the monthly trend chart into #chartSpend.
 * @param {Object} [overrides]  — pass pre-fetched data to skip API call
 */
async function renderMonthlyTrend(overrides = {}) {
  const containerId = overrides.containerId || '#chartSpend';
  const container   = document.querySelector(containerId);
  if (!container) return;

  const chartId = 'chart-monthly-trend';
  _destroy(chartId);
  _showLoading(container);

  try {
    let bills;
    if (overrides.bills) {
      bills = overrides.bills;
    } else {
      const data = await _fetch('bills.list', {
        bill_year: overrides.year || '',
      });
      bills = data?.bills || data || [];
    }

    if (!bills.length) { _showEmpty(container); return; }

    const chartData = _transformMonthly(bills, 12);

    // Remove loading state
    container.innerHTML = '';
    const { canvas } = _getCanvas(container, chartId);
    if (!canvas) return;

    const cfg   = ChartConfig.monthlyTrend(chartData, {
      showLegend: true,
      title: overrides.title || '',
    });
    const chart = new Chart(canvas, cfg);
    _register(chartId, chart, container, { type: 'monthlyTrend' });

  } catch (err) {
    console.error('[Charts] renderMonthlyTrend:', err);
    _showError(container, 'ไม่สามารถโหลดข้อมูลได้ กรุณาลองใหม่');
  }
}

/**
 * Render the yearly trend chart.
 * @param {Object} [overrides]
 */
async function renderYearlyTrend(overrides = {}) {
  const containerId = overrides.containerId || '#chartYearly';
  const container   = document.querySelector(containerId);
  if (!container) return;

  const chartId = 'chart-yearly-trend';
  _destroy(chartId);
  _showLoading(container);

  try {
    let bills;
    if (overrides.bills) {
      bills = overrides.bills;
    } else {
      const data = await _fetch('bills.list');
      bills = data?.bills || data || [];
    }

    if (!bills.length) { _showEmpty(container); return; }

    const chartData = _transformYearly(bills);

    container.innerHTML = '';
    const { canvas } = _getCanvas(container, chartId);
    if (!canvas) return;

    const cfg   = ChartConfig.yearlyTrend(chartData, { title: overrides.title || '' });
    const chart = new Chart(canvas, cfg);
    _register(chartId, chart, container, { type: 'yearlyTrend' });

  } catch (err) {
    console.error('[Charts] renderYearlyTrend:', err);
    _showError(container);
  }
}

/**
 * Render water vs electricity dual-axis chart.
 * @param {Object} [overrides]
 */
async function renderWaterVsElectricity(overrides = {}) {
  const containerId = overrides.containerId || '#chartWaterElec';
  const container   = document.querySelector(containerId);
  if (!container) return;

  const chartId = 'chart-water-vs-elec';
  _destroy(chartId);
  _showLoading(container);

  try {
    let bills;
    if (overrides.bills) {
      bills = overrides.bills;
    } else {
      const data = await _fetch('bills.list', { bill_year: overrides.year || '' });
      bills = data?.bills || data || [];
    }

    if (!bills.length) { _showEmpty(container); return; }

    const monthly = _transformMonthly(bills, 12);
    const chartData = {
      labels:      monthly.labels,
      electricity: monthly.electricity,
      water:       monthly.water,
    };

    container.innerHTML = '';
    const { canvas } = _getCanvas(container, chartId);
    if (!canvas) return;

    const cfg   = ChartConfig.waterVsElectricity(chartData, {});
    const chart = new Chart(canvas, cfg);
    _register(chartId, chart, container, { type: 'waterVsElectricity' });

  } catch (err) {
    console.error('[Charts] renderWaterVsElectricity:', err);
    _showError(container);
  }
}

/**
 * Render site comparison horizontal bar chart.
 * @param {Object} [overrides]
 * @param {string} [overrides.period]    — bill_period_key filter
 * @param {number} [overrides.top=10]
 */
async function renderSiteComparison(overrides = {}) {
  const containerId = overrides.containerId || '#chartSites';
  const container   = document.querySelector(containerId);
  if (!container) return;

  const chartId = 'chart-site-comparison';
  _destroy(chartId);
  _showLoading(container);

  try {
    let bills, sites;

    if (overrides.bills && overrides.sites) {
      bills = overrides.bills;
      sites = overrides.sites;
    } else {
      const params = {};
      if (overrides.period) {
        const [year, month] = overrides.period.split('-');
        if (year)  params.bill_year  = year;
        if (month) params.bill_month = month;
      }
      const [billsData, sitesData] = await Promise.all([
        _fetch('bills.list', params),
        _fetch('sites.list'),
      ]);
      bills = billsData?.bills || billsData || [];
      sites = sitesData?.sites || sitesData || [];
    }

    if (!bills.length) { _showEmpty(container); return; }

    const top       = overrides.top || 10;
    const chartData = _transformSiteComparison(bills, sites, top);

    // Dynamic height: 48px per site + padding
    const height = Math.max(200, chartData.sites.length * 48 + 40);
    container.style.height = height + 'px';

    container.innerHTML = '';
    const { canvas } = _getCanvas(container, chartId, height);
    if (!canvas) return;

    const cfg   = ChartConfig.siteComparison(chartData, {});
    const chart = new Chart(canvas, cfg);
    _register(chartId, chart, container, { type: 'siteComparison' });

  } catch (err) {
    console.error('[Charts] renderSiteComparison:', err);
    _showError(container);
  }
}

/**
 * Render usage trend analysis chart for a specific meter.
 * @param {Object}  overrides
 * @param {string}  overrides.meterId        — required
 * @param {string}  [overrides.containerId]
 * @param {string}  [overrides.meterType]    — 'ELECTRICITY' | 'WATER'
 * @param {number}  [overrides.months=18]
 */
async function renderUsageTrend(overrides = {}) {
  const containerId = overrides.containerId || '#chartUsageTrend';
  const container   = document.querySelector(containerId);
  if (!container) return;

  const meterId = overrides.meterId;
  if (!meterId) {
    _showEmpty(container, 'กรุณาเลือกมิเตอร์เพื่อดูการวิเคราะห์');
    return;
  }

  const chartId = `chart-usage-trend-${meterId}`;
  _destroy(chartId);
  _showLoading(container);

  try {
    let bills, anomalies;

    if (overrides.bills) {
      bills     = overrides.bills;
      anomalies = overrides.anomalies || [];
    } else {
      const [billsData, anomalyData] = await Promise.all([
        _fetch('bills.list', { meter_id: meterId }),
        _fetch('anomalies.list', { meter_id: meterId }).catch(() => ({ anomalies: [] })),
      ]);
      bills     = billsData?.bills     || billsData     || [];
      anomalies = anomalyData?.anomalies || anomalyData  || [];
    }

    // Limit to last N months
    const months = overrides.months || 18;
    const sorted = [...bills]
      .filter(b => b.bill_status !== 'CANCELLED')
      .sort((a, b) => String(a.bill_period_key).localeCompare(String(b.bill_period_key)))
      .slice(-months);

    if (!sorted.length) { _showEmpty(container); return; }

    const chartData = _transformUsageTrend(sorted, anomalies);

    container.innerHTML = '';
    const { canvas } = _getCanvas(container, chartId);
    if (!canvas) return;

    const cfg   = ChartConfig.usageTrend(chartData, {
      meterType: overrides.meterType || 'ELECTRICITY',
      yLabel:    overrides.yLabel    || 'ยอด (฿)',
    });
    const chart = new Chart(canvas, cfg);
    _register(chartId, chart, container, { type: 'usageTrend', meterId });

  } catch (err) {
    console.error('[Charts] renderUsageTrend:', err);
    _showError(container);
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 8 — PERIOD FILTER INTEGRATION
// Wires the #periodSelect dropdown to refresh all charts.
// ─────────────────────────────────────────────────────────────

let _currentPeriod = '';

function _bindPeriodSelect() {
  const select = document.getElementById('periodSelect');
  if (!select) return;

  select.addEventListener('change', () => {
    _currentPeriod = select.value;
    // Refresh charts that depend on period
    renderMonthlyTrend({ period: _currentPeriod });
    renderSiteComparison({ period: _currentPeriod });
    renderWaterVsElectricity({ year: _currentPeriod?.split('-')[0] });
  });
}


// ─────────────────────────────────────────────────────────────
// SECTION 9 — CHART TYPE FILTER (tab buttons in panel header)
// Wires .tab-btn[data-filter] buttons to switch datasets.
// ─────────────────────────────────────────────────────────────

function _bindTypeFilter() {
  const group = document.querySelector('.tab-group[aria-label]');
  if (!group) return;

  group.addEventListener('click', async (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;

    const filter = btn.dataset.filter;
    if (!filter) return;

    // Update active state
    group.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('tab-btn--active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });

    // Re-render monthly trend with type filter
    const monthlyEntry = _registry.get('chart-monthly-trend');
    if (!monthlyEntry) return;

    try {
      const data = await _fetch('bills.list', { bill_year: _currentPeriod?.split('-')[0] || '' });
      const bills = data?.bills || data || [];

      const monthly = _transformMonthly(bills, 12);
      const show = filter === 'all'
        ? monthly
        : {
            labels:      monthly.labels,
            electricity: filter === 'electricity' ? monthly.electricity : [],
            water:       filter === 'water'       ? monthly.water       : [],
            gas:         filter === 'gas'         ? monthly.gas         : [],
            internet:    filter === 'internet'    ? monthly.internet    : [],
          };

      const newCfg = ChartConfig.monthlyTrend(show, { showLegend: true });
      const chart  = monthlyEntry.chart;
      chart.data   = newCfg.data;
      chart.update('active');
    } catch (err) {
      console.warn('[Charts] _bindTypeFilter:', err.message);
    }
  });
}


// ─────────────────────────────────────────────────────────────
// SECTION 10 — PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Initialize the chart manager.
 * Call once after DOM ready.
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl  — GAS Web App deployment URL
 * @param {string} opts.token    — session token from Auth.gs
 * @param {Object} [opts.lazy]   — override per-chart lazy defaults
 */
function init(opts = {}) {
  if (!opts.baseUrl) {
    console.warn('[Charts] baseUrl is required for API calls.');
  }

  _baseUrl = opts.baseUrl || '';
  _token   = opts.token   || '';

  // Register Chart.js global defaults once
  _applyChartJsDefaults();

  // Wire UI bindings
  _bindPeriodSelect();
  _bindTypeFilter();

  // Lazy-mount all standard chart containers
  _mountAll(opts.lazy || {});
}

/**
 * Apply Chart.js global defaults once.
 * Keeps individual configs lean.
 */
function _applyChartJsDefaults() {
  if (typeof Chart === 'undefined') {
    console.error('[Charts] Chart.js not found. Load it before Charts.js.');
    return;
  }
  const t = ChartConfig.tokens.get();

  Chart.defaults.color         = t.textMuted;
  Chart.defaults.font.family   = t.fontUI;
  Chart.defaults.font.size     = 12;
  Chart.defaults.responsive    = true;
  Chart.defaults.animation.duration = 700;
}

/**
 * Lazy-mount all charts that have matching container IDs in the DOM.
 * Unknown containers are silently skipped.
 */
function _mountAll(lazyOpts = {}) {
  const specs = [
    { id: '#chartSpend',       fn: () => renderMonthlyTrend()      },
    { id: '#chartYearly',      fn: () => renderYearlyTrend()       },
    { id: '#chartWaterElec',   fn: () => renderWaterVsElectricity() },
    { id: '#chartSites',       fn: () => renderSiteComparison()    },
    { id: '#chartUsageTrend',  fn: () => renderUsageTrend({
        meterId: document.querySelector('#chartUsageTrend')
          ?.dataset?.meterId || '',
      })
    },
  ];

  specs.forEach(({ id, fn }) => {
    const el = document.querySelector(id);
    if (!el) return;
    const disableLazy = lazyOpts[id] === false;
    disableLazy ? fn() : _lazyMount(el, fn);
  });
}

/**
 * Mount a single chart by type into a selector or element.
 *
 * @param {'monthlyTrend'|'yearlyTrend'|'waterVsElectricity'|'siteComparison'|'usageTrend'} type
 * @param {string|Element} container
 * @param {Object} [opts]   — passed to the render function
 */
function mount(type, container, opts = {}) {
  const el = typeof container === 'string'
    ? document.querySelector(container)
    : container;
  if (!el) { console.warn(`[Charts] mount: container not found: ${container}`); return; }

  const overrides = { containerId: null, ...opts };
  // Patch the container reference by injecting a temporary id
  const tmpId = `_charts_tmp_${Date.now()}`;
  el.id = el.id || tmpId;
  overrides.containerId = `#${el.id}`;

  const fns = {
    monthlyTrend:       () => renderMonthlyTrend(overrides),
    yearlyTrend:        () => renderYearlyTrend(overrides),
    waterVsElectricity: () => renderWaterVsElectricity(overrides),
    siteComparison:     () => renderSiteComparison(overrides),
    usageTrend:         () => renderUsageTrend(overrides),
  };

  const fn = fns[type];
  if (!fn) { console.warn(`[Charts] Unknown type: ${type}`); return; }
  _lazyMount(el, fn);
}

/**
 * Refresh a chart by its registered id (e.g. after data changes).
 * @param {string} chartId
 */
function refresh(chartId) {
  const entry = _registry.get(chartId);
  if (!entry) return;
  const type = entry.meta?.type;
  const fns  = {
    monthlyTrend:       renderMonthlyTrend,
    yearlyTrend:        renderYearlyTrend,
    waterVsElectricity: renderWaterVsElectricity,
    siteComparison:     renderSiteComparison,
    usageTrend:         () => renderUsageTrend({ meterId: entry.meta?.meterId }),
  };
  const fn = fns[type];
  if (fn) fn({ containerId: `#${entry.container.id}` });
}

/**
 * Destroy a single chart by id.
 */
function destroy(chartId) { _destroy(chartId); }

/**
 * Destroy all charts and disconnect observers.
 */
function destroyAll() {
  _destroyAll();
  if (_io) { _io.disconnect(); _io = null; }
  _lazyQueue.clear();
}

/**
 * Update token cache (call after dynamic theme change).
 */
function refreshTokens() { ChartConfig.tokens.refresh(); }

/**
 * Expose transform helpers for testing / external use.
 */
const transforms = {
  monthly:        _transformMonthly,
  yearly:         _transformYearly,
  siteComparison: _transformSiteComparison,
  usageTrend:     _transformUsageTrend,
};

const Charts = Object.freeze({
  init,
  mount,
  refresh,
  destroy,
  destroyAll,
  refreshTokens,
  transforms,

  // Direct render functions (for manual control)
  render: {
    monthlyTrend:       renderMonthlyTrend,
    yearlyTrend:        renderYearlyTrend,
    waterVsElectricity: renderWaterVsElectricity,
    siteComparison:     renderSiteComparison,
    usageTrend:         renderUsageTrend,
  },
});

// ── ESM export
export { Charts };

// ── CJS / inline script fallback
if (typeof window !== 'undefined') {
  window.Charts = Charts;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Charts };
}
