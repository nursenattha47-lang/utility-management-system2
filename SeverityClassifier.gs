// ============================================================
// SeverityClassifier.gs — Severity Classification Engine
// UtilityManager | PHASE 5B — Abnormal Detection Engine
// ============================================================
// รับผิดชอบ:
//   1. Multi-signal severity classification (CRITICAL/HIGH/MEDIUM/LOW)
//   2. Anomaly type labeling & description generation (TH/EN)
//   3. Confidence scoring สำหรับแต่ละ anomaly
//   4. Abnormal ranking logic (priority order)
//   5. Deduplication / signal merging (หลาย signal → 1 anomaly record)
//   6. Emoji + color tag สำหรับ UI rendering
// ============================================================
// Dependencies: Config.gs, Utils.gs, ThresholdEngine.gs
// Called by:   AbnormalDetector.gs
// ============================================================
// AI Extension hooks:
//   scExplainAnomaly()  — สร้าง natural language explanation
//   scGetFeatureVector() — export features สำหรับ ML severity model
// ============================================================


// ============================================================
// SECTION 1 — SEVERITY LEVELS & CONSTANTS
// ============================================================

/**
 * Severity levels ที่ระบบรองรับ (เรียงจากมากไปน้อย)
 * ใช้เป็น enum ทั่วทั้ง Phase 5B
 */
const SC_SEVERITY = {
  CRITICAL: 'CRITICAL',  // ต้องจัดการทันที
  HIGH:     'HIGH',      // ต้องตรวจสอบภายในวันนี้
  MEDIUM:   'MEDIUM',    // ต้องตรวจสอบภายใน 3 วัน
  LOW:      'LOW',       // รับทราบ / ติดตาม
  NONE:     'NONE',      // ปกติ (ใช้ใน return value)
};

/**
 * ลำดับความสำคัญ (ตัวเลข) สำหรับ sorting
 * ตัวเลขน้อย = สำคัญกว่า
 */
const SC_SEVERITY_RANK = {
  CRITICAL: 1,
  HIGH:     2,
  MEDIUM:   3,
  LOW:      4,
  NONE:     99,
};

/**
 * สี (CSS class / hex) สำหรับแต่ละ severity
 * ใช้ใน UI rendering
 */
const SC_SEVERITY_COLORS = {
  CRITICAL: { hex: '#DC2626', cssClass: 'severity-critical', bg: '#FEF2F2' },
  HIGH:     { hex: '#EA580C', cssClass: 'severity-high',     bg: '#FFF7ED' },
  MEDIUM:   { hex: '#D97706', cssClass: 'severity-medium',   bg: '#FFFBEB' },
  LOW:      { hex: '#2563EB', cssClass: 'severity-low',      bg: '#EFF6FF' },
  NONE:     { hex: '#6B7280', cssClass: 'severity-none',     bg: '#F9FAFB' },
};

/**
 * Emoji สำหรับแต่ละ severity (ใช้ใน email notification)
 */
const SC_SEVERITY_EMOJI = {
  CRITICAL: '🔴',
  HIGH:     '🟠',
  MEDIUM:   '🟡',
  LOW:      '🔵',
  NONE:     '⚪',
};

/**
 * Anomaly types และ label (TH/EN)
 * เป็น registry กลางของ anomaly types ทั้งหมดในระบบ
 */
