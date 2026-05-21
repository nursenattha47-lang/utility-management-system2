// ============================================================
// ThresholdEngine.gs — Dynamic Threshold Calculation Engine
// UtilityManager | PHASE 5B — Abnormal Detection Engine
// ============================================================
// รับผิดชอบ:
//   1. Configurable threshold management (per site / per meter / global)
//   2. Dynamic threshold calculation จาก historical data
//   3. Statistical bounds (mean ± kσ, IQR-based, percentile-based)
//   4. Adaptive thresholds ที่ปรับตามฤดูกาลและ trend
//   5. Threshold override per meter type (ELECTRICITY vs WATER)
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs, TrendCalculator.gs
// Called by:   AbnormalDetector.gs, SeverityClassifier.gs
// ============================================================
// AI Extension hooks:
//   teGetMLFeatures()     — export feature vectors สำหรับ ML model
//   teApplyMLThresholds() — รับ threshold ที่คำนวณโดย ML จากภายนอก
// ============================================================


// ============================================================
// SECTION 1 — THRESHOLD CONFIGURATION
// ปรับค่าตรงนี้ได้โดยไม่ต้องแก้ logic
// ============================================================

/**
 * Global default thresholds
 * ทุกค่าสามารถ override ได้ระดับ site / meter / meterType
 *
 * อ้างอิงค่าเริ่มต้นจาก Config.gs THRESHOLDS
 * แต่ ThresholdEngine จัดการค่าที่ละเอียดกว่า
 */
const TE_DEFAULTS = {
  // ── Spike Detection ──────────────────────────────────────
  SPIKE_PCT_LOW:      20,   // % เพิ่มขึ้นจากเดือนก่อน → LOW
  SPIKE_PCT_MEDIUM:   CONFIG.THRESHOLDS.SPIKE_PCT    || 30,   // → MEDIUM
  SPIKE_PCT_HIGH:     CONFIG.THRESHOLDS.SPIKE_PCT_HIGH || 50, // → HIGH
  SPIKE_PCT_CRITICAL: 100,  // % → CRITICAL (เพิ่มเป็น 2 เท่า)

  // ── Drop Detection ───────────────────────────────────────
  DROP_PCT_LOW:      20,   // % ลดลงจากเดือนก่อน → LOW (กระแสไฟ/น้ำลดผิดปกติ)
  DROP_PCT_MEDIUM:   35,   // → MEDIUM
  DROP_PCT_HIGH:     CONFIG.THRESHOLDS.WATER_DROP_PCT || 50, // → HIGH
  DROP_PCT_CRITICAL: 80,   // → CRITICAL (แทบไม่มีการใช้)

  // ── Historical Average Comparison ────────────────────────
  AVG_WINDOW_MONTHS:  6,   // จำนวนเดือนที่ใช้คำนวณค่าเฉลี่ย historical
  AVG_PCT_LOW:        15,  // % สูงกว่า historical avg → LOW
  AVG_PCT_MEDIUM:     CONFIG.THRESHOLDS.AVG6M_PCT || 40, // → MEDIUM
  AVG_PCT_HIGH:       60,  // → HIGH
  AVG_PCT_CRITICAL:   100, // → CRITICAL

  // ── Dynamic Statistical Thresholds ───────────────────────
  Z_SCORE_MEDIUM:     1.5, // z-score สำหรับ MEDIUM (≈93rd percentile)
  Z_SCORE_HIGH:       2.0, // → HIGH (≈97.7th percentile)
  Z_SCORE_CRITICAL:   3.0, // → CRITICAL (≈99.7th percentile)
  IQR_MULTIPLIER:     1.5, // k ใน (Q3 + k*IQR) สำหรับ outlier upper bound
  IQR_MULTIPLIER_EXT: 3.0, // extreme outlier upper bound

  // ── Minimum Data Requirements ────────────────────────────
  MIN_MONTHS:   CONFIG.THRESHOLDS.MIN_MONTHS_DETECT || 3, // ขั้นต่ำก่อน detect
  MIN_FOR_STAT: 6,   // ขั้นต่ำก่อนใช้ statistical thresholds
  MIN_FOR_IQR:  8,   // ขั้นต่ำก่อนใช้ IQR thresholds

  // ── Zero / Near-Zero Usage ────────────────────────────────
  ZERO_THRESHOLD:      0,    // units_used ≤ นี้ = ZERO_USAGE anomaly
  NEAR_ZERO_PCT:       5,    // % ของ avg ที่ถือว่า near-zero
};

