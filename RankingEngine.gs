// ============================================================
// RankingEngine.gs — Ranking Engine (Orchestrator)
// UtilityManager | PHASE 5C — Ranking Engine
// ============================================================
// รับผิดชอบ:
//   1. Public API สำหรับทุก ranking type
//   2. Batch data load เดียว (ไม่โหลด Sheet ซ้ำ)
//   3. Coordinate RankingCalculator.gs + AbnormalDetector.gs
//   4. Caching layer สำหรับ repeated calls
//   5. Error handling + structured response
//   6. Auth validation
// ============================================================
// Dependencies (load order matters in GAS):
//   Config.gs            ← CONFIG constants
//   Utils.gs             ← utility helpers
//   Database.gs          ← dbGetAll()
//   Auth.gs              ← requireAuth()
//   TrendCalculator.gs   ← batch data helpers
//   SeverityClassifier.gs ← scRankAnomalies
//   AbnormalDetector.gs  ← getAnomalyReport()
//   RankingCalculator.gs ← math engine (load immediately before this)
// ============================================================
// Public API (called from Code.gs / Analytics.gs):
//   getAllRankings(token, options)            — ครบทุก 6 ประเภทรอบเดียว
//   getElectricityCostRanking(token, options) — ค่าไฟสูงสุด
//   getWaterCostRanking(token, options)       — ค่าน้ำสูงสุด
//   getHighestUsageRanking(token, options)    — ใช้มากสุด
//   getFastestGrowthRanking(token, options)   — โตเร็วสุด
//   getAbnormalUsageRanking(token, options)   — ผิดปกติมากสุด
//   getSiteEfficiencyRanking(token, options)  — ประสิทธิภาพสูงสุด
// ============================================================
// Response shape (ทุก function):
// {
//   success:      boolean,
//   ranking_type: string,
//   items:        RankRecord[],
//   meta:         { total_items, top_n, generated_at, duration_ms, ... },
//   error?:       string
// }
// ============================================================


// ============================================================
// SECTION 1 — ENGINE CONFIGURATION
// ============================================================

/**
 * Config สำหรับ RankingEngine
 */
var RE_CONFIG = {
  // ── Cache ─────────────────────────────────────────────────
  // เก็บ cache ใน PropertiesService (สำหรับ same execution only)
  // GAS execution ใหม่ cache จะล้างเองอัตโนมัติ
  CACHE_ENABLED:       true,
  CACHE_KEY_PREFIX:    'RANKING_',

  // ── Anomaly source ────────────────────────────────────────
  // 'SHEET'   = อ่านจาก Anomalies sheet โดยตรง (เร็ว)
  // 'DETECT'  = รัน detection engine ใหม่ (ข้อมูลสดกว่า แต่ช้ากว่า)
  ANOMALY_SOURCE:      'SHEET',

  // ── Logging ───────────────────────────────────────────────
  LOG_LEVEL:           'INFO',  // 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

  // ── Valid options ─────────────────────────────────────────
  VALID_METER_TYPES:   ['ALL', 'ELECTRICITY', 'WATER'],
  VALID_SEVERITIES:    ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
};


// ============================================================
// SECTION 2 — COMBINED ENTRY POINT
// ============================================================

/**
 * ดึง Ranking ครบทุก 6 ประเภทในรอบเดียว
 * Batch load ข้อมูลครั้งเดียว แล้วส่งต่อให้ทุก calculator
 * เหมาะสำหรับ dashboard ที่ต้องการข้อมูลครบ
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {number}  [options.top_n]         — จำนวนอันดับ (default 10)
 * @param {number}  [options.year]          — กรองเฉพาะปี (null = ทั้งหมด)
 * @param {string}  [options.site_id]       — กรองเฉพาะ site (null = ทั้งหมด)
 * @param {string}  [options.meter_type]    — 'ELECTRICITY'|'WATER'|'ALL'
 * @param {string}  [options.min_severity]  — สำหรับ abnormal ranking
 * @param {boolean} [options.include_zero]  — รวม site ที่ไม่มีค่า
 * @returns {Object}
 *   {
 *     electricity_cost: RankResponse,
 *     water_cost:       RankResponse,
 *     highest_usage:    RankResponse,
 *     fastest_growth:   RankResponse,
 *     abnormal_usage:   RankResponse,
 *     site_efficiency:  RankResponse,
 *     meta:             { generated_at, duration_ms, total_bills, total_sites }
 *   }
 */
