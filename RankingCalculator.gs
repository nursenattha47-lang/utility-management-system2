// ============================================================
// RankingCalculator.gs — Ranking Math & Data Engine
// UtilityManager | PHASE 5C — Ranking Engine
// ============================================================
// รับผิดชอบ:
//   1. Aggregate bills ต่อ site/meter สำหรับ ranking
//   2. คำนวณ electricity cost ranking
//   3. คำนวณ water cost ranking
//   4. คำนวณ highest usage ranking (units_used)
//   5. คำนวณ fastest growth ranking (MoM + YoY growth rate)
//   6. คำนวณ abnormal usage ranking (anomaly-driven)
//   7. คำนวณ site efficiency ranking (cost/unit composite score)
// ============================================================
// Dependencies (must load before this file):
//   Config.gs        — CONFIG.SHEETS, CONFIG.ENUMS
//   Utils.gs         — utility helpers
//   Database.gs      — dbGetAll()
//   TrendCalculator.gs — tcLoadAllData, tcFilterValidBills,
//                        tcBuildMeterMap, tcBuildSiteMap,
//                        tcGroupBySite, tcGroupByMeter,
//                        tcMean, tcLinearRegression,
//                        tcBuildTimeSeriesMap,
//                        tcTimeSeriesMapToArray,
//                        tcMoMChangeSeries, tcAvgCostPerUnit,
//                        tcFilterByMeterType
//   AbnormalDetector.gs — getAnomalyReport() (for abnormal ranking)
// ============================================================
// Public API (called by RankingEngine.gs only):
//   rcAggregateBysite(bills, meters, sites)
//   rcAggregateByMeter(bills, meters, sites)
//   rcRankElectricityCost(siteAggregates, options)
//   rcRankWaterCost(siteAggregates, options)
//   rcRankHighestUsage(siteAggregates, options)
//   rcRankFastestGrowth(bills, meters, sites, options)
//   rcRankAbnormalUsage(anomalies, siteAggregates, options)
//   rcRankSiteEfficiency(siteAggregates, options)
//   rcBuildRankRecord(raw, rank, options)
//   rcNormalizeScores(items, field)
// ============================================================
// All functions are PURE relative to Sheet I/O —
// they accept pre-loaded data arrays; no direct Sheet reads.
// ============================================================


// ============================================================
// SECTION 1 — CONFIGURATION
// ============================================================

/**
 * ค่า config สำหรับ ranking calculator
 * ปรับได้โดยไม่แก้ logic
 */
var RC_CONFIG = {
  // ── Decimal precision ─────────────────────────────────────
  DECIMAL_PLACES: 2,

  // ── Default top-N ─────────────────────────────────────────
  DEFAULT_TOP_N: 10,        // แสดง N อันดับแรกโดย default

  // ── Growth ranking ────────────────────────────────────────
  // ต้องการข้อมูลอย่างน้อยกี่เดือนจึงคำนวณ growth ได้น่าเชื่อถือ
  GROWTH_MIN_MONTHS: 3,

  // น้ำหนัก MoM vs YoY สำหรับ growth score (รวม = 1.0)
  GROWTH_WEIGHT_MOM: 0.5,
  GROWTH_WEIGHT_YOY: 0.5,

  // ── Efficiency ranking ────────────────────────────────────
  // น้ำหนักแต่ละ factor ใน composite efficiency score (รวม = 1.0)
  EFFICIENCY_WEIGHT_CPU:        0.40,  // cost per unit
  EFFICIENCY_WEIGHT_TREND:      0.30,  // consumption trend direction
  EFFICIENCY_WEIGHT_STABILITY:  0.20,  // variance / stability
  EFFICIENCY_WEIGHT_YOY:        0.10,  // YoY improvement

  // ── Abnormal ranking ──────────────────────────────────────
  // น้ำหนัก anomaly severity สำหรับ scoring
  SEVERITY_WEIGHTS: {
    CRITICAL: 100,
    HIGH:      60,
    MEDIUM:    30,
    LOW:       10,
    NONE:       0,
  },

  // ── Meter types ───────────────────────────────────────────
  METER_TYPE_ELECTRICITY: 'ELECTRICITY',
  METER_TYPE_WATER:       'WATER',
};


// ============================================================
// SECTION 2 — SITE AGGREGATE BUILDER
// ============================================================

/**
 * Aggregate bills ต่อ site — คืน Map ของ site metrics
 * ทำครั้งเดียวแล้วส่งต่อให้ทุก ranking function
 * O(n) single-pass สำหรับ large datasets
 *
 * @param {Object[]} bills    — pre-filtered valid bills
 * @param {Object[]} meters   — all meters
 * @param {Object[]} sites    — all sites
 * @returns {Object[]}  — array of siteAggregate objects
 *
 * siteAggregate shape:
 * {
 *   site_id, site_name, site_type, province,
 *   total_elec_cost,   total_water_cost,   total_other_cost,
 *   total_elec_units,  total_water_units,
 *   total_cost,        total_units,
 *   bill_count,        meter_count,
 *   avg_monthly_elec,  avg_monthly_water,
 *   elec_bills, water_bills, all_bills,   // raw subsets for deeper calc
 * }
 */
