// ============================================================
// AbnormalDetector.gs — Abnormal Detection Engine (Orchestrator)
// UtilityManager | PHASE 5B — Abnormal Detection Engine
// ============================================================
// รับผิดชอบ:
//   1. Usage spike detection (MoM + vs historical avg + statistical)
//   2. Sudden drop detection (MoM + zero/near-zero + statistical)
//   3. Historical average comparison (rolling 3/6/12m)
//   4. Dynamic threshold calculation (per site/meter/type)
//   5. Anomaly record generation + save to Anomalies sheet
//   6. Multi-site, multi-meter support
//   7. Trigger-callable entry points
// ============================================================
// Dependencies:
//   Config.gs, Utils.gs, Database.gs, Auth.gs
//   TrendCalculator.gs   ← rolling avg, mean, std dev
//   ThresholdEngine.gs   ← threshold resolution + calculation
//   SeverityClassifier.gs ← severity + ranking
// ============================================================
// Public API:
//   detectAnomalies(token, options)       — main entry (all sites)
//   detectAnomaliesForMeter(bills, meterId, meterType, siteId) — single meter
//   getAnomalyReport(token, options)      — ดึง anomalies พร้อม summary
//   runAnomalyDetectionTrigger()          — Time-driven trigger entry
// ============================================================
// AI Extension hooks:
//   adGetMLReadyDataset()  — export labeled dataset สำหรับ ML training
// ============================================================


// ============================================================
// SECTION 1 — DETECTION CONFIGURATION
// ============================================================

/**
 * Configuration สำหรับ detection engine
 * ปรับได้โดยไม่ต้องแก้ logic
 */
const AD_CONFIG = {
  // ── Features Toggle ───────────────────────────────────────
  ENABLE_SPIKE_DETECTION:      true,   // เปิด/ปิด spike detection
  ENABLE_DROP_DETECTION:       true,   // เปิด/ปิด drop detection
  ENABLE_ZERO_DETECTION:       true,   // เปิด/ปิด zero usage detection
  ENABLE_STAT_DETECTION:       true,   // เปิด/ปิด statistical outlier
  ENABLE_YOY_DETECTION:        false,  // YoY detection (ต้องการข้อมูล 2 ปี)
  ENABLE_SEASONAL_BASELINE:    false,  // seasonal comparison (optional)

  // ── Performance ───────────────────────────────────────────
  BATCH_SIZE:         50,   // จำนวน meters ที่ process ต่อ batch
  CACHE_THRESHOLD_MS: 300,  // ms timeout สำหรับ PropertiesService cache

  // ── Output Control ────────────────────────────────────────
  SAVE_TO_SHEET:        true,   // บันทึก anomalies ลง Anomalies sheet
  OVERWRITE_SAME_PERIOD: true,  // ถ้า anomaly เดิมมีอยู่แล้ว → overwrite
  MIN_CONFIDENCE_SAVE:  20,     // confidence ขั้นต่ำก่อน save (กรอง noise)

  // ── Logging ───────────────────────────────────────────────
  LOG_LEVEL: 'INFO',   // 'DEBUG' | 'INFO' | 'WARN'
};


// ============================================================
// SECTION 2 — PUBLIC API
// ============================================================

/**
 * ตรวจหา anomalies ทุก site / ทุก meter
 * Entry point หลักสำหรับเรียกจากภายนอก
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string}   [options.site_id]      — จำกัดเฉพาะ site (null = ทุก site)
 * @param {string}   [options.meter_id]     — จำกัดเฉพาะ meter (null = ทุก meter)
 * @param {string}   [options.meter_type]   — 'ELECTRICITY'|'WATER'|'ALL'
 * @param {number}   [options.bill_year]    — ตรวจเฉพาะปี (null = ล่าสุด)
 * @param {number}   [options.bill_month]   — ตรวจเฉพาะเดือน (null = ล่าสุด)
 * @param {boolean}  [options.dry_run]      — true = ไม่ save ลง sheet
 * @returns {Object}
 *   {
 *     anomalies:   Object[],   — anomaly records ทั้งหมด (ranked)
 *     summary:     Object,     — scSummarize() output
 *     meta:        Object,     — { duration_ms, meters_checked, ... }
 *   }
 */