function getAllRankings(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  _reLog('INFO', 'getAllRankings START');

  try {
    // ── Single batch load (หัวใจของ performance) ────────────
    var ctx = _loadRankingContext(options);

    // ── Run all 6 rankings ──────────────────────────────────
    var results = {
      electricity_cost: _runElectricityCost(ctx, options),
      water_cost:       _runWaterCost(ctx, options),
      highest_usage:    _runHighestUsage(ctx, options),
      fastest_growth:   _runFastestGrowth(ctx, options),
      abnormal_usage:   _runAbnormalUsage(ctx, options),
      site_efficiency:  _runSiteEfficiency(ctx, options),
      meta: {
        generated_at:  new Date().toISOString(),
        duration_ms:   Date.now() - startTime,
        total_bills:   ctx.bills.length,
        total_sites:   ctx.sites.length,
        total_meters:  ctx.meters.length,
        total_anomalies: ctx.anomalies.length,
        options_used:  options,
      },
    };

    _reLog('INFO', 'getAllRankings DONE — ' + (Date.now() - startTime) + 'ms');
    return results;

  } catch (e) {
    _reLog('ERROR', 'getAllRankings FAILED: ' + e.message);
    throw e;
  }
}


// ============================================================
// SECTION 3 — INDIVIDUAL PUBLIC FUNCTIONS
// ============================================================

/**
 * อันดับ site ที่มีค่าไฟฟ้าสูงสุด
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {number}  [options.top_n]
 * @param {number}  [options.year]
 * @param {boolean} [options.include_zero]
 * @returns {Object}  RankResponse
 */
function getElectricityCostRanking(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  try {
    var ctx   = _loadRankingContext(options);
    var items = _runElectricityCost(ctx, options);
    return _buildResponse('ELECTRICITY_COST', items, options, Date.now() - startTime);
  } catch (e) {
    return _buildErrorResponse('ELECTRICITY_COST', e, options);
  }
}


/**
 * อันดับ site ที่มีค่าน้ำสูงสุด
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}  RankResponse
 */
function getWaterCostRanking(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  try {
    var ctx   = _loadRankingContext(options);
    var items = _runWaterCost(ctx, options);
    return _buildResponse('WATER_COST', items, options, Date.now() - startTime);
  } catch (e) {
    return _buildErrorResponse('WATER_COST', e, options);
  }
}


/**
 * อันดับ site ที่ใช้พลังงาน/น้ำมากสุด (units)
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string}  [options.meter_type]  — 'ELECTRICITY'|'WATER'|'ALL'
 * @returns {Object}  RankResponse
 */
function getHighestUsageRanking(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  try {
    var ctx   = _loadRankingContext(options);
    var items = _runHighestUsage(ctx, options);
    return _buildResponse('HIGHEST_USAGE', items, options, Date.now() - startTime);
  } catch (e) {
    return _buildErrorResponse('HIGHEST_USAGE', e, options);
  }
}


/**
 * อันดับ site ที่มี growth rate สูงสุด (ค่าใช้จ่ายเพิ่มเร็วสุด)
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string}  [options.meter_type]
 * @param {boolean} [options.include_negative]  — รวม site ที่ลดลงด้วย
 * @returns {Object}  RankResponse
 */
function getFastestGrowthRanking(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  try {
    var ctx   = _loadRankingContext(options);
    var items = _runFastestGrowth(ctx, options);
    return _buildResponse('FASTEST_GROWTH', items, options, Date.now() - startTime);
  } catch (e) {
    return _buildErrorResponse('FASTEST_GROWTH', e, options);
  }
}


