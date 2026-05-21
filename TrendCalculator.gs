// ============================================================
// TrendCalculator.gs — Core Trend Calculation Engine
// UtilityManager | PHASE 5A — Trend Analysis Engine
// ============================================================
// รับผิดชอบ:
//   - คำนวณ Rolling Average (3, 6, 12 เดือน)
//   - Month-over-Month (MoM) change
//   - Year-over-Year (YoY) change
//   - Linear regression / slope สำหรับ trend direction
//   - Aggregate bills per site / per meter / per meter_type
//   - Utility helpers สำหรับ TrendAnalyzer.gs
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs
// ใช้งาน: เรียกจาก TrendAnalyzer.gs เท่านั้น
// ============================================================


// ============================================================
// SECTION 1 — CONSTANTS & CONFIGURATION
// ============================================================

/**
 * ค่า default สำหรับ rolling window sizes
 * สามารถ override ได้ผ่าน options ใน public functions
 */
const TREND_CALC_CONFIG = {
  ROLLING_WINDOWS:    [3, 6, 12],   // เดือนสำหรับ rolling average
  MIN_DATA_POINTS:    2,            // จำนวน data point ขั้นต่ำก่อนคำนวณ trend
  MIN_ROLLING_FILL:   0,            // ใช้ 0 แทน null เมื่อข้อมูลไม่ครบ window
  DECIMAL_PLACES:     2,            // ทศนิยมสำหรับ % change
  COST_PER_UNIT_ELEC: null,         // null = คำนวณจากข้อมูลจริง (amount_total / units_used)
  COST_PER_UNIT_WATER: null,        // null = คำนวณจากข้อมูลจริง
};

/**
 * ประเภทมิเตอร์ที่รองรับ
 */
const METER_TYPES = {
  ELECTRICITY: 'ELECTRICITY',
  WATER:       'WATER',
  ALL:         'ALL',   // รวมทุกประเภท
};


// ============================================================
// SECTION 2 — DATA PREPARATION HELPERS
// ============================================================

/**
 * สร้าง period key จากปีและเดือน (พ.ศ.)
 * Format: "2568-06"  — ใช้ lexicographic sort ได้ถูกต้อง
 *
 * @param {number|string} year   — พ.ศ.
 * @param {number|string} month
 * @returns {string}
 */
function tcMakePeriodKey(year, month) {
  return String(year) + '-' + String(month).padStart(2, '0');
}


/**
 * แปลง period key กลับเป็น { year, month }
 *
 * @param {string} key  — "2568-06"
 * @returns {{ year: number, month: number }}
 */
function tcParsePeriodKey(key) {
  const parts = String(key).split('-');
  return {
    year:  parseInt(parts[0], 10),
    month: parseInt(parts[1], 10),
  };
}


/**
 * เรียง array ของ bill objects ตาม period_key (น้อย→มาก = เก่า→ใหม่)
 *
 * @param {Object[]} bills
 * @returns {Object[]}  — sorted copy (ไม่ mutate ต้นฉบับ)
 */
