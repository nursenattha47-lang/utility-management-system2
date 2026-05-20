/**
 * ============================================================
 * FilterService.js — Filter State Engine
 * UtilityManager | PHASE 4D — Filter System
 * ============================================================
 * Provides:
 *   - Immutable filter state with event-driven updates
 *   - URL query string sync (history.pushState / popstate)
 *   - Fast in-memory bill filtering (no re-fetch needed)
 *   - Month, Year, Site, MeterType filters
 *   - Reset logic with selective or full reset
 *   - Subscriber pattern for chart/table/KPI consumers
 * ============================================================
 * Usage:
 *   FilterService.init({ bills, sites, meters });
 *   FilterService.subscribe(({ filters, results }) => { ... });
 *   FilterService.set('year', '2568');
 *   FilterService.reset();
 * ============================================================
 * Dependencies: None — pure JS, no framework
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// SECTION 1 — CONSTANTS
// ─────────────────────────────────────────────────────────────

/** Keys that map directly to URL query params */
const FILTER_KEYS = ['year', 'month', 'site', 'meterType'];

/** Thai Buddhist year range for the year picker */
const YEAR_RANGE_MIN = 2565;
const YEAR_RANGE_MAX_OFFSET = 1; // currentYear + offset

/** URL param namespace prefix to avoid collisions */
const URL_PREFIX = 'f_';

/** Debounce delay for URL writes (ms) */
const URL_WRITE_DEBOUNCE = 120;

/** Default empty filter state */
const EMPTY_FILTERS = Object.freeze({
  year:      '',   // Buddhist year string e.g. "2568", '' = all
  month:     '',   // '1'–'12', '' = all
  site:      '',   // site_id, '' = all
  meterType: '',   // 'ELECTRICITY' | 'WATER' | 'GAS' | 'INTERNET' | '' = all
});


// ─────────────────────────────────────────────────────────────
// SECTION 2 — INTERNAL STATE
// ─────────────────────────────────────────────────────────────

let _state = {
  filters:    { ...EMPTY_FILTERS },
  allBills:   [],
  allSites:   [],
  allMeters:  [],
  results:    [],        // filtered bills
  resultMeta: {},        // { total, byType, bySite, byStatus }
  isReady:    false,
};

/** Subscriber registry: Set of callback functions */
const _subscribers = new Set();

/** Pending URL write timer */
let _urlTimer = null;


// ─────────────────────────────────────────────────────────────
// SECTION 3 — FILTERING ENGINE
// Pure function: filters → filtered bills + meta
// ─────────────────────────────────────────────────────────────

/**
 * Apply current filters to the full bill dataset.
 * Returns { results, meta } without mutating state.
 *
 * @param {Object[]} bills
 * @param {Object}   filters
 * @returns {{ results: Object[], meta: Object }}
 */
function _applyFilters(bills, filters) {
  let results = bills;

  // ── Year filter (Buddhist year as string)
  if (filters.year) {
    results = results.filter(b => String(b.bill_year) === String(filters.year));
  }

  // ── Month filter
  if (filters.month) {
    results = results.filter(b => String(b.bill_month) === String(filters.month));
  }

  // ── Site filter
  if (filters.site) {
    results = results.filter(b => b.site_id === filters.site);
  }

  // ── Meter type filter (join via meter data embedded on bill, or meter_type field)
  if (filters.meterType) {
    results = results.filter(b => {
      // Bills may carry meter_type directly (from enriched API) or via meter_id join
      return (
        String(b.meter_type || '').toUpperCase() === filters.meterType.toUpperCase() ||
        String(b.meterType  || '').toUpperCase() === filters.meterType.toUpperCase()
      );
    });
  }

  // ── Build meta aggregations (fast single-pass)
  const meta = _buildMeta(results);

  return { results, meta };
}

/**
 * Build aggregation metadata from a filtered bill array.
 * Single O(n) pass for all aggregations.
 *
 * @param {Object[]} bills
 * @returns {Object}
 */
