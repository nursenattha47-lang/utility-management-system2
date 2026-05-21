// ============================================================
// TrendAnalyzer.gs — Trend Analysis Engine (Orchestrator)
// UtilityManager | PHASE 5A — Trend Analysis Engine
// ============================================================
// รับผิดชอบ:
//   1. Monthly Comparison Analysis   (MoM per site/meter/type)
//   2. Year-over-Year Comparison     (YoY annual + monthly breakdown)
//   3. Rolling Average Analysis      (3, 6, 12 month windows)
//   4. Consumption Trend Calculation (units_used trajectory)
//   5. Cost Trend Analysis           (amount_total + cost/unit)
//   6. Site Performance Analysis     (rank + efficiency score)
// ============================================================
// Dependencies:
//   Config.gs, Utils.gs, Database.gs, Auth.gs
//   TrendCalculator.gs  ← math engine (must load first)
// ============================================================
// Public API (เรียกจาก Analytics.gs หรือ Code.gs):
//   getTrendAnalysis(token, options)        — รวมทุก analysis
//   getMonthlyComparison(token, options)    — MoM
//   getYoYComparison(token, options)        — Year-over-Year
//   getRollingAverages(token, options)      — Rolling avg
//   getConsumptionTrend(token, options)     — Units trend
//   getCostTrend(token, options)            — Cost trend
//   getSitePerformance(token, options)      — Site ranking
// ============================================================


// ============================================================
// SECTION 1 — PUBLIC ENTRY POINTS
// ============================================================

/**
 * ดึง Trend Analysis ครบทุก module ในรอบเดียว
 * เหมาะสำหรับ dashboard ที่ต้องการข้อมูลทั้งหมด
 * ใช้ batch load เพื่อไม่อ่าน Sheet ซ้ำ
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string} [options.site_id]       — กรองเฉพาะ site (null = ทั้งหมด)
 * @param {string} [options.meter_type]    — 'ELECTRICITY'|'WATER'|'ALL'
 * @param {number} [options.year_a]        — ปีหลัก (default = ปีล่าสุดในข้อมูล)
 * @param {number} [options.year_b]        — ปีเปรียบเทียบ (default = year_a - 1)
 * @param {number[]} [options.rolling_windows] — [3, 6, 12]
 * @returns {Object}  — { monthly, yoy, rolling, consumption, cost, sitePerformance, meta }
 */
function getTrendAnalysis(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);

  try {
    // ---- 1. Batch load ทุก table ครั้งเดียว ----
    var data     = tcLoadAllData();
    var bills    = tcFilterValidBills(data.bills);
    var meters   = data.meters;
    var sites    = data.sites;

    // ---- 2. กรองตาม site_id (ถ้าระบุ) ----
    if (options.site_id) {
      bills = bills.filter(function(b) { return b.site_id === options.site_id; });
    }

    // ---- 3. กรองตาม meter_type ----
    var meterMap = tcBuildMeterMap(meters);
    if (options.meter_type && options.meter_type !== 'ALL') {
      bills = tcFilterByMeterType(bills, options.meter_type, meterMap);
    }

    // ---- 4. ตรวจสอบ years ----
    var availableYears = tcGetAvailableYears(bills);
    var yearA = options.year_a || (availableYears[0]  || new Date().getFullYear() + 543);
    var yearB = options.year_b || (availableYears[1]  || yearA - 1);

    // ---- 5. Run all analyses (ส่ง pre-loaded data เพื่อไม่โหลดซ้ำ) ----
    var ctx = {
      bills:    bills,
      meters:   meters,
      sites:    sites,
      meterMap: meterMap,
      siteMap:  tcBuildSiteMap(sites),
      yearA:    yearA,
      yearB:    yearB,
      options:  options,
    };

    return {
      monthly:        _runMonthlyComparison(ctx),
      yoy:            _runYoYComparison(ctx),
      rolling:        _runRollingAverages(ctx),
      consumption:    _runConsumptionTrend(ctx),
      cost:           _runCostTrend(ctx),
      sitePerformance: _runSitePerformance(ctx),
      meta: {
        year_a:          yearA,
        year_b:          yearB,
        available_years: availableYears,
        bill_count:      bills.length,
        site_count:      Object.keys(tcGroupBySite(bills)).length,
        meter_type:      options.meter_type,
        generated_at:    new Date().toISOString(),
      },
    };

  } catch (e) {
    Logger.log('[TrendAnalyzer] getTrendAnalysis ERROR: ' + e.message);
    throw e;
  }
}


/**
 * Monthly Comparison Analysis
 * เปรียบเทียบค่าใช้จ่าย/การใช้งาน month-over-month
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}
 */
function getMonthlyComparison(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);
  var ctx = _buildContext(options);
  return _runMonthlyComparison(ctx);
}


/**
 * Year-over-Year Comparison
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}
 */
function getYoYComparison(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);
  var ctx = _buildContext(options);
  return _runYoYComparison(ctx);
}


/**
 * Rolling Average Analysis
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}
 */
function getRollingAverages(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);
  var ctx = _buildContext(options);
  return _runRollingAverages(ctx);
}


/**
 * Consumption Trend (units_used)
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}
 */
function getConsumptionTrend(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);
  var ctx = _buildContext(options);
  return _runConsumptionTrend(ctx);
}


/**
 * Cost Trend (amount_total + cost per unit)
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}
 */
function getCostTrend(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);
  var ctx = _buildContext(options);
  return _runCostTrend(ctx);
}


/**
 * Site Performance Analysis
 *
 * @param {string} token
 * @param {Object} [options]
 * @returns {Object}
 */
function getSitePerformance(token, options) {
  requireAuth(token, 'canRead');
  options = _normalizeOptions(options);
  var ctx = _buildContext(options);
  return _runSitePerformance(ctx);
}


// ============================================================
// SECTION 2 — CONTEXT BUILDER
// (shared setup สำหรับ individual public functions)
// ============================================================