/**
 * Override thresholds per meter type
 * ค่าที่กำหนดที่นี่จะ merge กับ TE_DEFAULTS (key-by-key)
 */
const TE_METER_TYPE_OVERRIDES = {
  ELECTRICITY: {
    // ไฟฟ้า: spike มักเกิดจากอุปกรณ์ใหม่ → ยอมรับการเปลี่ยนแปลงได้มากกว่า
    SPIKE_PCT_LOW:    25,
    SPIKE_PCT_MEDIUM: 35,
    DROP_PCT_MEDIUM:  40,   // ไฟฟ้าลดลงปกติกว่า — ต้องลดมากกว่าจึง flag
  },
  WATER: {
    // น้ำ: การลดลงผิดปกติน่าสงสัยกว่า (มิเตอร์เสีย / ปิดใช้ / รั่ว)
    DROP_PCT_LOW:    15,
    DROP_PCT_MEDIUM: 30,
    DROP_PCT_HIGH:   CONFIG.THRESHOLDS.WATER_DROP_PCT || 50,
    SPIKE_PCT_HIGH:  45,    // น้ำ spike ก็ผิดปกติมากกว่าไฟฟ้า
  },
};


// ============================================================
// SECTION 2 — THRESHOLD RESOLUTION
// Logic สำหรับ merge/override thresholds หลายระดับ
// ============================================================

/**
 * ดึง threshold config สำหรับ meter หนึ่งตัว
 * ลำดับ priority (สูง → ต่ำ):
 *   1. Per-meter override (จาก Properties / custom config)
 *   2. Per-site override
 *   3. Per-meterType override (TE_METER_TYPE_OVERRIDES)
 *   4. Global TE_DEFAULTS
 *
 * @param {string} meterId
 * @param {string} meterType  — 'ELECTRICITY' | 'WATER'
 * @param {string} [siteId]
 * @returns {Object} — merged threshold config object
 */
function teGetThresholds(meterId, meterType, siteId) {
  // เริ่มจาก global defaults
  var config = _cloneDefaults();

  // Layer 2: meter type overrides
  var typeOverride = TE_METER_TYPE_OVERRIDES[String(meterType).toUpperCase()];
  if (typeOverride) {
    config = _mergeThresholds(config, typeOverride);
  }

  // Layer 3: per-site overrides (เก็บใน PropertiesService)
  if (siteId) {
    var siteOverride = _loadSiteThresholdOverride(siteId);
    if (siteOverride) {
      config = _mergeThresholds(config, siteOverride);
    }
  }

  // Layer 4: per-meter overrides (ละเอียดที่สุด)
  var meterOverride = _loadMeterThresholdOverride(meterId);
  if (meterOverride) {
    config = _mergeThresholds(config, meterOverride);
  }

  return config;
}


/**
 * บันทึก threshold override สำหรับ site หนึ่ง
 * เก็บใน PropertiesService (persistent ข้าม execution)
 *
 * @param {string} siteId
 * @param {Object} overrides  — partial threshold object
 */
function teSaveSiteThresholdOverride(siteId, overrides) {
  var key = 'threshold_site_' + siteId;
  PropertiesService.getScriptProperties()
    .setProperty(key, JSON.stringify(overrides));
  Logger.log('[ThresholdEngine] Saved site override: ' + siteId);
}


/**
 * บันทึก threshold override สำหรับ meter หนึ่ง
 *
 * @param {string} meterId
 * @param {Object} overrides  — partial threshold object
 */
