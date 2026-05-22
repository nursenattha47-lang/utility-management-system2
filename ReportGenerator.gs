// ============================================================
// ReportGenerator.gs — Report Content Builders
// UtilityManager | PHASE 6A — Report Service
// ============================================================
// รับผิดชอบ: สร้างเนื้อหา (content) ของแต่ละ report ประเภท
//   1. rgBuildMonthlyContent()     — รายงานรายเดือน
//   2. rgBuildYearlyContent()      — รายงานรายปี
//   3. rgBuildExecutiveContent()   — สรุปผู้บริหาร
//   4. rgBuildSiteContent()        — รายงานแยกสถานที่
//   5. rgBuildWaterContent()       — รายงานน้ำ
//   6. rgBuildElectricityContent() — รายงานไฟฟ้า
// ============================================================
// ทุกฟังก์ชันรับ pre-loaded data (ไม่อ่าน Sheet โดยตรง)
// คืน content object: { text, summary, rows, metadata }
// ── text    = plain-text report (บันทึกเป็นไฟล์)
// ── summary = key metrics สำหรับ dashboard
// ── rows    = raw data สำหรับ export ต่อ (Excel/CSV phase ถัดไป)
// ── metadata= ข้อมูลเกี่ยวกับ report นี้
// ============================================================
// Dependencies:
//   Config.gs, Utils.gs, ReportService.gs (RS_CONFIG)
//   TrendCalculator.gs (tcGroupBySite, tcBuildMeterMap)
// ============================================================

'use strict';

// ============================================================
// SECTION 1 — SHARED REPORT UTILITIES
// ============================================================

/**
 * สัญลักษณ์ separator บรรทัดใน plain-text report
 */
var RG_LINE     = '═'.repeat(70);
var RG_LINE_SM  = '─'.repeat(70);
var RG_LINE_DOT = '·'.repeat(70);

/**
 * ชื่อเดือนภาษาไทย (index 0 = มกราคม)
 */
var RG_MONTHS_TH = [
  'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
  'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
  'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
];

var RG_MONTHS_SHORT = [
  'ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
  'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.',
];

/**
 * Label ประเภทมิเตอร์ภาษาไทย
 */
var RG_METER_TYPE_TH = {
  ELECTRICITY: 'ไฟฟ้า',
  WATER:       'น้ำประปา',
  GAS:         'แก๊ส',
  INTERNET:    'อินเทอร์เน็ต',
  ALL:         'ทุกประเภท',
};

/**
 * สร้าง report header มาตรฐาน (ใช้ร่วมกันทุก report)
 *
 * @param {string} title      — ชื่อรายงาน
 * @param {string} subtitle   — หัวข้อย่อย
 * @param {Object} meta       — { generated_at, generated_by, period, ... }
 * @returns {string}
 */
function rgBuildHeader(title, subtitle, meta) {
  meta = meta || {};
  var lines = [];

  lines.push(RG_LINE);
  lines.push(_center('ระบบบริหารจัดการสาธารณูปโภค (UtilityManager)', 70));
  lines.push(_center(title, 70));
  if (subtitle) lines.push(_center(subtitle, 70));
  lines.push(RG_LINE);

  if (meta.period)       lines.push('  ช่วงเวลา    : ' + meta.period);
  if (meta.site_name)    lines.push('  สถานที่     : ' + meta.site_name);
  if (meta.meter_type)   lines.push('  ประเภท      : ' + (RG_METER_TYPE_TH[meta.meter_type] || meta.meter_type));
  lines.push('  วันที่สร้าง : ' + _formatDateTimeTH(meta.generated_at || new Date()));
  lines.push('  สร้างโดย   : ' + (meta.generated_by || 'ระบบอัตโนมัติ'));
  lines.push(RG_LINE_SM);
  lines.push('');

  return lines.join('\n');
}

/**
 * สร้าง report footer มาตรฐาน
 *
 * @param {Object} [meta]
 * @returns {string}
 */
function rgBuildFooter(meta) {
  meta = meta || {};
  var lines = [];
  lines.push('');
  lines.push(RG_LINE);
  lines.push(_center('--- สิ้นสุดรายงาน ---', 70));
  if (meta.duration_ms) {
    lines.push(_center('ใช้เวลาสร้าง: ' + meta.duration_ms + ' ms', 70));
  }
  lines.push(RG_LINE);
  return lines.join('\n');
}

/**
 * สร้าง section header
 *
 * @param {string} title
 * @param {string} [icon]  — emoji หรือ symbol
 * @returns {string}
 */
function rgSectionHeader(title, icon) {
  icon = icon || '▸';
  return '\n' + icon + ' ' + title + '\n' + RG_LINE_SM + '\n';
}

/**
 * จัดรูปแบบตารางข้อมูลแบบ plain-text (ASCII table)
 * รองรับ Thai characters (นับ byte-width)
 *
 * @param {string[]} headers   — ชื่อคอลัมน์
 * @param {Array[]}  rows      — แถวข้อมูล (array of arrays)
 * @param {number[]} [widths]  — ความกว้างของแต่ละคอลัมน์
 * @returns {string}
 */
function rgBuildTable(headers, rows, widths) {
  // คำนวณความกว้างอัตโนมัติถ้าไม่ระบุ
  if (!widths) {
    widths = headers.map(function(h, i) {
      var colMax = _strWidth(h);
      rows.forEach(function(row) {
        var w = _strWidth(String(row[i] || ''));
        if (w > colMax) colMax = w;
      });
      return Math.min(colMax + 2, 30); // จำกัด max width
    });
  }

  var lines = [];
  var separator = '+' + widths.map(function(w) { return '-'.repeat(w + 2); }).join('+') + '+';

  // Header row
  lines.push(separator);
  lines.push('|' + headers.map(function(h, i) {
    return ' ' + _padRight(h, widths[i]) + ' ';
  }).join('|') + '|');
  lines.push(separator.replace(/-/g, '='));

  // Data rows
  rows.forEach(function(row) {
    lines.push('|' + headers.map(function(_, i) {
      var cell = String(row[i] !== undefined && row[i] !== null ? row[i] : '-');
      return ' ' + _padRight(cell, widths[i]) + ' ';
    }).join('|') + '|');
  });

  lines.push(separator);
  return lines.join('\n');
}

/**
 * จัด format ตัวเลขเงิน (บาท) สำหรับ report
 * @param {number} amount
 * @returns {string}  เช่น "1,234.56 บาท"
 */
function rgFormatBaht(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '-';
  return Number(amount).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' บาท';
}