/**
 * สร้าง context object สำหรับใช้ใน _run* functions
 * batch-load ข้อมูล + apply filters
 * @private
 */
function _buildContext(options) {
  var data      = tcLoadAllData();
  var bills     = tcFilterValidBills(data.bills);
  var meterMap  = tcBuildMeterMap(data.meters);
  var siteMap   = tcBuildSiteMap(data.sites);

  // กรองตาม site_id
  if (options.site_id) {
    bills = bills.filter(function(b) { return b.site_id === options.site_id; });
  }

  // กรองตาม meter_type
  if (options.meter_type && options.meter_type !== 'ALL') {
    bills = tcFilterByMeterType(bills, options.meter_type, meterMap);
  }

  var availableYears = tcGetAvailableYears(bills);
  var yearA = options.year_a || (availableYears[0] || new Date().getFullYear() + 543);
  var yearB = options.year_b || (availableYears[1] || yearA - 1);

  return {
    bills:    bills,
    meters:   data.meters,
    sites:    data.sites,
    meterMap: meterMap,
    siteMap:  siteMap,
    yearA:    yearA,
    yearB:    yearB,
    options:  options,
  };
}


// ============================================================
// SECTION 3 — MONTHLY COMPARISON ANALYSIS
// ============================================================

/**
 * คำนวณ MoM comparison ระดับ aggregate (ทุก site รวมกัน)
 * และระดับ per-site, per-meter
 *
 * Output structure:
 * {
 *   aggregate:  [ { period_key, year, month, amount_total, units_used, mom_abs, mom_pct }, ... ]
 *   by_site:    { site_id: [ ... ] }
 *   by_meter:   { meter_id: [ ... ] }
 *   by_type:    { ELECTRICITY: [...], WATER: [...] }
 *   summary:    { biggest_increase, biggest_decrease, avg_mom_pct, trend_direction }
 * }
 * @private
 */
function _runMonthlyComparison(ctx) {
  var bills    = ctx.bills;
  var meterMap = ctx.meterMap;

  // ---- Aggregate: ทุก site รวมกัน ----
  var aggAmountMap = tcBuildTimeSeriesMap(bills, 'amount_total');
  var aggUnitsMap  = tcBuildTimeSeriesMap(bills, 'units_used');

  var aggAmountSeries = tcMoMChangeSeries(tcTimeSeriesMapToArray(aggAmountMap), 'value');
  var aggUnitsSeries  = tcMoMChangeSeries(tcTimeSeriesMapToArray(aggUnitsMap),  'value');

  // Merge amount + units เข้าด้วยกัน
  var aggregate = _mergeAmountAndUnits(aggAmountSeries, aggUnitsSeries);

  // ---- Per Site ----
  var bySite    = {};
  var siteGroups = tcGroupBySite(bills);
  Object.keys(siteGroups).forEach(function(siteId) {
    var siteBills     = siteGroups[siteId];
    var siteAmountMap = tcBuildTimeSeriesMap(siteBills, 'amount_total');
    var siteUnitMap   = tcBuildTimeSeriesMap(siteBills, 'units_used');
    var amtSeries     = tcMoMChangeSeries(tcTimeSeriesMapToArray(siteAmountMap), 'value');
    var unitSeries    = tcMoMChangeSeries(tcTimeSeriesMapToArray(siteUnitMap),   'value');
    bySite[siteId]    = _mergeAmountAndUnits(amtSeries, unitSeries);
  });

  // ---- Per Meter ----
  var byMeter = {};
  var meterGroups = tcGroupByMeter(bills);
  Object.keys(meterGroups).forEach(function(meterId) {
    var mBills      = meterGroups[meterId];
    var mAmountMap  = tcBuildTimeSeriesMap(mBills, 'amount_total');
    var mUnitMap    = tcBuildTimeSeriesMap(mBills, 'units_used');
    var amtS        = tcMoMChangeSeries(tcTimeSeriesMapToArray(mAmountMap), 'value');
    var unitS       = tcMoMChangeSeries(tcTimeSeriesMapToArray(mUnitMap),   'value');
    byMeter[meterId] = _mergeAmountAndUnits(amtS, unitS);
  });

  // ---- By Meter Type ----
  var byType = {};
  ['ELECTRICITY', 'WATER'].forEach(function(mt) {
    var typeBills    = tcFilterByMeterType(bills, mt, meterMap);
    var typeAmtMap   = tcBuildTimeSeriesMap(typeBills, 'amount_total');
    var typeUnitMap  = tcBuildTimeSeriesMap(typeBills, 'units_used');
    var amtSeries2   = tcMoMChangeSeries(tcTimeSeriesMapToArray(typeAmtMap), 'value');
    var unitSeries2  = tcMoMChangeSeries(tcTimeSeriesMapToArray(typeUnitMap), 'value');
    byType[mt]       = _mergeAmountAndUnits(amtSeries2, unitSeries2);
  });

  // ---- Summary Stats ----
  var momPcts  = aggregate.filter(function(p) { return p.mom_pct !== null; }).map(function(p) { return p.mom_pct; });
  var summary  = _buildMoMSummary(aggregate, momPcts);

  return {
    aggregate: aggregate,
    by_site:   bySite,
    by_meter:  byMeter,
    by_type:   byType,
    summary:   summary,
  };
}


/**
 * Merge amount series + units series เป็น combined array
 * @private
 */
function _mergeAmountAndUnits(amountSeries, unitsSeries) {
  // build lookup by period_key
  var unitsMap = {};
  unitsSeries.forEach(function(p) { unitsMap[p.period_key] = p; });

  return amountSeries.map(function(ap) {
    var up = unitsMap[ap.period_key] || {};
    return {
      period_key:   ap.period_key,
      year:         ap.year,
      month:        ap.month,
      amount_total: ap.value,
      units_used:   up.value   || 0,
      mom_abs_amt:  ap.mom_abs,
      mom_pct_amt:  ap.mom_pct,
      mom_abs_units: up.mom_abs || null,
      mom_pct_units: up.mom_pct || null,
      has_gap:      ap.has_gap || false,
    };
  });
}