function teSaveMeterThresholdOverride(meterId, overrides) {
  var key = 'threshold_meter_' + meterId;
  PropertiesService.getScriptProperties()
    .setProperty(key, JSON.stringify(overrides));
  Logger.log('[ThresholdEngine] Saved meter override: ' + meterId);
}


/**
 * ลบ threshold override สำหรับ site (reset to default)
 *
 * @param {string} siteId
 */
function teRemoveSiteThresholdOverride(siteId) {
  var key = 'threshold_site_' + siteId;
  PropertiesService.getScriptProperties().deleteProperty(key);
}


/**
 * ลบ threshold override สำหรับ meter (reset to default)
 *
 * @param {string} meterId
 */
function teRemoveMeterThresholdOverride(meterId) {
  var key = 'threshold_meter_' + meterId;
  PropertiesService.getScriptProperties().deleteProperty(key);
}


// ============================================================
// SECTION 3 — DYNAMIC THRESHOLD CALCULATION
// คำนวณ threshold จาก historical data (ไม่ใช่ค่าคงที่)
// ============================================================

/**
 * คำนวณ dynamic thresholds สำหรับ meter จาก historical bills
 * ใช้ statistical methods:
 *   - Mean ± k*StdDev  (z-score based)
 *   - IQR-based outlier bounds (robust ต่อ extreme values)
 *   - Percentile bounds
 *
 * @param {Object[]} sortedBills  — bills เรียงตาม period_key (เก่า→ใหม่)
 * @param {string}   metric       — 'amount_total' | 'units_used'
 * @param {Object}   threshConfig — จาก teGetThresholds()
 * @returns {Object} dynamicBounds
 *   {
 *     mean:            number,
 *     stdDev:          number,
 *     upperMedium:     number,   // mean + Z_MEDIUM * σ
 *     upperHigh:       number,   // mean + Z_HIGH * σ
 *     upperCritical:   number,   // mean + Z_CRITICAL * σ
 *     lowerMedium:     number,   // mean - Z_MEDIUM * σ
 *     lowerHigh:       number,   // mean - Z_HIGH * σ
 *     iqrUpperBound:   number,   // Q3 + k*IQR
 *     iqrLowerBound:   number,   // Q1 - k*IQR
 *     p10:             number,   // 10th percentile
 *     p90:             number,   // 90th percentile
 *     p95:             number,   // 95th percentile
 *     sampleSize:      number,
 *     methodUsed:      string,   // 'STATISTICAL' | 'IQR' | 'INSUFFICIENT'
 *   }
 */