const SC_ANOMALY_TYPES = {
  // ── Usage Spikes ─────────────────────────────────────────
  SPIKE_MOM: {
    labelTH: 'ค่าใช้จ่ายพุ่งสูงจากเดือนก่อน',
    labelEN: 'Month-over-Month Spike',
    category: 'SPIKE',
    affectsMetric: 'amount_total',
  },
  SPIKE_UNITS_MOM: {
    labelTH: 'การใช้พลังงานพุ่งสูงจากเดือนก่อน',
    labelEN: 'Units Usage MoM Spike',
    category: 'SPIKE',
    affectsMetric: 'units_used',
  },
  SPIKE_VS_AVG: {
    labelTH: 'ค่าใช้จ่ายสูงกว่าค่าเฉลี่ย historical',
    labelEN: 'Above Historical Average',
    category: 'SPIKE',
    affectsMetric: 'amount_total',
  },
  SPIKE_STATISTICAL: {
    labelTH: 'ค่าผิดปกติทางสถิติ (Outlier)',
    labelEN: 'Statistical Outlier (Upper)',
    category: 'SPIKE',
    affectsMetric: 'amount_total',
  },

  // ── Sudden Drops ─────────────────────────────────────────
  DROP_MOM: {
    labelTH: 'ค่าใช้จ่ายลดลงผิดปกติจากเดือนก่อน',
    labelEN: 'Sudden Drop MoM',
    category: 'DROP',
    affectsMetric: 'amount_total',
  },
  DROP_UNITS_MOM: {
    labelTH: 'การใช้พลังงานลดลงผิดปกติ',
    labelEN: 'Units Usage Sudden Drop',
    category: 'DROP',
    affectsMetric: 'units_used',
  },
  ZERO_USAGE: {
    labelTH: 'ไม่มีการใช้พลังงาน (0 หน่วย)',
    labelEN: 'Zero Usage Detected',
    category: 'DROP',
    affectsMetric: 'units_used',
  },
  NEAR_ZERO_USAGE: {
    labelTH: 'การใช้พลังงานต่ำผิดปกติ',
    labelEN: 'Near-Zero Usage',
    category: 'DROP',
    affectsMetric: 'units_used',
  },
  DROP_STATISTICAL: {
    labelTH: 'ค่าต่ำผิดปกติทางสถิติ (Outlier)',
    labelEN: 'Statistical Outlier (Lower)',
    category: 'DROP',
    affectsMetric: 'amount_total',
  },

  // ── Cross-period Comparisons ──────────────────────────────
  SPIKE_YOY: {
    labelTH: 'ค่าใช้จ่ายสูงกว่าปีที่แล้ว',
    labelEN: 'Year-over-Year Spike',
    category: 'SPIKE',
    affectsMetric: 'amount_total',
  },
  DROP_YOY: {
    labelTH: 'ค่าใช้จ่ายต่ำกว่าปีที่แล้วผิดปกติ',
    labelEN: 'Year-over-Year Drop',
    category: 'DROP',
    affectsMetric: 'amount_total',
  },
};


// ============================================================
// SECTION 2 — PRIMARY CLASSIFIER
// ============================================================

/**
 * จำแนก severity จาก anomaly signals หลายตัวพร้อมกัน
 * รวม signals และคืนค่า severity สูงสุด
 *
 * @param {Object[]} signals  — array ของ signal objects
 *   Each signal: { type: SC_ANOMALY_TYPES key, severity: SC_SEVERITY value, score: number }
 * @returns {string}  — SC_SEVERITY value (highest severity found)
 */
function scClassifyFromSignals(signals) {
  if (!signals || signals.length === 0) return SC_SEVERITY.NONE;

  var highest = SC_SEVERITY.NONE;
  signals.forEach(function(sig) {
    if (_severityRank(sig.severity) < _severityRank(highest)) {
      highest = sig.severity;
    }
  });

  return highest;
}


/**
 * จำแนก severity จากค่า % change โดยตรง
 * ใช้เมื่อมี signal เดี่ยวและต้องการ classify เร็ว
 *
 * @param {number} pctChange   — % เปลี่ยนแปลง (บวก=เพิ่ม, ลบ=ลด)
 * @param {string} direction   — 'SPIKE' | 'DROP'
 * @param {Object} threshConfig  — จาก teGetThresholds()
 * @returns {string}  — SC_SEVERITY value
 */