function _buildMeta(bills) {
  const byType   = {};
  const bySite   = {};
  const byStatus = {};
  const byPeriod = {};
  let   totalAmt = 0;

  for (const b of bills) {
    const amt = parseFloat(b.amount_total || 0);
    totalAmt += amt;

    // by meter type
    const type = (b.meter_type || b.meterType || 'UNKNOWN').toUpperCase();
    byType[type] = (byType[type] || 0) + amt;

    // by site
    if (b.site_id) {
      if (!bySite[b.site_id]) bySite[b.site_id] = { count: 0, amount: 0 };
      bySite[b.site_id].count++;
      bySite[b.site_id].amount += amt;
    }

    // by status
    const status = b.bill_status || 'UNKNOWN';
    byStatus[status] = (byStatus[status] || 0) + 1;

    // by period key (for sparklines)
    const pk = b.bill_period_key || '';
    if (pk) {
      if (!byPeriod[pk]) byPeriod[pk] = { count: 0, amount: 0 };
      byPeriod[pk].count++;
      byPeriod[pk].amount += amt;
    }
  }

  // Top sites sorted by amount desc
  const topSites = Object.entries(bySite)
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, 10)
    .map(([id, data]) => ({ site_id: id, ...data }));

  return {
    total:     bills.length,
    totalAmt:  Math.round(totalAmt * 100) / 100,
    byType,
    bySite,
    byStatus,
    byPeriod,
    topSites,
  };
}


// ─────────────────────────────────────────────────────────────
// SECTION 4 — URL STATE SYNC
// ─────────────────────────────────────────────────────────────

/**
 * Read filter state from current URL query string.
 * Returns partial filters object (only params present in URL).
 */
function _readFromURL() {
  const sp = new URLSearchParams(window.location.search);
  const partial = {};
  for (const key of FILTER_KEYS) {
    const val = sp.get(URL_PREFIX + key);
    if (val !== null) partial[key] = val;
  }
  return partial;
}

/**
 * Write current filters to URL using history.pushState.
 * Debounced to avoid rapid history entries.
 */
function _writeToURL(filters) {
  clearTimeout(_urlTimer);
  _urlTimer = setTimeout(() => {
    const sp = new URLSearchParams(window.location.search);

    // Remove all existing filter params first
    for (const key of FILTER_KEYS) {
      sp.delete(URL_PREFIX + key);
    }

    // Set non-empty filters
    for (const key of FILTER_KEYS) {
      if (filters[key]) sp.set(URL_PREFIX + key, filters[key]);
    }

    const qs = sp.toString();
    const newURL = window.location.pathname + (qs ? '?' + qs : '');
    if (newURL !== window.location.pathname + window.location.search) {
      history.pushState({ filters }, '', newURL);
    }
  }, URL_WRITE_DEBOUNCE);
}

/**
 * Handle browser back/forward navigation.
 */
function _onPopState(event) {
  const urlFilters = _readFromURL();
  const merged = { ...EMPTY_FILTERS, ...urlFilters };
  _applyAndNotify(merged, false); // false = don't push URL again
}


// ─────────────────────────────────────────────────────────────
// SECTION 5 — STATE MUTATION & NOTIFICATION
// ─────────────────────────────────────────────────────────────

/**
 * Core: apply new filters, update state, notify subscribers.
 *
 * @param {Object}  newFilters     — complete filter state
 * @param {boolean} [pushURL=true] — whether to update URL
 */
function _applyAndNotify(newFilters, pushURL = true) {
  _state.filters = { ...newFilters };

  const { results, meta } = _applyFilters(_state.allBills, _state.filters);
  _state.results    = results;
  _state.resultMeta = meta;

  if (pushURL && typeof history !== 'undefined') {
    _writeToURL(_state.filters);
  }

  // Notify all subscribers synchronously
  const payload = _buildPayload();
  for (const cb of _subscribers) {
    try { cb(payload); } catch (e) { console.error('[FilterService] subscriber error:', e); }
  }
}

/**
 * Build the payload object sent to subscribers.
 */
function _buildPayload() {
  return Object.freeze({
    filters:     { ..._state.filters },
    results:     _state.results,
    meta:        _state.resultMeta,
    allBills:    _state.allBills,
    allSites:    _state.allSites,
    allMeters:   _state.allMeters,
    activeCount: _countActiveFilters(_state.filters),
    isFiltered:  _countActiveFilters(_state.filters) > 0,
  });
}