function detectAnomalies(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeDetectOptions(options);

  var startTime = Date.now();
  _adLog('INFO', 'detectAnomalies START — options: ' + JSON.stringify(options));

  try {
    // ── 1. Batch load ทุก table ────────────────────────────
    var data    = tcLoadAllData();
    var allBills = tcFilterValidBills(data.bills);
    var meters  = data.meters;
    var sites   = data.sites;

    // ── 2. Apply filters ───────────────────────────────────
    if (options.site_id) {
      allBills = allBills.filter(function(b) { return b.site_id === options.site_id; });
      meters   = meters.filter(function(m)   { return m.site_id === options.site_id; });
    }
    if (options.meter_id) {
      allBills = allBills.filter(function(b) { return b.meter_id === options.meter_id; });
      meters   = meters.filter(function(m)   { return m.meter_id === options.meter_id; });
    }
    if (options.meter_type && options.meter_type !== 'ALL') {
      var meterMap = tcBuildMeterMap(meters);
      allBills = tcFilterByMeterType(allBills, options.meter_type, meterMap);
    }

    // ── 3. Group bills by meter ────────────────────────────
    var billsByMeter = tcGroupBy(allBills, 'meter_id');
    var meterLookup  = _buildMeterLookup(meters);
    var siteLookup   = _buildSiteLookup(sites);

    // ── 4. Process each meter ──────────────────────────────
    var allAnomalies = [];
    var metersChecked = 0;
    var meterIds = Object.keys(billsByMeter);

    _adLog('INFO', 'Processing ' + meterIds.length + ' meters');

    meterIds.forEach(function(meterId) {
      var meterBills = billsByMeter[meterId];
      var meterInfo  = meterLookup[meterId] || {};
      var meterType  = meterInfo.meter_type || 'ELECTRICITY';
      var siteId     = meterInfo.site_id    || null;

      // กรอง bill_year / bill_month ถ้าระบุ
      var targetBills = _filterByPeriod(meterBills, options.bill_year, options.bill_month);
      if (targetBills.length === 0) return; // ไม่มี bill ในช่วงที่กำหนด

      try {
        var meterAnomalies = detectAnomaliesForMeter(
          meterBills,    // all bills สำหรับ meter นี้ (ใช้สำหรับ baseline)
          meterId,
          meterType,
          siteId,
          targetBills    // bills ที่ต้องการ check (อาจเป็น subset)
        );
        allAnomalies = allAnomalies.concat(meterAnomalies);
        metersChecked++;
      } catch (e) {
        _adLog('WARN', 'Error processing meter ' + meterId + ': ' + e.message);
      }
    });

    // ── 5. Rank all anomalies ──────────────────────────────
    var rankedAnomalies = scRankAnomalies(allAnomalies);
    var summary         = scSummarize(rankedAnomalies);

    // ── 6. Enrich with site/meter name ─────────────────────
    rankedAnomalies = _enrichAnomalies(rankedAnomalies, meterLookup, siteLookup);

    // ── 7. Save to Anomalies sheet ─────────────────────────
    if (AD_CONFIG.SAVE_TO_SHEET && !options.dry_run) {
      _saveAnomaliesToSheet(rankedAnomalies);
    }

    var duration = Date.now() - startTime;
    _adLog('INFO', 'detectAnomalies DONE — '
      + rankedAnomalies.length + ' anomalies found in '
      + duration + 'ms');

    return {
      anomalies: rankedAnomalies,
      summary:   summary,
      meta: {
        duration_ms:    duration,
        meters_checked: metersChecked,
        anomaly_count:  rankedAnomalies.length,
        site_id:        options.site_id,
        meter_type:     options.meter_type,
        generated_at:   new Date().toISOString(),
        dry_run:        options.dry_run || false,
      },
    };

  } catch (e) {
    _adLog('WARN', 'detectAnomalies ERROR: ' + e.message);
    throw e;
  }
}


/**
 * ตรวจหา anomalies สำหรับ meter เดียว
 * ใช้เป็น unit-testable function สำหรับ individual meter
 *
 * @param {Object[]} allMeterBills   — all bills ของ meter นี้ (สำหรับ baseline)
 * @param {string}   meterId
 * @param {string}   meterType       — 'ELECTRICITY' | 'WATER'
 * @param {string}   [siteId]
 * @param {Object[]} [targetBills]   — bills ที่จะ check (default = bill ล่าสุด)
 * @returns {Object[]}  — anomaly records (un-ranked)
 */