function scClassifyPct(pctChange, direction, threshConfig) {
  var analysis = teAnalyzePctChange(
    /* current */ Math.abs(pctChange),
    /* ref     */ 100,
    threshConfig,
    direction
  );
  // teAnalyzePctChange ทำงานกับค่าจริง ไม่ใช่ % ดังนั้นเราเรียก thresholdHit โดยตรง
  // แต่ใน case นี้เราส่ง absChange ดังนั้น logic อาจต่างกัน
  // → ใช้ direct threshold check แทน

  var cfg = threshConfig || {};
  var abs = Math.abs(pctChange);

  if (direction === 'SPIKE') {
    if (abs >= (cfg.SPIKE_PCT_CRITICAL || 100)) return SC_SEVERITY.CRITICAL;
    if (abs >= (cfg.SPIKE_PCT_HIGH     || 50))  return SC_SEVERITY.HIGH;
    if (abs >= (cfg.SPIKE_PCT_MEDIUM   || 30))  return SC_SEVERITY.MEDIUM;
    if (abs >= (cfg.SPIKE_PCT_LOW      || 20))  return SC_SEVERITY.LOW;
  } else if (direction === 'DROP') {
    if (abs >= (cfg.DROP_PCT_CRITICAL  || 80))  return SC_SEVERITY.CRITICAL;
    if (abs >= (cfg.DROP_PCT_HIGH      || 50))  return SC_SEVERITY.HIGH;
    if (abs >= (cfg.DROP_PCT_MEDIUM    || 35))  return SC_SEVERITY.MEDIUM;
    if (abs >= (cfg.DROP_PCT_LOW       || 20))  return SC_SEVERITY.LOW;
  }

  return SC_SEVERITY.NONE;
}


/**
 * จำแนก severity จาก z-score
 *
 * @param {number} zScore
 * @param {Object} threshConfig
 * @returns {string}  — SC_SEVERITY value
 */
function scClassifyZScore(zScore, threshConfig) {
  if (zScore === null || isNaN(zScore)) return SC_SEVERITY.NONE;

  var cfg = threshConfig || {};
  var abs = Math.abs(zScore);

  if (abs >= (cfg.Z_SCORE_CRITICAL || 3.0)) return SC_SEVERITY.CRITICAL;
  if (abs >= (cfg.Z_SCORE_HIGH     || 2.0)) return SC_SEVERITY.HIGH;
  if (abs >= (cfg.Z_SCORE_MEDIUM   || 1.5)) return SC_SEVERITY.MEDIUM;

  return SC_SEVERITY.NONE;
}


// ============================================================
// SECTION 3 — ANOMALY RECORD BUILDER
// ============================================================

/**
 * สร้าง anomaly record พร้อมสำหรับบันทึกลง Anomalies sheet
 * รวม signals หลายตัว → 1 record ต่อ meter/period
 *
 * @param {Object} params
 * @param {string}   params.meterId
 * @param {string}   params.siteId
 * @param {string}   params.meterType     — 'ELECTRICITY' | 'WATER'
 * @param {number}   params.billYear      — พ.ศ.
 * @param {number}   params.billMonth
 * @param {number}   params.currentValue  — amount_total ของ bill นี้
 * @param {number}   params.prevValue     — amount_total เดือนก่อน
 * @param {number}   params.unitsUsed
 * @param {Object[]} params.signals       — anomaly signals ที่ตรวจพบ
 * @param {Object}   params.dynamicBounds — จาก teCalculateDynamicBounds()
 * @param {Object}   params.baseline      — จาก teCalculateRollingBaseline()
 * @returns {Object}  — anomaly record ที่พร้อม insert ลง sheet
 */
function scBuildAnomalyRecord(params) {
  var signals     = params.signals || [];
  var severity    = scClassifyFromSignals(signals);
  var confidence  = scCalculateConfidence(signals, params.dynamicBounds);
  var primaryType = _selectPrimaryType(signals);
  var message     = scGenerateMessage(primaryType, severity, params);
  var periodKey   = tcMakePeriodKey(params.billYear, params.billMonth);

  // Unique anomaly_id: meter + period + type
  var anomalyId = 'ANO_' + params.meterId
    + '_' + periodKey.replace('-', '')
    + '_' + (primaryType || 'UNKNOWN');

  return {
    anomaly_id:     anomalyId,
    site_id:        params.siteId,
    meter_id:       params.meterId,
    meter_type:     params.meterType,
    bill_year:      params.billYear,
    bill_month:     params.billMonth,
    bill_period_key: periodKey,
    anomaly_type:   primaryType,
    severity:       severity,
    confidence:     confidence,
    message:        message,
    value:          params.currentValue || null,
    prev_value:     params.prevValue    || null,
    avg_baseline:   params.baseline ? params.baseline.avg : null,
    dynamic_mean:   params.dynamicBounds ? params.dynamicBounds.mean : null,
    z_score:        params.dynamicBounds && params.dynamicBounds.mean !== null
                      ? _calcZScore(params.currentValue, params.dynamicBounds)
                      : null,
    signals_json:   JSON.stringify(signals.map(function(s) {
                      return { type: s.type, severity: s.severity, pct: s.pctChange };
                    })),
    detected_at:    new Date().toISOString(),
    status:         'OPEN',   // OPEN | ACKNOWLEDGED | RESOLVED
    resolved_at:    null,
    resolved_by:    null,
    notes:          null,
  };
}