function teCalculateDynamicBounds(sortedBills, metric, threshConfig) {
  var cfg = threshConfig || _cloneDefaults();

  // ดึงค่า metric ออกมาเป็น array (กรอง null/0 ที่ไม่ valid)
  var values = sortedBills
    .map(function(b) { return parseFloat(b[metric]); })
    .filter(function(v) { return !isNaN(v) && v > 0; });

  var n = values.length;

  // กรณีข้อมูลไม่พอ → return fallback
  if (n < cfg.MIN_MONTHS) {
    return {
      mean: null, stdDev: null,
      upperMedium: null, upperHigh: null, upperCritical: null,
      lowerMedium: null, lowerHigh: null,
      iqrUpperBound: null, iqrLowerBound: null,
      p10: null, p90: null, p95: null,
      sampleSize: n,
      methodUsed: 'INSUFFICIENT',
    };
  }

  var mean   = tcMean(values);
  var stdDev = tcStdDev(values);
  var sorted = values.slice().sort(function(a, b) { return a - b; });

  // ── Z-score bounds ──────────────────────────────────────
  var upperMedium   = mean + cfg.Z_SCORE_MEDIUM   * stdDev;
  var upperHigh     = mean + cfg.Z_SCORE_HIGH     * stdDev;
  var upperCritical = mean + cfg.Z_SCORE_CRITICAL * stdDev;
  var lowerMedium   = Math.max(0, mean - cfg.Z_SCORE_MEDIUM   * stdDev);
  var lowerHigh     = Math.max(0, mean - cfg.Z_SCORE_HIGH     * stdDev);

  // ── IQR bounds (ใช้เมื่อ n ≥ MIN_FOR_IQR) ───────────────
  var iqrUpperBound = null;
  var iqrLowerBound = null;

  if (n >= cfg.MIN_FOR_IQR) {
    var q1 = _percentile(sorted, 25);
    var q3 = _percentile(sorted, 75);
    var iqr = q3 - q1;
    iqrUpperBound = q3 + cfg.IQR_MULTIPLIER * iqr;
    iqrLowerBound = Math.max(0, q1 - cfg.IQR_MULTIPLIER * iqr);
  }

  // ── Percentile bounds ────────────────────────────────────
  var p10 = _percentile(sorted, 10);
  var p90 = _percentile(sorted, 90);
  var p95 = _percentile(sorted, 95);

  // methodUsed: ถ้า n ≥ MIN_FOR_IQR ใช้ IQR เป็นหลัก ไม่งั้นใช้ z-score
  var methodUsed = n >= cfg.MIN_FOR_IQR ? 'IQR' : 'STATISTICAL';

  return {
    mean:           _round2(mean),
    stdDev:         _round2(stdDev),
    upperMedium:    _round2(upperMedium),
    upperHigh:      _round2(upperHigh),
    upperCritical:  _round2(upperCritical),
    lowerMedium:    _round2(lowerMedium),
    lowerHigh:      _round2(lowerHigh),
    iqrUpperBound:  iqrUpperBound !== null ? _round2(iqrUpperBound) : null,
    iqrLowerBound:  iqrLowerBound !== null ? _round2(iqrLowerBound) : null,
    p10:            _round2(p10),
    p90:            _round2(p90),
    p95:            _round2(p95),
    sampleSize:     n,
    methodUsed:     methodUsed,
  };
}


/**
 * คำนวณ rolling baseline (ค่าเฉลี่ยเคลื่อนที่)
 * สำหรับเปรียบเทียบกับค่าล่าสุด
 *
 * @param {Object[]} sortedBills   — bills เรียง period_key (เก่า→ใหม่)
 * @param {string}   metric        — 'amount_total' | 'units_used'
 * @param {number}   window        — จำนวนเดือนย้อนหลัง (default: AVG_WINDOW_MONTHS)
 * @returns {{ avg: number|null, count: number, values: number[] }}
 */
function teCalculateRollingBaseline(sortedBills, metric, window) {
  var w = window || TE_DEFAULTS.AVG_WINDOW_MONTHS;

  // ใช้ n-1 ถึง n-w (ไม่รวม bill ล่าสุด เพื่อให้ baseline ไม่ bias)
  var historicalBills = sortedBills.slice(-(w + 1), -1);
  var values = historicalBills
    .map(function(b) { return parseFloat(b[metric]); })
    .filter(function(v) { return !isNaN(v) && v > 0; });

  if (values.length === 0) {
    return { avg: null, count: 0, values: [] };
  }

  return {
    avg:    _round2(tcMean(values)),
    count:  values.length,
    values: values,
  };
}


/**
 * คำนวณ seasonal baseline — เปรียบเทียบกับเดือนเดียวกันของปีก่อน
 * ช่วยลด false positive ที่เกิดจากฤดูกาล (เช่น AC ช่วงร้อน)
 *
 * @param {Object[]} allBills  — all bills ของ meter นี้ (ไม่จำเป็นต้องเรียง)
 * @param {number}   targetMonth
 * @param {string}   metric
 * @param {number}   [lookbackYears=2]  — ดูย้อนหลังกี่ปี
 * @returns {{ avg: number|null, count: number, years: number[] }}
 */