/**
 * อันดับ site ที่มี anomaly/ผิดปกติมากสุด
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string}  [options.min_severity]  — 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'
 * @param {number}  [options.year]
 * @returns {Object}  RankResponse
 */
function getAbnormalUsageRanking(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  try {
    var ctx   = _loadRankingContext(options);
    var items = _runAbnormalUsage(ctx, options);
    return _buildResponse('ABNORMAL_USAGE', items, options, Date.now() - startTime);
  } catch (e) {
    return _buildErrorResponse('ABNORMAL_USAGE', e, options);
  }
}


/**
 * อันดับ site ที่มี efficiency score สูงสุด (ประหยัดพลังงานดีที่สุด)
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string}  [options.meter_type]
 * @returns {Object}  RankResponse
 */
function getSiteEfficiencyRanking(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeRankOptions(options);

  var startTime = Date.now();
  try {
    var ctx   = _loadRankingContext(options);
    var items = _runSiteEfficiency(ctx, options);
    return _buildResponse('SITE_EFFICIENCY', items, options, Date.now() - startTime);
  } catch (e) {
    return _buildErrorResponse('SITE_EFFICIENCY', e, options);
  }
}


// ============================================================
// SECTION 4 — CONTEXT LOADER (BATCH DATA)
// ============================================================

/**
 * โหลดข้อมูลทั้งหมดที่ต้องใช้สำหรับ ranking ครั้งเดียว
 * ป้องกันการ read Sheet ซ้ำๆ เมื่อเรียกหลาย ranking function
 *
 * Context object:
 * {
 *   bills:          Object[]   — valid (PAID/APPROVED) bills
 *   meters:         Object[]   — all active meters
 *   sites:          Object[]   — all active sites
 *   anomalies:      Object[]   — anomaly records จาก Anomalies sheet
 *   siteAggregates: Object[]   — pre-computed จาก rcAggregateBysite()
 *   meterAggregates:Object[]   — pre-computed จาก rcAggregateByMeter()
 *   meterMap:       Object     — { meter_id: meter }
 *   siteMap:        Object     — { site_id: site }
 * }
 *
 * @param {Object} options
 * @returns {Object}  context
 * @private
 */
function _loadRankingContext(options) {
  _reLog('DEBUG', '_loadRankingContext START');

  // ── 1. Batch read ทุก table ──────────────────────────────
  var rawData = tcLoadAllData();  // { bills, meters, sites }

  // ── 2. Filter valid bills (PAID + APPROVED เท่านั้น) ────
  var validBills = tcFilterValidBills(rawData.bills);

  // ── 3. Apply site filter (ถ้าระบุ) ──────────────────────
  var bills   = validBills;
  var meters  = rawData.meters;
  var sites   = rawData.sites;

  if (options.site_id) {
    bills  = bills.filter(function(b) { return b.site_id === options.site_id; });
    meters = meters.filter(function(m) { return m.site_id === options.site_id; });
    sites  = sites.filter(function(s) { return s.site_id === options.site_id; });
  }

  // Filter inactive meters/sites (status = ACTIVE only)
  meters = meters.filter(function(m) { return !m.status || m.status === 'ACTIVE'; });
  sites  = sites.filter(function(s)  { return !s.status || s.status === 'ACTIVE'; });

  // ── 4. Load anomalies ────────────────────────────────────
  var anomalies = _loadAnomalies(options);

  // ── 5. Pre-compute site aggregates (ใช้ร่วมกันทุก ranking) ─
  var siteAggregates  = rcAggregateBysite(bills, meters, sites);
  var meterAggregates = rcAggregateByMeter(bills, meters, sites);

  _reLog('DEBUG', '_loadRankingContext DONE — bills:' + bills.length +
    ' sites:' + sites.length + ' anomalies:' + anomalies.length);

  return {
    bills:           bills,
    meters:          meters,
    sites:           sites,
    anomalies:       anomalies,
    siteAggregates:  siteAggregates,
    meterAggregates: meterAggregates,
    meterMap:        tcBuildMeterMap(meters),
    siteMap:         tcBuildSiteMap(sites),
  };
}