// ============================================================
// SECTION 4 — CONFIDENCE SCORING
// ============================================================

/**
 * คำนวณ confidence score (0–100) สำหรับ anomaly
 * สูง = มั่นใจว่าผิดปกติจริง, ต่ำ = อาจเป็น false positive
 *
 * Factors:
 *   - จำนวน signals ที่ agree กัน (+)
 *   - ขนาดของ % change ยิ่งมาก ยิ่งมั่นใจ (+)
 *   - ประเภท signal ที่แม่นยำกว่า (dynamic > pct) (+)
 *   - sample size ที่น้อยเกินไป (-)
 *   - signals ที่ขัดแย้งกัน (-)
 *
 * @param {Object[]} signals       — anomaly signals
 * @param {Object}   [dynamicBounds]
 * @returns {number} 0–100
 */
function scCalculateConfidence(signals, dynamicBounds) {
  if (!signals || signals.length === 0) return 0;

  var score = 30; // baseline confidence

  // ── Factor 1: จำนวน signals ที่ consistent ──────────────
  var spikeCount = signals.filter(function(s) {
    return (SC_ANOMALY_TYPES[s.type] || {}).category === 'SPIKE';
  }).length;
  var dropCount = signals.filter(function(s) {
    return (SC_ANOMALY_TYPES[s.type] || {}).category === 'DROP';
  }).length;

  var dominantCount = Math.max(spikeCount, dropCount);
  var conflictCount = Math.min(spikeCount, dropCount);

  // signals ยิ่งมาก ยิ่งมั่นใจ (สูงสุด +30)
  score += Math.min(30, dominantCount * 10);

  // signals ขัดแย้งกัน → ลด confidence (สูงสุด -20)
  score -= Math.min(20, conflictCount * 10);

  // ── Factor 2: ขนาด % change ─────────────────────────────
  var maxPct = signals.reduce(function(max, s) {
    return Math.max(max, Math.abs(s.pctChange || 0));
  }, 0);

  if (maxPct >= 100) score += 20;
  else if (maxPct >= 50) score += 15;
  else if (maxPct >= 30) score += 10;
  else if (maxPct >= 20) score += 5;

  // ── Factor 3: Dynamic bound signal (เชื่อถือได้มากกว่า % based) ─
  var hasStatSig = signals.some(function(s) {
    return s.type === 'SPIKE_STATISTICAL' || s.type === 'DROP_STATISTICAL';
  });
  if (hasStatSig) score += 10;

  // ── Factor 4: Sample size ────────────────────────────────
  if (dynamicBounds) {
    if (dynamicBounds.sampleSize >= 12) score += 5;
    else if (dynamicBounds.sampleSize < 3) score -= 15;
    else if (dynamicBounds.sampleSize < 6) score -= 8;
  }

  // ── Factor 5: Severity agreement ─────────────────────────
  var severities = signals.map(function(s) { return s.severity; });
  var topSev = severities.filter(function(sv) {
    return sv === SC_SEVERITY.HIGH || sv === SC_SEVERITY.CRITICAL;
  }).length;
  if (topSev >= 2) score += 5;

  // Clamp 0–100
  return Math.max(0, Math.min(100, Math.round(score)));
}


// ============================================================
// SECTION 5 — RANKING LOGIC
// ============================================================

/**
 * เรียงลำดับ anomaly records ตาม priority
 * Priority factors (สูง → ต่ำ):
 *   1. Severity (CRITICAL > HIGH > MEDIUM > LOW)
 *   2. Confidence score (สูงกว่า = สำคัญกว่า)
 *   3. % deviation จาก baseline (ยิ่งมาก = สำคัญกว่า)
 *   4. Recent period (ใหม่กว่า = สำคัญกว่า)
 *
 * @param {Object[]} anomalies  — anomaly records จาก scBuildAnomalyRecord()
 * @returns {Object[]}  — sorted array (สำคัญสุดก่อน) พร้อม rank field
 */
