/**
 * ============================================================
 * ChartConfig.js — Chart.js Configuration Factory
 * UtilityManager | PHASE 4C — Charts Module
 * ============================================================
 * Provides:
 *   - Design tokens synced to Dashboard.css CSS variables
 *   - Base plugin defaults (tooltip, legend, grid)
 *   - Factory functions for every chart type
 *   - Responsive breakpoint helpers
 *   - Animation presets (entrance, update, reduced-motion)
 * ============================================================
 * Usage:
 *   import { ChartConfig } from './ChartConfig.js';
 *   const cfg = ChartConfig.monthlyTrend(data, options);
 *   new Chart(canvas, cfg);
 * ============================================================
 * Dependencies: Chart.js ≥ 4.x  (CDN or npm)
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// SECTION 1 — DESIGN TOKENS
// Read CSS custom properties from :root so charts stay in sync
// with Dashboard.css palette. Falls back to hardcoded values
// for environments where CSS variables aren't available.
// ─────────────────────────────────────────────────────────────

const _css = (name, fallback) => {
  if (typeof getComputedStyle !== 'undefined') {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    if (v) return v;
  }
  return fallback;
};

/**
 * Design token map — mirrors Dashboard.css :root variables.
 * Call ChartTokens.refresh() after theme changes.
 */
const ChartTokens = (() => {
  let _tokens = null;

  function build() {
    return {
      // Surface
      surface:       _css('--bg-surface',      '#FFFFFF'),
      surfaceAlt:    _css('--bg-surface-alt',  '#FAFAF8'),
      bgRoot:        _css('--bg-root',         '#F5F4F1'),

      // Text
      textPrimary:   _css('--text-primary',    '#111827'),
      textSecondary: _css('--text-secondary',  '#374151'),
      textMuted:     _css('--text-muted',      '#9CA3AF'),

      // Borders
      border:        _css('--border',          '#E5E3DF'),
      borderLight:   _css('--border-light',    '#F0EEE9'),

      // Accent
      accent:        _css('--accent',          '#2563EB'),
      accentHover:   _css('--accent-hover',    '#1D4ED8'),
      accentLight:   _css('--accent-light',    '#EFF6FF'),
      accentMuted:   _css('--accent-muted',    'rgba(37,99,235,0.12)'),

      // Semantic KPI palettes
      electricity: {
        solid:  _css('--kpi-blue-text',       '#1850A8'),
        light:  _css('--kpi-blue-bg',         '#EEF4FD'),
        border: _css('--kpi-blue-border',     '#C5D9F5'),
      },
      water: {
        solid:  _css('--kpi-teal-text',       '#0B6E56'),
        light:  _css('--kpi-teal-bg',         '#EBF7F3'),
        border: _css('--kpi-teal-border',     '#B5DDD0'),
      },
      overdue: {
        solid:  _css('--kpi-red-text',        '#991B1B'),
        light:  _css('--kpi-red-bg',          '#FEF2F2'),
        border: _css('--kpi-red-border',      '#FECACA'),
      },
      warning: {
        solid:  _css('--kpi-amber-text',      '#854D0E'),
        light:  _css('--kpi-amber-bg',        '#FFFBEB'),
        border: _css('--kpi-amber-border',    '#FDE68A'),
      },
      anomaly: {
        solid:  _css('--kpi-purple-text',     '#4C1D95'),
        light:  _css('--kpi-purple-bg',       '#F5F3FF'),
        border: _css('--kpi-purple-border',   '#DDD6FE'),
      },
      neutral: {
        solid:  _css('--kpi-gray-text',       '#4A4845'),
        light:  _css('--kpi-gray-bg',         '#F8F7F4'),
        border: _css('--kpi-gray-border',     '#E0DDD7'),
      },

      // Status colors
      paid:      _css('--color-paid',         '#16A34A'),
      approved:  _css('--color-approved',     '#2563EB'),
      pending:   _css('--color-pending',      '#D97706'),
      cancelled: _css('--color-cancelled',    '#6B7280'),

      // Font
      fontMono:  "'DM Mono', ui-monospace, monospace",
      fontUI:    "'DM Sans', 'Sarabun', -apple-system, sans-serif",
    };
  }

  return {
    get()      { return _tokens || (_tokens = build()); },
    refresh()  { _tokens = build(); return _tokens; },
  };
})();