/**
 * จัด format หน่วยการใช้
 * @param {number} units
 * @param {string} meterType
 * @returns {string}
 */
function rgFormatUnits(units, meterType) {
  if (units === null || units === undefined || isNaN(units)) return '-';
  var unitLabel = meterType === 'WATER' ? 'หน่วย (ลบ.ม.)' : 'หน่วย (kWh)';
  return Number(units).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' ' + unitLabel;
}

/**
 * จัด format % change พร้อม indicator
 * @param {number} pct
 * @returns {string}
 */
function rgFormatPct(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return 'N/A';
  var sign = pct >= 0 ? '▲' : '▼';
  return sign + ' ' + Math.abs(pct).toFixed(1) + '%';
}


// ============================================================
// SECTION 2 — MONTHLY REPORT BUILDER
// ============================================================

/**
 * สร้างเนื้อหารายงานรายเดือน
 *
 * โครงสร้าง:
 *   1. Header
 *   2. สรุป KPIs ภาพรวมเดือนนี้
 *   3. ตารางสรุปแยก site
 *   4. ตารางสรุปแยกประเภท (ไฟฟ้า/น้ำ)
 *   5. รายการบิลทั้งหมด
 *   6. Footer
 *
 * @param {Object[]} bills    — บิลของเดือนนั้น (filtered แล้ว)
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @returns {{ text, summary, rows, metadata }}
 */
function rgBuildMonthlyContent(bills, sites, meters, options) {
  options = options || {};

  var year      = options.year;
  var month     = options.month;
  var monthName = RG_MONTHS_TH[(month || 1) - 1] || '';
  var meterMap  = _buildMeterMapLocal(meters);
  var siteMap   = _buildSiteMapLocal(sites);

  // ── 1. คำนวณ KPI ──────────────────────────────────────
  var kpi = _calcBillKPIs(bills, meterMap);

  // ── 2. สรุปต่อ site ───────────────────────────────────
  var siteBreakdown = _aggregateBySite(bills, meterMap, siteMap);

  // ── 3. สรุปต่อประเภทมิเตอร์ ─────────────────────────
  var typeBreakdown = _aggregateByMeterType(bills, meterMap);

  // ── 4. สร้าง plain text ───────────────────────────────
  var textParts = [];

  textParts.push(rgBuildHeader(
    'รายงานค่าสาธารณูปโภครายเดือน',
    'ประจำเดือน ' + monthName + ' พ.ศ. ' + year,
    {
      period:       monthName + ' ' + year,
      meter_type:   options.meter_type || 'ALL',
      generated_at: new Date(),
    }
  ));

  // ── ส่วนที่ 1: KPI Summary ────────────────────────────
  textParts.push(rgSectionHeader('สรุปภาพรวมเดือน ' + monthName + ' ' + year, '📊'));
  textParts.push(_buildKPIBlock(kpi));

  // ── ส่วนที่ 2: แยก site ──────────────────────────────
  textParts.push(rgSectionHeader('สรุปค่าใช้จ่ายแยกตามสถานที่', '🏢'));
  if (siteBreakdown.length > 0) {
    textParts.push(rgBuildTable(
      ['สถานที่', 'ค่าไฟ (บาท)', 'ค่าน้ำ (บาท)', 'รวม (บาท)', 'จำนวนบิล'],
      siteBreakdown.map(function(s) {
        return [
          _truncate(s.site_name, 18),
          _fmtNum(s.elec_amount),
          _fmtNum(s.water_amount),
          _fmtNum(s.total_amount),
          s.bill_count,
        ];
      }),
      [18, 14, 14, 14, 10]
    ));

    // ยอดรวมสุดท้าย
    textParts.push('\n  รวมทั้งหมด: ' + rgFormatBaht(kpi.total_amount));
  } else {
    textParts.push('  (ไม่มีข้อมูล)');
  }

  // ── ส่วนที่ 3: แยกประเภท ─────────────────────────────
  textParts.push(rgSectionHeader('สรุปแยกตามประเภทสาธารณูปโภค', '⚡'));
  textParts.push(rgBuildTable(
    ['ประเภท', 'จำนวนบิล', 'หน่วยรวม', 'ค่าใช้จ่าย (บาท)', 'เฉลี่ย/บิล (บาท)'],
    typeBreakdown.map(function(t) {
      return [
        RG_METER_TYPE_TH[t.meter_type] || t.meter_type,
        t.bill_count,
        _fmtNum(t.total_units),
        _fmtNum(t.total_amount),
        _fmtNum(t.avg_per_bill),
      ];
    }),
    [14, 10, 14, 18, 18]
  ));

  // ── ส่วนที่ 4: รายการบิลทั้งหมด ──────────────────────
  textParts.push(rgSectionHeader('รายการบิลทั้งหมด (' + bills.length + ' รายการ)', '📋'));
  if (bills.length > 0) {
    // เรียงตาม site แล้วตาม amount
    var sortedBills = bills.slice().sort(function(a, b) {
      if (a.site_id !== b.site_id) return a.site_id.localeCompare(b.site_id);
      return parseFloat(b.amount_total || 0) - parseFloat(a.amount_total || 0);
    });

    textParts.push(rgBuildTable(
      ['สถานที่', 'ประเภท', 'หน่วย', 'จำนวนเงิน (บาท)', 'สถานะ'],
      sortedBills.map(function(b) {
        var meter     = meterMap[b.meter_id] || {};
        var siteName  = siteMap[b.site_id] ? siteMap[b.site_id].site_name : b.site_id;
        return [
          _truncate(siteName, 18),
          RG_METER_TYPE_TH[meter.meter_type] || meter.meter_type || '?',
          _fmtNum(b.units_used),
          _fmtNum(b.amount_total),
          _translateStatus(b.bill_status),
        ];
      }),
      [18, 10, 10, 18, 12]
    ));
  } else {
    textParts.push('  (ไม่มีบิลในเดือนนี้)');
  }

  textParts.push(rgBuildFooter());

  // ── 5. สร้าง summary object ────────────────────────────
  var summary = {
    year:          year,
    month:         month,
    month_name:    monthName,
    total_amount:  kpi.total_amount,
    elec_amount:   kpi.elec_amount,
    water_amount:  kpi.water_amount,
    total_units:   kpi.total_units,
    bill_count:    bills.length,
    paid_count:    kpi.paid_count,
    unpaid_count:  kpi.unpaid_count,
    site_count:    siteBreakdown.length,
  };

  return {
    text:     textParts.join('\n'),
    summary:  summary,
    rows:     siteBreakdown,
    metadata: { year: year, month: month, bill_count: bills.length },
  };
}