function scRankAnomalies(anomalies) {
  if (!anomalies || anomalies.length === 0) return [];

  var ranked = anomalies.slice().sort(function(a, b) {
    // 1. Severity rank (น้อย = สำคัญกว่า)
    var sevDiff = _severityRank(a.severity) - _severityRank(b.severity);
    if (sevDiff !== 0) return sevDiff;

    // 2. Confidence (สูง = สำคัญกว่า)
    var confDiff = (b.confidence || 0) - (a.confidence || 0);
    if (Math.abs(confDiff) > 5) return confDiff;

    // 3. % deviation จาก baseline
    var aDeviation = _calcDeviation(a);
    var bDeviation = _calcDeviation(b);
    var devDiff = bDeviation - aDeviation;
    if (Math.abs(devDiff) > 1) return devDiff;

    // 4. Period (ใหม่กว่า = สำคัญกว่า)
    var aPeriod = a.bill_period_key || '';
    var bPeriod = b.bill_period_key || '';
    return bPeriod.localeCompare(aPeriod);
  });

  // ใส่ rank (1-based)
  return ranked.map(function(a, i) {
    return Object.assign({}, a, { rank: i + 1 });
  });
}


/**
 * กรอง anomalies ตาม severity ขั้นต่ำ
 *
 * @param {Object[]} anomalies
 * @param {string}   minSeverity  — SC_SEVERITY value
 * @returns {Object[]}
 */
function scFilterBySeverity(anomalies, minSeverity) {
  var minRank = _severityRank(minSeverity);
  return anomalies.filter(function(a) {
    return _severityRank(a.severity) <= minRank;
  });
}


/**
 * สรุป anomalies เป็น summary object สำหรับ dashboard / email
 *
 * @param {Object[]} rankedAnomalies  — จาก scRankAnomalies()
 * @returns {Object}
 *   {
 *     total:      number,
 *     bySeverity: { CRITICAL, HIGH, MEDIUM, LOW },
 *     byType:     { SPIKE, DROP },
 *     topAnomaly: Object,   // rank #1
 *     siteIds:    string[], // unique sites affected
 *     generatedAt: string,
 *   }
 */
function scSummarize(rankedAnomalies) {
  var bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  var byType     = { SPIKE: 0, DROP: 0, OTHER: 0 };
  var siteSet    = {};

  rankedAnomalies.forEach(function(a) {
    // count by severity
    if (bySeverity.hasOwnProperty(a.severity)) bySeverity[a.severity]++;

    // count by type category
    var typeDef = SC_ANOMALY_TYPES[a.anomaly_type];
    if (typeDef) {
      var cat = typeDef.category || 'OTHER';
      byType[cat] = (byType[cat] || 0) + 1;
    } else {
      byType.OTHER = (byType.OTHER || 0) + 1;
    }

    // collect unique sites
    if (a.site_id) siteSet[a.site_id] = true;
  });

  return {
    total:       rankedAnomalies.length,
    bySeverity:  bySeverity,
    byType:      byType,
    topAnomaly:  rankedAnomalies[0] || null,
    siteIds:     Object.keys(siteSet),
    generatedAt: new Date().toISOString(),
  };
}


// ============================================================
// SECTION 6 — MESSAGE GENERATION
// ============================================================

/**
 * สร้าง human-readable message สำหรับ anomaly (ภาษาไทย)
 *
 * @param {string} anomalyType  — key ใน SC_ANOMALY_TYPES
 * @param {string} severity     — SC_SEVERITY value
 * @param {Object} params       — { currentValue, prevValue, pctChange, baseline }
 * @returns {string}
 */