// ─────────────────────────────────────────────────────────────
// SECTION 2 — ANIMATION PRESETS
// ─────────────────────────────────────────────────────────────

/** Returns false if user prefers reduced motion. */
const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ANIMATIONS = {
  /** Standard entrance — bars/lines grow from zero. */
  entrance: {
    duration: 700,
    easing:   'easeOutQuart',
    delay(ctx) {
      return ctx.type === 'data' ? ctx.dataIndex * 18 : 0;
    },
  },

  /** Quick update when data refreshes. */
  update: {
    duration: 350,
    easing:   'easeInOutQuad',
  },

  /** No animation for reduced-motion users. */
  none: {
    duration: 0,
  },

  /** Get appropriate preset based on user preference. */
  forContext(type = 'entrance') {
    return prefersReducedMotion() ? ANIMATIONS.none : ANIMATIONS[type] || ANIMATIONS.entrance;
  },
};


// ─────────────────────────────────────────────────────────────
// SECTION 3 — GRADIENT HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Creates a vertical linear gradient for area fills.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} colorTop    — rgba top color
 * @param {string} colorBottom — rgba bottom color (usually transparent)
 * @param {number} [chartHeight=300]
 */
function makeAreaGradient(ctx, colorTop, colorBottom = 'rgba(255,255,255,0)', chartHeight = 300) {
  const g = ctx.createLinearGradient(0, 0, 0, chartHeight);
  g.addColorStop(0,   colorTop);
  g.addColorStop(0.7, colorTop.replace(/[\d.]+\)$/, '0.15)'));
  g.addColorStop(1,   colorBottom);
  return g;
}

/**
 * Converts a hex color to rgba string.
 * @param {string} hex
 * @param {number} alpha
 */
function hexToRgba(hex, alpha = 1) {
  const h = hex.replace('#', '');
  const len = h.length === 3 ? 1 : 2;
  const r = parseInt(h.slice(0,       len),   16);
  const g = parseInt(h.slice(len,     len*2), 16);
  const b = parseInt(h.slice(len*2,   len*3), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}


// ─────────────────────────────────────────────────────────────
// SECTION 4 — RESPONSIVE HELPERS
// ─────────────────────────────────────────────────────────────

const BP = { sm: 600, md: 900, lg: 1200 };

function getBreakpoint() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  if (w <= BP.sm) return 'sm';
  if (w <= BP.md) return 'md';
  if (w <= BP.lg) return 'lg';
  return 'xl';
}

/**
 * Returns a value that scales with viewport.
 * @param {{ sm, md, lg, xl }} map
 */
function responsive(map) {
  const bp = getBreakpoint();
  return map[bp] ?? map.lg ?? map.xl;
}


// ─────────────────────────────────────────────────────────────
// SECTION 5 — BASE PLUGIN DEFAULTS
// Shared plugins config injected into every chart.
// ─────────────────────────────────────────────────────────────

function basePlugins(overrides = {}) {
  const t = ChartTokens.get();

  return {
    legend: {
      display: true,
      position: 'top',
      align: 'end',
      labels: {
        color:        t.textSecondary,
        font:         { family: t.fontUI, size: 12, weight: '500' },
        boxWidth:     10,
        boxHeight:    10,
        borderRadius: 3,
        padding:      16,
        usePointStyle: true,
        pointStyle:   'circle',
      },
      ...overrides.legend,
    },

    tooltip: {
      enabled:       true,
      mode:          'index',
      intersect:     false,
      backgroundColor: t.surface,
      borderColor:   t.border,
      borderWidth:   1,
      titleColor:    t.textPrimary,
      bodyColor:     t.textSecondary,
      footerColor:   t.textMuted,
      padding:       { x: 14, y: 10 },
      cornerRadius:  8,
      titleFont:     { family: t.fontUI,   size: 13, weight: '600' },
      bodyFont:      { family: t.fontMono, size: 12, weight: '400' },
      footerFont:    { family: t.fontUI,   size: 11, weight: '400' },
      boxPadding:    6,
      caretSize:     5,
      displayColors: true,
      callbacks: {
        label(item) {
          const v = item.parsed.y ?? item.parsed;
          const fmt = new Intl.NumberFormat('th-TH', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          }).format(v);
          return `  ${item.dataset.label}: ฿${fmt}`;
        },
      },
      ...overrides.tooltip,
    },

    // Crosshair via chartjs-plugin-annotation or custom draw
    ...overrides.extra,
  };
}