// ============================================================
// SECTION 3 — YEARLY REPORT BUILDER
// ============================================================

/**
 * สร้างเนื้อหารายงานรายปี
 *
 * โครงสร้าง:
 *   1. Header
 *   2. KPI ภาพรวมทั้งปี
 *   3. ตารางรายเดือน (12 เดือน)
 *   4. YoY Comparison
 *   5. ตาราง Top 5 sites ค่าใช้จ่ายสูงสุด
 *   6. สรุปแยกประเภท
 *   7. Footer
 *
 * @param {Object[]} billsMain     — บิลปีหลัก
 * @param {Object[]} billsCompare  — บิลปีเปรียบเทียบ
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @returns {{ text, summary, rows, metadata }}
 */
function rgBuildYearlyContent(billsMain, billsCompare, sites, meters, options) {
  options = options || {};

  var year        = options.year;
  var compareYear = options.compare_year || (year - 1);
  var meterMap    = _buildMeterMapLocal(meters);
  var siteMap     = _buildSiteMapLocal(sites);

  // ── คำนวณ KPI ─────────────────────────────────────────
  var kpiMain    = _calcBillKPIs(billsMain,    meterMap);
  var kpiCompare = _calcBillKPIs(billsCompare, meterMap);

  // ── รายเดือน (monthly breakdown) ─────────────────────
  var monthlyRows = _buildMonthlyBreakdown(billsMain, meterMap);

  // ── YoY calculation ───────────────────────────────────
  var yoyAmt   = _calcYoYPct(kpiMain.total_amount,  kpiCompare.total_amount);
  var yoyUnits = _calcYoYPct(kpiMain.total_units,   kpiCompare.total_units);

  // ── Top sites ─────────────────────────────────────────
  var siteBreakdown = _aggregateBySite(billsMain, meterMap, siteMap);
  siteBreakdown.sort(function(a, b) { return b.total_amount - a.total_amount; });
  var topSites = siteBreakdown.slice(0, 10);

  // ── Type breakdown ────────────────────────────────────
  var typeBreakdown = _aggregateByMeterType(billsMain, meterMap);

  // ── สร้าง text ────────────────────────────────────────
  var textParts = [];

  textParts.push(rgBuildHeader(
    'รายงานค่าสาธารณูปโภครายปี',
    'ประจำปี พ.ศ. ' + year + '  (เปรียบเทียบกับปี ' + compareYear + ')',
    {
      period:       'ปี พ.ศ. ' + year,
      meter_type:   options.meter_type || 'ALL',
      generated_at: new Date(),
    }
  ));

  // ── ส่วนที่ 1: KPI ────────────────────────────────────
  textParts.push(rgSectionHeader('สรุป KPI ประจำปี ' + year, '📊'));
  textParts.push(_buildKPIBlock(kpiMain));
  textParts.push('');
  textParts.push('  ▶ เปรียบเทียบกับปี ' + compareYear + ':');
  textParts.push('    ค่าใช้จ่ายรวม  : ' + rgFormatPct(yoyAmt)   +
                 '  (' + rgFormatBaht(kpiMain.total_amount) + ' vs ' + rgFormatBaht(kpiCompare.total_amount) + ')');
  textParts.push('    หน่วยรวม       : ' + rgFormatPct(yoyUnits)  +
                 '  (' + _fmtNum(kpiMain.total_units) + ' vs ' + _fmtNum(kpiCompare.total_units) + ' หน่วย)');

  // ── ส่วนที่ 2: Monthly breakdown ─────────────────────
  textParts.push(rgSectionHeader('ค่าใช้จ่ายรายเดือน ปี ' + year, '📅'));
  if (monthlyRows.length > 0) {
    textParts.push(rgBuildTable(
      ['เดือน', 'ค่าไฟ (บาท)', 'ค่าน้ำ (บาท)', 'รวม (บาท)', 'จำนวนบิล'],
      monthlyRows.map(function(r) {
        return [
          RG_MONTHS_SHORT[r.month - 1] + ' ' + year,
          _fmtNum(r.elec_amount),
          _fmtNum(r.water_amount),
          _fmtNum(r.total_amount),
          r.bill_count,
        ];
      }),
      [14, 14, 14, 14, 10]
    ));
    // ยอดรวม
    textParts.push('\n  ยอดรวมทั้งปี: ' + rgFormatBaht(kpiMain.total_amount));
  } else {
    textParts.push('  (ไม่มีข้อมูล)');
  }

  // ── ส่วนที่ 3: Top sites ──────────────────────────────
  textParts.push(rgSectionHeader('สถานที่ที่มีค่าใช้จ่ายสูงสุด (Top 10)', '🏆'));
  if (topSites.length > 0) {
    textParts.push(rgBuildTable(
      ['อันดับ', 'สถานที่', 'ค่าไฟ (บาท)', 'ค่าน้ำ (บาท)', 'รวม (บาท)'],
      topSites.map(function(s, i) {
        return [
          i + 1,
          _truncate(s.site_name, 20),
          _fmtNum(s.elec_amount),
          _fmtNum(s.water_amount),
          _fmtNum(s.total_amount),
        ];
      }),
      [6, 20, 14, 14, 14]
    ));
  } else {
    textParts.push('  (ไม่มีข้อมูล)');
  }

  // ── ส่วนที่ 4: แยกประเภท ─────────────────────────────
  textParts.push(rgSectionHeader('สรุปแยกตามประเภทสาธารณูปโภค', '⚡'));
  textParts.push(rgBuildTable(
    ['ประเภท', 'จำนวนบิล', 'รวม (บาท)', 'เฉลี่ย/เดือน (บาท)', 'สัดส่วน (%)'],
    typeBreakdown.map(function(t) {
      var pct = kpiMain.total_amount > 0
        ? (t.total_amount / kpiMain.total_amount * 100).toFixed(1)
        : '0.0';
      return [
        RG_METER_TYPE_TH[t.meter_type] || t.meter_type,
        t.bill_count,
        _fmtNum(t.total_amount),
        _fmtNum(t.total_amount / 12),
        pct + '%',
      ];
    }),
    [14, 10, 14, 20, 12]
  ));

  textParts.push(rgBuildFooter());

  // ── summary ──────────────────────────────────────────
  var summary = {
    year:           year,
    compare_year:   compareYear,
    total_amount:   kpiMain.total_amount,
    elec_amount:    kpiMain.elec_amount,
    water_amount:   kpiMain.water_amount,
    yoy_amount_pct: yoyAmt,
    yoy_units_pct:  yoyUnits,
    bill_count:     billsMain.length,
    site_count:     siteBreakdown.length,
    month_coverage: monthlyRows.length,
  };

  return {
    text:     textParts.join('\n'),
    summary:  summary,
    rows:     monthlyRows,
    metadata: { year: year, compare_year: compareYear, bill_count: billsMain.length },
  };
}