function rcAggregateBysite(bills, meters, sites) {
  // Build lookup maps for O(1) access
  var meterMap = tcBuildMeterMap(meters);
  var siteMap  = tcBuildSiteMap(sites);

  // Single-pass accumulator per site
  var acc = {};  // { site_id: accumulator }

  bills.forEach(function(bill) {
    var sid = bill.site_id || 'UNKNOWN';

    // Initialise accumulator on first encounter
    if (!acc[sid]) {
      var site = siteMap[sid] || {};
      acc[sid] = {
        site_id:           sid,
        site_name:         site.site_name  || sid,
        site_type:         site.site_type  || '',
        province:          site.province   || '',
        total_elec_cost:   0,
        total_water_cost:  0,
        total_other_cost:  0,
        total_elec_units:  0,
        total_water_units: 0,
        total_cost:        0,
        total_units:       0,
        bill_count:        0,
        meter_ids:         {},  // set-like object for unique count
        elec_bills:        [],
        water_bills:       [],
        all_bills:         [],
      };
    }

    var a      = acc[sid];
    var amount = parseFloat(bill.amount_total || 0);
    var units  = parseFloat(bill.units_used   || 0);
    var meter  = meterMap[bill.meter_id] || {};
    var mtype  = (bill.meter_type || meter.meter_type || '').toUpperCase();

    // Accumulate by meter type
    if (mtype === RC_CONFIG.METER_TYPE_ELECTRICITY) {
      a.total_elec_cost  += amount;
      a.total_elec_units += units;
      a.elec_bills.push(bill);
    } else if (mtype === RC_CONFIG.METER_TYPE_WATER) {
      a.total_water_cost  += amount;
      a.total_water_units += units;
      a.water_bills.push(bill);
    } else {
      a.total_other_cost += amount;
    }

    // Universal totals
    a.total_cost  += amount;
    a.total_units += units;
    a.bill_count++;
    if (bill.meter_id) a.meter_ids[bill.meter_id] = true;
    a.all_bills.push(bill);
  });

  // Convert accumulator to final array + compute derived metrics
  return Object.values(acc).map(function(a) {
    var meterCount = Object.keys(a.meter_ids).length;

    // Monthly averages: divide total by distinct period count
    var distinctPeriods = _countDistinctPeriods(a.all_bills);
    var months = Math.max(distinctPeriods, 1);

    return {
      site_id:           a.site_id,
      site_name:         a.site_name,
      site_type:         a.site_type,
      province:          a.province,
      total_elec_cost:   _round(a.total_elec_cost),
      total_water_cost:  _round(a.total_water_cost),
      total_other_cost:  _round(a.total_other_cost),
      total_elec_units:  _round(a.total_elec_units),
      total_water_units: _round(a.total_water_units),
      total_cost:        _round(a.total_cost),
      total_units:       _round(a.total_units),
      bill_count:        a.bill_count,
      meter_count:       meterCount,
      avg_monthly_elec:  _round(a.total_elec_cost  / months),
      avg_monthly_water: _round(a.total_water_cost / months),
      avg_monthly_cost:  _round(a.total_cost       / months),
      // raw bill subsets kept for growth & efficiency calculations
      elec_bills:        a.elec_bills,
      water_bills:       a.water_bills,
      all_bills:         a.all_bills,
    };
  });
}


/**
 * Aggregate bills ต่อ meter — สำหรับ meter-level ranking
 * ใช้โครงสร้างเดียวกับ rcAggregateBysite แต่ group ด้วย meter_id
 *
 * @param {Object[]} bills
 * @param {Object[]} meters
 * @param {Object[]} sites
 * @returns {Object[]}  — array of meterAggregate objects
 */
function rcAggregateByMeter(bills, meters, sites) {
  var meterMap = tcBuildMeterMap(meters);
  var siteMap  = tcBuildSiteMap(sites);
  var acc = {};

  bills.forEach(function(bill) {
    var mid = bill.meter_id || 'UNKNOWN';
    if (!acc[mid]) {
      var meter = meterMap[mid] || {};
      var site  = siteMap[meter.site_id || bill.site_id] || {};
      acc[mid] = {
        meter_id:    mid,
        meter_number: meter.meter_number || mid,
        meter_type:  (meter.meter_type || '').toUpperCase(),
        meter_name:  meter.meter_name || '',
        site_id:     meter.site_id || bill.site_id || '',
        site_name:   site.site_name || '',
        total_cost:  0,
        total_units: 0,
        bill_count:  0,
        bills:       [],
      };
    }
    var a = acc[mid];
    a.total_cost  += parseFloat(bill.amount_total || 0);
    a.total_units += parseFloat(bill.units_used   || 0);
    a.bill_count++;
    a.bills.push(bill);
  });

  return Object.values(acc).map(function(a) {
    var months = Math.max(_countDistinctPeriods(a.bills), 1);
    return Object.assign({}, a, {
      total_cost:       _round(a.total_cost),
      total_units:      _round(a.total_units),
      avg_monthly_cost: _round(a.total_cost  / months),
      avg_monthly_units:_round(a.total_units / months),
      cost_per_unit:    _round(a.total_units > 0 ? a.total_cost / a.total_units : 0),
    });
  });
}