function detectAnomaliesForMeter(allMeterBills, meterId, meterType, siteId, targetBills) {
  // เรียง bills ตาม period (เก่า→ใหม่)
  var sortedAll = tcSortByPeriod(allMeterBills);

  // ถ้าไม่ระบุ targetBills → ใช้ bill ล่าสุดเพียง 1 รายการ
  var targets = targetBills
    ? tcSortByPeriod(targetBills)
    : (sortedAll.length > 0 ? [sortedAll[sortedAll.length - 1]] : []);

  if (targets.length === 0 || sortedAll.length < AD_CONFIG.ENABLE_STAT_DETECTION
    ? 1 : CONFIG.THRESHOLDS.MIN_MONTHS_DETECT) {
    return [];
  }

  // โหลด threshold config สำหรับ meter นี้ (รวม overrides)
  var threshConfig   = teGetThresholds(meterId, meterType, siteId);

  // คำนวณ dynamic bounds จาก ALL historical bills
  var dynamicBoundsAmt   = teCalculateDynamicBounds(sortedAll, 'amount_total', threshConfig);
  var dynamicBoundsUnits = teCalculateDynamicBounds(sortedAll, 'units_used',   threshConfig);

  var anomalies = [];

  // ตรวจสอบแต่ละ target bill
  targets.forEach(function(targetBill) {
    // หา index ของ targetBill ใน sortedAll
    var idx = _findBillIndex(sortedAll, targetBill);
    if (idx < threshConfig.MIN_MONTHS - 1) return; // ข้อมูลไม่พอ

    var prevBill        = idx > 0 ? sortedAll[idx - 1]     : null;
    var historyBills    = sortedAll.slice(0, idx); // bills ก่อน target

    // Rolling baseline (สำหรับ vs-avg comparison)
    var baselineAmt   = teCalculateRollingBaseline(sortedAll.slice(0, idx + 1), 'amount_total', threshConfig.AVG_WINDOW_MONTHS);
    var baselineUnits = teCalculateRollingBaseline(sortedAll.slice(0, idx + 1), 'units_used',   threshConfig.AVG_WINDOW_MONTHS);

    // รวม signals จากทุก detection method
    var signals = [];

    // ── Detection Module 1: Spike Detection ─────────────
    if (AD_CONFIG.ENABLE_SPIKE_DETECTION) {
      var spikeSignals = _detectSpike(
        targetBill, prevBill, baselineAmt, threshConfig, 'amount_total'
      );
      signals = signals.concat(spikeSignals);

      var spikeUnitsSignals = _detectSpike(
        targetBill, prevBill, baselineUnits, threshConfig, 'units_used'
      );
      signals = signals.concat(spikeUnitsSignals);
    }

    // ── Detection Module 2: Drop Detection ──────────────
    if (AD_CONFIG.ENABLE_DROP_DETECTION || AD_CONFIG.ENABLE_ZERO_DETECTION) {
      var dropSignals = _detectDrop(
        targetBill, prevBill, baselineAmt, baselineUnits,
        threshConfig, meterType
      );
      signals = signals.concat(dropSignals);
    }

    // ── Detection Module 3: Statistical Outlier ─────────
    if (AD_CONFIG.ENABLE_STAT_DETECTION && dynamicBoundsAmt.methodUsed !== 'INSUFFICIENT') {
      var statSignals = _detectStatisticalOutlier(
        targetBill, dynamicBoundsAmt, dynamicBoundsUnits, threshConfig
      );
      signals = signals.concat(statSignals);
    }

    // ── Detection Module 4: YoY Comparison ──────────────
    if (AD_CONFIG.ENABLE_YOY_DETECTION) {
      var yoySignals = _detectYoY(targetBill, historyBills, threshConfig);
      signals = signals.concat(yoySignals);
    }

    // ── ถ้าไม่มี signal → ไม่บันทึก ───────────────────
    if (signals.length === 0) return;

    // ── ตรวจสอบ confidence ขั้นต่ำ ───────────────────────
    var confidence = scCalculateConfidence(signals, dynamicBoundsAmt);
    if (confidence < AD_CONFIG.MIN_CONFIDENCE_SAVE) return;

    // ── สร้าง anomaly record ──────────────────────────────
    var pctChange = (prevBill && prevBill.amount_total > 0)
      ? ((targetBill.amount_total - prevBill.amount_total) / prevBill.amount_total * 100)
      : null;

    var record = scBuildAnomalyRecord({
      meterId:       meterId,
      siteId:        siteId || targetBill.site_id,
      meterType:     meterType,
      billYear:      parseInt(targetBill.bill_year),
      billMonth:     parseInt(targetBill.bill_month),
      currentValue:  parseFloat(targetBill.amount_total) || null,
      prevValue:     prevBill ? parseFloat(prevBill.amount_total) || null : null,
      unitsUsed:     parseFloat(targetBill.units_used) || null,
      signals:       signals,
      dynamicBounds: dynamicBoundsAmt,
      baseline:      baselineAmt,
      pctChange:     pctChange,
    });

    anomalies.push(record);
  });

  return anomalies;
}


/**
 * ดึง anomaly report พร้อม summary (สำหรับ API / dashboard)
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string}   [options.site_id]
 * @param {string}   [options.meter_type]
 * @param {string}   [options.min_severity]  — SC_SEVERITY value
 * @param {number}   [options.limit]         — จำนวน records สูงสุด
 * @param {string}   [options.status]        — 'OPEN'|'ACKNOWLEDGED'|'RESOLVED'
 * @returns {Object}  — { anomalies, summary, meta }
 */