// ============================================================
// SECTION 4 — EXECUTIVE SUMMARY BUILDER
// ============================================================

/**
 * สร้าง Executive Summary Report
 *
 * โครงสร้าง:
 *   1. Header
 *   2. KPI ไฮไลท์ (4 ตัวหลัก)
 *   3. Top 5 sites ค่าใช้จ่ายสูงสุด
 *   4. Sites ที่มี anomaly สูงสุด
 *   5. Trend ภาพรวม 6 เดือน
 *   6. Bills outstanding / overdue
 *   7. Footer
 *
 * @param {Object[]} allBills
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object[]} anomalies
 * @param {Object[]} payments
 * @param {Object}   options
 * @returns {{ text, summary, rows, metadata }}
 */
function rgBuildExecutiveContent(allBills, sites, meters, anomalies, payments, options) {
  options = options || {};

  var year     = options.year || _getLatestYearLocal(allBills);
  var meterMap = _buildMeterMapLocal(meters);
  var siteMap  = _buildSiteMapLocal(sites);

  // กรองบิลปีล่าสุด
  var yearBills = allBills.filter(function(b) {
    return String(b.bill_year) === String(year);
  });

  // ── KPIs ──────────────────────────────────────────────
  var kpi          = _calcBillKPIs(yearBills, meterMap);
  var prevYearBills = allBills.filter(function(b) {
    return String(b.bill_year) === String(year - 1);
  });
  var kpiPrev      = _calcBillKPIs(prevYearBills, meterMap);
  var yoyPct       = _calcYoYPct(kpi.total_amount, kpiPrev.total_amount);

  // ── Top sites ─────────────────────────────────────────
  var siteBreakdown = _aggregateBySite(yearBills, meterMap, siteMap);
  siteBreakdown.sort(function(a, b) { return b.total_amount - a.total_amount; });
  var top5Sites = siteBreakdown.slice(0, 5);

  // ── Anomaly summary ───────────────────────────────────
  var criticalAnomalies = anomalies.filter(function(a) {
    return a.severity === 'CRITICAL' || a.severity === 'HIGH';
  });
  var anomalyBySite = {};
  criticalAnomalies.forEach(function(a) {
    anomalyBySite[a.site_id] = (anomalyBySite[a.site_id] || 0) + 1;
  });
  var topAnomalySites = Object.keys(anomalyBySite)
    .map(function(sid) {
      return {
        site_id:   sid,
        site_name: siteMap[sid] ? siteMap[sid].site_name : sid,
        count:     anomalyBySite[sid],
      };
    })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 5);

  // ── Overdue bills ─────────────────────────────────────
  var today        = new Date();
  var overdueBills = yearBills.filter(function(b) {
    if (b.bill_status === 'PAID' || b.bill_status === 'CANCELLED') return false;
    if (!b.due_date) return false;
    var due = new Date(b.due_date);
    return due < today;
  });

  // ── 6-month trend ─────────────────────────────────────
  var last6Months  = _buildLast6MonthsTrend(allBills, meterMap);

  // ── สร้าง text ────────────────────────────────────────
  var textParts = [];

  textParts.push(rgBuildHeader(
    'รายงานสรุปผู้บริหาร (Executive Summary)',
    'ภาพรวมค่าสาธารณูปโภค ประจำปี พ.ศ. ' + year,
    { period: 'ปี พ.ศ. ' + year, generated_at: new Date() }
  ));

  // ── ส่วนที่ 1: KPI Highlights ─────────────────────────
  textParts.push(rgSectionHeader('ตัวชี้วัดหลัก (KPI Highlights) ปี ' + year, '🎯'));
  textParts.push('');
  textParts.push('  💰 ค่าใช้จ่ายรวมทั้งปี  : ' + rgFormatBaht(kpi.total_amount) +
                 '  (' + rgFormatPct(yoyPct) + ' จากปีก่อน)');
  textParts.push('  ⚡ ค่าไฟฟ้ารวม          : ' + rgFormatBaht(kpi.elec_amount));
  textParts.push('  💧 ค่าน้ำรวม            : ' + rgFormatBaht(kpi.water_amount));
  textParts.push('  📋 จำนวนบิลทั้งหมด     : ' + kpi.total_bills + ' รายการ');
  textParts.push('  ✅ ชำระแล้ว            : ' + kpi.paid_count + ' รายการ');
  textParts.push('  ⏳ ยังไม่ชำระ          : ' + kpi.unpaid_count + ' รายการ');
  textParts.push('  🚨 เลยกำหนด            : ' + overdueBills.length + ' รายการ');
  textParts.push('  ⚠️  ความผิดปกติ (สูง)  : ' + criticalAnomalies.length + ' รายการ');
  textParts.push('');

  // ── ส่วนที่ 2: Top 5 sites ────────────────────────────
  textParts.push(rgSectionHeader('สถานที่ค่าใช้จ่ายสูงสุด (Top 5) ปี ' + year, '🏆'));
  if (top5Sites.length > 0) {
    textParts.push(rgBuildTable(
      ['อันดับ', 'สถานที่', 'ค่าไฟ (บาท)', 'ค่าน้ำ (บาท)', 'รวม (บาท)', '%'],
      top5Sites.map(function(s, i) {
        var pct = kpi.total_amount > 0
          ? (s.total_amount / kpi.total_amount * 100).toFixed(1) + '%'
          : '-';
        return [
          i + 1,
          _truncate(s.site_name, 20),
          _fmtNum(s.elec_amount),
          _fmtNum(s.water_amount),
          _fmtNum(s.total_amount),
          pct,
        ];
      }),
      [6, 20, 12, 12, 14, 6]
    ));
  } else {
    textParts.push('  (ไม่มีข้อมูล)');
  }

  // ── ส่วนที่ 3: Anomaly sites ──────────────────────────
  textParts.push(rgSectionHeader('สถานที่ที่มีการแจ้งเตือนสูงสุด', '⚠️'));
  if (topAnomalySites.length > 0) {
    textParts.push(rgBuildTable(
      ['อันดับ', 'สถานที่', 'จำนวนเตือน (High/Critical)'],
      topAnomalySites.map(function(s, i) {
        return [i + 1, _truncate(s.site_name, 30), s.count + ' ครั้ง'];
      }),
      [6, 30, 28]
    ));
  } else {
    textParts.push('  ✅ ไม่มีการแจ้งเตือนระดับสูง');
  }

  // ── ส่วนที่ 4: 6-month trend ──────────────────────────
  textParts.push(rgSectionHeader('แนวโน้มค่าใช้จ่าย 6 เดือนล่าสุด', '📈'));
  if (last6Months.length > 0) {
    textParts.push(rgBuildTable(
      ['เดือน', 'ค่าไฟ (บาท)', 'ค่าน้ำ (บาท)', 'รวม (บาท)', 'เปลี่ยนแปลง'],
      last6Months.map(function(r, i) {
        var prevAmt = i > 0 ? last6Months[i - 1].total_amount : null;
        var change  = prevAmt !== null ? rgFormatPct(_calcYoYPct(r.total_amount, prevAmt)) : '-';
        return [
          RG_MONTHS_SHORT[r.month - 1] + ' ' + r.year,
          _fmtNum(r.elec_amount),
          _fmtNum(r.water_amount),
          _fmtNum(r.total_amount),
          change,
        ];
      }),
      [12, 14, 14, 14, 12]
    ));
  } else {
    textParts.push('  (ไม่มีข้อมูลย้อนหลัง)');
  }

  // ── ส่วนที่ 5: Overdue bills ──────────────────────────
  if (overdueBills.length > 0) {
    textParts.push(rgSectionHeader('บิลเลยกำหนดชำระ (' + overdueBills.length + ' รายการ)', '🚨'));
    textParts.push(rgBuildTable(
      ['สถานที่', 'ประเภท', 'จำนวนเงิน (บาท)', 'ครบกำหนด'],
      overdueBills.slice(0, 20).map(function(b) {
        var siteName = siteMap[b.site_id] ? siteMap[b.site_id].site_name : b.site_id;
        var meter    = meterMap[b.meter_id] || {};
        return [
          _truncate(siteName, 20),
          RG_METER_TYPE_TH[meter.meter_type] || '?',
          _fmtNum(b.amount_total),
          b.due_date || '-',
        ];
      }),
      [20, 12, 18, 14]
    ));
    if (overdueBills.length > 20) {
      textParts.push('  ... และอีก ' + (overdueBills.length - 20) + ' รายการ');
    }
  }

  textParts.push(rgBuildFooter());

  // ── summary ──────────────────────────────────────────
  var summary = {
    year:               year,
    total_amount:       kpi.total_amount,
    yoy_pct:            yoyPct,
    elec_amount:        kpi.elec_amount,
    water_amount:       kpi.water_amount,
    bill_count:         kpi.total_bills,
    paid_count:         kpi.paid_count,
    unpaid_count:       kpi.unpaid_count,
    overdue_count:      overdueBills.length,
    critical_anomalies: criticalAnomalies.length,
    top5_sites:         top5Sites,
  };

  return {
    text:     textParts.join('\n'),
    summary:  summary,
    rows:     siteBreakdown,
    metadata: { year: year, bill_count: yearBills.length },
  };
}