/**
 * โหลด anomalies จาก Sheet หรือ run detection (ตาม RE_CONFIG.ANOMALY_SOURCE)
 *
 * @param {Object} options
 * @returns {Object[]}  anomaly records
 * @private
 */
function _loadAnomalies(options) {
  try {
    if (RE_CONFIG.ANOMALY_SOURCE === 'SHEET') {
      // อ่านจาก Anomalies sheet โดยตรง (เร็ว)
      var allAnomalies = dbGetAll(CONFIG.SHEETS.ANOMALIES || 'Anomalies');

      // กรองตามปีถ้าระบุ
      if (options.year) {
        allAnomalies = allAnomalies.filter(function(a) {
          return parseInt(a.bill_year) === parseInt(options.year);
        });
      }

      // กรองตาม site ถ้าระบุ
      if (options.site_id) {
        allAnomalies = allAnomalies.filter(function(a) {
          return a.site_id === options.site_id;
        });
      }

      return allAnomalies;
    }
    // ถ้า ANOMALY_SOURCE = 'DETECT' → ไม่รันใน context loader
    // เพราะ detectAnomalies ต้องการ token (auth) และมี side effect (save to sheet)
    // RankingEngine ใช้ SHEET mode เสมอสำหรับ ranking
    return [];

  } catch (e) {
    // ถ้า Anomalies sheet ยังไม่มี → return empty (graceful degradation)
    _reLog('WARN', '_loadAnomalies failed (sheet not found?): ' + e.message);
    return [];
  }
}


// ============================================================
// SECTION 5 — INTERNAL RUNNER FUNCTIONS
// (รับ context + options, return ranked items)
// ============================================================

/**
 * @private — Electricity Cost ranking runner
 */
function _runElectricityCost(ctx, options) {
  return rcRankElectricityCost(ctx.siteAggregates, {
    top_n:        options.top_n,
    year:         options.year,
    include_zero: options.include_zero,
  });
}


/**
 * @private — Water Cost ranking runner
 */
function _runWaterCost(ctx, options) {
  return rcRankWaterCost(ctx.siteAggregates, {
    top_n:        options.top_n,
    year:         options.year,
    include_zero: options.include_zero,
  });
}


/**
 * @private — Highest Usage ranking runner
 */
function _runHighestUsage(ctx, options) {
  return rcRankHighestUsage(ctx.siteAggregates, {
    top_n:       options.top_n,
    meter_type:  options.meter_type,
    year:        options.year,
  });
}


/**
 * @private — Fastest Growth ranking runner
 * Growth ต้องการ raw bills (ไม่ใช่ siteAggregates) เพราะต้องสร้าง time-series
 */
function _runFastestGrowth(ctx, options) {
  return rcRankFastestGrowth(ctx.bills, ctx.meters, ctx.sites, {
    top_n:            options.top_n,
    meter_type:       options.meter_type,
    include_negative: options.include_negative || false,
  });
}


/**
 * @private — Abnormal Usage ranking runner
 */
function _runAbnormalUsage(ctx, options) {
  return rcRankAbnormalUsage(ctx.anomalies, ctx.siteAggregates, {
    top_n:        options.top_n,
    min_severity: options.min_severity || 'LOW',
    year:         options.year,
  });
}


/**
 * @private — Site Efficiency ranking runner
 */
function _runSiteEfficiency(ctx, options) {
  return rcRankSiteEfficiency(ctx.siteAggregates, {
    top_n:      options.top_n,
    meter_type: options.meter_type,
  });
}


// ============================================================
// SECTION 6 — RESPONSE BUILDERS
// ============================================================