function getAnomalyReport(token, options) {
  requireAuth(token, 'canRead');
  options = options || {};

  var allAnomalies = dbGetAll(CONFIG.SHEETS.ANOMALIES);

  // ── Filters ────────────────────────────────────────────────
  if (options.site_id) {
    allAnomalies = allAnomalies.filter(function(a) {
      return a.site_id === options.site_id;
    });
  }
  if (options.meter_type && options.meter_type !== 'ALL') {
    allAnomalies = allAnomalies.filter(function(a) {
      return String(a.meter_type).toUpperCase() === options.meter_type.toUpperCase();
    });
  }
  if (options.status) {
    allAnomalies = allAnomalies.filter(function(a) {
      return a.status === options.status;
    });
  }
  if (options.bill_year) {
    allAnomalies = allAnomalies.filter(function(a) {
      return String(a.bill_year) === String(options.bill_year);
    });
  }

  // ── Severity filter ─────────────────────────────────────
  if (options.min_severity) {
    allAnomalies = scFilterBySeverity(allAnomalies, options.min_severity);
  }

  // ── Rank ─────────────────────────────────────────────────
  var ranked  = scRankAnomalies(allAnomalies);
  var summary = scSummarize(ranked);

  // ── Limit ─────────────────────────────────────────────────
  if (options.limit && options.limit > 0) {
    ranked = ranked.slice(0, options.limit);
  }

  return {
    anomalies: ranked,
    summary:   summary,
    meta: {
      total_unfiltered: allAnomalies.length,
      filters_applied:  options,
      generated_at:     new Date().toISOString(),
    },
  };
}


/**
 * Trigger entry point — เรียกจาก Time-driven Trigger ต้นเดือน
 * ไม่ต้องการ token (server-side automation)
 *
 * Trigger setup ใน Triggers.gs:
 *   ScriptApp.newTrigger('runAnomalyDetectionTrigger')
 *     .timeBased().onMonthDay(2).atHour(8).create();
 */
function runAnomalyDetectionTrigger() {
  _adLog('INFO', 'runAnomalyDetectionTrigger START');

  try {
    // ใช้ admin bypass (server-side, no user session)
    var adminToken = _getSystemToken();

    var result = detectAnomalies(adminToken, {
      meter_type: 'ALL',
      dry_run:    false,
    });

    _adLog('INFO', 'Trigger complete — '
      + result.anomalies.length + ' anomalies, '
      + 'CRITICAL: ' + result.summary.bySeverity.CRITICAL + ', '
      + 'HIGH: ' + result.summary.bySeverity.HIGH);

    // ส่ง email ถ้ามี CRITICAL หรือ HIGH anomalies
    var urgentAnomalies = scFilterBySeverity(
      result.anomalies,
      SC_SEVERITY.HIGH
    );

    if (urgentAnomalies.length > 0) {
      _sendAnomalyAlertEmail(urgentAnomalies, result.summary);
    }

    return result;

  } catch (e) {
    _adLog('WARN', 'runAnomalyDetectionTrigger ERROR: ' + e.message);
    // Log ลง AuditLog แต่ไม่ throw (trigger ไม่ควร fail silently)
    try {
      log('ERROR', 'runAnomalyDetectionTrigger', e.message);
    } catch (logErr) { /* ignore */ }
  }
}


// ============================================================
// SECTION 3 — DETECTION MODULE 1: SPIKE DETECTION
// ============================================================

/**
 * ตรวจหา usage/cost spike
 * สนับสนุน 2 วิธี: MoM comparison + vs historical average
 *
 * @param {Object}      targetBill
 * @param {Object|null} prevBill       — bill เดือนก่อน (null ถ้าไม่มี)
 * @param {Object}      baseline       — จาก teCalculateRollingBaseline()
 * @param {Object}      threshConfig   — จาก teGetThresholds()
 * @param {string}      metric         — 'amount_total' | 'units_used'
 * @returns {Object[]}  — signals array
 * @private
 */
function _detectSpike(targetBill, prevBill, baseline, threshConfig, metric) {
  var signals = [];
  var current = parseFloat(targetBill[metric]);

  if (isNaN(current) || current <= 0) return signals;

  // ── Method A: Month-over-Month spike ────────────────────
  if (prevBill) {
    var prev = parseFloat(prevBill[metric]);
    if (!isNaN(prev) && prev > 0) {
      var momPct    = ((current - prev) / prev) * 100;
      var momResult = teAnalyzePctChange(current, prev, threshConfig, 'SPIKE');

      if (momResult.thresholdHit !== 'NONE') {
        var typeKey = metric === 'units_used' ? 'SPIKE_UNITS_MOM' : 'SPIKE_MOM';
        signals.push({
          type:       typeKey,
          severity:   momResult.thresholdHit,
          pctChange:  Math.round(momPct * 10) / 10,
          method:     'MOM',
          metric:     metric,
          current:    current,
          reference:  prev,
        });
      }
    }
  }

  // ── Method B: vs Historical Average ─────────────────────
  if (baseline && baseline.avg !== null && baseline.count >= threshConfig.MIN_MONTHS) {
    var avgPct    = ((current - baseline.avg) / baseline.avg) * 100;
    var avgResult = teAnalyzePctChange(current, baseline.avg, threshConfig, 'SPIKE');

    // เฉพาะ MEDIUM+ เพื่อลด noise จาก avg-based detection
    if (avgResult.exceedsMedium) {
      signals.push({
        type:       'SPIKE_VS_AVG',
        severity:   avgResult.thresholdHit,
        pctChange:  Math.round(avgPct * 10) / 10,
        method:     'VS_AVG',
        metric:     metric,
        current:    current,
        reference:  baseline.avg,
        avgCount:   baseline.count,
      });
    }
  }

  return signals;
}