// ============================================================
// SECTION 5 — SITE REPORT BUILDER
// ============================================================

/**
 * สร้างรายงานแยกสถานที่
 *
 * โครงสร้าง:
 *   1. Header (ชื่อ site)
 *   2. ข้อมูล site
 *   3. KPIs ของ site นั้น
 *   4. ตารางรายเดือน
 *   5. รายการมิเตอร์ทั้งหมด
 *   6. รายการ anomalies
 *   7. ประวัติการชำระเงิน
 *   8. Footer
 *
 * @param {Object[]} siteBills   — บิลของ site นั้นๆ
 * @param {Object}   site        — site object
 * @param {Object[]} meters
 * @param {Object[]} anomalies
 * @param {Object[]} payments
 * @param {Object}   options
 * @returns {{ text, summary, rows, metadata }}
 */
function rgBuildSiteContent(siteBills, site, meters, anomalies, payments, options) {
  options = options || {};

  var meterMap     = _buildMeterMapLocal(meters);
  var kpi          = _calcBillKPIs(siteBills, meterMap);
  var monthlyRows  = _buildMonthlyBreakdown(siteBills, meterMap);

  // กรอง meters ของ site นี้
  var siteMeters   = meters.filter(function(m) {
    return m.site_id === site.site_id;
  });

  // กรอง anomalies ของ site นี้
  var siteAnomalies = anomalies.filter(function(a) {
    return a.site_id === site.site_id;
  }).sort(function(a, b) {
    return String(b.created_at).localeCompare(String(a.created_at));
  });

  // ── สร้าง text ────────────────────────────────────────
  var textParts = [];

  textParts.push(rgBuildHeader(
    'รายงานค่าสาธารณูปโภคแยกสถานที่',
    site.site_name + '  (' + site.site_id + ')',
    {
      period:       options.year ? 'ปี พ.ศ. ' + options.year : 'ทุกช่วงเวลา',
      site_name:    site.site_name,
      generated_at: new Date(),
    }
  ));

  // ── ข้อมูล site ───────────────────────────────────────
  textParts.push(rgSectionHeader('ข้อมูลสถานที่', '🏢'));
  textParts.push('  รหัสสถานที่  : ' + site.site_id);
  textParts.push('  ชื่อสถานที่ : ' + site.site_name);
  textParts.push('  ประเภท       : ' + (site.site_type    || '-'));
  textParts.push('  จังหวัด      : ' + (site.province     || '-'));
  textParts.push('  ที่อยู่       : ' + (site.address      || '-'));
  textParts.push('  จำนวนมิเตอร์ : ' + siteMeters.length + ' เครื่อง');
  textParts.push('');

  // ── KPIs ──────────────────────────────────────────────
  textParts.push(rgSectionHeader('สรุปค่าใช้จ่าย' +
    (options.year ? ' ปี ' + options.year : ''), '📊'));
  textParts.push(_buildKPIBlock(kpi));

  // ── Monthly breakdown ─────────────────────────────────
  textParts.push(rgSectionHeader('ค่าใช้จ่ายรายเดือน', '📅'));
  if (monthlyRows.length > 0) {
    textParts.push(rgBuildTable(
      ['เดือน', 'ค่าไฟ (บาท)', 'ค่าน้ำ (บาท)', 'รวม (บาท)', 'บิล'],
      monthlyRows.map(function(r) {
        return [
          RG_MONTHS_SHORT[r.month - 1] + ' ' + r.year,
          _fmtNum(r.elec_amount),
          _fmtNum(r.water_amount),
          _fmtNum(r.total_amount),
          r.bill_count,
        ];
      }),
      [12, 14, 14, 14, 6]
    ));
  } else {
    textParts.push('  (ไม่มีข้อมูล)');
  }

  // ── Meters ─────────────────────────────────────────────
  textParts.push(rgSectionHeader('รายการมิเตอร์ (' + siteMeters.length + ' เครื่อง)', '🔌'));
  if (siteMeters.length > 0) {
    textParts.push(rgBuildTable(
      ['รหัสมิเตอร์', 'เลขมิเตอร์', 'ประเภท', 'ผู้ให้บริการ', 'สถานะ'],
      siteMeters.map(function(m) {
        return [
          m.meter_id,
          m.meter_number || '-',
          RG_METER_TYPE_TH[m.meter_type] || m.meter_type || '-',
          m.provider || '-',
          _translateStatus(m.meter_status),
        ];
      }),
      [14, 14, 10, 16, 10]
    ));
  } else {
    textParts.push('  (ไม่มีมิเตอร์)');
  }

  // ── Anomalies ─────────────────────────────────────────
  if (siteAnomalies.length > 0) {
    textParts.push(rgSectionHeader(
      'ประวัติความผิดปกติ (' + siteAnomalies.length + ' รายการ)', '⚠️'));
    textParts.push(rgBuildTable(
      ['วันที่', 'ประเภท', 'ระดับ', 'ค่าที่ตรวจพบ', 'ข้อความ'],
      siteAnomalies.slice(0, 15).map(function(a) {
        return [
          (a.created_at || '').substring(0, 10),
          a.anomaly_type  || '-',
          a.severity      || '-',
          _fmtNum(a.current_value),
          _truncate(a.message || '', 25),
        ];
      }),
      [12, 14, 10, 14, 25]
    ));
  }

  textParts.push(rgBuildFooter());

  var summary = {
    site_id:      site.site_id,
    site_name:    site.site_name,
    total_amount: kpi.total_amount,
    elec_amount:  kpi.elec_amount,
    water_amount: kpi.water_amount,
    bill_count:   siteBills.length,
    meter_count:  siteMeters.length,
    anomaly_count: siteAnomalies.length,
  };

  return {
    text:     textParts.join('\n'),
    summary:  summary,
    rows:     monthlyRows,
    metadata: { site_id: site.site_id, bill_count: siteBills.length },
  };
}