/**
 * สร้าง summary stats สำหรับ MoM series
 * @private
 */
function _buildMoMSummary(series, pcts) {
  if (!pcts || pcts.length === 0) {
    return { biggest_increase: null, biggest_decrease: null, avg_mom_pct: null, trend_direction: 'STABLE' };
  }

  var maxPct  = Math.max.apply(null, pcts);
  var minPct  = Math.min.apply(null, pcts);
  var avgPct  = tcMean(pcts);

  var biggestIncrease = series.find(function(p) { return p.mom_pct_amt === maxPct; }) || null;
  var biggestDecrease = series.find(function(p) { return p.mom_pct_amt === minPct; }) || null;

  // คำนวณ trend direction จาก regression ของ amount_total
  var amounts  = series.map(function(p) { return p.amount_total; });
  var reg      = tcLinearRegression(amounts);
  var direction = tcSlopeToTrendLabel(reg.slope);

  return {
    biggest_increase:  biggestIncrease ? { period_key: biggestIncrease.period_key, mom_pct: maxPct } : null,
    biggest_decrease:  biggestDecrease ? { period_key: biggestDecrease.period_key, mom_pct: minPct } : null,
    avg_mom_pct:       avgPct !== null ? parseFloat(avgPct.toFixed(2)) : null,
    trend_direction:   direction,
    regression:        reg,
  };
}


// ============================================================
// SECTION 4 — YEAR-OVER-YEAR COMPARISON
// ============================================================

/**
 * คำนวณ YoY comparison ครบถ้วน
 *
 * Output:
 * {
 *   monthly_breakdown: [ { month, year_a, year_b, value_a, value_b, yoy_abs, yoy_pct }, x12 ]
 *   annual_summary:    [ { year, total, count, yoy_abs, yoy_pct }, ... ]
 *   by_type:           { ELECTRICITY: {...}, WATER: {...} }
 *   by_site:           { site_id: { monthly_breakdown, annual_summary } }
 *   summary:           { best_month, worst_month, total_yoy_pct, avg_yoy_pct }
 * }
 * @private
 */
function _runYoYComparison(ctx) {
  var bills     = ctx.bills;
  var yearA     = ctx.yearA;
  var yearB     = ctx.yearB;
  var meterMap  = ctx.meterMap;

  // ---- Aggregate: ทุก site รวมกัน ----
  var aggAmtMap  = tcBuildTimeSeriesMap(bills, 'amount_total');
  var aggUnitMap = tcBuildTimeSeriesMap(bills, 'units_used');

  var monthlyAmt   = tcYoYComparison(aggAmtMap,  yearA, yearB);
  var monthlyUnits = tcYoYComparison(aggUnitMap, yearA, yearB);

  // Merge amount + units
  var monthlyBreakdown = monthlyAmt.map(function(ma, i) {
    var mu = monthlyUnits[i] || {};
    return Object.assign({}, ma, {
      units_a:     mu.value_a,
      units_b:     mu.value_b,
      yoy_abs_units: mu.yoy_abs,
      yoy_pct_units: mu.yoy_pct,
    });
  });

  // ---- Annual Summary ----
  var availableYears = tcGetAvailableYears(bills);
  var annualSummary  = tcYoYAnnualSummary(aggAmtMap, availableYears);

  // ---- By Meter Type ----
  var byType = {};
  ['ELECTRICITY', 'WATER'].forEach(function(mt) {
    var typeBills    = tcFilterByMeterType(bills, mt, meterMap);
    var typeAmtMap   = tcBuildTimeSeriesMap(typeBills, 'amount_total');
    var typeUnitMap  = tcBuildTimeSeriesMap(typeBills, 'units_used');
    byType[mt] = {
      monthly_breakdown: tcYoYComparison(typeAmtMap, yearA, yearB),
      annual_summary:    tcYoYAnnualSummary(typeAmtMap, availableYears),
      units_breakdown:   tcYoYComparison(typeUnitMap, yearA, yearB),
    };
  });

  // ---- By Site (top-level summary per site, ไม่ลงลึกทุก site เพื่อประสิทธิภาพ) ----
  var bySite = {};
  var siteGroups = tcGroupBySite(bills);
  Object.keys(siteGroups).forEach(function(siteId) {
    var siteBills   = siteGroups[siteId];
    var siteAmtMap  = tcBuildTimeSeriesMap(siteBills, 'amount_total');
    bySite[siteId] = {
      monthly_breakdown: tcYoYComparison(siteAmtMap, yearA, yearB),
      annual_summary:    tcYoYAnnualSummary(siteAmtMap, availableYears),
    };
  });

  // ---- Summary Stats ----
  var validPcts  = monthlyBreakdown.filter(function(m) { return m.yoy_pct !== null; });
  var pctValues  = validPcts.map(function(m) { return m.yoy_pct; });
  var bestMonth  = validPcts.length > 0 ? validPcts.reduce(function(a, b) { return a.yoy_pct < b.yoy_pct ? a : b; }) : null;
  var worstMonth = validPcts.length > 0 ? validPcts.reduce(function(a, b) { return a.yoy_pct > b.yoy_pct ? a : b; }) : null;

  var totalA = annualSummary.find(function(a) { return a.year === yearA; });
  var totalB = annualSummary.find(function(a) { return a.year === yearB; });
  var totalYoYPct = totalA && totalB ? tcPctChange(totalA.total, totalB.total) : null;

  return {
    monthly_breakdown: monthlyBreakdown,
    annual_summary:    annualSummary,
    by_type:           byType,
    by_site:           bySite,
    summary: {
      year_a:         yearA,
      year_b:         yearB,
      best_month:     bestMonth  ? { month: bestMonth.month,  yoy_pct: bestMonth.yoy_pct }  : null,
      worst_month:    worstMonth ? { month: worstMonth.month, yoy_pct: worstMonth.yoy_pct } : null,
      total_yoy_pct:  totalYoYPct,
      avg_yoy_pct:    pctValues.length > 0 ? parseFloat(tcMean(pctValues).toFixed(2)) : null,
    },
  };
}