// ============================================================
// SECTION 4 — DETECTION MODULE 2: DROP DETECTION
// ============================================================

/**
 * ตรวจหา sudden drop + zero/near-zero usage
 *
 * @param {Object}      targetBill
 * @param {Object|null} prevBill
 * @param {Object}      baselineAmt     — rolling baseline for amount_total
 * @param {Object}      baselineUnits   — rolling baseline for units_used
 * @param {Object}      threshConfig
 * @param {string}      meterType       — 'ELECTRICITY' | 'WATER'
 * @returns {Object[]}  — signals array
 * @private
 */
function _detectDrop(targetBill, prevBill, baselineAmt, baselineUnits, threshConfig, meterType) {
  var signals = [];

  // ── Zero / Near-zero detection ────────────────────────────
  if (AD_CONFIG.ENABLE_ZERO_DETECTION) {
    var units = parseFloat(targetBill.units_used);

    if (!isNaN(units)) {
      // Zero usage
      if (units <= threshConfig.ZERO_THRESHOLD) {
        signals.push({
          type:      'ZERO_USAGE',
          severity:  SC_SEVERITY.HIGH,
          pctChange: -100,
          method:    'ZERO_CHECK',
          metric:    'units_used',
          current:   units,
          reference: null,
        });

      // Near-zero: ต่ำกว่า NEAR_ZERO_PCT% ของ baseline avg
      } else if (baselineUnits && baselineUnits.avg > 0) {
        var nearZeroCutoff = baselineUnits.avg * (threshConfig.NEAR_ZERO_PCT / 100);
        if (units <= nearZeroCutoff) {
          signals.push({
            type:      'NEAR_ZERO_USAGE',
            severity:  SC_SEVERITY.MEDIUM,
            pctChange: Math.round(((units - baselineUnits.avg) / baselineUnits.avg) * 100 * 10) / 10,
            method:    'NEAR_ZERO_CHECK',
            metric:    'units_used',
            current:   units,
            reference: baselineUnits.avg,
          });
        }
      }
    }
  }

  // ── Drop detection: MoM ─────────────────────────────────
  if (AD_CONFIG.ENABLE_DROP_DETECTION && prevBill) {
    // Check amount_total drop
    var curAmt  = parseFloat(targetBill.amount_total);
    var prevAmt = parseFloat(prevBill.amount_total);

    if (!isNaN(curAmt) && !isNaN(prevAmt) && prevAmt > 0) {
      var amtDropResult = teAnalyzePctChange(curAmt, prevAmt, threshConfig, 'DROP');
      if (amtDropResult.thresholdHit !== 'NONE' && curAmt < prevAmt) {
        signals.push({
          type:      'DROP_MOM',
          severity:  amtDropResult.thresholdHit,
          pctChange: amtDropResult.pctChange,
          method:    'MOM',
          metric:    'amount_total',
          current:   curAmt,
          reference: prevAmt,
        });
      }
    }

    // Check units_used drop
    var curUnits  = parseFloat(targetBill.units_used);
    var prevUnits = parseFloat(prevBill.units_used);

    if (!isNaN(curUnits) && !isNaN(prevUnits) && prevUnits > 0) {
      var unitsDropResult = teAnalyzePctChange(curUnits, prevUnits, threshConfig, 'DROP');
      if (unitsDropResult.thresholdHit !== 'NONE' && curUnits < prevUnits) {
        // น้ำ: drop สำคัญกว่า → ยก severity ขึ้น 1 ระดับ
        var dropSev = unitsDropResult.thresholdHit;
        if (meterType === 'WATER' && dropSev === SC_SEVERITY.LOW) {
          dropSev = SC_SEVERITY.MEDIUM;
        }
        signals.push({
          type:      'DROP_UNITS_MOM',
          severity:  dropSev,
          pctChange: unitsDropResult.pctChange,
          method:    'MOM',
          metric:    'units_used',
          current:   curUnits,
          reference: prevUnits,
        });
      }
    }
  }

  return signals;
}


// ============================================================
// SECTION 5 — DETECTION MODULE 3: STATISTICAL OUTLIER
// ============================================================

/**
 * ตรวจหา statistical outlier จาก dynamic bounds
 * ใช้ IQR หรือ z-score ขึ้นอยู่กับ sample size
 *
 * @param {Object} targetBill
 * @param {Object} dynamicBoundsAmt    — จาก teCalculateDynamicBounds() for amount_total
 * @param {Object} dynamicBoundsUnits  — จาก teCalculateDynamicBounds() for units_used
 * @param {Object} threshConfig
 * @returns {Object[]}  — signals array
 * @private
 */