// ============================================================
// SECTION 6 — WATER / ELECTRICITY REPORT BUILDERS
// ============================================================

/**
 * สร้างรายงานน้ำ (Water Report)
 * structure เหมือน Monthly แต่แสดงเฉพาะ WATER meters
 *
 * @param {Object[]} waterBills   — บิลน้ำ (filtered แล้ว)
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @returns {{ text, summary, rows, metadata }}
 */
function rgBuildWaterContent(waterBills, sites, meters, options) {
  options = options || {};
  return _buildUtilityTypeContent(
    waterBills, sites, meters, options,
    'WATER', 'รายงานค่าน้ำประปา', '💧'
  );
}

/**
 * สร้างรายงานไฟฟ้า (Electricity Report)
 *
 * @param {Object[]} elecBills    — บิลไฟฟ้า (filtered แล้ว)
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @returns {{ text, summary, rows, metadata }}
 */
function rgBuildElectricityContent(elecBills, sites, meters, options) {
  options = options || {};
  return _buildUtilityTypeContent(
    elecBills, sites, meters, options,
    'ELECTRICITY', 'รายงานค่าไฟฟ้า', '⚡'
  );
}

/**
 * Generic builder สำหรับ Water / Electricity report
 * ใช้ร่วมกันเพื่อหลีกเลี่ยงโค้ดซ้ำ (DRY principle)
 * @private
 */
function _buildUtilityTypeContent(bills, sites, meters, options, meterType, title, icon) {
  var meterMap      = _buildMeterMapLocal(meters);
  var siteMap       = _buildSiteMapLocal(sites);
  var kpi           = _calcBillKPIs(bills, meterMap);
  var siteBreakdown = _aggregateBySite(bills, meterMap, siteMap);
  siteBreakdown.sort(function(a, b) { return b.total_amount - a.total_amount; });

  var period = '';
  if (options.year && options.month) {
    period = RG_MONTHS_TH[options.month - 1] + ' พ.ศ. ' + options.year;
  } else if (options.year) {
    period = 'ปี พ.ศ. ' + options.year;
  } else {
    period = 'ทุกช่วงเวลา';
  }

  var textParts = [];

  textParts.push(rgBuildHeader(
    title,
    'ประจำ' + period,
    {
      period:       period,
      meter_type:   meterType,
      generated_at: new Date(),
    }
  ));

  // ── KPIs ──────────────────────────────────────────────
  textParts.push(rgSectionHeader('สรุปภาพรวม', icon));
  textParts.push('  จำนวนบิล    : ' + bills.length + ' รายการ');
  textParts.push('  รวมหน่วย    : ' + _fmtNum(kpi.total_units) + ' หน่วย');
  textParts.push('  รวมค่าใช้จ่าย: ' + rgFormatBaht(kpi.total_amount));
  textParts.push('  เฉลี่ย/บิล  : ' + rgFormatBaht(kpi.avg_per_bill));
  textParts.push('  ชำระแล้ว    : ' + kpi.paid_count + ' รายการ');
  textParts.push('  ยังไม่ชำระ  : ' + kpi.unpaid_count + ' รายการ');
  textParts.push('');

  // ── แยก site ─────────────────────────────────────────
  textParts.push(rgSectionHeader('สรุปแยกตามสถานที่', '🏢'));
  if (siteBreakdown.length > 0) {
    var amtField   = meterType === 'WATER' ? 'water_amount' : 'elec_amount';
    var unitField  = meterType === 'WATER' ? 'water_units'  : 'elec_units';
    textParts.push(rgBuildTable(
      ['สถานที่', 'หน่วยรวม', 'ค่าใช้จ่าย (บาท)', 'ราคา/หน่วย', 'สถานะ'],
      siteBreakdown.map(function(s) {
        var unitsCost = s.total_units > 0
          ? (s.total_amount / s.total_units).toFixed(2)
          : '-';
        return [
          _truncate(s.site_name, 20),
          _fmtNum(s[unitField] || s.total_units),
          _fmtNum(s[amtField]  || s.total_amount),
          unitsCost,
          s.bill_count + ' บิล',
        ];
      }),
      [20, 12, 18, 12, 10]
    ));
  } else {
    textParts.push('  (ไม่มีข้อมูล)');
  }

  // ── Monthly trend (ถ้ามีหลายเดือน) ──────────────────
  var monthlyRows = _buildMonthlyBreakdown(bills, meterMap);
  if (monthlyRows.length > 1) {
    textParts.push(rgSectionHeader('แนวโน้มรายเดือน', '📈'));
    var amtKey = meterType === 'WATER' ? 'water_amount' : 'elec_amount';
    textParts.push(rgBuildTable(
      ['เดือน', 'จำนวนบิล', 'หน่วยรวม', 'ค่าใช้จ่าย (บาท)'],
      monthlyRows.map(function(r) {
        return [
          RG_MONTHS_SHORT[r.month - 1] + ' ' + r.year,
          r.bill_count,
          _fmtNum(r.total_units),
          _fmtNum(r[amtKey] || r.total_amount),
        ];
      }),
      [12, 10, 12, 18]
    ));
  }

  textParts.push(rgBuildFooter());

  var summary = {
    meter_type:   meterType,
    period:       period,
    total_amount: kpi.total_amount,
    total_units:  kpi.total_units,
    bill_count:   bills.length,
    site_count:   siteBreakdown.length,
  };

  return {
    text:     textParts.join('\n'),
    summary:  summary,
    rows:     siteBreakdown,
    metadata: { meter_type: meterType, bill_count: bills.length },
  };
}