/**
 * สร้าง standardized success response
 *
 * @param {string}   rankingType
 * @param {Object[]} items        — ranked records จาก RankingCalculator
 * @param {Object}   options
 * @param {number}   durationMs
 * @returns {Object}
 * @private
 */
function _buildResponse(rankingType, items, options, durationMs) {
  return {
    success:      true,
    ranking_type: rankingType,
    items:        items,
    meta: {
      total_items:  items.length,
      top_n:        options.top_n,
      year_filter:  options.year    || null,
      site_filter:  options.site_id || null,
      type_filter:  options.meter_type || 'ALL',
      generated_at: new Date().toISOString(),
      duration_ms:  durationMs,
    },
  };
}


/**
 * สร้าง standardized error response
 *
 * @param {string} rankingType
 * @param {Error}  error
 * @param {Object} options
 * @returns {Object}
 * @private
 */
function _buildErrorResponse(rankingType, error, options) {
  _reLog('ERROR', rankingType + ' FAILED: ' + error.message);
  return {
    success:      false,
    ranking_type: rankingType,
    items:        [],
    error:        error.message,
    meta: {
      total_items:  0,
      top_n:        options.top_n,
      generated_at: new Date().toISOString(),
    },
  };
}


// ============================================================
// SECTION 7 — OPTIONS NORMALIZER
// ============================================================

/**
 * Normalize และ validate options object
 * ใส่ default values + clamp ค่าที่อาจผิดพลาด
 *
 * @param {Object} [opts]
 * @returns {Object}  normalized options
 * @private
 */
function _normalizeRankOptions(opts) {
  opts = opts || {};

  // top_n: clamp 1–100
  var topN = parseInt(opts.top_n) || 10;
  topN = Math.max(1, Math.min(100, topN));

  // meter_type: uppercase + validate
  var meterType = (opts.meter_type || 'ALL').toUpperCase();
  if (RE_CONFIG.VALID_METER_TYPES.indexOf(meterType) === -1) {
    meterType = 'ALL';
  }

  // min_severity: validate
  var minSev = (opts.min_severity || 'LOW').toUpperCase();
  if (RE_CONFIG.VALID_SEVERITIES.indexOf(minSev) === -1) {
    minSev = 'LOW';
  }

  // year: integer or null
  var year = opts.year ? parseInt(opts.year) : null;
  if (year && (year < 2500 || year > 2600)) year = null; // sanity check (Thai Buddhist year range)

  return {
    top_n:            topN,
    meter_type:       meterType,
    min_severity:     minSev,
    year:             year,
    site_id:          opts.site_id          || null,
    include_zero:     opts.include_zero     || false,
    include_negative: opts.include_negative || false,
  };
}


// ============================================================
// SECTION 8 — CODE.GS ROUTER INTEGRATION
// ============================================================

/**
 * Handler สำหรับ doGet / doPost router ใน Code.gs
 * เรียกได้ด้วย action = 'rankings.*'
 *
 * ตัวอย่าง URL:
 *   ?action=rankings.all&token=xxx&top_n=10&year=2568
 *   ?action=rankings.electricity&token=xxx
 *   ?action=rankings.water&token=xxx&year=2568
 *   ?action=rankings.usage&token=xxx&meter_type=ELECTRICITY
 *   ?action=rankings.growth&token=xxx
 *   ?action=rankings.abnormal&token=xxx&min_severity=HIGH
 *   ?action=rankings.efficiency&token=xxx
 *
 * @param {string} action  — sub-action (ส่วนหลัง 'rankings.')
 * @param {string} token
 * @param {Object} params  — query params / POST body
 * @returns {Object}
 */