// ============================================================
// SECTION 5 — ROLLING AVERAGE ANALYSIS
// ============================================================

/**
 * คำนวณ Rolling Average สำหรับ amount_total และ units_used
 * รองรับ multiple window sizes (3, 6, 12 เดือน)
 *
 * Output:
 * {
 *   periods:    [ period_key, ... ]                           — timeline labels
 *   amounts:    { raw: [], ra3: [], ra6: [], ra12: [] }       — บาท
 *   units:      { raw: [], ra3: [], ra6: [], ra12: [] }       — หน่วย
 *   by_type:    { ELECTRICITY: {...}, WATER: {...} }
 *   by_site:    { site_id: { periods, amounts, units } }
 *   trend_info: { slope, direction, r2 }
 * }
 * @private
 */
function _runRollingAverages(ctx) {
  var bills    = ctx.bills;
  var meterMap = ctx.meterMap;
  var windows  = ctx.options.rolling_windows || [3, 6, 12];

  // ---- Aggregate ----
  var aggAmt   = tcBuildTimeSeriesMap(bills, 'amount_total');
  var aggUnits = tcBuildTimeSeriesMap(bills, 'units_used');

  var aggAmtArr   = tcTimeSeriesMapToArray(aggAmt);
  var aggUnitsArr = tcTimeSeriesMapToArray(aggUnits);

  var periods     = aggAmtArr.map(function(p) { return p.period_key; });
  var rawAmounts  = aggAmtArr.map(function(p) { return p.value; });
  var rawUnits    = aggUnitsArr.map(function(p) { return p.value; });

  var raAmounts = tcMultiRollingAverage(rawAmounts, windows);
  var raUnits   = tcMultiRollingAverage(rawUnits,   windows);

  // ---- Build standard output for a bills subset ----
  function _buildRASeries(billsSubset) {
    var amtMap    = tcBuildTimeSeriesMap(billsSubset, 'amount_total');
    var unitMap   = tcBuildTimeSeriesMap(billsSubset, 'units_used');
    var amtArr    = tcTimeSeriesMapToArray(amtMap);
    var unitArr   = tcTimeSeriesMapToArray(unitMap);
    var rawAmt    = amtArr.map(function(p) { return p.value; });
    var rawUnt    = unitArr.map(function(p) { return p.value; });
    var raAmt     = tcMultiRollingAverage(rawAmt,  windows);
    var raUnt     = tcMultiRollingAverage(rawUnt,  windows);
    var reg       = tcLinearRegression(rawAmt);

    var amountResult = { raw: rawAmt };
    var unitsResult  = { raw: rawUnt };
    windows.forEach(function(w) {
      amountResult['ra' + w] = raAmt[w];
      unitsResult['ra'  + w] = raUnt[w];
    });

    return {
      periods:    amtArr.map(function(p) { return p.period_key; }),
      amounts:    amountResult,
      units:      unitsResult,
      trend_info: { slope: reg.slope, direction: tcSlopeToTrendLabel(reg.slope), r2: reg.r2 },
    };
  }

  // ---- By Meter Type ----
  var byType = {};
  ['ELECTRICITY', 'WATER'].forEach(function(mt) {
    var typeBills = tcFilterByMeterType(bills, mt, meterMap);
    if (typeBills.length > 0) {
      byType[mt] = _buildRASeries(typeBills);
    }
  });

  // ---- By Site ----
  var bySite = {};
  var siteGroups = tcGroupBySite(bills);
  Object.keys(siteGroups).forEach(function(siteId) {
    bySite[siteId] = _buildRASeries(siteGroups[siteId]);
  });

  // ---- Aggregate trend info ----
  var regAgg   = tcLinearRegression(rawAmounts);
  var amtResult = { raw: rawAmounts };
  var untResult = { raw: rawUnits };
  windows.forEach(function(w) {
    amtResult['ra' + w] = raAmounts[w];
    untResult['ra' + w] = raUnits[w];
  });

  return {
    periods:    periods,
    amounts:    amtResult,
    units:      untResult,
    by_type:    byType,
    by_site:    bySite,
    trend_info: { slope: regAgg.slope, direction: tcSlopeToTrendLabel(regAgg.slope), r2: regAgg.r2 },
    windows_used: windows,
  };
}


// ============================================================
// SECTION 6 — CONSUMPTION TREND CALCULATION
// ============================================================

/**
 * วิเคราะห์แนวโน้มการใช้พลังงาน (units_used)
 *
 * Output:
 * {
 *   aggregate: {
 *     series:          [ { period_key, year, month, units_used, mom_pct, ra3, ra6, ra12 } ]
 *     regression:      { slope, intercept, r2, direction }
 *     peak:            { period_key, units_used }
 *     trough:          { period_key, units_used }
 *     avg_units:       number
 *     std_dev:         number
 *   }
 *   by_type:   { ELECTRICITY: {...}, WATER: {...} }
 *   by_site:   { site_id: { series, regression, avg_units } }
 *   by_meter:  { meter_id: { series, regression, avg_units, cost_per_unit_trend } }
 * }
 * @private
 */