// ============================================================
// SECTION 7 — DATA AGGREGATION HELPERS
// ============================================================

/**
 * คำนวณ KPI รวมจาก bills
 * @param {Object[]} bills
 * @param {Object}   meterMap
 * @returns {Object} KPI object
 * @private
 */
function _calcBillKPIs(bills, meterMap) {
  var totalAmount  = 0;
  var elecAmount   = 0;
  var waterAmount  = 0;
  var totalUnits   = 0;
  var elecUnits    = 0;
  var waterUnits   = 0;
  var paidCount    = 0;
  var unpaidCount  = 0;

  (bills || []).forEach(function(b) {
    var amt   = parseFloat(b.amount_total || 0);
    var units = parseFloat(b.units_used   || 0);
    var meter = meterMap[b.meter_id]      || {};
    var type  = meter.meter_type || b.meter_type || 'ELECTRICITY';

    totalAmount += amt;
    totalUnits  += units;

    if (type === 'WATER') {
      waterAmount += amt;
      waterUnits  += units;
    } else if (type === 'ELECTRICITY') {
      elecAmount  += amt;
      elecUnits   += units;
    }

    if (b.bill_status === 'PAID') {
      paidCount++;
    } else if (b.bill_status !== 'CANCELLED') {
      unpaidCount++;
    }
  });

  var totalBills = bills ? bills.length : 0;
  return {
    total_amount:  _round2(totalAmount),
    elec_amount:   _round2(elecAmount),
    water_amount:  _round2(waterAmount),
    total_units:   _round2(totalUnits),
    elec_units:    _round2(elecUnits),
    water_units:   _round2(waterUnits),
    total_bills:   totalBills,
    paid_count:    paidCount,
    unpaid_count:  unpaidCount,
    avg_per_bill:  totalBills > 0 ? _round2(totalAmount / totalBills) : 0,
  };
}

/**
 * Aggregate bills ต่อ site
 * @param {Object[]} bills
 * @param {Object}   meterMap
 * @param {Object}   siteMap
 * @returns {Object[]}
 * @private
 */
function _aggregateBySite(bills, meterMap, siteMap) {
  var groups = {};

  (bills || []).forEach(function(b) {
    var sid   = b.site_id || 'UNKNOWN';
    var meter = meterMap[b.meter_id] || {};
    var type  = meter.meter_type || b.meter_type || 'ELECTRICITY';
    var amt   = parseFloat(b.amount_total || 0);
    var units = parseFloat(b.units_used   || 0);

    if (!groups[sid]) {
      groups[sid] = {
        site_id:      sid,
        site_name:    siteMap[sid] ? siteMap[sid].site_name : sid,
        total_amount: 0,
        elec_amount:  0,
        water_amount: 0,
        total_units:  0,
        elec_units:   0,
        water_units:  0,
        bill_count:   0,
      };
    }

    groups[sid].total_amount += amt;
    groups[sid].total_units  += units;
    groups[sid].bill_count++;

    if (type === 'WATER') {
      groups[sid].water_amount += amt;
      groups[sid].water_units  += units;
    } else {
      groups[sid].elec_amount  += amt;
      groups[sid].elec_units   += units;
    }
  });

  return Object.values(groups).map(function(s) {
    s.total_amount = _round2(s.total_amount);
    s.elec_amount  = _round2(s.elec_amount);
    s.water_amount = _round2(s.water_amount);
    return s;
  });
}

/**
 * Aggregate bills ต่อ meter_type
 * @param {Object[]} bills
 * @param {Object}   meterMap
 * @returns {Object[]}
 * @private
 */
function _aggregateByMeterType(bills, meterMap) {
  var groups = {};

  (bills || []).forEach(function(b) {
    var meter = meterMap[b.meter_id] || {};
    var type  = meter.meter_type || b.meter_type || 'ELECTRICITY';
    var amt   = parseFloat(b.amount_total || 0);
    var units = parseFloat(b.units_used   || 0);

    if (!groups[type]) {
      groups[type] = { meter_type: type, total_amount: 0, total_units: 0, bill_count: 0 };
    }

    groups[type].total_amount += amt;
    groups[type].total_units  += units;
    groups[type].bill_count++;
  });

  return Object.values(groups).map(function(t) {
    t.total_amount = _round2(t.total_amount);
    t.total_units  = _round2(t.total_units);
    t.avg_per_bill = t.bill_count > 0 ? _round2(t.total_amount / t.bill_count) : 0;
    return t;
  });
}

/**
 * สร้าง monthly breakdown (เรียงตามเดือน)
 * @param {Object[]} bills
 * @param {Object}   meterMap
 * @returns {Object[]}  — เรียงตาม year, month
 * @private
 */