function teCalculateSeasonalBaseline(allBills, targetMonth, metric, lookbackYears) {
  var years = lookbackYears || 2;
  var latestYear = allBills.reduce(function(max, b) {
    return Math.max(max, parseInt(b.bill_year) || 0);
  }, 0);

  // กรองเฉพาะ bills เดือนเดียวกัน ของปีก่อนๆ
  var samePeriodBills = allBills.filter(function(b) {
    var y = parseInt(b.bill_year);
    var m = parseInt(b.bill_month);
    return m === targetMonth && y >= (latestYear - years) && y < latestYear;
  });

  var values = samePeriodBills
    .map(function(b) { return parseFloat(b[metric]); })
    .filter(function(v) { return !isNaN(v) && v > 0; });

  if (values.length === 0) {
    return { avg: null, count: 0, years: [] };
  }

  var usedYears = samePeriodBills.map(function(b) { return parseInt(b.bill_year); });

  return {
    avg:   _round2(tcMean(values)),
    count: values.length,
    years: usedYears,
  };
}


// ============================================================
// SECTION 4 — PERCENTAGE THRESHOLD ANALYSIS
// ============================================================

/**
 * วิเคราะห์การเปลี่ยนแปลงเป็น % พร้อม classify ระดับ
 *
 * @param {number} currentValue
 * @param {number} referenceValue   — ค่าที่ใช้เปรียบเทียบ (เดือนก่อน / avg)
 * @param {Object} threshConfig     — จาก teGetThresholds()
 * @param {string} [direction]      — 'SPIKE' | 'DROP' | 'AUTO'
 * @returns {Object}
 *   {
 *     pctChange:    number,   // % เปลี่ยนแปลง (บวก=เพิ่ม, ลบ=ลด)
 *     absChange:    number,
 *     direction:    'SPIKE' | 'DROP' | 'FLAT',
 *     exceedsLow:   boolean,
 *     exceedsMedium: boolean,
 *     exceedsHigh:  boolean,
 *     exceedsCritical: boolean,
 *     thresholdHit: string,  // 'NONE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'
 *   }
 */
function teAnalyzePctChange(currentValue, referenceValue, threshConfig, direction) {
  var cfg = threshConfig || _cloneDefaults();

  if (!referenceValue || referenceValue === 0) {
    return _nullPctResult();
  }

  var absChange = currentValue - referenceValue;
  var pctChange = _round2((absChange / referenceValue) * 100);
  var dir = direction || (pctChange > 0 ? 'SPIKE' : pctChange < 0 ? 'DROP' : 'FLAT');

  // ถ้า direction='AUTO' แต่ระบุ direction ไว้ ให้ใช้ที่ระบุ
  if (direction === 'SPIKE')  dir = 'SPIKE';
  if (direction === 'DROP')   dir = 'DROP';

  var absPct = Math.abs(pctChange);
  var hit    = 'NONE';

  if (dir === 'SPIKE') {
    if (absPct >= cfg.SPIKE_PCT_CRITICAL) hit = 'CRITICAL';
    else if (absPct >= cfg.SPIKE_PCT_HIGH)   hit = 'HIGH';
    else if (absPct >= cfg.SPIKE_PCT_MEDIUM) hit = 'MEDIUM';
    else if (absPct >= cfg.SPIKE_PCT_LOW)    hit = 'LOW';
  } else if (dir === 'DROP') {
    if (absPct >= cfg.DROP_PCT_CRITICAL) hit = 'CRITICAL';
    else if (absPct >= cfg.DROP_PCT_HIGH)   hit = 'HIGH';
    else if (absPct >= cfg.DROP_PCT_MEDIUM) hit = 'MEDIUM';
    else if (absPct >= cfg.DROP_PCT_LOW)    hit = 'LOW';
  }

  return {
    pctChange:       pctChange,
    absChange:       _round2(absChange),
    direction:       dir,
    exceedsLow:      hit !== 'NONE',
    exceedsMedium:   hit === 'MEDIUM' || hit === 'HIGH' || hit === 'CRITICAL',
    exceedsHigh:     hit === 'HIGH' || hit === 'CRITICAL',
    exceedsCritical: hit === 'CRITICAL',
    thresholdHit:    hit,
  };
}