function _runConsumptionTrend(ctx) {
  var bills    = ctx.bills;
  var meterMap = ctx.meterMap;

  function _analyzeConsumption(billsSubset) {
    var unitsMap    = tcBuildTimeSeriesMap(billsSubset, 'units_used');
    var sorted      = tcTimeSeriesMapToArray(unitsMap);
    var rawUnits    = sorted.map(function(p) { return p.value; });

    var withMoM     = tcMoMChangeSeries(sorted, 'value');
    var raAll       = tcMultiRollingAverage(rawUnits, [3, 6, 12]);
    var reg         = tcLinearRegression(rawUnits);
    var avgUnits    = tcMean(rawUnits);
    var stdDev      = tcStdDev(rawUnits);

    // หา peak และ trough
    var peakPt   = sorted.reduce(function(a, b) { return (b.value > a.value) ? b : a; }, sorted[0] || {});
    var troughPt = sorted.reduce(function(a, b) { return (b.value < a.value) ? b : a; }, sorted[0] || {});

    // Combine series พร้อม rolling averages
    var series = withMoM.map(function(p, i) {
      return {
        period_key: p.period_key,
        year:       p.year,
        month:      p.month,
        units_used: p.value,
        mom_abs:    p.mom_abs,
        mom_pct:    p.mom_pct,
        ra3:        raAll[3]  ? raAll[3][i]  : null,
        ra6:        raAll[6]  ? raAll[6][i]  : null,
        ra12:       raAll[12] ? raAll[12][i] : null,
      };
    });

    return {
      series:      series,
      regression:  Object.assign({}, reg, { direction: tcSlopeToTrendLabel(reg.slope) }),
      peak:        peakPt   ? { period_key: peakPt.period_key,   units_used: peakPt.value   } : null,
      trough:      troughPt ? { period_key: troughPt.period_key, units_used: troughPt.value } : null,
      avg_units:   avgUnits !== null ? parseFloat(avgUnits.toFixed(2)) : null,
      std_dev:     stdDev,
      data_points: rawUnits.length,
    };
  }

  // ---- Aggregate ----
  var aggregate = _analyzeConsumption(bills);

  // ---- By Type ----
  var byType = {};
  ['ELECTRICITY', 'WATER'].forEach(function(mt) {
    var typeBills = tcFilterByMeterType(bills, mt, meterMap);
    if (typeBills.length > 0) {
      byType[mt] = _analyzeConsumption(typeBills);
    }
  });

  // ---- By Site ----
  var bySite = {};
  var siteGroups = tcGroupBySite(bills);
  Object.keys(siteGroups).forEach(function(siteId) {
    bySite[siteId] = _analyzeConsumption(siteGroups[siteId]);
  });

  // ---- By Meter (เพิ่ม cost_per_unit trend) ----
  var byMeter = {};
  var meterGroups = tcGroupByMeter(bills);
  Object.keys(meterGroups).forEach(function(meterId) {
    var mBills   = meterGroups[meterId];
    var mResult  = _analyzeConsumption(mBills);

    // คำนวณ cost per unit trend
    var cpuSeries = mBills.map(function(b) {
      return {
        period_key: b.bill_period_key || tcMakePeriodKey(b.bill_year, b.bill_month),
        cpu:        tcCostPerUnit(b),
      };
    }).sort(function(a, b) { return a.period_key < b.period_key ? -1 : 1; });

    var cpuValues = cpuSeries.map(function(p) { return p.cpu; });
    var cpuReg    = tcLinearRegression(cpuValues.filter(function(v) { return v !== null; }));

    mResult.cost_per_unit_series = cpuSeries;
    mResult.cost_per_unit_trend  = Object.assign({}, cpuReg, {
      direction: tcSlopeToTrendLabel(cpuReg.slope),
      avg:       tcAvgCostPerUnit(mBills),
    });

    byMeter[meterId] = mResult;
  });

  return {
    aggregate: aggregate,
    by_type:   byType,
    by_site:   bySite,
    by_meter:  byMeter,
  };
}


// ============================================================
// SECTION 7 — COST TREND ANALYSIS
// ============================================================

/**
 * วิเคราะห์แนวโน้มค่าใช้จ่าย (amount_total)
 * รวมถึง cost breakdown, cost efficiency, และ anomaly detection
 *
 * Output:
 * {
 *   aggregate: {
 *     series:       [ { period_key, amount_total, mom_pct, ra3, ra6, ra12 } ]
 *     regression:   { slope, direction, r2 }
 *     total_annual: { year: total_amount }
 *     peak:         { period_key, amount_total }
 *     avg_monthly:  number
 *   }
 *   by_type:   { ELECTRICITY: {...}, WATER: {...} }
 *   by_site:   { site_id: { series, regression, share_pct } }
 *   efficiency: { cost_per_unit_trend, avg_cost_per_unit, sites_ranked_by_efficiency }
 * }
 * @private
 */
function _runCostTrend(ctx) {
  var bills    = ctx.bills;
  var meterMap = ctx.meterMap;
  var siteMap  = ctx.siteMap;

  function _analyzeCost(billsSubset) {
    var amtMap   = tcBuildTimeSeriesMap(billsSubset, 'amount_total');
    var sorted   = tcTimeSeriesMapToArray(amtMap);
    var rawAmts  = sorted.map(function(p) { return p.value; });

    var withMoM  = tcMoMChangeSeries(sorted, 'value');
    var raAll    = tcMultiRollingAverage(rawAmts, [3, 6, 12]);
    var reg      = tcLinearRegression(rawAmts);
    var avgAmt   = tcMean(rawAmts);

    var peakPt   = sorted.reduce(function(a, b) { return (b.value > a.value) ? b : a; }, sorted[0] || {});

    var series = withMoM.map(function(p, i) {
      return {
        period_key:   p.period_key,
        year:         p.year,
        month:        p.month,
        amount_total: p.value,
        mom_abs:      p.mom_abs,
        mom_pct:      p.mom_pct,
        ra3:          raAll[3]  ? raAll[3][i]  : null,
        ra6:          raAll[6]  ? raAll[6][i]  : null,
        ra12:         raAll[12] ? raAll[12][i] : null,
      };
    });

    // Annual totals
    var totalAnnual = {};
    sorted.forEach(function(p) {
      if (!totalAnnual[p.year]) totalAnnual[p.year] = 0;
      totalAnnual[p.year] += p.value;
    });

    return {
      series:       series,
      regression:   Object.assign({}, reg, { direction: tcSlopeToTrendLabel(reg.slope) }),
      total_annual: totalAnnual,
      peak:         peakPt ? { period_key: peakPt.period_key, amount_total: peakPt.value } : null,
      avg_monthly:  avgAmt !== null ? parseFloat(avgAmt.toFixed(2)) : null,
      data_points:  rawAmts.length,
    };
  }

  // ---- Aggregate ----
  var aggregate = _analyzeCost(bills);

  // ---- By Type ----
  var byType = {};
  ['ELECTRICITY', 'WATER'].forEach(function(mt) {
    var typeBills = tcFilterByMeterType(bills, mt, meterMap);
    if (typeBills.length > 0) {
      byType[mt] = _analyzeCost(typeBills);
    }
  });

  // ---- By Site (พร้อม share %) ----
  var grandTotal = aggregate.series.reduce(function(s, p) { return s + (p.amount_total || 0); }, 0);
  var bySite = {};
  var siteGroups = tcGroupBySite(bills);
  Object.keys(siteGroups).forEach(function(siteId) {
    var siteResult = _analyzeCost(siteGroups[siteId]);
    var siteTotal  = Object.values(siteResult.total_annual).reduce(function(s, v) { return s + v; }, 0);
    siteResult.share_pct = grandTotal > 0 ? parseFloat(((siteTotal / grandTotal) * 100).toFixed(2)) : 0;
    bySite[siteId] = siteResult;
  });

  // ---- Efficiency Analysis ----
  var efficiency = _buildEfficiencyAnalysis(bills, siteGroups, siteMap, meterMap);

  return {
    aggregate:  aggregate,
    by_type:    byType,
    by_site:    bySite,
    efficiency: efficiency,
  };
}