function tcSortByPeriod(bills) {
  return bills.slice().sort(function(a, b) {
    const ka = a.bill_period_key || tcMakePeriodKey(a.bill_year, a.bill_month);
    const kb = b.bill_period_key || tcMakePeriodKey(b.bill_year, b.bill_month);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}


/**
 * แปลง bill rows เป็น time-series map เพื่อให้ lookup O(1)
 * Key = period_key, Value = aggregated record
 *
 * @param {Object[]} bills   — sorted หรือ unsorted ได้
 * @param {string}   field   — 'amount_total' | 'units_used' | ...
 * @returns {Object}  — { "2568-01": { period_key, value, count }, ... }
 */
function tcBuildTimeSeriesMap(bills, field) {
  var map = {};
  bills.forEach(function(b) {
    var key = b.bill_period_key || tcMakePeriodKey(b.bill_year, b.bill_month);
    if (!map[key]) {
      map[key] = {
        period_key: key,
        year:       parseInt(b.bill_year,  10),
        month:      parseInt(b.bill_month, 10),
        value:      0,
        count:      0,
      };
    }
    var raw = parseFloat(b[field]);
    if (!isNaN(raw)) {
      map[key].value += raw;
      map[key].count++;
    }
  });
  return map;
}


/**
 * แปลง time-series map เป็น sorted array
 * เรียงจากเก่าสุดไปใหม่สุด
 *
 * @param {Object} tsMap  — ผลจาก tcBuildTimeSeriesMap
 * @returns {Object[]}
 */
function tcTimeSeriesMapToArray(tsMap) {
  return Object.values(tsMap).sort(function(a, b) {
    return a.period_key < b.period_key ? -1 : a.period_key > b.period_key ? 1 : 0;
  });
}


/**
 * กรอง bills ตาม meter_type (ELECTRICITY / WATER / ALL)
 *
 * @param {Object[]} bills
 * @param {string}   meterType  — ค่าจาก METER_TYPES
 * @param {Object}   meterMap   — { meter_id: meterObj } สำหรับ lookup
 * @returns {Object[]}
 */
function tcFilterByMeterType(bills, meterType, meterMap) {
  if (!meterType || meterType === METER_TYPES.ALL) return bills;
  meterMap = meterMap || {};
  return bills.filter(function(b) {
    // bills อาจมี meter_type โดยตรง (denormalized) หรือ lookup จาก meterMap
    var mt = b.meter_type || (meterMap[b.meter_id] && meterMap[b.meter_id].meter_type) || '';
    return mt.toUpperCase() === meterType.toUpperCase();
  });
}


// ============================================================
// SECTION 3 — ROLLING AVERAGE CALCULATOR
// ============================================================

/**
 * คำนวณ Rolling Average สำหรับ time-series array
 *
 * Algorithm: สำหรับแต่ละ point i คำนวณ mean ของ window ขนาด W
 *   ถ้า i < W-1 → ใช้ข้อมูลที่มี (partial window) หรือ null ตาม fillPartial
 *
 * @param {number[]} values       — ค่า time-series เรียงเก่า→ใหม่
 * @param {number}   windowSize   — ขนาด window (เช่น 3, 6, 12)
 * @param {Object}   [opts]
 * @param {boolean}  [opts.fillPartial=true]  — คำนวณ partial window ที่ต้นชุด
 * @returns {number[]}  — ขนาดเท่ากับ values (null ถ้าไม่พอ window)
 */
function tcRollingAverage(values, windowSize, opts) {
  opts = opts || {};
  var fillPartial = opts.fillPartial !== false; // default true

  return values.map(function(_, i) {
    var start = i - windowSize + 1;
    if (start < 0) {
      // partial window
      if (!fillPartial) return null;
      start = 0;
    }
    var slice = values.slice(start, i + 1);
    // กรอง null/NaN ออกก่อนหาค่าเฉลี่ย
    var valid = slice.filter(function(v) { return v !== null && !isNaN(v); });
    if (valid.length === 0) return null;
    return valid.reduce(function(s, v) { return s + v; }, 0) / valid.length;
  });
}


/**
 * คำนวณ Rolling Average หลาย window sizes พร้อมกัน
 * ประหยัด iteration — ผ่าน values แค่ครั้งเดียว
 *
 * @param {number[]} values
 * @param {number[]} windowSizes  — เช่น [3, 6, 12]
 * @returns {Object}  — { 3: number[], 6: number[], 12: number[] }
 */
function tcMultiRollingAverage(values, windowSizes) {
  windowSizes = windowSizes || TREND_CALC_CONFIG.ROLLING_WINDOWS;
  var result = {};
  windowSizes.forEach(function(w) {
    result[w] = tcRollingAverage(values, w);
  });
  return result;
}


// ============================================================
// SECTION 4 — MONTH-OVER-MONTH (MoM) CALCULATOR
// ============================================================

/**
 * คำนวณ MoM change สำหรับ time-series array
 * MoM[i] = (values[i] - values[i-1]) / values[i-1] * 100
 *
 * @param {number[]} values
 * @returns {{ absolute: number[], percent: number[] }}
 *   index 0 จะเป็น null เสมอ (ไม่มี previous month)
 */
function tcMoMChange(values) {
  var absolute = [null];
  var percent  = [null];

  for (var i = 1; i < values.length; i++) {
    var curr = values[i];
    var prev = values[i - 1];

    if (curr === null || isNaN(curr) || prev === null || isNaN(prev)) {
      absolute.push(null);
      percent.push(null);
      continue;
    }

    var abs = curr - prev;
    absolute.push(abs);

    if (prev === 0) {
      // prev = 0: ถ้า curr > 0 → +Infinity (บันทึกเป็น null เพื่อหลีกเลี่ยง division by zero)
      percent.push(curr > 0 ? null : 0);
    } else {
      percent.push(parseFloat(((abs / prev) * 100).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES)));
    }
  }

  return { absolute: absolute, percent: percent };
}


/**
 * คำนวณ MoM สำหรับ time-series map แบบ period-aware
 * (จัดการ gap ระหว่างเดือนได้ถูกต้อง)
 *
 * @param {Object[]} tsSorted  — array จาก tcTimeSeriesMapToArray (sorted)
 * @param {string}   field     — 'value'
 * @returns {Object[]}  — tsSorted พร้อม .mom_abs และ .mom_pct เพิ่มใน each element
 */
function tcMoMChangeSeries(tsSorted, field) {
  field = field || 'value';
  return tsSorted.map(function(point, i) {
    if (i === 0) {
      return Object.assign({}, point, { mom_abs: null, mom_pct: null });
    }
    var curr    = point[field];
    var prevPt  = tsSorted[i - 1];
    var prev    = prevPt[field];

    // ตรวจสอบว่าเป็นเดือนก่อนหน้าจริง (ไม่มี gap)
    var expectedPrevKey = tcGetPrevMonthKey(point.year, point.month);
    var isConsecutive   = (prevPt.period_key === expectedPrevKey);

    if (!isConsecutive) {
      // มี gap — ไม่สามารถ MoM ได้ถูกต้อง
      return Object.assign({}, point, { mom_abs: null, mom_pct: null, has_gap: true });
    }

    var abs = (curr !== null && prev !== null) ? curr - prev : null;
    var pct = null;
    if (abs !== null && prev !== 0) {
      pct = parseFloat(((abs / prev) * 100).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
    }

    return Object.assign({}, point, { mom_abs: abs, mom_pct: pct });
  });
}


/**
 * คำนวณ period_key ของเดือนก่อนหน้า
 *
 * @param {number} year
 * @param {number} month
 * @returns {string}
 */
function tcGetPrevMonthKey(year, month) {
  if (month === 1) {
    return tcMakePeriodKey(year - 1, 12);
  }
  return tcMakePeriodKey(year, month - 1);
}


// ============================================================
// SECTION 5 — YEAR-OVER-YEAR (YoY) CALCULATOR
// ============================================================

/**
 * คำนวณ YoY change สำหรับ time-series map
 * จับคู่เดือนเดียวกันระหว่าง 2 ปีที่ระบุ
 *
 * @param {Object}        tsMap    — { period_key: { value, year, month, ... } }
 * @param {number|string} yearA    — ปีใหม่กว่า (พ.ศ.)
 * @param {number|string} yearB    — ปีเก่ากว่า (พ.ศ.)
 * @returns {Object[]}  — array 12 เดือน พร้อม yoy_abs, yoy_pct
 */
function tcYoYComparison(tsMap, yearA, yearB) {
  var result = [];

  for (var m = 1; m <= 12; m++) {
    var keyA = tcMakePeriodKey(yearA, m);
    var keyB = tcMakePeriodKey(yearB, m);

    var ptA = tsMap[keyA] || null;
    var ptB = tsMap[keyB] || null;

    var valA = ptA ? ptA.value : null;
    var valB = ptB ? ptB.value : null;

    var abs = (valA !== null && valB !== null) ? valA - valB : null;
    var pct = null;
    if (abs !== null && valB !== 0) {
      pct = parseFloat(((abs / valB) * 100).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
    }

    result.push({
      month:    m,
      year_a:   parseInt(yearA, 10),
      year_b:   parseInt(yearB, 10),
      value_a:  valA,
      value_b:  valB,
      yoy_abs:  abs,
      yoy_pct:  pct,
      has_data_a: ptA !== null,
      has_data_b: ptB !== null,
    });
  }

  return result;
}


/**
 * สรุป YoY รายปี (annual total comparison)
 *
 * @param {Object}   tsMap
 * @param {number[]} years  — เรียง [ใหม่→เก่า] เช่น [2568, 2567, 2566]
 * @returns {Object[]}  — array of { year, total, count, yoy_abs, yoy_pct }
 */
function tcYoYAnnualSummary(tsMap, years) {
  // คำนวณ total ต่อปีก่อน
  var annualTotals = {};
  years.forEach(function(yr) {
    var total = 0;
    var count = 0;
    for (var m = 1; m <= 12; m++) {
      var key = tcMakePeriodKey(yr, m);
      if (tsMap[key]) {
        total += tsMap[key].value;
        count++;
      }
    }
    annualTotals[yr] = { year: yr, total: total, count: count };
  });

  // เพิ่ม YoY เทียบปีก่อนหน้าในชุด
  return years.map(function(yr, i) {
    var current  = annualTotals[yr];
    var prevYear = years[i + 1];
    var prev     = prevYear ? annualTotals[prevYear] : null;

    var abs = (prev && current) ? current.total - prev.total : null;
    var pct = null;
    if (abs !== null && prev.total !== 0) {
      pct = parseFloat(((abs / prev.total) * 100).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
    }

    return Object.assign({}, current, {
      prev_year:  prevYear || null,
      prev_total: prev ? prev.total : null,
      yoy_abs:    abs,
      yoy_pct:    pct,
    });
  });
}


// ============================================================
// SECTION 6 — LINEAR REGRESSION (Trend Direction)
// ============================================================

/**
 * Simple linear regression: y = a + bx
 * ใช้คำนวณทิศทาง trend (slope b)
 *
 * @param {number[]} values  — time-series (index = x)
 * @returns {{ slope: number, intercept: number, r2: number }}
 *   slope > 0  = trend ขาขึ้น
 *   slope < 0  = trend ขาลง
 *   r2         = goodness of fit (0-1)
 */
function tcLinearRegression(values) {
  // กรองค่า null/NaN ออก แล้ว map เป็น { x, y }
  var points = [];
  values.forEach(function(v, i) {
    if (v !== null && !isNaN(v)) {
      points.push({ x: i, y: v });
    }
  });

  var n = points.length;
  if (n < 2) {
    return { slope: 0, intercept: values[0] || 0, r2: 0, n: n };
  }

  var sumX  = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  points.forEach(function(p) {
    sumX  += p.x;
    sumY  += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  });

  var denom = (n * sumX2 - sumX * sumX);
  if (denom === 0) {
    return { slope: 0, intercept: sumY / n, r2: 0, n: n };
  }

  var slope     = (n * sumXY - sumX * sumY) / denom;
  var intercept = (sumY - slope * sumX) / n;

  // R² calculation
  var yMean = sumY / n;
  var ssTot = 0, ssRes = 0;
  points.forEach(function(p) {
    ssTot += Math.pow(p.y - yMean, 2);
    ssRes += Math.pow(p.y - (intercept + slope * p.x), 2);
  });
  var r2 = ssTot > 0 ? parseFloat((1 - ssRes / ssTot).toFixed(4)) : 0;

  return {
    slope:     parseFloat(slope.toFixed(4)),
    intercept: parseFloat(intercept.toFixed(4)),
    r2:        r2,
    n:         n,
  };
}


/**
 * แปลง slope เป็น trend label ภาษาไทย
 *
 * @param {number} slope
 * @param {number} [threshold=0.01]  — ค่า slope เล็กกว่านี้ถือว่า STABLE
 * @returns {'INCREASING'|'DECREASING'|'STABLE'}
 */
function tcSlopeToTrendLabel(slope, threshold) {
  threshold = threshold || 0.01;
  if (slope > threshold)  return 'INCREASING';
  if (slope < -threshold) return 'DECREASING';
  return 'STABLE';
}


// ============================================================
// SECTION 7 — AGGREGATION HELPERS
// ============================================================

/**
 * Aggregate bills ตาม site_id — คืน Map ของ bills แต่ละ site
 * ใช้ batch loop แทน filter ซ้ำเพื่อประสิทธิภาพ O(n)
 *
 * @param {Object[]} bills
 * @returns {Object}  — { site_id: Object[] }
 */
function tcGroupBySite(bills) {
  var groups = {};
  bills.forEach(function(b) {
    var sid = b.site_id || 'UNKNOWN';
    if (!groups[sid]) groups[sid] = [];
    groups[sid].push(b);
  });
  return groups;
}


/**
 * Aggregate bills ตาม meter_id — คืน Map ของ bills แต่ละ meter
 *
 * @param {Object[]} bills
 * @returns {Object}  — { meter_id: Object[] }
 */
function tcGroupByMeter(bills) {
  var groups = {};
  bills.forEach(function(b) {
    var mid = b.meter_id || 'UNKNOWN';
    if (!groups[mid]) groups[mid] = [];
    groups[mid].push(b);
  });
  return groups;
}


/**
 * สร้าง meterMap จาก array: { meter_id: meterObject }
 * ใช้ O(1) lookup แทน find() ซ้ำๆ
 *
 * @param {Object[]} meters
 * @returns {Object}
 */
function tcBuildMeterMap(meters) {
  var map = {};
  (meters || []).forEach(function(m) {
    map[m.meter_id] = m;
  });
  return map;
}


/**
 * สร้าง siteMap จาก array: { site_id: siteObject }
 *
 * @param {Object[]} sites
 * @returns {Object}
 */
function tcBuildSiteMap(sites) {
  var map = {};
  (sites || []).forEach(function(s) {
    map[s.site_id] = s;
  });
  return map;
}


// ============================================================
// SECTION 8 — COST PER UNIT CALCULATOR
// ============================================================

/**
 * คำนวณ cost per unit จาก bill (บาท/หน่วย)
 * ใช้ amount_total / units_used
 *
 * @param {Object} bill
 * @returns {number|null}
 */
function tcCostPerUnit(bill) {
  var units  = parseFloat(bill.units_used  || 0);
  var amount = parseFloat(bill.amount_total || 0);
  if (units <= 0 || amount <= 0) return null;
  return parseFloat((amount / units).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
}


/**
 * คำนวณ average cost per unit สำหรับ array ของ bills
 *
 * @param {Object[]} bills
 * @returns {number|null}
 */
function tcAvgCostPerUnit(bills) {
  var totalUnits  = 0;
  var totalAmount = 0;
  bills.forEach(function(b) {
    var u = parseFloat(b.units_used   || 0);
    var a = parseFloat(b.amount_total || 0);
    if (u > 0) {
      totalUnits  += u;
      totalAmount += a;
    }
  });
  if (totalUnits <= 0) return null;
  return parseFloat((totalAmount / totalUnits).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
}


// ============================================================
// SECTION 9 — PERCENTAGE & MATH UTILITIES
// ============================================================

/**
 * คำนวณ % change (curr - prev) / prev * 100
 * Return null ถ้า prev = 0 หรือ null
 *
 * @param {number} curr
 * @param {number} prev
 * @returns {number|null}
 */
function tcPctChange(curr, prev) {
  if (prev === null || prev === undefined || isNaN(prev) || prev === 0) return null;
  if (curr === null || curr === undefined || isNaN(curr)) return null;
  return parseFloat((((curr - prev) / prev) * 100).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
}


/**
 * คำนวณ mean ของ array (กรอง null/NaN)
 *
 * @param {number[]} arr
 * @returns {number|null}
 */
function tcMean(arr) {
  var valid = (arr || []).filter(function(v) { return v !== null && !isNaN(v); });
  if (valid.length === 0) return null;
  return valid.reduce(function(s, v) { return s + v; }, 0) / valid.length;
}


/**
 * คำนวณ median ของ array (กรอง null/NaN)
 *
 * @param {number[]} arr
 * @returns {number|null}
 */
function tcMedian(arr) {
  var valid = (arr || []).filter(function(v) { return v !== null && !isNaN(v); }).sort(function(a,b){return a-b;});
  if (valid.length === 0) return null;
  var mid = Math.floor(valid.length / 2);
  return valid.length % 2 !== 0 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}


/**
 * คำนวณ standard deviation ของ array
 *
 * @param {number[]} arr
 * @returns {number|null}
 */
function tcStdDev(arr) {
  var valid = (arr || []).filter(function(v) { return v !== null && !isNaN(v); });
  if (valid.length < 2) return null;
  var mean = valid.reduce(function(s, v) { return s + v; }, 0) / valid.length;
  var variance = valid.reduce(function(s, v) { return s + Math.pow(v - mean, 2); }, 0) / valid.length;
  return parseFloat(Math.sqrt(variance).toFixed(TREND_CALC_CONFIG.DECIMAL_PLACES));
}


/**
 * Clamp ค่าให้อยู่ในช่วง [min, max]
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function tcClamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}


// ============================================================
// SECTION 10 — BATCH DATA LOADER
// ============================================================

/**
 * โหลด Bills, Meters, Sites ด้วย batch read เดียว
 * ลด Google Sheets API calls จาก 3 → 1 read ต่อ sheet
 *
 * @param {Object} ss  — SpreadsheetApp.openById(CONFIG.SHEET_ID)
 * @returns {{ bills: Object[], meters: Object[], sites: Object[] }}
 */
function tcLoadAllData(ss) {
  var bills  = dbGetAll(CONFIG.SHEETS.BILLS);
  var meters = dbGetAll(CONFIG.SHEETS.METERS);
  var sites  = dbGetAll(CONFIG.SHEETS.SITES);
  return { bills: bills, meters: meters, sites: sites };
}


/**
 * กรอง bills เฉพาะที่มี bill_status = PAID หรือ APPROVED
 * เพื่อไม่ให้ PENDING_REVIEW / CANCELLED บิดเบือน trend
 *
 * @param {Object[]} bills
 * @returns {Object[]}
 */
function tcFilterValidBills(bills) {
  return bills.filter(function(b) {
    return b.bill_status === 'PAID' || b.bill_status === 'APPROVED';
  });
}


/**
 * ดึงรายการปี (พ.ศ.) ที่มีในข้อมูล เรียงใหม่→เก่า
 *
 * @param {Object[]} bills
 * @returns {number[]}
 */
function tcGetAvailableYears(bills) {
  var yearSet = {};
  bills.forEach(function(b) { yearSet[b.bill_year] = true; });
  return Object.keys(yearSet).map(Number).sort(function(a, b) { return b - a; });
}