// ============================================================
// SECTION 3 — ELECTRICITY COST RANKING
// ============================================================

/**
 * จัดอันดับ site ตามค่าไฟฟ้า (สูงสุดก่อน)
 *
 * Ranking criteria (primary → secondary):
 *   1. total_elec_cost (ทุก period รวมกัน)
 *   2. avg_monthly_elec (ถ้า total เท่ากัน)
 *   3. total_elec_units (ถ้า avg เท่ากัน)
 *
 * @param {Object[]} siteAggregates  — จาก rcAggregateBysite()
 * @param {Object}   [options]
 * @param {number}   [options.top_n]        — จำนวนอันดับที่ต้องการ (default 10)
 * @param {number}   [options.year]         — กรองเฉพาะปี (null = ทั้งหมด)
 * @param {boolean}  [options.include_zero] — รวม site ที่ไม่มีค่าไฟ (default false)
 * @returns {Object[]}  — ranked array พร้อม rank field
 */
function rcRankElectricityCost(siteAggregates, options) {
  options = options || {};
  var topN        = options.top_n        || RC_CONFIG.DEFAULT_TOP_N;
  var includeZero = options.include_zero || false;

  // กรอง site ที่มีค่าไฟจริง
  var candidates = siteAggregates.filter(function(s) {
    return includeZero ? true : s.total_elec_cost > 0;
  });

  // ถ้าระบุปี ต้องคำนวณค่าไฟใหม่สำหรับปีนั้น
  if (options.year) {
    candidates = candidates.map(function(s) {
      var yearBills = s.elec_bills.filter(function(b) {
        return parseInt(b.bill_year) === parseInt(options.year);
      });
      var yearCost  = yearBills.reduce(function(sum, b) { return sum + parseFloat(b.amount_total || 0); }, 0);
      var yearUnits = yearBills.reduce(function(sum, b) { return sum + parseFloat(b.units_used   || 0); }, 0);
      var months    = Math.max(_countDistinctPeriods(yearBills), 1);
      return Object.assign({}, s, {
        total_elec_cost:  _round(yearCost),
        total_elec_units: _round(yearUnits),
        avg_monthly_elec: _round(yearCost / months),
        _period_label:    'ปี ' + options.year,
      });
    }).filter(function(s) { return includeZero ? true : s.total_elec_cost > 0; });
  }

  // Sort: primary = total_elec_cost DESC, secondary = avg_monthly DESC
  candidates.sort(function(a, b) {
    if (b.total_elec_cost !== a.total_elec_cost) return b.total_elec_cost - a.total_elec_cost;
    if (b.avg_monthly_elec !== a.avg_monthly_elec) return b.avg_monthly_elec - a.avg_monthly_elec;
    return b.total_elec_units - a.total_elec_units;
  });

  // Assign rank + build output records
  return candidates.slice(0, topN).map(function(s, i) {
    return rcBuildRankRecord(s, i + 1, {
      ranking_type:   'ELECTRICITY_COST',
      primary_value:  s.total_elec_cost,
      primary_label:  'ค่าไฟฟ้ารวม (บาท)',
      secondary_value: s.avg_monthly_elec,
      secondary_label: 'เฉลี่ย/เดือน (บาท)',
      unit_value:      s.total_elec_units,
      unit_label:      'หน่วยรวม (kWh)',
      cost_per_unit:  s.total_elec_units > 0 ? _round(s.total_elec_cost / s.total_elec_units) : null,
    });
  });
}


// ============================================================
// SECTION 4 — WATER COST RANKING
// ============================================================

/**
 * จัดอันดับ site ตามค่าน้ำประปา (สูงสุดก่อน)
 *
 * Ranking criteria:
 *   1. total_water_cost DESC
 *   2. avg_monthly_water DESC
 *   3. total_water_units DESC
 *
 * @param {Object[]} siteAggregates
 * @param {Object}   [options]  — เหมือน rcRankElectricityCost
 * @returns {Object[]}
 */
function rcRankWaterCost(siteAggregates, options) {
  options = options || {};
  var topN        = options.top_n        || RC_CONFIG.DEFAULT_TOP_N;
  var includeZero = options.include_zero || false;

  var candidates = siteAggregates.filter(function(s) {
    return includeZero ? true : s.total_water_cost > 0;
  });

  // Year-filter variant
  if (options.year) {
    candidates = candidates.map(function(s) {
      var yearBills = s.water_bills.filter(function(b) {
        return parseInt(b.bill_year) === parseInt(options.year);
      });
      var yearCost  = yearBills.reduce(function(sum, b) { return sum + parseFloat(b.amount_total || 0); }, 0);
      var yearUnits = yearBills.reduce(function(sum, b) { return sum + parseFloat(b.units_used   || 0); }, 0);
      var months    = Math.max(_countDistinctPeriods(yearBills), 1);
      return Object.assign({}, s, {
        total_water_cost:  _round(yearCost),
        total_water_units: _round(yearUnits),
        avg_monthly_water: _round(yearCost / months),
      });
    }).filter(function(s) { return includeZero ? true : s.total_water_cost > 0; });
  }

  candidates.sort(function(a, b) {
    if (b.total_water_cost !== a.total_water_cost) return b.total_water_cost - a.total_water_cost;
    if (b.avg_monthly_water !== a.avg_monthly_water) return b.avg_monthly_water - a.avg_monthly_water;
    return b.total_water_units - a.total_water_units;
  });

  return candidates.slice(0, topN).map(function(s, i) {
    return rcBuildRankRecord(s, i + 1, {
      ranking_type:    'WATER_COST',
      primary_value:   s.total_water_cost,
      primary_label:   'ค่าน้ำรวม (บาท)',
      secondary_value: s.avg_monthly_water,
      secondary_label: 'เฉลี่ย/เดือน (บาท)',
      unit_value:      s.total_water_units,
      unit_label:      'หน่วยรวม (ลบ.ม.)',
      cost_per_unit:   s.total_water_units > 0 ? _round(s.total_water_cost / s.total_water_units) : null,
    });
  });
}