/**
 * คำนวณ cost efficiency metrics
 * @private
 */
function _buildEfficiencyAnalysis(bills, siteGroups, siteMap, meterMap) {
  // ---- Global cost per unit trend (across all valid bills) ----
  var sortedBills = tcSortByPeriod(bills);
  var cpuByPeriod = {};
  sortedBills.forEach(function(b) {
    var key = b.bill_period_key || tcMakePeriodKey(b.bill_year, b.bill_month);
    if (!cpuByPeriod[key]) cpuByPeriod[key] = { totalUnits: 0, totalAmount: 0 };
    cpuByPeriod[key].totalUnits  += parseFloat(b.units_used   || 0);
    cpuByPeriod[key].totalAmount += parseFloat(b.amount_total || 0);
  });

  var cpuSeries = Object.keys(cpuByPeriod).sort().map(function(key) {
    var d   = cpuByPeriod[key];
    var cpu = d.totalUnits > 0 ? parseFloat((d.totalAmount / d.totalUnits).toFixed(4)) : null;
    return { period_key: key, cost_per_unit: cpu };
  });

  var cpuValues = cpuSeries.map(function(p) { return p.cost_per_unit; });
  var cpuReg    = tcLinearRegression(cpuValues.filter(function(v) { return v !== null; }));

  // ---- Sites ranked by avg cost per unit ----
  var siteEfficiency = Object.keys(siteGroups).map(function(siteId) {
    var siteBills  = siteGroups[siteId];
    var avgCpu     = tcAvgCostPerUnit(siteBills);
    var totalAmt   = siteBills.reduce(function(s, b) { return s + parseFloat(b.amount_total || 0); }, 0);
    var totalUnits = siteBills.reduce(function(s, b) { return s + parseFloat(b.units_used   || 0); }, 0);
    var site       = siteMap[siteId] || {};

    return {
      site_id:        siteId,
      site_name:      site.site_name || siteId,
      avg_cost_per_unit: avgCpu,
      total_amount:   parseFloat(totalAmt.toFixed(2)),
      total_units:    parseFloat(totalUnits.toFixed(2)),
      bill_count:     siteBills.length,
    };
  }).filter(function(s) { return s.avg_cost_per_unit !== null; })
    .sort(function(a, b) { return a.avg_cost_per_unit - b.avg_cost_per_unit; }); // เรียงจาก efficient สุด

  return {
    cost_per_unit_series: cpuSeries,
    cost_per_unit_trend:  Object.assign({}, cpuReg, {
      direction:         tcSlopeToTrendLabel(cpuReg.slope),
      avg_cost_per_unit: tcMean(cpuValues.filter(function(v) { return v !== null; })),
    }),
    sites_ranked_by_efficiency: siteEfficiency,
  };
}


// ============================================================
// SECTION 8 — SITE PERFORMANCE ANALYSIS
// ============================================================

/**
 * วิเคราะห์ประสิทธิภาพรายสถานที่
 * คำนวณ composite score จากหลายมิติ
 *
 * Output:
 * {
 *   sites: [
 *     {
 *       site_id, site_name, site_type,
 *       total_amount,  total_units,
 *       avg_monthly_amount, avg_monthly_units,
 *       cost_per_unit,
 *       trend_direction_amount,  trend_direction_units,
 *       mom_pct_last,            — MoM เดือนล่าสุด
 *       yoy_pct,                 — YoY เทียบปีก่อน
 *       meter_count,
 *       performance_score,       — composite 0-100
 *       performance_grade,       — A/B/C/D/F
 *     }
 *   ]
 *   ranked_by_spend:       site_id[]  — เรียงค่าใช้จ่ายสูง→ต่ำ
 *   ranked_by_efficiency:  site_id[]  — เรียงตาม cost/unit ต่ำ→สูง
 *   ranked_by_trend:       site_id[]  — เรียงจาก trend ดีขึ้นมากสุด
 *   summary: { best_performer, worst_performer, avg_site_amount }
 * }
 * @private
 */