function _detectStatisticalOutlier(targetBill, dynamicBoundsAmt, dynamicBoundsUnits, threshConfig) {
  var signals = [];

  // ── Amount total outlier ─────────────────────────────────
  var amtCurrent = parseFloat(targetBill.amount_total);
  if (!isNaN(amtCurrent) && amtCurrent > 0) {
    var amtCheck = teCheckDynamicBounds(amtCurrent, dynamicBoundsAmt);

    if (amtCheck.isUpperOutlier && amtCheck.severity !== SC_SEVERITY.NONE) {
      signals.push({
        type:      'SPIKE_STATISTICAL',
        severity:  amtCheck.severity,
        pctChange: dynamicBoundsAmt.mean > 0
                     ? Math.round(((amtCurrent - dynamicBoundsAmt.mean) / dynamicBoundsAmt.mean) * 100 * 10) / 10
                     : null,
        method:    amtCheck.boundType,
        metric:    'amount_total',
        current:   amtCurrent,
        reference: dynamicBoundsAmt.mean,
        zScore:    amtCheck.zScore,
      });
    }

    if (amtCheck.isLowerOutlier && amtCheck.severity !== SC_SEVERITY.NONE) {
      signals.push({
        type:      'DROP_STATISTICAL',
        severity:  amtCheck.severity,
        pctChange: dynamicBoundsAmt.mean > 0
                     ? Math.round(((amtCurrent - dynamicBoundsAmt.mean) / dynamicBoundsAmt.mean) * 100 * 10) / 10
                     : null,
        method:    amtCheck.boundType,
        metric:    'amount_total',
        current:   amtCurrent,
        reference: dynamicBoundsAmt.mean,
        zScore:    amtCheck.zScore,
      });
    }
  }

  // ── Units used outlier ───────────────────────────────────
  var unitsCurrent = parseFloat(targetBill.units_used);
  if (!isNaN(unitsCurrent) && unitsCurrent > 0 && dynamicBoundsUnits.methodUsed !== 'INSUFFICIENT') {
    var unitsCheck = teCheckDynamicBounds(unitsCurrent, dynamicBoundsUnits);

    if (unitsCheck.isUpperOutlier && unitsCheck.severity !== SC_SEVERITY.NONE) {
      signals.push({
        type:      'SPIKE_UNITS_MOM',  // reuse type (stat-based spike in units)
        severity:  unitsCheck.severity,
        pctChange: dynamicBoundsUnits.mean > 0
                     ? Math.round(((unitsCurrent - dynamicBoundsUnits.mean) / dynamicBoundsUnits.mean) * 100 * 10) / 10
                     : null,
        method:    unitsCheck.boundType + '_UNITS',
        metric:    'units_used',
        current:   unitsCurrent,
        reference: dynamicBoundsUnits.mean,
        zScore:    unitsCheck.zScore,
      });
    }
  }

  return signals;
}


// ============================================================
// SECTION 6 — DETECTION MODULE 4: YEAR-OVER-YEAR
// ============================================================

/**
 * ตรวจหา anomaly เปรียบเทียบ YoY (เดือนเดียวกันปีที่แล้ว)
 *
 * @param {Object}   targetBill
 * @param {Object[]} historyBills   — all bills ก่อน targetBill (สำหรับ meter นี้)
 * @param {Object}   threshConfig
 * @returns {Object[]}  — signals array
 * @private
 */
function _detectYoY(targetBill, historyBills, threshConfig) {
  var signals  = [];
  var targetY  = parseInt(targetBill.bill_year);
  var targetM  = parseInt(targetBill.bill_month);

  // หา bill ปีที่แล้ว เดือนเดียวกัน
  var yoyBill = historyBills.find(function(b) {
    return parseInt(b.bill_year) === (targetY - 1)
      && parseInt(b.bill_month) === targetM;
  });

  if (!yoyBill) return signals;

  var current = parseFloat(targetBill.amount_total);
  var yoyRef  = parseFloat(yoyBill.amount_total);

  if (isNaN(current) || isNaN(yoyRef) || yoyRef <= 0) return signals;

  var yoyPct = ((current - yoyRef) / yoyRef) * 100;

  if (yoyPct >= threshConfig.SPIKE_PCT_HIGH) {
    signals.push({
      type:      'SPIKE_YOY',
      severity:  yoyPct >= threshConfig.SPIKE_PCT_CRITICAL ? SC_SEVERITY.HIGH : SC_SEVERITY.MEDIUM,
      pctChange: Math.round(yoyPct * 10) / 10,
      method:    'YOY',
      metric:    'amount_total',
      current:   current,
      reference: yoyRef,
    });
  } else if (yoyPct <= -(threshConfig.DROP_PCT_HIGH)) {
    signals.push({
      type:      'DROP_YOY',
      severity:  SC_SEVERITY.MEDIUM,
      pctChange: Math.round(yoyPct * 10) / 10,
      method:    'YOY',
      metric:    'amount_total',
      current:   current,
      reference: yoyRef,
    });
  }

  return signals;
}