// ─────────────────────────────────────────────────────────────
// SECTION 6 — BASE SCALE DEFAULTS
// ─────────────────────────────────────────────────────────────

function baseScaleX(overrides = {}) {
  const t = ChartTokens.get();
  return {
    grid: {
      display: false,
    },
    border: {
      display: false,
    },
    ticks: {
      color:  t.textMuted,
      font:   { family: t.fontUI, size: 11 },
      maxRotation: 0,
      padding: 8,
    },
    ...overrides,
  };
}

function baseScaleY(overrides = {}) {
  const t = ChartTokens.get();
  return {
    grid: {
      color:       t.borderLight,
      lineWidth:   1,
      drawTicks:   false,
    },
    border: {
      display: false,
      dash:    [4, 4],
    },
    ticks: {
      color:    t.textMuted,
      font:     { family: t.fontMono, size: 11 },
      padding:  10,
      maxTicksLimit: 6,
      callback(v) {
        if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
        if (v >= 1_000)     return (v / 1_000).toFixed(0) + 'K';
        return v;
      },
    },
    ...overrides,
  };
}


// ─────────────────────────────────────────────────────────────
// SECTION 7 — CHART CONFIGURATION FACTORIES
// Each function returns a complete Chart.js config object.
// ─────────────────────────────────────────────────────────────

// ── 7.1  Monthly Trend Chart ──────────────────────────────────

/**
 * Line + area chart: utility spend over 12 months.
 *
 * @param {Object} data
 * @param {string[]} data.labels          — e.g. ["ม.ค.", "ก.พ.", ...]
 * @param {number[]} data.electricity     — monthly amounts
 * @param {number[]} data.water
 * @param {number[]} [data.gas]
 * @param {number[]} [data.internet]
 * @param {Object}  [options]
 * @param {boolean} [options.showLegend=true]
 * @param {string}  [options.title]
 * @returns {Object} Chart.js config
 */