function scGenerateMessage(anomalyType, severity, params) {
  var typeDef  = SC_ANOMALY_TYPES[anomalyType] || {};
  var label    = typeDef.labelTH || anomalyType || 'ค่าผิดปกติ';
  var sevLabel = _severityLabel(severity);

  // ค่า % change ที่แสดงใน message
  var pctStr = '';
  if (params.pctChange !== undefined && params.pctChange !== null) {
    var absPct = Math.abs(params.pctChange);
    var dir    = params.pctChange > 0 ? 'เพิ่มขึ้น' : 'ลดลง';
    pctStr = dir + ' ' + absPct.toFixed(1) + '%';
  } else if (params.currentValue && params.prevValue && params.prevValue > 0) {
    var calcPct = ((params.currentValue - params.prevValue) / params.prevValue) * 100;
    var calcAbs = Math.abs(calcPct);
    var calcDir = calcPct > 0 ? 'เพิ่มขึ้น' : 'ลดลง';
    pctStr = calcDir + ' ' + calcAbs.toFixed(1) + '%';
  }

  // baseline comparison
  var baselineStr = '';
  if (params.baseline && params.baseline.avg && params.currentValue) {
    var baselinePct = ((params.currentValue - params.baseline.avg) / params.baseline.avg) * 100;
    baselineStr = ' (สูงกว่าค่าเฉลี่ย ' + Math.abs(baselinePct).toFixed(1) + '%)';
  }

  return '[' + sevLabel + '] ' + label
    + (pctStr ? ' ' + pctStr : '')
    + baselineStr;
}


/**
 * สร้าง detailed explanation สำหรับ anomaly (สำหรับ email/report)
 * ── AI Extension hook ──
 * ในอนาคตสามารถเรียก Anthropic API เพื่อสร้าง explanation อัตโนมัติ
 *
 * @param {Object} anomalyRecord   — จาก scBuildAnomalyRecord()
 * @param {Object} [context]       — { siteName, meterLabel, currency }
 * @returns {string}  — multi-line explanation text
 */
function scExplainAnomaly(anomalyRecord, context) {
  var ctx       = context || {};
  var siteName  = ctx.siteName   || anomalyRecord.site_id;
  var meterLabel = ctx.meterLabel || anomalyRecord.meter_id;
  var cur       = ctx.currency   || 'บาท';
  var a         = anomalyRecord;

  var lines = [];
  lines.push('📍 สถานที่: ' + siteName + ' | มิเตอร์: ' + meterLabel);
  lines.push('📅 รอบบิล: ' + a.bill_period_key);
  lines.push(SC_SEVERITY_EMOJI[a.severity] + ' ระดับ: ' + _severityLabel(a.severity)
    + ' (confidence: ' + (a.confidence || 0) + '%)');
  lines.push('⚡ ประเภท: ' + (SC_ANOMALY_TYPES[a.anomaly_type] || {}).labelTH || a.anomaly_type);
  lines.push('');

  if (a.value !== null && a.prev_value !== null) {
    var pct = a.prev_value > 0
      ? ((a.value - a.prev_value) / a.prev_value * 100).toFixed(1)
      : '-';
    lines.push('💰 ค่าใช้จ่ายเดือนนี้:  ' + _formatNumber(a.value) + ' ' + cur);
    lines.push('💰 ค่าใช้จ่ายเดือนก่อน: ' + _formatNumber(a.prev_value) + ' ' + cur);
    lines.push('📈 เปลี่ยนแปลง: ' + pct + '%');
  }

  if (a.avg_baseline) {
    lines.push('📊 ค่าเฉลี่ย baseline: ' + _formatNumber(a.avg_baseline) + ' ' + cur);
  }

  if (a.z_score !== null) {
    lines.push('📐 Z-score: ' + a.z_score + 'σ');
  }

  lines.push('');
  lines.push('🔍 ' + (a.message || 'กรุณาตรวจสอบค่ามิเตอร์'));

  // ── AI hook placeholder ──────────────────────────────────
  // TODO: เมื่อต้องการใช้ AI อธิบาย ให้เรียก:
  //   var aiExplanation = _callAnthropicAPI(anomalyRecord, context);
  //   lines.push('\n🤖 AI Analysis: ' + aiExplanation);

  return lines.join('\n');
}


/**
 * Export feature vector สำหรับ ML severity model
 * ── AI Extension hook ──
 *
 * @param {Object} anomalyRecord
 * @param {Object} dynamicBounds
 * @returns {Object}  — flat feature object สำหรับ ML inference
 */