// ============================================================
// SECTION 7 — SHEET PERSISTENCE
// ============================================================

/**
 * บันทึก anomaly records ลง Anomalies sheet
 * รองรับ overwrite ถ้า anomaly_id ซ้ำ
 *
 * @param {Object[]} anomalies
 * @private
 */
function _saveAnomaliesToSheet(anomalies) {
  if (!anomalies || anomalies.length === 0) return;

  var existing = dbGetAll(CONFIG.SHEETS.ANOMALIES);
  var existingMap = {};
  existing.forEach(function(a) {
    existingMap[a.anomaly_id] = true;
  });

  var toInsert = [];
  var overwriteCount = 0;

  anomalies.forEach(function(a) {
    if (existingMap[a.anomaly_id]) {
      if (AD_CONFIG.OVERWRITE_SAME_PERIOD) {
        // Update existing record
        try {
          dbUpdate(CONFIG.SHEETS.ANOMALIES, 'anomaly_id', a.anomaly_id, a);
          overwriteCount++;
        } catch (e) {
          _adLog('WARN', 'Failed to overwrite anomaly ' + a.anomaly_id + ': ' + e.message);
        }
      }
      // ถ้าไม่ overwrite → ข้ามไป (ไม่บันทึกซ้ำ)
    } else {
      toInsert.push(a);
    }
  });

  // Batch insert new anomalies
  if (toInsert.length > 0) {
    toInsert.forEach(function(a) {
      try {
        dbInsert(CONFIG.SHEETS.ANOMALIES, a);
      } catch (e) {
        _adLog('WARN', 'Failed to insert anomaly: ' + e.message);
      }
    });
  }

  _adLog('INFO', 'Saved: ' + toInsert.length + ' new, '
    + overwriteCount + ' overwritten anomalies');
}


// ============================================================
// SECTION 8 — AI EXTENSION HOOK
// ============================================================

/**
 * Export labeled dataset สำหรับ ML training
 * ── AI Extension hook ──
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {number}  [options.limit]   — จำนวน records สูงสุด
 * @returns {Object[]}  — feature vectors พร้อม label
 */
function adGetMLReadyDataset(token, options) {
  requireAuth(token, 'canRead');
  options = options || {};

  var anomalies = dbGetAll(CONFIG.SHEETS.ANOMALIES);
  var dataset   = [];

  anomalies.forEach(function(a) {
    // Parse dynamic bounds จาก signals_json ถ้ามี
    var dynamicBounds = null;
    if (a.dynamic_mean !== null) {
      dynamicBounds = { mean: parseFloat(a.dynamic_mean) };
    }

    var features = scGetFeatureVector(a, dynamicBounds);
    dataset.push(Object.assign({}, features, {
      anomaly_id:   a.anomaly_id,
      label:        a.severity,         // ML target variable
      status:       a.status,           // OPEN/RESOLVED (for feedback loop)
      meter_type:   a.meter_type,
      bill_year:    a.bill_year,
      bill_month:   a.bill_month,
    }));
  });

  if (options.limit) {
    dataset = dataset.slice(0, options.limit);
  }

  return dataset;
}


// ============================================================
// SECTION 9 — PRIVATE HELPERS
// ============================================================

/**
 * Normalize detection options
 * @private
 */
function _normalizeDetectOptions(options) {
  options = options || {};
  return {
    site_id:    options.site_id    || null,
    meter_id:   options.meter_id   || null,
    meter_type: (options.meter_type || 'ALL').toUpperCase(),
    bill_year:  options.bill_year  ? parseInt(options.bill_year, 10)  : null,
    bill_month: options.bill_month ? parseInt(options.bill_month, 10) : null,
    dry_run:    options.dry_run    || false,
  };
}


/**
 * สร้าง meter lookup map { meter_id → meter object }
 * @private
 */
function _buildMeterLookup(meters) {
  var map = {};
  (meters || []).forEach(function(m) { map[m.meter_id] = m; });
  return map;
}


/**
 * สร้าง site lookup map { site_id → site object }
 * @private
 */
function _buildSiteLookup(sites) {
  var map = {};
  (sites || []).forEach(function(s) { map[s.site_id] = s; });
  return map;
}


/**
 * กรอง bills ตาม bill_year / bill_month
 * ถ้า year/month เป็น null → ใช้ bill ล่าสุด
 * @private
 */