function rankingsRouter(action, token, params) {
  // แยก sub-action (รองรับ 'rankings.electricity' หรือ 'electricity' โดยตรง)
  var sub = (action || '').replace(/^rankings\./, '').toLowerCase();

  var options = {
    top_n:            params.top_n,
    meter_type:       params.meter_type,
    year:             params.year,
    site_id:          params.site_id,
    min_severity:     params.min_severity,
    include_zero:     params.include_zero === 'true',
    include_negative: params.include_negative === 'true',
  };

  switch (sub) {
    case 'all':
      return getAllRankings(token, options);
    case 'electricity':
    case 'electricity_cost':
      return getElectricityCostRanking(token, options);
    case 'water':
    case 'water_cost':
      return getWaterCostRanking(token, options);
    case 'usage':
    case 'highest_usage':
      return getHighestUsageRanking(token, options);
    case 'growth':
    case 'fastest_growth':
      return getFastestGrowthRanking(token, options);
    case 'abnormal':
    case 'abnormal_usage':
      return getAbnormalUsageRanking(token, options);
    case 'efficiency':
    case 'site_efficiency':
      return getSiteEfficiencyRanking(token, options);
    default:
      return {
        success: false,
        error:   'Unknown ranking action: ' + sub,
        items:   [],
        meta:    { generated_at: new Date().toISOString() },
      };
  }
}


// ============================================================
// SECTION 9 — TRIGGER ENTRY POINT
// ============================================================

/**
 * Time-driven trigger: pre-compute rankings ต้นเดือน
 * บันทึก result ลง cache / MonthlySummary sheet
 * เรียกได้จาก Triggers.gs
 *
 * ตัวอย่างการตั้ง trigger (ใน Triggers.gs):
 *   ScriptApp.newTrigger('precomputeMonthlyRankings')
 *     .timeBased().onMonthDay(3).atHour(7).create();
 */
function precomputeMonthlyRankings() {
  _reLog('INFO', 'precomputeMonthlyRankings START');
  var startTime = Date.now();

  try {
    // ใช้ ADMIN token สำหรับ trigger calls
    var adminToken = _getSystemToken();
    if (!adminToken) {
      _reLog('WARN', 'precomputeMonthlyRankings: no system token, skipping');
      return;
    }

    // คำนวณปีล่าสุด (ปี พ.ศ. ปัจจุบัน)
    var currentYear = new Date().getFullYear() + 543;

    var rankings = getAllRankings(adminToken, {
      top_n:        20,
      year:         currentYear,
      meter_type:   'ALL',
      min_severity: 'LOW',
    });

    // บันทึกสรุปลง Logger (หรือสามารถ extend เพื่อ save ลง sheet ได้)
    _reLog('INFO', 'precomputeMonthlyRankings DONE — ' +
      (Date.now() - startTime) + 'ms | ' +
      'elec:' + rankings.electricity_cost.meta.total_items +
      ' water:' + rankings.water_cost.meta.total_items +
      ' abnormal:' + rankings.abnormal_usage.meta.total_items
    );

  } catch (e) {
    _reLog('ERROR', 'precomputeMonthlyRankings FAILED: ' + e.message);
  }
}


// ============================================================
// SECTION 10 — PRIVATE UTILITIES
// ============================================================

/**
 * Logging helper — ใช้ Logger.log ของ GAS
 * กรองตาม RE_CONFIG.LOG_LEVEL
 *
 * @param {string} level  — 'DEBUG'|'INFO'|'WARN'|'ERROR'
 * @param {string} msg
 * @private
 */
function _reLog(level, msg) {
  var levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  var configLevel = levels[RE_CONFIG.LOG_LEVEL] || 1;
  if ((levels[level] || 0) >= configLevel) {
    Logger.log('[RankingEngine][' + level + '] ' + msg);
  }
}


/**
 * ดึง system token สำหรับ trigger calls
 * ใช้ PropertiesService เก็บ token ที่ admin สร้างไว้
 *
 * @returns {string|null}
 * @private
 */
function _getSystemToken() {
  try {
    var props = PropertiesService.getScriptProperties();
    return props.getProperty('SYSTEM_TOKEN') || null;
  } catch (e) {
    return null;
  }
}