/**
 * เปรียบเทียบ currentValue กับ dynamic bounds จาก teCalculateDynamicBounds()
 *
 * @param {number} currentValue
 * @param {Object} dynamicBounds   — จาก teCalculateDynamicBounds()
 * @returns {Object}
 *   {
 *     zScore:           number|null,
 *     isUpperOutlier:   boolean,   // เกิน upper IQR/z bound
 *     isLowerOutlier:   boolean,   // ต่ำกว่า lower IQR/z bound
 *     severity:         'NONE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL',
 *     boundType:        'Z_SCORE'|'IQR'|'NONE',
 *   }
 */
function teCheckDynamicBounds(currentValue, dynamicBounds) {
  if (!dynamicBounds || dynamicBounds.methodUsed === 'INSUFFICIENT') {
    return { zScore: null, isUpperOutlier: false, isLowerOutlier: false, severity: 'NONE', boundType: 'NONE' };
  }

  var db  = dynamicBounds;
  var sev = 'NONE';
  var isUpper = false;
  var isLower = false;
  var boundType = db.methodUsed === 'IQR' ? 'IQR' : 'Z_SCORE';

  // Z-score
  var zScore = null;
  if (db.mean !== null && db.stdDev !== null && db.stdDev > 0) {
    zScore = _round2((currentValue - db.mean) / db.stdDev);
  }

  // ใช้ IQR bounds ถ้ามี (robust กว่า)
  if (db.iqrUpperBound !== null) {
    if (currentValue > db.iqrUpperBound) {
      isUpper = true;
      sev = 'MEDIUM';
      // ถ้าเกิน z HIGH/CRITICAL bounds ด้วย → ยกระดับ
      if (db.upperCritical !== null && currentValue > db.upperCritical) sev = 'CRITICAL';
      else if (db.upperHigh !== null && currentValue > db.upperHigh)    sev = 'HIGH';
    } else if (currentValue < db.iqrLowerBound) {
      isLower = true;
      sev = 'MEDIUM';
      if (db.lowerHigh !== null && currentValue < db.lowerHigh) sev = 'HIGH';
    }
  } else if (db.upperMedium !== null) {
    // Fallback ใช้ z-score bounds
    if (currentValue > db.upperCritical)     { isUpper = true; sev = 'CRITICAL'; }
    else if (currentValue > db.upperHigh)    { isUpper = true; sev = 'HIGH'; }
    else if (currentValue > db.upperMedium)  { isUpper = true; sev = 'MEDIUM'; }
    else if (currentValue < db.lowerHigh)    { isLower = true; sev = 'HIGH'; }
    else if (currentValue < db.lowerMedium)  { isLower = true; sev = 'MEDIUM'; }
  }

  return {
    zScore:         zScore,
    isUpperOutlier: isUpper,
    isLowerOutlier: isLower,
    severity:       sev,
    boundType:      boundType,
  };
}


// ============================================================
// SECTION 5 — AI EXTENSION HOOKS
// ============================================================

/**
 * Export feature vectors สำหรับ ML/AI model ภายนอก
 * เตรียมไว้สำหรับการต่อยอดด้วย AI ในอนาคต
 *
 * @param {Object[]} sortedBills   — bills เรียงตาม period_key
 * @param {string}   metric        — 'amount_total' | 'units_used'
 * @returns {Object[]} feature vectors (แต่ละ row = 1 billing period)
 *   Each row: { period_key, value, mom_pct, ra3, ra6, ra12, zScore, iqrBound }
 */