function scGetFeatureVector(anomalyRecord, dynamicBounds) {
  var a  = anomalyRecord;
  var db = dynamicBounds || {};

  return {
    pct_change_mom:     a.prev_value > 0
                          ? ((a.value - a.prev_value) / a.prev_value * 100)
                          : null,
    pct_from_avg:       a.avg_baseline > 0
                          ? ((a.value - a.avg_baseline) / a.avg_baseline * 100)
                          : null,
    z_score:            a.z_score,
    confidence:         a.confidence,
    signal_count:       JSON.parse(a.signals_json || '[]').length,
    sample_size:        db.sampleSize || null,
    is_water:           a.meter_type === 'WATER' ? 1 : 0,
    bill_month:         a.bill_month,
    severity_label:     SC_SEVERITY_RANK[a.severity] || 99,
    // เพิ่ม features เพิ่มเติมได้ตามต้องการ
  };
}


// ============================================================
// SECTION 7 — UI HELPERS
// ============================================================

/**
 * ดึง color config สำหรับ severity (ใช้ใน frontend render)
 *
 * @param {string} severity
 * @returns {{ hex: string, cssClass: string, bg: string }}
 */
function scGetSeverityColor(severity) {
  return SC_SEVERITY_COLORS[severity] || SC_SEVERITY_COLORS.NONE;
}


/**
 * ดึง emoji สำหรับ severity (ใช้ใน email)
 *
 * @param {string} severity
 * @returns {string}
 */
function scGetSeverityEmoji(severity) {
  return SC_SEVERITY_EMOJI[severity] || '⚪';
}


/**
 * ดึง anomaly type info
 *
 * @param {string} type  — key ใน SC_ANOMALY_TYPES
 * @returns {Object}
 */
function scGetTypeInfo(type) {
  return SC_ANOMALY_TYPES[type] || {
    labelTH: type,
    labelEN: type,
    category: 'OTHER',
    affectsMetric: null,
  };
}


// ============================================================
// SECTION 8 — PRIVATE HELPERS
// ============================================================

/**
 * แปลง severity string เป็น numeric rank สำหรับ comparison
 * @private
 */
function _severityRank(severity) {
  return SC_SEVERITY_RANK[severity] || SC_SEVERITY_RANK.NONE;
}


/**
 * เลือก primary anomaly type จาก signals
 * เลือก: HIGH severity ก่อน, ถ้าเท่ากันเลือก type แรก
 * @private
 */
function _selectPrimaryType(signals) {
  if (!signals || signals.length === 0) return null;

  var sorted = signals.slice().sort(function(a, b) {
    return _severityRank(a.severity) - _severityRank(b.severity);
  });

  return sorted[0].type;
}


/**
 * คำนวณ deviation สำหรับ ranking
 * @private
 */
function _calcDeviation(anomaly) {
  if (anomaly.avg_baseline && anomaly.avg_baseline > 0 && anomaly.value) {
    return Math.abs((anomaly.value - anomaly.avg_baseline) / anomaly.avg_baseline * 100);
  }
  if (anomaly.prev_value && anomaly.prev_value > 0 && anomaly.value) {
    return Math.abs((anomaly.value - anomaly.prev_value) / anomaly.prev_value * 100);
  }
  return 0;
}


/**
 * คำนวณ z-score จาก dynamic bounds
 * @private
 */
function _calcZScore(value, dynamicBounds) {
  if (!dynamicBounds || dynamicBounds.mean === null || !dynamicBounds.stdDev) return null;
  if (dynamicBounds.stdDev === 0) return null;
  return Math.round(((value - dynamicBounds.mean) / dynamicBounds.stdDev) * 100) / 100;
}


/**
 * แปลง severity เป็น label ภาษาไทย
 * @private
 */
function _severityLabel(severity) {
  var labels = {
    CRITICAL: 'วิกฤต',
    HIGH:     'สูง',
    MEDIUM:   'กลาง',
    LOW:      'ต่ำ',
    NONE:     'ปกติ',
  };
  return labels[severity] || severity;
}


/**
 * Format number with thousand separator
 * @private
 */
function _formatNumber(v) {
  if (v === null || v === undefined) return '-';
  return Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