// ============================================================
// SECTION 5 — HIGHEST USAGE RANKING
// ============================================================

/**
 * จัดอันดับ site ตามปริมาณการใช้ (units_used) รวมทุกประเภท
 * หรือกรองตาม meter_type ถ้าระบุ
 *
 * Ranking criteria:
 *   1. total_units DESC
 *   2. avg_monthly_cost DESC  (tie-breaker)
 *
 * @param {Object[]} siteAggregates
 * @param {Object}   [options]
 * @param {string}   [options.meter_type]  — 'ELECTRICITY'|'WATER'|'ALL'
 * @param {number}   [options.top_n]
 * @returns {Object[]}
 */
function rcRankHighestUsage(siteAggregates, options) {
  options = options || {};
  var topN      = options.top_n || RC_CONFIG.DEFAULT_TOP_N;
  var meterType = (options.meter_type || 'ALL').toUpperCase();

  var candidates = siteAggregates.map(function(s) {
    var units, cost, label;
    if (meterType === RC_CONFIG.METER_TYPE_ELECTRICITY) {
      units = s.total_elec_units;
      cost  = s.total_elec_cost;
      label = 'kWh';
    } else if (meterType === RC_CONFIG.METER_TYPE_WATER) {
      units = s.total_water_units;
      cost  = s.total_water_cost;
      label = 'ลบ.ม.';
    } else {
      units = s.total_units;
      cost  = s.total_cost;
      label = 'หน่วยรวม';
    }
    return Object.assign({}, s, {
      _rank_units: units,
      _rank_cost:  cost,
      _unit_label: label,
    });
  }).filter(function(s) { return s._rank_units > 0; });

  candidates.sort(function(a, b) {
    if (b._rank_units !== a._rank_units) return b._rank_units - a._rank_units;
    return b._rank_cost - a._rank_cost;
  });

  return candidates.slice(0, topN).map(function(s, i) {
    return rcBuildRankRecord(s, i + 1, {
      ranking_type:    'HIGHEST_USAGE',
      primary_value:   s._rank_units,
      primary_label:   'ปริมาณใช้รวม (' + s._unit_label + ')',
      secondary_value: s._rank_cost,
      secondary_label: 'ค่าใช้จ่ายรวม (บาท)',
      unit_value:      null,
      unit_label:      null,
      cost_per_unit:   s._rank_units > 0 ? _round(s._rank_cost / s._rank_units) : null,
    });
  });
}


// ============================================================
// SECTION 6 — FASTEST GROWTH RANKING
// ============================================================

/**
 * จัดอันดับ site ที่มี growth rate สูงสุด
 * Growth = weighted combination ของ MoM last-period + YoY annual change
 *
 * Algorithm:
 *   1. สร้าง time-series amount_total ต่อ site
 *   2. คำนวณ MoM % change ของเดือนล่าสุด
 *   3. คำนวณ YoY % change (ปีล่าสุดเทียบปีก่อน)
 *   4. growth_score = (MoM * weight_mom) + (YoY * weight_yoy)
 *   5. เรียงตาม growth_score DESC
 *
 * @param {Object[]} bills   — valid bills (pre-filtered)
 * @param {Object[]} meters
 * @param {Object[]} sites
 * @param {Object}   [options]
 * @param {string}   [options.meter_type]  — กรองประเภทมิเตอร์
 * @param {number}   [options.top_n]
 * @param {boolean}  [options.include_negative]  — รวม growth ลด (default false = เฉพาะ +)
 * @returns {Object[]}
 */