function _filterByPeriod(sortedBills, year, month) {
  if (!year && !month) {
    // ใช้ bill ล่าสุดเพียง 1 รายการ
    return sortedBills.length > 0 ? [sortedBills[sortedBills.length - 1]] : [];
  }

  return sortedBills.filter(function(b) {
    var matchYear  = !year  || String(b.bill_year)  === String(year);
    var matchMonth = !month || String(b.bill_month) === String(month);
    return matchYear && matchMonth;
  });
}


/**
 * หา index ของ targetBill ใน sortedBills array
 * เปรียบเทียบด้วย bill_period_key หรือ year+month
 * @private
 */
function _findBillIndex(sortedBills, targetBill) {
  var targetKey = targetBill.bill_period_key
    || tcMakePeriodKey(targetBill.bill_year, targetBill.bill_month);

  for (var i = 0; i < sortedBills.length; i++) {
    var k = sortedBills[i].bill_period_key
      || tcMakePeriodKey(sortedBills[i].bill_year, sortedBills[i].bill_month);
    if (k === targetKey) return i;
  }
  return sortedBills.length - 1; // fallback: ใช้ตัวสุดท้าย
}


/**
 * Enrich anomaly records ด้วย site_name / meter_label
 * @private
 */
function _enrichAnomalies(anomalies, meterLookup, siteLookup) {
  return anomalies.map(function(a) {
    var meter = meterLookup[a.meter_id] || {};
    var site  = siteLookup[a.site_id]   || {};
    return Object.assign({}, a, {
      site_name:   site.site_name   || a.site_id,
      meter_label: meter.meter_name || meter.meter_number || a.meter_id,
    });
  });
}


/**
 * ส่ง email แจ้งเตือน anomalies
 * @private
 */
function _sendAnomalyAlertEmail(urgentAnomalies, summary) {
  try {
    var adminEmails = CONFIG.EMAIL.ADMIN_EMAILS || [];
    if (adminEmails.length === 0) return;

    var subject = '[UtilityManager] ⚠️ พบ Anomaly '
      + summary.bySeverity.CRITICAL + ' CRITICAL, '
      + summary.bySeverity.HIGH + ' HIGH';

    var lines = [
      'พบการใช้พลังงานผิดปกติที่ต้องตรวจสอบ',
      '─────────────────────────────────',
      'สรุป: CRITICAL=' + summary.bySeverity.CRITICAL
        + ', HIGH=' + summary.bySeverity.HIGH
        + ', MEDIUM=' + summary.bySeverity.MEDIUM,
      '',
    ];

    // Top 5 anomalies
    urgentAnomalies.slice(0, 5).forEach(function(a, i) {
      lines.push((i + 1) + '. ' + scExplainAnomaly(a, {
        siteName:   a.site_name,
        meterLabel: a.meter_label,
      }));
      lines.push('─────────────────────────────────');
    });

    var body = lines.join('\n');

    GmailApp.sendEmail(
      adminEmails.join(','),
      subject,
      body,
      { name: CONFIG.EMAIL.SENDER_NAME }
    );

    _adLog('INFO', 'Alert email sent to ' + adminEmails.join(','));
  } catch (e) {
    _adLog('WARN', 'Failed to send alert email: ' + e.message);
  }
}


/**
 * ดึง system token สำหรับ trigger (bypass auth)
 * @private
 */
function _getSystemToken() {
  // ใช้ internal mechanism เดียวกับ generateTrendSummary
  // ต้องมีฟังก์ชัน getSystemToken() ใน Auth.gs
  if (typeof getSystemToken === 'function') {
    return getSystemToken();
  }
  // Fallback: ถ้าไม่มี → ใช้ admin session
  var props = PropertiesService.getScriptProperties();
  return props.getProperty('SYSTEM_TOKEN') || 'system';
}


/**
 * Logger wrapper ที่ respect LOG_LEVEL
 * @private
 */
function _adLog(level, message) {
  var levels = { DEBUG: 0, INFO: 1, WARN: 2 };
  var configLevel = levels[AD_CONFIG.LOG_LEVEL] || 1;
  if ((levels[level] || 0) >= configLevel) {
    Logger.log('[AbnormalDetector][' + level + '] ' + message);
  }
}


// ============================================================
// SECTION 10 — UTILITY: tcGroupBy (local if not in TrendCalculator)
// ============================================================

/**
 * Group array of objects by a key
 * (สำรองไว้ในกรณีที่ TrendCalculator.gs ไม่มี tcGroupBy)
 *
 * @param {Object[]} arr
 * @param {string}   key
 * @returns {Object}  — { keyValue: [items] }
 */
function tcGroupBy(arr, key) {
  // ถ้า TrendCalculator.gs มี tcGroupBySite อยู่แล้ว ให้ใช้ได้เลย
  // function นี้เป็น generic version สำหรับ key ใดๆ
  var map = {};
  (arr || []).forEach(function(item) {
    var k = item[key];
    if (!map[k]) map[k] = [];
    map[k].push(item);
  });
  return map;
}