function _runSitePerformance(ctx) {
  var bills    = ctx.bills;
  var yearA    = ctx.yearA;
  var yearB    = ctx.yearB;
  var siteMap  = ctx.siteMap;
  var meterMap = ctx.meterMap;

  var siteGroups = tcGroupBySite(bills);
  var siteIds    = Object.keys(siteGroups);

  // ---- คำนวณ metrics ต่อ site ----
  var siteMetrics = siteIds.map(function(siteId) {
    var siteBills = siteGroups[siteId];
    var site      = siteMap[siteId] || {};

    // Totals
    var totalAmt   = siteBills.reduce(function(s, b) { return s + parseFloat(b.amount_total || 0); }, 0);
    var totalUnits = siteBills.reduce(function(s, b) { return s + parseFloat(b.units_used   || 0); }, 0);

    // Monthly averages
    var amtMap    = tcBuildTimeSeriesMap(siteBills, 'amount_total');
    var unitMap   = tcBuildTimeSeriesMap(siteBills, 'units_used');
    var amtArr    = tcTimeSeriesMapToArray(amtMap);
    var unitArr   = tcTimeSeriesMapToArray(unitMap);

    var amtValues  = amtArr.map(function(p) { return p.value; });
    var unitValues = unitArr.map(function(p) { return p.value; });

    var avgMonthlyAmt   = tcMean(amtValues);
    var avgMonthlyUnits = tcMean(unitValues);
    var costPerUnit     = tcAvgCostPerUnit(siteBills);

    // Regression
    var amtReg   = tcLinearRegression(amtValues);
    var unitReg  = tcLinearRegression(unitValues);

    // MoM last period
    var amtMoM  = tcMoMChangeSeries(amtArr, 'value');
    var lastMoM = amtMoM.length > 0 ? amtMoM[amtMoM.length - 1].mom_pct : null;

    // YoY (ปีล่าสุดเทียบปีก่อน)
    var yoyData    = tcYoYComparison(amtMap, yearA, yearB);
    var yoyAnnual  = tcYoYAnnualSummary(amtMap, [yearA, yearB]);
    var yoyPct     = yoyAnnual.length > 0 ? yoyAnnual[0].yoy_pct : null;

    // นับมิเตอร์
    var meterIds = {};
    siteBills.forEach(function(b) { meterIds[b.meter_id] = true; });
    var meterCount = Object.keys(meterIds).length;

    // ---- Composite Performance Score (0-100) ----
    // คิดจาก: trend direction (ลดลง = ดี), MoM change, YoY change, cost efficiency
    var score = _calcPerformanceScore({
      trendSlope:  amtReg.slope,
      momPctLast:  lastMoM,
      yoyPct:      yoyPct,
      costPerUnit: costPerUnit,
      avgCpu:      null, // จะ fill หลัง normalize
    });

    return {
      site_id:                siteId,
      site_name:              site.site_name   || siteId,
      site_type:              site.site_type   || '',
      province:               site.province    || '',
      total_amount:           parseFloat(totalAmt.toFixed(2)),
      total_units:            parseFloat(totalUnits.toFixed(2)),
      avg_monthly_amount:     avgMonthlyAmt  !== null ? parseFloat(avgMonthlyAmt.toFixed(2))  : null,
      avg_monthly_units:      avgMonthlyUnits !== null ? parseFloat(avgMonthlyUnits.toFixed(2)) : null,
      cost_per_unit:          costPerUnit,
      trend_direction_amount: tcSlopeToTrendLabel(amtReg.slope),
      trend_direction_units:  tcSlopeToTrendLabel(unitReg.slope),
      trend_slope_amount:     amtReg.slope,
      trend_r2_amount:        amtReg.r2,
      mom_pct_last:           lastMoM,
      yoy_pct:                yoyPct,
      meter_count:            meterCount,
      bill_count:             siteBills.length,
      _raw_score:             score,           // ชั่วคราว สำหรับ normalize
    };
  });

  // ---- Normalize scores → 0-100 ----
  // (raw score เป็น relative ต้องเทียบกับ site อื่น)
  var scores     = siteMetrics.map(function(s) { return s._raw_score; });
  var minScore   = Math.min.apply(null, scores);
  var maxScore   = Math.max.apply(null, scores);
  var scoreRange = maxScore - minScore;

  siteMetrics.forEach(function(s) {
    var normalized = scoreRange > 0
      ? Math.round(((s._raw_score - minScore) / scoreRange) * 100)
      : 50;
    s.performance_score = tcClamp(normalized, 0, 100);
    s.performance_grade = _scoreToGrade(s.performance_score);
    delete s._raw_score;
  });

  // ---- Rankings ----
  var rankedBySpend = siteMetrics.slice()
    .sort(function(a, b) { return b.total_amount - a.total_amount; })
    .map(function(s) { return s.site_id; });

  var rankedByEfficiency = siteMetrics.slice()
    .filter(function(s) { return s.cost_per_unit !== null; })
    .sort(function(a, b) { return a.cost_per_unit - b.cost_per_unit; })
    .map(function(s) { return s.site_id; });

  var rankedByTrend = siteMetrics.slice()
    .sort(function(a, b) { return a.trend_slope_amount - b.trend_slope_amount; })  // slope เล็ก = ค่าลด = ดี
    .map(function(s) { return s.site_id; });

  // ---- Summary ----
  var sortedByScore = siteMetrics.slice().sort(function(a, b) { return b.performance_score - a.performance_score; });
  var avgSiteAmt    = tcMean(siteMetrics.map(function(s) { return s.avg_monthly_amount; }));

  return {
    sites:                  siteMetrics,
    ranked_by_spend:        rankedBySpend,
    ranked_by_efficiency:   rankedByEfficiency,
    ranked_by_trend:        rankedByTrend,
    summary: {
      best_performer:   sortedByScore.length > 0 ? { site_id: sortedByScore[0].site_id, score: sortedByScore[0].performance_score } : null,
      worst_performer:  sortedByScore.length > 1 ? { site_id: sortedByScore[sortedByScore.length - 1].site_id, score: sortedByScore[sortedByScore.length - 1].performance_score } : null,
      avg_site_amount:  avgSiteAmt !== null ? parseFloat(avgSiteAmt.toFixed(2)) : null,
      total_sites:      siteMetrics.length,
    },
  };
}


/**
 * คำนวณ raw performance score สำหรับ site
 * สูงกว่า = ดีกว่า (ค่าใช้จ่ายมีแนวโน้มลดลง)
 * @private
 */