function rcRankFastestGrowth(bills, meters, sites, options) {
  options = options || {};
  var topN            = options.top_n            || RC_CONFIG.DEFAULT_TOP_N;
  var includeNegative = options.include_negative || false;
  var meterType       = (options.meter_type      || 'ALL').toUpperCase();

  var meterMap = tcBuildMeterMap(meters);
  var siteMap  = tcBuildSiteMap(sites);

  // กรอง meter_type ก่อน
  var filteredBills = meterType !== 'ALL'
    ? tcFilterByMeterType(bills, meterType, meterMap)
    : bills;

  // Group by site
  var siteGroups = tcGroupBySite(filteredBills);

  var results = [];

  Object.keys(siteGroups).forEach(function(siteId) {
    var siteBills = siteGroups[siteId];

    // ต้องมีข้อมูลขั้นต่ำ
    if (siteBills.length < RC_CONFIG.GROWTH_MIN_MONTHS) return;

    var site = siteMap[siteId] || {};

    // สร้าง time-series ต่อ site
    var amtMap  = tcBuildTimeSeriesMap(siteBills, 'amount_total');
    var sorted  = tcTimeSeriesMapToArray(amtMap);

    if (sorted.length < 2) return;

    // MoM % change ของ period ล่าสุด
    var momSeries = tcMoMChangeSeries(sorted, 'value');
    var lastMoM   = null;
    for (var i = momSeries.length - 1; i >= 0; i--) {
      if (momSeries[i].mom_pct !== null) {
        lastMoM = momSeries[i].mom_pct;
        break;
      }
    }

    // YoY % change (ปีล่าสุดเทียบปีก่อน)
    var yoyPct  = _calcYoYPct(sorted);

    // Linear regression slope (trend direction สำหรับ context)
    var rawValues = sorted.map(function(p) { return p.value; });
    var regression = tcLinearRegression(rawValues);

    // Composite growth score
    var momVal = lastMoM !== null ? lastMoM : 0;
    var yoyVal = yoyPct  !== null ? yoyPct  : 0;
    var growthScore = _round(
      (momVal * RC_CONFIG.GROWTH_WEIGHT_MOM) +
      (yoyVal * RC_CONFIG.GROWTH_WEIGHT_YOY)
    );

    // Skip ถ้าไม่รวม negative growth
    if (!includeNegative && growthScore <= 0) return;

    // คำนวณ totals สำหรับ display
    var totalCost  = siteBills.reduce(function(s, b) { return s + parseFloat(b.amount_total || 0); }, 0);
    var totalUnits = siteBills.reduce(function(s, b) { return s + parseFloat(b.units_used   || 0); }, 0);

    results.push({
      site_id:          siteId,
      site_name:        site.site_name || siteId,
      site_type:        site.site_type || '',
      province:         site.province  || '',
      growth_score:     growthScore,
      mom_pct:          lastMoM !== null ? _round(lastMoM) : null,
      yoy_pct:          yoyPct  !== null ? _round(yoyPct)  : null,
      regression_slope: regression ? _round(regression.slope) : null,
      regression_r2:    regression ? _round(regression.r2)    : null,
      trend_direction:  regression ? _rcSlopeTrend(regression.slope) : 'STABLE',
      total_cost:       _round(totalCost),
      total_units:      _round(totalUnits),
      data_points:      sorted.length,
      meter_type_filter: meterType,
    });
  });

  // Sort by growth_score DESC
  results.sort(function(a, b) { return b.growth_score - a.growth_score; });

  return results.slice(0, topN).map(function(s, i) {
    return rcBuildRankRecord(s, i + 1, {
      ranking_type:    'FASTEST_GROWTH',
      primary_value:   s.growth_score,
      primary_label:   'Growth Score (%)',
      secondary_value: s.mom_pct,
      secondary_label: 'MoM เดือนล่าสุด (%)',
      unit_value:      s.yoy_pct,
      unit_label:      'YoY เปลี่ยนแปลง (%)',
      cost_per_unit:   null,
    });
  });
}


// ============================================================
// SECTION 7 — ABNORMAL USAGE RANKING
// ============================================================

/**
 * จัดอันดับ site ตามความรุนแรงของ anomalies ที่ตรวจพบ
 * Site ที่มี anomaly score สูงสุดอยู่อันดับต้น (ต้องแก้ไขก่อน)
 *
 * Scoring formula ต่อ site:
 *   anomaly_score = Σ (severity_weight × confidence / 100)
 *     โดย sum บน anomalies ทุก record ของ site นั้น
 *
 * @param {Object[]} anomalies      — anomaly records (จาก getAnomalyReport / Anomalies sheet)
 * @param {Object[]} siteAggregates — จาก rcAggregateBysite() สำหรับ cost context
 * @param {Object}   [options]
 * @param {string}   [options.min_severity]  — 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'
 * @param {number}   [options.top_n]
 * @param {number}   [options.year]          — กรองเฉพาะปี
 * @returns {Object[]}
 */