function teGetMLFeatures(sortedBills, metric) {
  if (!sortedBills || sortedBills.length === 0) return [];

  var values  = sortedBills.map(function(b) { return parseFloat(b[metric]) || 0; });
  var ra3     = tcRollingAverage(values, 3);
  var ra6     = tcRollingAverage(values, 6);
  var ra12    = tcRollingAverage(values, 12);
  var mean    = tcMean(values);
  var stdDev  = tcStdDev(values);

  return sortedBills.map(function(b, i) {
    var v     = parseFloat(b[metric]) || 0;
    var prev  = i > 0 ? (parseFloat(sortedBills[i - 1][metric]) || 0) : null;
    var momPct = (prev !== null && prev > 0) ? _round2(((v - prev) / prev) * 100) : null;
    var z      = (stdDev > 0) ? _round2((v - mean) / stdDev) : null;

    return {
      period_key: b.bill_period_key || tcMakePeriodKey(b.bill_year, b.bill_month),
      value:      v,
      mom_pct:    momPct,
      ra3:        ra3[i],
      ra6:        ra6[i],
      ra12:       ra12[i],
      z_score:    z,
      month:      parseInt(b.bill_month),
      year:       parseInt(b.bill_year),
    };
  });
}


/**
 * รับ threshold ที่คำนวณโดย ML model จากภายนอก และ save ลง Properties
 * ML model สามารถส่ง custom threshold มาได้ผ่าน API
 *
 * @param {string} meterId
 * @param {Object} mlThresholds  — { SPIKE_PCT_MEDIUM, SPIKE_PCT_HIGH, ... }
 * @param {string} [modelVersion]
 */
function teApplyMLThresholds(meterId, mlThresholds, modelVersion) {
  var key = 'threshold_meter_' + meterId;
  var existing = _loadMeterThresholdOverride(meterId) || {};

  // Merge ML thresholds กับ existing overrides
  var merged = Object.assign({}, existing, mlThresholds, {
    _ml_model_version: modelVersion || 'unknown',
    _ml_applied_at:    new Date().toISOString(),
  });

  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(merged));
  Logger.log('[ThresholdEngine] Applied ML thresholds for meter: ' + meterId
    + ' (model: ' + (modelVersion || 'unknown') + ')');
}


// ============================================================
// SECTION 6 — PRIVATE HELPERS
// ============================================================

/**
 * Clone TE_DEFAULTS (ป้องกันการ mutate global)
 * @private
 */
function _cloneDefaults() {
  return Object.assign({}, TE_DEFAULTS);
}


/**
 * Merge threshold objects — override key-by-key
 * @private
 */
function _mergeThresholds(base, override) {
  return Object.assign({}, base, override);
}


/**
 * โหลด site-level threshold override จาก PropertiesService
 * @private
 */
function _loadSiteThresholdOverride(siteId) {
  try {
    var raw = PropertiesService.getScriptProperties()
      .getProperty('threshold_site_' + siteId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    Logger.log('[ThresholdEngine] Error loading site override for ' + siteId + ': ' + e.message);
    return null;
  }
}


/**
 * โหลด meter-level threshold override จาก PropertiesService
 * @private
 */
function _loadMeterThresholdOverride(meterId) {
  try {
    var raw = PropertiesService.getScriptProperties()
      .getProperty('threshold_meter_' + meterId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    Logger.log('[ThresholdEngine] Error loading meter override for ' + meterId + ': ' + e.message);
    return null;
  }
}


/**
 * คำนวณ percentile จาก sorted array
 * ใช้ linear interpolation
 * @private
 */
function _percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];

  var index = (p / 100) * (sortedArr.length - 1);
  var lower = Math.floor(index);
  var upper = Math.ceil(index);
  var frac  = index - lower;

  if (lower === upper) return sortedArr[lower];
  return _round2(sortedArr[lower] * (1 - frac) + sortedArr[upper] * frac);
}


/**
 * Round to 2 decimal places
 * @private
 */
function _round2(v) {
  return Math.round(v * 100) / 100;
}


/**
 * Return empty pct analysis result
 * @private
 */
function _nullPctResult() {
  return {
    pctChange: null, absChange: null, direction: 'FLAT',
    exceedsLow: false, exceedsMedium: false,
    exceedsHigh: false, exceedsCritical: false,
    thresholdHit: 'NONE',
  };
}