function _calcPerformanceScore(metrics) {
  var score = 50; // baseline

  // Trend ลดลง → ดี (+), ขึ้น → แย่ (-)
  if (metrics.trendSlope !== null && !isNaN(metrics.trendSlope)) {
    score -= metrics.trendSlope * 10; // slope ลบ (ลดลง) → score เพิ่ม
  }

  // MoM: ลดลง → ดี
  if (metrics.momPctLast !== null) {
    score -= metrics.momPctLast * 0.5;
  }

  // YoY: ลดลง → ดี
  if (metrics.yoyPct !== null) {
    score -= metrics.yoyPct * 0.3;
  }

  return score;
}


/**
 * แปลง score (0-100) เป็น grade
 * @private
 */
function _scoreToGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}


// ============================================================
// SECTION 9 — OPTIONS NORMALIZER
// ============================================================

/**
 * Normalize และ validate options object
 * @private
 */
function _normalizeOptions(options) {
  options = options || {};
  return {
    site_id:         options.site_id   || null,
    meter_type:      (options.meter_type || 'ALL').toUpperCase(),
    year_a:          options.year_a    ? parseInt(options.year_a, 10)  : null,
    year_b:          options.year_b    ? parseInt(options.year_b, 10)  : null,
    rolling_windows: options.rolling_windows || [3, 6, 12],
  };
}


// ============================================================
// SECTION 10 — TRIGGER-CALLABLE WRAPPER
// (เรียกจาก Triggers.gs ทุกต้นเดือน)
// ============================================================

/**
 * Generate และ cache trend analysis ลง MonthlySummary sheet
 * เรียกโดย Time-driven trigger ต้นเดือน
 * ไม่ต้องการ token (เป็น server-side automation)
 *
 * Trigger setup ใน Triggers.gs:
 *   ScriptApp.newTrigger('generateTrendSummary')
 *     .timeBased().onMonthDay(3).atHour(7).create();
 */
function generateTrendSummary() {
  try {
    Logger.log('[TrendAnalyzer] generateTrendSummary START');

    var ss     = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var data   = tcLoadAllData(ss);
    var bills  = tcFilterValidBills(data.bills);

    if (bills.length === 0) {
      Logger.log('[TrendAnalyzer] ไม่มีข้อมูล bill — ข้ามการสร้าง trend summary');
      return;
    }

    // ใช้ admin token bypass สำหรับ server trigger
    var fakeCtx = _buildTriggerContext(bills, data.meters, data.sites);

    // Run all trend analyses
    var trends  = {
      monthly:         _runMonthlyComparison(fakeCtx),
      yoy:             _runYoYComparison(fakeCtx),
      rolling:         _runRollingAverages(fakeCtx),
      consumption:     _runConsumptionTrend(fakeCtx),
      cost:            _runCostTrend(fakeCtx),
      sitePerformance: _runSitePerformance(fakeCtx),
    };

    // บันทึก summary key metrics ลง MonthlySummary sheet
    _saveTrendSummaryToSheet(ss, trends, fakeCtx);

    Logger.log('[TrendAnalyzer] generateTrendSummary DONE');

  } catch (e) {
    Logger.log('[TrendAnalyzer] generateTrendSummary ERROR: ' + e.message);
    // ไม่ throw เพื่อให้ trigger ไม่หยุด
  }
}


/**
 * สร้าง context สำหรับ trigger (ไม่มี auth token)
 * @private
 */
function _buildTriggerContext(bills, meters, sites) {
  var meterMap       = tcBuildMeterMap(meters);
  var siteMap        = tcBuildSiteMap(sites);
  var availableYears = tcGetAvailableYears(bills);
  var yearA          = availableYears[0] || (new Date().getFullYear() + 543);
  var yearB          = availableYears[1] || yearA - 1;

  return {
    bills:    bills,
    meters:   meters,
    sites:    sites,
    meterMap: meterMap,
    siteMap:  siteMap,
    yearA:    yearA,
    yearB:    yearB,
    options:  _normalizeOptions({}),
  };
}


/**
 * บันทึก key trend metrics ลง MonthlySummary sheet
 * Format: 1 row per site per month สำหรับ Looker Studio compatibility
 * @private
 */
function _saveTrendSummaryToSheet(ss, trends, ctx) {
  var sheet      = ss.getSheetByName(CONFIG.SHEETS.MONTHLY_SUMMARY);
  if (!sheet) {
    Logger.log('[TrendAnalyzer] ไม่พบ sheet MonthlySummary');
    return;
  }

  var now      = new Date().toISOString();
  var newRows  = [];

  // บันทึก site performance ลง MonthlySummary
  var sites = trends.sitePerformance.sites || [];
  sites.forEach(function(site) {
    var siteMonthly = (trends.monthly.by_site[site.site_id] || []);
    var lastPeriod  = siteMonthly.length > 0 ? siteMonthly[siteMonthly.length - 1] : {};

    newRows.push([
      now,                            // generated_at
      site.site_id,                   // site_id
      site.site_name,                 // site_name
      ctx.yearA,                      // analysis_year
      site.total_amount,              // total_amount_ytd
      site.total_units,               // total_units_ytd
      site.avg_monthly_amount,        // avg_monthly_amount
      site.avg_monthly_units,         // avg_monthly_units
      site.cost_per_unit,             // avg_cost_per_unit
      site.trend_direction_amount,    // trend_direction
      site.mom_pct_last,              // latest_mom_pct
      site.yoy_pct,                   // yoy_pct
      site.performance_score,         // performance_score
      site.performance_grade,         // performance_grade
      site.meter_count,               // meter_count
      site.bill_count,                // bill_count
    ]);
  });

  if (newRows.length === 0) return;

  // Append rows (batch write ครั้งเดียว — ไม่ loop appendRow)
  var lastRow  = sheet.getLastRow();
  var startRow = lastRow + 1;
  sheet.getRange(startRow, 1, newRows.length, newRows[0].length)
       .setValues(newRows);

  Logger.log('[TrendAnalyzer] บันทึก ' + newRows.length + ' rows ลง MonthlySummary');
}