function monthlyTrendConfig(data, options = {}) {
  const t   = ChartTokens.get();
  const anim = ANIMATIONS.forContext('entrance');

  const datasets = [];

  if (data.electricity?.length) {
    datasets.push({
      label:           'ไฟฟ้า',
      data:            data.electricity,
      borderColor:     t.electricity.solid,
      backgroundColor(ctx) {
        const c = ctx.chart.ctx;
        return makeAreaGradient(c,
          hexToRgba(t.electricity.solid, 0.22),
          'rgba(255,255,255,0)',
          ctx.chart.height
        );
      },
      borderWidth:     2.5,
      pointRadius:     0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBackgroundColor: t.surface,
      pointHoverBorderColor: t.electricity.solid,
      fill:            true,
      tension:         0.38,
      order:           1,
    });
  }

  if (data.water?.length) {
    datasets.push({
      label:           'น้ำประปา',
      data:            data.water,
      borderColor:     t.water.solid,
      backgroundColor(ctx) {
        const c = ctx.chart.ctx;
        return makeAreaGradient(c,
          hexToRgba(t.water.solid, 0.18),
          'rgba(255,255,255,0)',
          ctx.chart.height
        );
      },
      borderWidth:     2,
      pointRadius:     0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBackgroundColor: t.surface,
      pointHoverBorderColor: t.water.solid,
      fill:            true,
      tension:         0.38,
      order:           2,
    });
  }

  if (data.gas?.length) {
    datasets.push({
      label:           'แก๊ส',
      data:            data.gas,
      borderColor:     t.warning.solid,
      borderWidth:     2,
      pointRadius:     0,
      pointHoverRadius: 4,
      fill:            false,
      tension:         0.35,
      borderDash:      [5, 3],
      order:           3,
    });
  }

  if (data.internet?.length) {
    datasets.push({
      label:           'อินเทอร์เน็ต',
      data:            data.internet,
      borderColor:     t.anomaly.solid,
      borderWidth:     2,
      pointRadius:     0,
      pointHoverRadius: 4,
      fill:            false,
      tension:         0.35,
      borderDash:      [3, 3],
      order:           4,
    });
  }

  return {
    type: 'line',
    data: { labels: data.labels || [], datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { mode: 'index', intersect: false },
      animation:           anim,
      layout:              { padding: { top: 8, right: 4, bottom: 0, left: 0 } },
      plugins: {
        ...basePlugins({
          legend: { display: options.showLegend !== false },
          tooltip: {
            callbacks: {
              title: ([item]) => item.label,
              label(item) {
                const v = item.parsed.y;
                const fmt = new Intl.NumberFormat('th-TH').format(Math.round(v));
                return `  ${item.dataset.label}: ฿${fmt}`;
              },
              footer(items) {
                const total = items.reduce((s, i) => s + (i.parsed.y || 0), 0);
                return `รวม: ฿${new Intl.NumberFormat('th-TH').format(Math.round(total))}`;
              },
            },
          },
        }),
        title: options.title ? {
          display: true,
          text:    options.title,
          color:   t.textPrimary,
          font:    { family: t.fontUI, size: 14, weight: '600' },
          padding: { bottom: 16 },
          align:   'start',
        } : { display: false },
      },
      scales: {
        x: baseScaleX(),
        y: baseScaleY({
          beginAtZero: true,
          stacked:     false,
        }),
      },
    },
  };
}


// ── 7.2  Yearly Trend Chart ───────────────────────────────────

/**
 * Grouped bar chart: annual spend by utility type, multi-year.
 *
 * @param {Object} data
 * @param {string[]} data.years     — e.g. ["2566", "2567", "2568"]
 * @param {Object}  data.series     — { electricity: [], water: [], gas: [], internet: [] }
 * @param {Object}  [options]
 * @returns {Object} Chart.js config
 */
function yearlyTrendConfig(data, options = {}) {
  const t    = ChartTokens.get();
  const anim = ANIMATIONS.forContext('entrance');

  const palette = [
    { key: 'electricity', label: 'ไฟฟ้า',        color: t.electricity.solid, borderColor: t.electricity.border },
    { key: 'water',       label: 'น้ำประปา',       color: t.water.solid,       borderColor: t.water.border },
    { key: 'gas',         label: 'แก๊ส',           color: t.warning.solid,     borderColor: t.warning.border },
    { key: 'internet',    label: 'อินเทอร์เน็ต',   color: t.anomaly.solid,     borderColor: t.anomaly.border },
  ];

  const datasets = palette
    .filter(p => data.series?.[p.key]?.length)
    .map(p => ({
      label:            p.label,
      data:             data.series[p.key],
      backgroundColor:  hexToRgba(p.color, 0.85),
      hoverBackgroundColor: p.color,
      borderColor:      p.color,
      borderWidth:      0,
      borderRadius:     { topLeft: 4, topRight: 4 },
      borderSkipped:    'bottom',
      barPercentage:    0.72,
      categoryPercentage: 0.78,
    }));

  return {
    type: 'bar',
    data: { labels: data.years || [], datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           anim,
      layout:              { padding: { top: 8, right: 0, bottom: 0, left: 0 } },
      plugins: {
        ...basePlugins({ legend: { display: true } }),
        title: options.title ? {
          display: true,
          text:    options.title,
          color:   t.textPrimary,
          font:    { family: t.fontUI, size: 14, weight: '600' },
          padding: { bottom: 16 },
          align:   'start',
        } : { display: false },
      },
      scales: {
        x: baseScaleX(),
        y: baseScaleY({ beginAtZero: true }),
      },
    },
  };
}


// ── 7.3  Water vs Electricity Comparison ─────────────────────