function _buildMonthlyBreakdown(bills, meterMap) {
  var groups = {};

  (bills || []).forEach(function(b) {
    var year  = parseInt(b.bill_year  || 0);
    var month = parseInt(b.bill_month || 0);
    var key   = year + '_' + ('0' + month).slice(-2);
    var meter = meterMap[b.meter_id] || {};
    var type  = meter.meter_type || b.meter_type || 'ELECTRICITY';
    var amt   = parseFloat(b.amount_total || 0);
    var units = parseFloat(b.units_used   || 0);

    if (!groups[key]) {
      groups[key] = {
        key:          key,
        year:         year,
        month:        month,
        total_amount: 0,
        elec_amount:  0,
        water_amount: 0,
        total_units:  0,
        bill_count:   0,
      };
    }

    groups[key].total_amount += amt;
    groups[key].total_units  += units;
    groups[key].bill_count++;

    if (type === 'WATER') {
      groups[key].water_amount += amt;
    } else {
      groups[key].elec_amount  += amt;
    }
  });

  return Object.values(groups)
    .sort(function(a, b) {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    })
    .map(function(r) {
      r.total_amount = _round2(r.total_amount);
      r.elec_amount  = _round2(r.elec_amount);
      r.water_amount = _round2(r.water_amount);
      return r;
    });
}

/**
 * สร้างข้อมูล 6 เดือนล่าสุด (สำหรับ executive trend)
 * @param {Object[]} bills
 * @param {Object}   meterMap
 * @returns {Object[]}
 * @private
 */
function _buildLast6MonthsTrend(bills, meterMap) {
  var monthly = _buildMonthlyBreakdown(bills, meterMap);
  // คืน 6 เดือนล่าสุด
  return monthly.slice(-6);
}

/**
 * คำนวณ % เปลี่ยนแปลง YoY
 * @param {number} current
 * @param {number} previous
 * @returns {number|null}
 * @private
 */
function _calcYoYPct(current, previous) {
  if (!previous || previous === 0) return null;
  return _round2(((current - previous) / previous) * 100);
}

/**
 * หาปีล่าสุดจาก bills (local version)
 * @private
 */
function _getLatestYearLocal(bills) {
  if (!bills || bills.length === 0) return new Date().getFullYear() + 543;
  var years = bills.map(function(b) { return parseInt(b.bill_year) || 0; });
  return Math.max.apply(null, years);
}

/**
 * สร้าง meterMap local (ไม่พึ่ง TrendCalculator)
 * @private
 */
function _buildMeterMapLocal(meters) {
  var map = {};
  (meters || []).forEach(function(m) { map[m.meter_id] = m; });
  return map;
}

/**
 * สร้าง siteMap local
 * @private
 */
function _buildSiteMapLocal(sites) {
  var map = {};
  (sites || []).forEach(function(s) { map[s.site_id] = s; });
  return map;
}


// ============================================================
// SECTION 8 — TEXT FORMATTING HELPERS
// ============================================================

/**
 * สร้าง KPI block text (ใช้ร่วมกันหลาย report)
 * @param {Object} kpi
 * @returns {string}
 * @private
 */
function _buildKPIBlock(kpi) {
  var lines = [];
  lines.push('  💰 รวมค่าใช้จ่าย    : ' + rgFormatBaht(kpi.total_amount));
  lines.push('  ⚡ ค่าไฟฟ้า         : ' + rgFormatBaht(kpi.elec_amount) +
             '  (' + _fmtNum(kpi.elec_units)  + ' kWh)');
  lines.push('  💧 ค่าน้ำประปา      : ' + rgFormatBaht(kpi.water_amount) +
             '  (' + _fmtNum(kpi.water_units) + ' ลบ.ม.)');
  lines.push('  📋 จำนวนบิล         : ' + kpi.total_bills + ' รายการ');
  lines.push('  ✅ ชำระแล้ว         : ' + kpi.paid_count + ' รายการ');
  lines.push('  ⏳ ยังไม่ชำระ       : ' + kpi.unpaid_count + ' รายการ');
  lines.push('  📊 เฉลี่ย/บิล       : ' + rgFormatBaht(kpi.avg_per_bill));
  lines.push('');
  return lines.join('\n');
}

/**
 * จัดข้อความให้อยู่กึ่งกลาง
 * @private
 */
function _center(text, width) {
  var len    = _strWidth(text);
  var pad    = Math.max(0, Math.floor((width - len) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * ประมาณความกว้างของ string (Thai chars กว้าง 2 ใน terminal)
 * @private
 */
function _strWidth(str) {
  if (!str) return 0;
  var w = 0;
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    // Thai unicode range: U+0E00–U+0E7F
    w += (code >= 0x0E00 && code <= 0x0E7F) ? 2 : 1;
  }
  return w;
}

/**
 * Pad string ทางขวาให้ครบ width (คำนวณ Thai width)
 * @private
 */
function _padRight(str, width) {
  var current = _strWidth(str);
  var needed  = Math.max(0, width - current);
  return str + ' '.repeat(needed);
}

/**
 * ตัด string ถ้ายาวเกิน maxLen
 * @private
 */
function _truncate(str, maxLen) {
  if (!str) return '';
  // นับแบบ Thai-aware
  var result = '';
  var w      = 0;
  for (var i = 0; i < str.length; i++) {
    var code   = str.charCodeAt(i);
    var cw     = (code >= 0x0E00 && code <= 0x0E7F) ? 2 : 1;
    if (w + cw > maxLen - 1) { result += '…'; break; }
    result += str[i];
    w      += cw;
  }
  return result;
}

/**
 * Format ตัวเลข สำหรับตาราง
 * @private
 */
function _fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('th-TH', {
    minimumFractionDigits:  2,
    maximumFractionDigits:  2,
  });
}

/**
 * Round ทศนิยม 2 ตำแหน่ง
 * @private
 */
function _round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

/**
 * แปล bill_status เป็นไทย
 * @private
 */
function _translateStatus(status) {
  var map = {
    PENDING:         'รอดำเนินการ',
    PENDING_REVIEW:  'รอตรวจสอบ',
    APPROVED:        'อนุมัติแล้ว',
    PAID:            'ชำระแล้ว',
    CANCELLED:       'ยกเลิก',
    ACTIVE:          'ใช้งาน',
    INACTIVE:        'ไม่ใช้งาน',
  };
  return map[status] || (status || '-');
}

/**
 * Format วันเวลาแบบไทย
 * @private
 */
function _formatDateTimeTH(dateInput) {
  try {
    var d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    var day   = ('0' + d.getDate()).slice(-2);
    var month = ('0' + (d.getMonth() + 1)).slice(-2);
    var year  = d.getFullYear() + 543; // แปลงเป็น พ.ศ.
    var hour  = ('0' + d.getHours()).slice(-2);
    var min   = ('0' + d.getMinutes()).slice(-2);
    return day + '/' + month + '/' + year + ' ' + hour + ':' + min + ' น.';
  } catch (e) {
    return String(dateInput);
  }
}