function rcRankAbnormalUsage(anomalies, siteAggregates, options) {
  options = options || {};
  var topN        = options.top_n        || RC_CONFIG.DEFAULT_TOP_N;
  var minSeverity = options.min_severity || 'LOW';
  var minWeight   = RC_CONFIG.SEVERITY_WEIGHTS[minSeverity] || 0;

  // Build siteAggregate lookup
  var siteAccLookup = {};
  siteAggregates.forEach(function(s) { siteAccLookup[s.site_id] = s; });

  // กรองตามปี (ถ้าระบุ)
  var filteredAnomalies = anomalies;
  if (options.year) {
    filteredAnomalies = anomalies.filter(function(a) {
      return parseInt(a.bill_year) === parseInt(options.year);
    });
  }

  // Accumulate anomaly score per site (single pass)
  var siteAnomalyAcc = {};  // { site_id: { score, count, bySeverity, anomalies[] } }

  filteredAnomalies.forEach(function(anomaly) {
    var sid      = anomaly.site_id;
    var severity = (anomaly.severity || 'LOW').toUpperCase();
    var weight   = RC_CONFIG.SEVERITY_WEIGHTS[severity] || 0;

    // Skip anomalies below minimum severity
    if (weight < minWeight) return;

    var confidence    = parseFloat(anomaly.confidence || 50) / 100;
    var contribution  = _round(weight * confidence);

    if (!siteAnomalyAcc[sid]) {
      siteAnomalyAcc[sid] = {
        site_id:      sid,
        anomaly_score: 0,
        anomaly_count: 0,
        by_severity:  { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        latest_period: '',
        anomaly_types: {},
        anomalies:    [],
      };
    }

    var a = siteAnomalyAcc[sid];
    a.anomaly_score  += contribution;
    a.anomaly_count++;
    if (a.by_severity.hasOwnProperty(severity)) a.by_severity[severity]++;
    if (anomaly.bill_period_key > a.latest_period) a.latest_period = anomaly.bill_period_key;
    var atype = anomaly.anomaly_type || 'UNKNOWN';
    a.anomaly_types[atype] = (a.anomaly_types[atype] || 0) + 1;
    a.anomalies.push(anomaly);
  });

  // Build ranked results
  var results = Object.values(siteAnomalyAcc).map(function(a) {
    var siteAgg   = siteAccLookup[a.site_id] || {};
    var topType   = _topKey(a.anomaly_types);

    return {
      site_id:          a.site_id,
      site_name:        siteAgg.site_name || a.site_id,
      site_type:        siteAgg.site_type || '',
      province:         siteAgg.province  || '',
      anomaly_score:    _round(a.anomaly_score),
      anomaly_count:    a.anomaly_count,
      by_severity:      a.by_severity,
      dominant_type:    topType,
      latest_period:    a.latest_period,
      total_cost:       siteAgg.total_cost  || 0,
      total_elec_cost:  siteAgg.total_elec_cost  || 0,
      total_water_cost: siteAgg.total_water_cost || 0,
      anomaly_details:  a.anomalies.slice(0, 5), // top 5 สำหรับ preview
    };
  });

  // Sort: anomaly_score DESC, then anomaly_count DESC
  results.sort(function(a, b) {
    if (b.anomaly_score !== a.anomaly_score) return b.anomaly_score - a.anomaly_score;
    return b.anomaly_count - a.anomaly_count;
  });

  return results.slice(0, topN).map(function(s, i) {
    return rcBuildRankRecord(s, i + 1, {
      ranking_type:    'ABNORMAL_USAGE',
      primary_value:   s.anomaly_score,
      primary_label:   'Anomaly Score',
      secondary_value: s.anomaly_count,
      secondary_label: 'จำนวน Anomalies',
      unit_value:      s.by_severity.CRITICAL + s.by_severity.HIGH,
      unit_label:      'HIGH/CRITICAL',
      cost_per_unit:   null,
    });
  });
}


// ============================================================
// SECTION 8 — SITE EFFICIENCY RANKING
// ============================================================

/**
 * จัดอันดับ site ตาม efficiency score (สูง = ดี = ประหยัดกว่า)
 * อันดับ 1 = site ที่ใช้พลังงานมีประสิทธิภาพสูงสุด
 *
 * Composite Efficiency Score (0–100):
 *   Component A (40%): cost_per_unit
 *     → normalize cross-site: ต่ำ = ดี (invert)
 *   Component B (30%): consumption trend slope
 *     → DECREASING = ดี, STABLE = กลาง, INCREASING = แย่
 *   Component C (20%): stability (inverse CV = std/mean)
 *     → ค่าสม่ำเสมอ = ดี
 *   Component D (10%): YoY improvement
 *     → ลดลงจากปีก่อน = ดี
 *
 * @param {Object[]} siteAggregates
 * @param {Object}   [options]
 * @param {number}   [options.top_n]
 * @param {string}   [options.meter_type]   — 'ELECTRICITY'|'WATER'|'ALL'
 * @returns {Object[]}
 */
function rcRankSiteEfficiency(siteAggregates, options) {
  options = options || {};
  var topN      = options.top_n      || RC_CONFIG.DEFAULT_TOP_N;
  var meterType = (options.meter_type || 'ALL').toUpperCase();

  // คำนวณ raw metrics ต่อ site ก่อน normalize
  var rawMetrics = siteAggregates
    .filter(function(s) { return s.total_units > 0 && s.bill_count >= 3; })
    .map(function(s) {
      // เลือก bills subset ตาม meterType
      var bills = meterType === RC_CONFIG.METER_TYPE_ELECTRICITY ? s.elec_bills
                : meterType === RC_CONFIG.METER_TYPE_WATER       ? s.water_bills
                : s.all_bills;

      if (!bills || bills.length < 2) return null;

      // A: cost per unit (ต่ำ = ดี)
      var cpu = tcAvgCostPerUnit(bills);

      // B: consumption trend slope
      var unitMap  = tcBuildTimeSeriesMap(bills, 'units_used');
      var unitArr  = tcTimeSeriesMapToArray(unitMap);
      var unitVals = unitArr.map(function(p) { return p.value; });
      var reg      = tcLinearRegression(unitVals);
      var slope    = reg ? reg.slope : 0;
      var r2       = reg ? reg.r2    : 0;

      // C: stability = CV (coefficient of variation) — ต่ำ = stable
      var mean = tcMean(unitVals);
      var cv   = (mean && mean > 0) ? _calcCV(unitVals, mean) : 999;

      // D: YoY improvement
      var amtMap    = tcBuildTimeSeriesMap(bills, 'amount_total');
      var amtSorted = tcTimeSeriesMapToArray(amtMap);
      var yoyPct    = _calcYoYPct(amtSorted);

      return {
        site_id:     s.site_id,
        site_name:   s.site_name,
        site_type:   s.site_type,
        province:    s.province,
        cpu:         cpu,
        slope:       slope,
        r2:          r2,
        cv:          cv,
        yoy_pct:     yoyPct,
        total_cost:  s.total_cost,
        total_units: s.total_units,
        total_elec_cost:   s.total_elec_cost,
        total_water_cost:  s.total_water_cost,
        avg_monthly_cost:  s.avg_monthly_cost,
        bill_count:  s.bill_count,
        meter_count: s.meter_count,
        data_months: unitArr.length,
      };
    }).filter(Boolean);

  if (rawMetrics.length === 0) return [];

  // ── Normalize each component across all sites ──────────────

  // Component A: cost_per_unit — lower is better → invert after normalize
  var cpuValues = rawMetrics.map(function(m) { return m.cpu !== null ? m.cpu : 0; });
  var cpuNorm   = rcNormalizeScores(cpuValues, true);  // inverted

  // Component B: slope → convert to score (ลดลง = 100, stable = 50, เพิ่ม = 0)
  var slopeScores = rawMetrics.map(function(m) { return _slopeToEffScore(m.slope, m.r2); });

  // Component C: stability → invert CV (ต่ำ = stable = ดี)
  var cvValues  = rawMetrics.map(function(m) { return m.cv < 999 ? m.cv : 10; });
  var cvNorm    = rcNormalizeScores(cvValues, true);   // inverted

  // Component D: YoY improvement (ลดลง = ดี → invert)
  var yoyScores = rawMetrics.map(function(m) {
    if (m.yoy_pct === null) return 50;                  // no data → neutral
    // clamp -50% to +50% → map to 0-100 (ลดลง 50%+ = 100, เพิ่มขึ้น 50%+ = 0)
    return Math.max(0, Math.min(100, 50 - m.yoy_pct));
  });

  // ── Composite score ────────────────────────────────────────
  var w = RC_CONFIG;
  var results = rawMetrics.map(function(m, i) {
    var scoreA = cpuNorm[i]   * w.EFFICIENCY_WEIGHT_CPU;
    var scoreB = slopeScores[i] * w.EFFICIENCY_WEIGHT_TREND;
    var scoreC = cvNorm[i]    * w.EFFICIENCY_WEIGHT_STABILITY;
    var scoreD = yoyScores[i] * w.EFFICIENCY_WEIGHT_YOY;

    var composite = _round(scoreA + scoreB + scoreC + scoreD);

    return Object.assign({}, m, {
      efficiency_score:   composite,
      score_breakdown: {
        cpu_score:       _round(cpuNorm[i]),
        trend_score:     _round(slopeScores[i]),
        stability_score: _round(cvNorm[i]),
        yoy_score:       _round(yoyScores[i]),
      },
    });
  });

  // Sort: efficiency_score DESC (สูง = ดี)
  results.sort(function(a, b) { return b.efficiency_score - a.efficiency_score; });

  return results.slice(0, topN).map(function(s, i) {
    return rcBuildRankRecord(s, i + 1, {
      ranking_type:    'SITE_EFFICIENCY',
      primary_value:   s.efficiency_score,
      primary_label:   'Efficiency Score (0-100)',
      secondary_value: s.cpu,
      secondary_label: 'ค่าเฉลี่ยต่อหน่วย (บาท/หน่วย)',
      unit_value:      s.yoy_pct,
      unit_label:      'YoY เปลี่ยนแปลง (%)',
      cost_per_unit:   s.cpu,
    });
  });
}


// ============================================================
// SECTION 9 — SHARED RECORD BUILDER
// ============================================================

/**
 * สร้าง standardized rank record สำหรับ output ทุกประเภท
 * ทุก ranking type คืน record shape เดียวกัน
 * ทำให้ frontend / table components ใช้ได้โดยไม่ต้องรู้ type
 *
 * @param {Object} raw      — site aggregate หรือ raw computed object
 * @param {number} rank     — 1-based rank number
 * @param {Object} meta     — ranking-type specific metadata
 * @returns {Object}  — standardized rank record
 */
function rcBuildRankRecord(raw, rank, meta) {
  return {
    // ── Identity ──────────────────────────────────────────
    rank:            rank,
    ranking_type:    meta.ranking_type    || '',
    site_id:         raw.site_id          || '',
    site_name:       raw.site_name        || raw.site_id || '',
    site_type:       raw.site_type        || '',
    province:        raw.province         || '',

    // ── Primary metric (ค่าที่ใช้ rank) ──────────────────
    primary_value:   meta.primary_value   !== undefined ? meta.primary_value  : null,
    primary_label:   meta.primary_label   || '',

    // ── Secondary metric (tie-breaker / context) ──────────
    secondary_value: meta.secondary_value !== undefined ? meta.secondary_value : null,
    secondary_label: meta.secondary_label || '',

    // ── Unit metric (additional context) ─────────────────
    unit_value:      meta.unit_value      !== undefined ? meta.unit_value     : null,
    unit_label:      meta.unit_label      || '',

    // ── Cost efficiency ────────────────────────────────────
    cost_per_unit:   meta.cost_per_unit   !== undefined ? meta.cost_per_unit  : null,

    // ── Common financials (always included for dashboard) ─
    total_cost:      raw.total_cost       || 0,
    total_elec_cost: raw.total_elec_cost  || 0,
    total_water_cost:raw.total_water_cost || 0,
    bill_count:      raw.bill_count       || 0,
    meter_count:     raw.meter_count      || 0,

    // ── Passthrough of all raw fields (for detail views) ──
    _raw: raw,
  };
}


// ============================================================
// SECTION 10 — NORMALIZATION UTILITY
// ============================================================

/**
 * Normalize array ของ numbers เป็น 0–100 scale
 * ใช้ min-max normalization
 *
 * @param {number[]} values   — raw values
 * @param {boolean}  invert   — true = ต่ำ = ดี (invert score)
 * @returns {number[]}  — normalized scores (0–100), same index as input
 */
function rcNormalizeScores(values, invert) {
  if (!values || values.length === 0) return [];

  var valid = values.filter(function(v) { return v !== null && !isNaN(v); });
  if (valid.length === 0) return values.map(function() { return 50; });

  var min = Math.min.apply(null, valid);
  var max = Math.max.apply(null, valid);
  var range = max - min;

  return values.map(function(v) {
    if (v === null || isNaN(v)) return 50; // neutral for missing data
    var norm = range === 0 ? 50 : ((v - min) / range) * 100;
    return _round(invert ? 100 - norm : norm);
  });
}


// ============================================================
// SECTION 11 — PRIVATE HELPERS
// ============================================================

/**
 * นับจำนวน distinct bill_period_key ใน bills array
 * @private
 */
function _countDistinctPeriods(bills) {
  var seen = {};
  bills.forEach(function(b) {
    if (b.bill_period_key) seen[b.bill_period_key] = true;
  });
  return Object.keys(seen).length;
}


/**
 * คำนวณ YoY % change จาก time-series array
 * เปรียบเทียบผลรวมของ 2 ปีล่าสุดในข้อมูล
 *
 * @param {Object[]} sorted  — จาก tcTimeSeriesMapToArray (period_key ASC)
 * @returns {number|null}
 * @private
 */
function _calcYoYPct(sorted) {
  if (!sorted || sorted.length < 2) return null;

  // หา 2 ปีล่าสุด
  var years = {};
  sorted.forEach(function(p) { years[p.year] = true; });
  var yearList = Object.keys(years).map(Number).sort(function(a, b) { return b - a; });
  if (yearList.length < 2) return null;

  var yearA = yearList[0];
  var yearB = yearList[1];

  var totalA = 0, totalB = 0;
  sorted.forEach(function(p) {
    if (p.year === yearA) totalA += p.value;
    if (p.year === yearB) totalB += p.value;
  });

  if (totalB === 0) return null;
  return _round(((totalA - totalB) / totalB) * 100);
}


/**
 * คำนวณ Coefficient of Variation (std / mean * 100)
 * @private
 */
function _calcCV(values, mean) {
  if (!mean || mean === 0) return 999;
  var variance = values.reduce(function(s, v) { return s + Math.pow(v - mean, 2); }, 0) / values.length;
  return Math.sqrt(variance) / mean * 100;
}


/**
 * แปลง regression slope เป็น efficiency score (0–100)
 * slope ลบ + r2 สูง = ดี (ประหยัดขึ้น)
 * @private
 */
function _slopeToEffScore(slope, r2) {
  r2 = r2 || 0;
  // normalize slope เป็น -1 ถึง +1 (approximate)
  var slopeNorm = Math.max(-1, Math.min(1, slope / 500));
  // แปลงเป็น 0-100 โดย invert (ลบ = ดี)
  var base = (1 - slopeNorm) / 2 * 100;
  // weight ด้วย r2 (ถ้า r2 ต่ำ ดึงเข้า neutral)
  return _round(base * r2 + 50 * (1 - r2));
}


/**
 * แปลง slope เป็น trend label
 * @private
 */
function _rcSlopeTrend(slope) {
  if (slope > 10)  return 'INCREASING';
  if (slope < -10) return 'DECREASING';
  return 'STABLE';
}


/**
 * หา key ที่มีค่าสูงสุดใน object
 * @private
 */
function _topKey(obj) {
  var top = null, max = -1;
  Object.keys(obj).forEach(function(k) {
    if (obj[k] > max) { max = obj[k]; top = k; }
  });
  return top;
}


/**
 * Round ตาม RC_CONFIG.DECIMAL_PLACES
 * @private
 */
function _round(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return parseFloat(v.toFixed(RC_CONFIG.DECIMAL_PLACES));
}