/**
 * Count how many filters are currently active (non-empty).
 */
function _countActiveFilters(filters) {
  return FILTER_KEYS.filter(k => !!filters[k]).length;
}


// ─────────────────────────────────────────────────────────────
// SECTION 6 — OPTION BUILDERS
// Derive unique values for filter dropdowns from data
// ─────────────────────────────────────────────────────────────

/**
 * Build year options from bills data.
 * Returns sorted descending array of { value, label } objects.
 */
function _buildYearOptions(bills) {
  const years = [...new Set(bills.map(b => String(b.bill_year || '')).filter(Boolean))];
  return years
    .sort((a, b) => parseInt(b) - parseInt(a))
    .map(y => ({ value: y, label: `ปี ${y}` }));
}

/**
 * Build month options.
 * Returns months 1–12 with Thai labels.
 */
function _buildMonthOptions() {
  const MONTHS_TH = [
    '', 'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
    'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
    'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
  ];
  return Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: MONTHS_TH[i + 1],
  }));
}

/**
 * Build site options from sites data.
 * Only includes sites that have at least one bill in current year filter (if set).
 */
function _buildSiteOptions(sites, bills, yearFilter) {
  const siteIdsWithBills = new Set(
    (yearFilter ? bills.filter(b => String(b.bill_year) === yearFilter) : bills)
      .map(b => b.site_id)
  );
  return sites
    .filter(s => siteIdsWithBills.has(s.site_id))
    .map(s => ({ value: s.site_id, label: s.site_name || s.site_code || s.site_id }))
    .sort((a, b) => a.label.localeCompare(b.label, 'th'));
}

/**
 * Build meter type options.
 * Only shows types that exist in the dataset.
 */
function _buildMeterTypeOptions(bills) {
  const LABELS = {
    ELECTRICITY: '⚡ ไฟฟ้า',
    WATER:       '💧 น้ำประปา',
    GAS:         '🔥 แก๊ส',
    INTERNET:    '📡 อินเทอร์เน็ต',
  };
  const types = [...new Set(
    bills.map(b => (b.meter_type || b.meterType || '').toUpperCase()).filter(Boolean)
  )];
  return types
    .filter(t => LABELS[t])
    .map(t => ({ value: t, label: LABELS[t] || t }));
}


// ─────────────────────────────────────────────────────────────
// SECTION 7 — PUBLIC API
// ─────────────────────────────────────────────────────────────