/**
 * Dual-axis line chart: electricity (left axis, ฿) vs
 * water (right axis, ฿) — overlaid for correlation analysis.
 *
 * @param {Object} data
 * @param {string[]} data.labels
 * @param {number[]} data.electricity
 * @param {number[]} data.water
 * @param {Object}  [options]
 * @returns {Object} Chart.js config
 */
function waterVsElectricityConfig(data, options = {}) {
  const t    = ChartTokens.get();
  const anim = ANIMATIONS.forContext('entrance');

  return {
    type: 'line',
    data: {
      labels: data.labels || [],
      datasets: [
        {
          label:           'ไฟฟ้า (แกนซ้าย)',
          data:            data.electricity || [],
          yAxisID:         'yElec',
          borderColor:     t.electricity.solid,
          backgroundColor(ctx) {
            return makeAreaGradient(ctx.chart.ctx,
              hexToRgba(t.electricity.solid, 0.15),
              'rgba(255,255,255,0)',
              ctx.chart.height
            );
          },
          borderWidth:     2.5,
          fill:            true,
          tension:         0.4,
          pointRadius:     3,
          pointBackgroundColor: t.electricity.solid,
          pointBorderColor:     t.surface,
          pointBorderWidth:     2,
          pointHoverRadius:     6,
          order:           1,
        },
        {
          label:           'น้ำประปา (แกนขวา)',
          data:            data.water || [],
          yAxisID:         'yWater',
          borderColor:     t.water.solid,
          backgroundColor(ctx) {
            return makeAreaGradient(ctx.chart.ctx,
              hexToRgba(t.water.solid, 0.12),
              'rgba(255,255,255,0)',
              ctx.chart.height
            );
          },
          borderWidth:     2,
          fill:            true,
          tension:         0.4,
          pointRadius:     3,
          pointBackgroundColor: t.water.solid,
          pointBorderColor:     t.surface,
          pointBorderWidth:     2,
          pointHoverRadius:     6,
          borderDash:      [6, 3],
          order:           2,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           anim,
      interaction:         { mode: 'index', intersect: false },
      layout:              { padding: { top: 8, right: 8 } },
      plugins: {
        ...basePlugins({
          legend: { display: true },
          tooltip: {
            callbacks: {
              title: ([item]) => item.label,
              label(item) {
                const v   = item.parsed.y;
                const fmt = new Intl.NumberFormat('th-TH').format(Math.round(v));
                const tag = item.datasetIndex === 0 ? '⚡' : '💧';
                return `  ${tag} ${item.dataset.label.replace(/ \(.*\)/, '')}: ฿${fmt}`;
              },
            },
          },
        }),
      },
      scales: {
        x: baseScaleX(),
        yElec: {
          ...baseScaleY(),
          position: 'left',
          title: {
            display: true,
            text:    'ค่าไฟฟ้า (฿)',
            color:   t.electricity.solid,
            font:    { family: t.fontUI, size: 11, weight: '500' },
            padding: { bottom: 6 },
          },
        },
        yWater: {
          ...baseScaleY(),
          position: 'right',
          grid: { drawOnChartArea: false },
          title: {
            display: true,
            text:    'ค่าน้ำ (฿)',
            color:   t.water.solid,
            font:    { family: t.fontUI, size: 11, weight: '500' },
            padding: { bottom: 6 },
          },
          ticks: {
            ...baseScaleY().ticks,
            color: t.water.solid,
          },
        },
      },
    },
  };
}


// ── 7.4  Site Comparison Chart ────────────────────────────────

/**
 * Horizontal bar chart: compare total spend across all sites
 * for a given period. Sorted descending.
 *
 * @param {Object} data
 * @param {string[]} data.sites        — site names
 * @param {number[]} data.amounts      — matching totals
 * @param {string[]} [data.colors]     — optional per-bar color overrides
 * @param {number}  [data.avgLine]     — optional average reference line value
 * @param {Object}  [options]
 * @returns {Object} Chart.js config
 */
function siteComparisonConfig(data, options = {}) {
  const t    = ChartTokens.get();
  const anim = ANIMATIONS.forContext('entrance');
  const max  = Math.max(...(data.amounts || [0]));

  // Color bars by spend intensity
  const barColors = (data.amounts || []).map(v => {
    const ratio = max > 0 ? v / max : 0;
    if (ratio >= 0.85) return t.electricity.solid;
    if (ratio >= 0.55) return hexToRgba(t.electricity.solid, 0.75);
    if (ratio >= 0.30) return hexToRgba(t.electricity.solid, 0.55);
    return hexToRgba(t.electricity.solid, 0.38);
  });

  return {
    type: 'bar',
    data: {
      labels: data.sites || [],
      datasets: [
        {
          label:            'ยอดรวม (฿)',
          data:             data.amounts || [],
          backgroundColor:  data.colors || barColors,
          hoverBackgroundColor: t.electricity.solid,
          borderRadius:     { topRight: 5, bottomRight: 5 },
          borderSkipped:    'left',
          barThickness:     responsive({ sm: 18, md: 22, lg: 26, xl: 28 }),
        },
        // Optional average reference line rendered as a scatter/point
        ...(data.avgLine ? [{
          label:           'ค่าเฉลี่ย',
          data:            (data.sites || []).map(() => data.avgLine),
          type:            'line',
          borderColor:     t.pending,
          borderWidth:     1.5,
          borderDash:      [5, 4],
          pointRadius:     0,
          fill:            false,
          tension:         0,
          order:           0,
        }] : []),
      ],
    },
    options: {
      indexAxis:           'y',
      responsive:          true,
      maintainAspectRatio: false,
      animation:           {
        ...anim,
        delay(ctx) {
          return ctx.type === 'data' ? ctx.dataIndex * 40 : 0;
        },
      },
      layout:   { padding: { top: 4, right: 16, bottom: 0, left: 0 } },
      plugins: {
        ...basePlugins({
          legend: { display: data.avgLine ? true : false },
          tooltip: {
            callbacks: {
              label(item) {
                if (item.dataset.type === 'line') {
                  return `  ค่าเฉลี่ย: ฿${new Intl.NumberFormat('th-TH').format(Math.round(item.parsed.x))}`;
                }
                return `  ฿${new Intl.NumberFormat('th-TH').format(Math.round(item.parsed.x))}`;
              },
            },
          },
        }),
      },
      scales: {
        x: {
          ...baseScaleY(),   // re-use Y scale style on horizontal axis
          position: 'bottom',
          beginAtZero: true,
          grid: {
            color:     t.borderLight,
            lineWidth: 1,
          },
        },
        y: {
          ...baseScaleX(),   // re-use X scale style on vertical axis
          ticks: {
            color:     t.textSecondary,
            font:      { family: t.fontUI, size: 12, weight: '400' },
            padding:   8,
            crossAlign: 'far',
          },
        },
      },
    },
  };
}


// ── 7.5  Usage Trend Analysis (Anomaly Overlay) ───────────────

/**
 * Line chart with anomaly band overlay and threshold line.
 * Shows historical usage + ±σ band for anomaly detection context.
 *
 * @param {Object} data
 * @param {string[]} data.labels
 * @param {number[]} data.usage          — actual usage values (units or ฿)
 * @param {number[]} data.avg6m          — 6-month rolling average
 * @param {number[]} [data.upperBand]    — avg + threshold (spike detection)
 * @param {Object[]} [data.anomalies]    — [{ index, severity }] markers
 * @param {string}  [options.yLabel]     — y-axis label (default: 'ยอด (฿)')
 * @param {string}  [options.meterType]  — 'ELECTRICITY' | 'WATER' | ...
 * @returns {Object} Chart.js config
 */
function usageTrendConfig(data, options = {}) {
  const t      = ChartTokens.get();
  const anim   = ANIMATIONS.forContext('entrance');
  const isWater = options.meterType === 'WATER';
  const mainColor = isWater ? t.water.solid : t.electricity.solid;

  // Build anomaly point colors: override specific indices
  const pointColors  = (data.usage || []).map((_, i) => {
    const a = (data.anomalies || []).find(x => x.index === i);
    if (!a) return 'transparent';
    return a.severity === 'HIGH' ? t.overdue.solid : t.warning.solid;
  });

  const pointRadii = (data.usage || []).map((_, i) =>
    (data.anomalies || []).some(x => x.index === i) ? 6 : 0
  );

  const datasets = [
    // Upper band (fill between avg and upper)
    ...(data.upperBand?.length ? [{
      label:            'เกณฑ์ผิดปกติ (+30%)',
      data:             data.upperBand,
      borderColor:      hexToRgba(t.warning.solid, 0.35),
      backgroundColor:  hexToRgba(t.warning.solid, 0.06),
      borderWidth:      1,
      borderDash:       [4, 4],
      pointRadius:      0,
      fill:             '+1',   // fill to avg6m dataset below
      tension:          0.3,
      order:            3,
    }] : []),

    // 6-month rolling average
    ...(data.avg6m?.length ? [{
      label:            'ค่าเฉลี่ย 6 เดือน',
      data:             data.avg6m,
      borderColor:      hexToRgba(t.neutral.solid, 0.6),
      borderWidth:      1.5,
      borderDash:       [6, 3],
      pointRadius:      0,
      fill:             false,
      tension:          0.4,
      order:            2,
    }] : []),

    // Actual usage — primary line
    {
      label:            options.yLabel || (isWater ? 'การใช้น้ำ' : 'การใช้ไฟ'),
      data:             data.usage || [],
      borderColor:      mainColor,
      backgroundColor(ctx) {
        return makeAreaGradient(ctx.chart.ctx,
          hexToRgba(mainColor, 0.18),
          'rgba(255,255,255,0)',
          ctx.chart.height
        );
      },
      borderWidth:      2.5,
      fill:             true,
      tension:          0.38,
      pointRadius:      pointRadii,
      pointBackgroundColor: pointColors,
      pointBorderColor:     t.surface,
      pointBorderWidth:     2,
      pointHoverRadius:     5,
      order:            1,
    },
  ];

  return {
    type: 'line',
    data: { labels: data.labels || [], datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           anim,
      interaction:         { mode: 'index', intersect: false },
      layout:              { padding: { top: 8, right: 4 } },
      plugins: {
        ...basePlugins({
          legend: { display: true },
          tooltip: {
            callbacks: {
              label(item) {
                const v   = item.parsed.y;
                const fmt = new Intl.NumberFormat('th-TH').format(Math.round(v));
                return `  ${item.dataset.label}: ฿${fmt}`;
              },
              afterBody(items) {
                const idx = items[0]?.dataIndex;
                const a = (data.anomalies || []).find(x => x.index === idx);
                if (!a) return [];
                const icon = a.severity === 'HIGH' ? '🔴' : '🟡';
                return [`  ${icon} พบความผิดปกติ: ${a.type || a.severity}`];
              },
            },
          },
        }),
      },
      scales: {
        x: baseScaleX(),
        y: {
          ...baseScaleY(),
          title: {
            display: !!(options.yLabel),
            text:    options.yLabel || '',
            color:   t.textMuted,
            font:    { family: t.fontUI, size: 11 },
            padding: { bottom: 4 },
          },
          beginAtZero: false,
        },
      },
    },
  };
}


// ─────────────────────────────────────────────────────────────
// SECTION 8 — PUBLIC API
// ─────────────────────────────────────────────────────────────

const ChartConfig = Object.freeze({
  tokens:              ChartTokens,
  animations:          ANIMATIONS,
  responsive,
  makeAreaGradient,
  hexToRgba,
  basePlugins,
  baseScaleX,
  baseScaleY,

  // Config factories
  monthlyTrend:        monthlyTrendConfig,
  yearlyTrend:         yearlyTrendConfig,
  waterVsElectricity:  waterVsElectricityConfig,
  siteComparison:      siteComparisonConfig,
  usageTrend:          usageTrendConfig,
});

// ── ESM export
export { ChartConfig, ChartTokens, ANIMATIONS, makeAreaGradient, hexToRgba };

// ── CJS / GAS-compatible fallback
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChartConfig, ChartTokens, ANIMATIONS, makeAreaGradient, hexToRgba };
}