const FilterService = {

  /**
   * Initialize with full dataset. Call once after data load.
   *
   * @param {Object} opts
   * @param {Object[]} opts.bills
   * @param {Object[]} [opts.sites]
   * @param {Object[]} [opts.meters]
   * @param {boolean}  [opts.syncURL=true]  — read initial state from URL
   */
  init({ bills = [], sites = [], meters = [], syncURL = true } = {}) {
    _state.allBills  = bills;
    _state.allSites  = sites;
    _state.allMeters = meters;
    _state.isReady   = true;

    // Restore filters from URL if requested
    let initialFilters = { ...EMPTY_FILTERS };
    if (syncURL && typeof window !== 'undefined') {
      const fromURL = _readFromURL();
      initialFilters = { ...initialFilters, ...fromURL };
      window.addEventListener('popstate', _onPopState);
    }

    _applyAndNotify(initialFilters, false);
    return this;
  },

  /**
   * Replace dataset (e.g. after re-fetch) and re-apply current filters.
   *
   * @param {Object} opts  — same shape as init opts
   */
  setData({ bills, sites, meters } = {}) {
    if (bills)   _state.allBills  = bills;
    if (sites)   _state.allSites  = sites;
    if (meters)  _state.allMeters = meters;
    _applyAndNotify(_state.filters, false);
    return this;
  },

  /**
   * Set a single filter key.
   *
   * @param {string} key    — 'year' | 'month' | 'site' | 'meterType'
   * @param {string} value  — value string, '' to clear
   */
  set(key, value) {
    if (!FILTER_KEYS.includes(key)) {
      console.warn(`[FilterService] Unknown filter key: ${key}`);
      return this;
    }
    const newFilters = { ..._state.filters, [key]: value };
    _applyAndNotify(newFilters);
    return this;
  },

  /**
   * Set multiple filters at once (batch, single notification).
   *
   * @param {Object} partial  — { year, month, site, meterType }
   */
  setMany(partial = {}) {
    const newFilters = { ..._state.filters };
    for (const key of FILTER_KEYS) {
      if (partial[key] !== undefined) newFilters[key] = partial[key];
    }
    _applyAndNotify(newFilters);
    return this;
  },

  /**
   * Reset all filters (or specific keys) to empty.
   *
   * @param {string[]} [keys]  — if omitted, resets all
   */
  reset(keys) {
    const newFilters = { ..._state.filters };
    const toReset = keys && keys.length ? keys : FILTER_KEYS;
    for (const key of toReset) newFilters[key] = '';
    _applyAndNotify(newFilters);
    return this;
  },

  /**
   * Subscribe to filter changes.
   * Callback receives: { filters, results, meta, activeCount, isFiltered }
   * Returns unsubscribe function.
   *
   * @param {Function} callback
   * @returns {Function} unsubscribe
   */
  subscribe(callback) {
    _subscribers.add(callback);
    // Immediately call with current state if ready
    if (_state.isReady) {
      try { callback(_buildPayload()); } catch (e) { /* ignore */ }
    }
    return () => _subscribers.delete(callback);
  },

  /** Unsubscribe a specific callback. */
  unsubscribe(callback) {
    _subscribers.delete(callback);
    return this;
  },

  // ── Getters ──

  /** Current filter values. */
  get filters() { return { ..._state.filters }; },

  /** Currently filtered bills. */
  get results() { return _state.results; },

  /** Aggregation metadata for current results. */
  get meta() { return _state.resultMeta; },

  /** Full unfiltered bill dataset. */
  get allBills() { return _state.allBills; },

  /** Number of active (non-empty) filters. */
  get activeCount() { return _countActiveFilters(_state.filters); },

  /** True if any filter is active. */
  get isFiltered() { return this.activeCount > 0; },

  // ── Option helpers (for populating dropdowns) ──

  /**
   * Get year options derived from bill data.
   * @returns {{ value: string, label: string }[]}
   */
  getYearOptions() {
    return _buildYearOptions(_state.allBills);
  },

  /**
   * Get month options (always 12 months).
   * @returns {{ value: string, label: string }[]}
   */
  getMonthOptions() {
    return _buildMonthOptions();
  },

  /**
   * Get site options filtered to those with bills.
   * @returns {{ value: string, label: string }[]}
   */
  getSiteOptions() {
    return _buildSiteOptions(_state.allSites, _state.allBills, _state.filters.year);
  },

  /**
   * Get meter type options present in the dataset.
   * @returns {{ value: string, label: string }[]}
   */
  getMeterTypeOptions() {
    return _buildMeterTypeOptions(_state.allBills);
  },

  /**
   * Filter bills manually with a custom predicate (no state change).
   * Useful for inline table search on top of existing filters.
   *
   * @param {Function} predicate  — fn(bill) → boolean
   * @returns {Object[]}
   */
  filterWith(predicate) {
    return _state.results.filter(predicate);
  },

  /**
   * Serialize current filters to a shareable URL string.
   * @returns {string}
   */
  toURL() {
    const sp = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      if (_state.filters[key]) sp.set(URL_PREFIX + key, _state.filters[key]);
    }
    const qs = sp.toString();
    return window.location.pathname + (qs ? '?' + qs : '');
  },

  /**
   * Teardown — remove event listeners and clear subscribers.
   */
  destroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', _onPopState);
    }
    clearTimeout(_urlTimer);
    _subscribers.clear();
    _state = {
      filters: { ...EMPTY_FILTERS },
      allBills: [], allSites: [], allMeters: [],
      results: [], resultMeta: {}, isReady: false,
    };
  },
};

// ── ESM export
export { FilterService, FILTER_KEYS, EMPTY_FILTERS };

// ── CJS / global fallback
if (typeof window !== 'undefined') window.FilterService = FilterService;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FilterService, FILTER_KEYS, EMPTY_FILTERS };
}
