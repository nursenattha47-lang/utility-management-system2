// ============================================================
// ExcelExport.gs — Excel Export Engine
// UtilityManager | PHASE 6C — Excel Export Engine
// ============================================================
// รับผิดชอบ:
//   1. สร้าง Monthly Excel Export (รายเดือน รวมทุก site)
//   2. สร้าง Yearly Excel Export  (รายปี เปรียบเทียบ YoY)
//   3. Multi-sheet Export (Summary + แยก sheet ตามประเภท)
//   4. Site-Separated Sheets (1 sheet ต่อ 1 site)
//   5. Auto-formatting (header, number, date, Thai font)
//   6. Formula Preservation (SUM, AVERAGE, % change ฯลฯ)
//   7. Summary Sheet Generation (KPI, grand total)
// ============================================================
// Dependencies (ต้อง load ก่อนไฟล์นี้):
//   Config.gs          — CONFIG, getConfig(), getSpreadsheet()
//   Utils.gs           — log(), generateId(), nowISO()
//   Auth.gs            — requireAuth()
//   ReportService.gs   — RS_CONFIG, _loadReportData() (via xlLoadData)
//   TrendCalculator.gs — tcLoadAllData(), tcFilterValidBills(),
//                        tcBuildMeterMap(), tcBuildSiteMap(),
//                        tcGroupBySite(), tcFilterByMeterType()
// ============================================================
// Public API:
//   xlExportMonthly(token, options)   → ExcelResult
//   xlExportYearly(token, options)    → ExcelResult
//   xlExportMultiSheet(token, options)→ ExcelResult
//   xlExportBySite(token, options)    → ExcelResult
//   xlGetDownloadUrl(fileId)          → string
//   xlDeleteFile(fileId)              → boolean
// ============================================================
// Response shape (ทุก xlExport* function):
// {
//   success:      boolean,
//   export_id:    string,     — XL_YYYYMMDD_xxxxx
//   file_id:      string,     — Google Drive file ID
//   filename:     string,     — ชื่อไฟล์ .xlsx
//   download_url: string,
//   folder_id:    string,
//   sheet_count:  number,     — จำนวน sheet ที่สร้าง
//   row_count:    number,     — จำนวน row ข้อมูลทั้งหมด
//   generated_at: string,
//   duration_ms:  number,
//   error?:       string,
// }
// ============================================================

'use strict';

// ============================================================
// SECTION 1 — EXCEL ENGINE CONFIGURATION
// ============================================================

/**
 * Config เฉพาะของ Excel Export Engine
 * แก้ไขได้โดยไม่กระทบโค้ดอื่น
 */
var XL_CONFIG = {

  // ── Branding ────────────────────────────────────────────
  COMPANY_NAME:    'UtilityManager',
  COMPANY_SUB:     'ระบบบริหารจัดการสาธารณูปโภค',
  COMPANY_VERSION: 'v6.0',

  // ── Sheet names (ภาษาไทย + English สำหรับ Summary) ────
  SHEET_NAMES: {
    SUMMARY:     'สรุปภาพรวม',
    MONTHLY:     'รายเดือน',
    YEARLY:      'รายปี',
    ELECTRICITY: 'ไฟฟ้า',
    WATER:       'น้ำประปา',
    SITE_PREFIX: 'สถานที่_',   // prefix สำหรับ site sheets
    RAW_DATA:    'ข้อมูลดิบ',
  },

  // ── Drive Subfolder ────────────────────────────────────
  SUBFOLDER:   'Excel',

  // ── ชื่อเดือนภาษาไทย ────────────────────────────────────
  MONTHS_TH: [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
    'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
    'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
  ],
  MONTHS_SHORT_TH: [
    'ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
    'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.',
  ],

  // ── สีสำหรับ Header / Rows ──────────────────────────────
  COLORS: {
    HEADER_BG:       '#1F4E79',   // Navy — header หลัก
    HEADER_FG:       '#FFFFFF',   // White
    SUBHEADER_BG:    '#2E75B6',   // Blue — sub-header
    SUBHEADER_FG:    '#FFFFFF',
    ELECTRICITY_BG:  '#FFF2CC',   // Yellow — ไฟฟ้า
    WATER_BG:        '#DDEEFF',   // Light Blue — น้ำ
    SUMMARY_BG:      '#E2EFDA',   // Green — summary row
    ALT_ROW_BG:      '#F5F5F5',   // Alternating row
    GRAND_TOTAL_BG:  '#D6E4F0',   // Grand total row
    NEGATIVE_FG:     '#C00000',   // Red — ค่าติดลบ / เกิน budget
    POSITIVE_FG:     '#375623',   // Dark Green — ค่าที่ดี
  },

  // ── Column widths (หน่วย: pixels ÷ 6 ≈ column unit) ───
  COL_WIDTHS: {
    DATE:       80,
    SITE:       200,
    METER:      150,
    TYPE:       90,
    UNITS:      100,
    AMOUNT:     120,
    RATE:       90,
    CHANGE_PCT: 90,
    NOTES:      200,
  },

  // ── จำนวน site สูงสุดที่ใส่ใน 1 export ─────────────────
  MAX_SITES_PER_EXPORT: 100,

  // ── จำนวน row สูงสุดก่อนแบ่ง chunk (ป้องกัน timeout) ──
  MAX_ROWS_PER_BATCH:   2000,

  // ── ID prefix ──────────────────────────────────────────
  ID_PREFIX: 'XL',

  // ── Freeze rows/cols ───────────────────────────────────
  FREEZE_ROWS: 3,   // freeze 3 แถวบนสุด (title + header)
  FREEZE_COLS: 2,   // freeze 2 column แรก (ลำดับ + site)
};


// ============================================================
// SECTION 2 — PUBLIC API: EXPORT FUNCTIONS
// ============================================================

/**
 * สร้าง Monthly Excel Export
 * รวมบิลทุก site ของเดือนที่ระบุ แยก sheet ตาม meter type
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year           — ปี พ.ศ. (required)
 * @param {number} options.month          — เดือน 1-12 (required)
 * @param {string} [options.site_id]      — กรองเฉพาะ site (null = ทั้งหมด)
 * @param {string} [options.meter_type]   — 'ALL'|'ELECTRICITY'|'WATER'
 * @param {boolean}[options.include_summary] — สร้าง Summary sheet (default: true)
 * @returns {Object} ExcelResult
 */
function xlExportMonthly(token, options) {
  requireAuth(token, 'canExport');
  options = _xlNormalizeOptions(options);

  if (!options.year || !options.month) {
    return _xlErrorResult('xlExportMonthly', 'ต้องระบุ year และ month');
  }

  var startTime = Date.now();
  log('INFO', 'ExcelExport', 'เริ่มสร้าง Monthly Excel: ' +
      options.year + '/' + options.month);

  try {
    // ── 1. โหลดข้อมูล ──────────────────────────────────
    var data   = _xlLoadData(options);
    var bills  = data.bills.filter(function(b) {
      return String(b.bill_year)  === String(options.year) &&
             String(b.bill_month) === String(options.month);
    });

    if (options.site_id) {
      bills = bills.filter(function(b) { return b.site_id === options.site_id; });
    }

    // ── 2. สร้าง Spreadsheet ใหม่ ──────────────────────
    var titleTh  = _xlMonthTh(options.month) + ' ' + (options.year + 543);
    var ss       = _xlCreateSpreadsheet('รายงานรายเดือน — ' + titleTh);
    var sheetLog = [];  // เก็บชื่อ sheet ที่สร้าง

    // ── 3. Summary Sheet ────────────────────────────────
    if (options.include_summary !== false) {
      var summarySheet = _xlGetOrRenameFirstSheet(ss, XL_CONFIG.SHEET_NAMES.SUMMARY);
      _xlBuildSummarySheet(summarySheet, bills, data.sites, data.meters, options, 'MONTHLY');
      sheetLog.push(XL_CONFIG.SHEET_NAMES.SUMMARY);
    }

    // ── 4. Monthly Data Sheet ───────────────────────────
    var monthSheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.MONTHLY);
    _xlBuildMonthlySheet(monthSheet, bills, data.sites, data.meters, options);
    sheetLog.push(XL_CONFIG.SHEET_NAMES.MONTHLY);

    // ── 5. แยก sheet ตาม meter type (ถ้า ALL) ──────────
    var meterType = options.meter_type || 'ALL';
    if (meterType === 'ALL' || meterType === 'ELECTRICITY') {
      var meterMap   = tcBuildMeterMap(data.meters);
      var elecBills  = tcFilterByMeterType(bills, 'ELECTRICITY', meterMap);
      if (elecBills.length > 0) {
        var elecSheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.ELECTRICITY);
        _xlBuildTypeSheet(elecSheet, elecBills, data.sites, data.meters, 'ELECTRICITY', options);
        sheetLog.push(XL_CONFIG.SHEET_NAMES.ELECTRICITY);
      }
    }
    if (meterType === 'ALL' || meterType === 'WATER') {
      var meterMap2  = tcBuildMeterMap(data.meters);
      var waterBills = tcFilterByMeterType(bills, 'WATER', meterMap2);
      if (waterBills.length > 0) {
        var waterSheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.WATER);
        _xlBuildTypeSheet(waterSheet, waterBills, data.sites, data.meters, 'WATER', options);
        sheetLog.push(XL_CONFIG.SHEET_NAMES.WATER);
      }
    }

    // ── 6. ย้าย Summary ไปเป็น sheet แรก ───────────────
    if (options.include_summary !== false) {
      ss.setActiveSheet(ss.getSheetByName(XL_CONFIG.SHEET_NAMES.SUMMARY));
      ss.moveActiveSheet(1);
    }

    // ── 7. Export เป็น .xlsx แล้วบันทึก Drive ──────────
    var filename   = _xlGenerateFilename('MONTHLY', options);
    var saveResult = _xlSaveToDrive(ss, filename);

    // ── 8. ลบ temp Spreadsheet (ไม่ต้องเก็บ Google Sheets) ─
    _xlCleanupTempSheet(ss);

    var result = _xlBuildResult(
      saveResult, filename, sheetLog.length,
      bills.length, Date.now() - startTime
    );

    log('INFO', 'ExcelExport',
        'Monthly Excel สำเร็จ: ' + result.export_id +
        ' sheets=' + sheetLog.length +
        ' rows='   + bills.length +
        ' (' + result.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ExcelExport', 'xlExportMonthly ERROR: ' + e.message);
    return _xlErrorResult('xlExportMonthly', e.message);
  }
}


/**
 * สร้าง Yearly Excel Export
 * สรุปรายปี เปรียบเทียบ YoY (Year-over-Year) ทุก site
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year           — ปีหลัก พ.ศ. (required)
 * @param {number} [options.compare_year] — ปีเปรียบเทียบ (default: year-1)
 * @param {string} [options.site_id]      — กรองเฉพาะ site
 * @param {string} [options.meter_type]   — 'ALL'|'ELECTRICITY'|'WATER'
 * @param {boolean}[options.include_monthly_breakdown] — แสดงรายเดือนด้วย (default: true)
 * @returns {Object} ExcelResult
 */
function xlExportYearly(token, options) {
  requireAuth(token, 'canExport');
  options = _xlNormalizeOptions(options);

  if (!options.year) {
    return _xlErrorResult('xlExportYearly', 'ต้องระบุ year');
  }

  options.compare_year = options.compare_year || (options.year - 1);

  var startTime = Date.now();
  log('INFO', 'ExcelExport', 'เริ่มสร้าง Yearly Excel: ' +
      options.year + ' vs ' + options.compare_year);

  try {
    // ── 1. โหลดข้อมูล 2 ปี ────────────────────────────
    var data        = _xlLoadData(options);
    var billsMain   = data.bills.filter(function(b) {
      return String(b.bill_year) === String(options.year);
    });
    var billsComp   = data.bills.filter(function(b) {
      return String(b.bill_year) === String(options.compare_year);
    });

    if (options.site_id) {
      billsMain = billsMain.filter(function(b) { return b.site_id === options.site_id; });
      billsComp = billsComp.filter(function(b) { return b.site_id === options.site_id; });
    }

    // ── 2. สร้าง Spreadsheet ────────────────────────────
    var titleTh = 'รายงานรายปี ' + (options.year + 543) +
                  ' เทียบกับ ' + (options.compare_year + 543);
    var ss      = _xlCreateSpreadsheet(titleTh);
    var sheetLog = [];

    // ── 3. Summary Sheet ────────────────────────────────
    var summarySheet = _xlGetOrRenameFirstSheet(ss, XL_CONFIG.SHEET_NAMES.SUMMARY);
    _xlBuildSummarySheet(summarySheet, billsMain, data.sites, data.meters, options, 'YEARLY');
    sheetLog.push(XL_CONFIG.SHEET_NAMES.SUMMARY);

    // ── 4. Yearly Comparison Sheet ──────────────────────
    var yearlySheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.YEARLY);
    _xlBuildYearlySheet(
      yearlySheet, billsMain, billsComp,
      data.sites, data.meters, options
    );
    sheetLog.push(XL_CONFIG.SHEET_NAMES.YEARLY);

    // ── 5. Monthly Breakdown (เดือน 1-12 ของปีหลัก) ───
    if (options.include_monthly_breakdown !== false) {
      var monthBreakSheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.MONTHLY);
      _xlBuildMonthlySheet(monthBreakSheet, billsMain, data.sites, data.meters, options);
      sheetLog.push(XL_CONFIG.SHEET_NAMES.MONTHLY);
    }

    // ── 6. แยก sheet Electricity / Water ───────────────
    var meterMap = tcBuildMeterMap(data.meters);
    ['ELECTRICITY', 'WATER'].forEach(function(mt) {
      var filtered = tcFilterByMeterType(billsMain, mt, meterMap);
      if (filtered.length > 0) {
        var sheetName = (mt === 'ELECTRICITY')
          ? XL_CONFIG.SHEET_NAMES.ELECTRICITY
          : XL_CONFIG.SHEET_NAMES.WATER;
        var typeSheet = ss.insertSheet(sheetName);
        _xlBuildTypeSheet(typeSheet, filtered, data.sites, data.meters, mt, options);
        sheetLog.push(sheetName);
      }
    });

    // ── 7. ย้าย Summary ไปหน้าแรก ──────────────────────
    ss.setActiveSheet(ss.getSheetByName(XL_CONFIG.SHEET_NAMES.SUMMARY));
    ss.moveActiveSheet(1);

    // ── 8. Export + Save ────────────────────────────────
    var filename   = _xlGenerateFilename('YEARLY', options);
    var saveResult = _xlSaveToDrive(ss, filename);
    _xlCleanupTempSheet(ss);

    var result = _xlBuildResult(
      saveResult, filename, sheetLog.length,
      billsMain.length, Date.now() - startTime
    );

    log('INFO', 'ExcelExport',
        'Yearly Excel สำเร็จ: ' + result.export_id +
        ' sheets=' + sheetLog.length + ' (' + result.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ExcelExport', 'xlExportYearly ERROR: ' + e.message);
    return _xlErrorResult('xlExportYearly', e.message);
  }
}


/**
 * Multi-Sheet Export — ทุก report type ใน workbook เดียว
 * เหมาะสำหรับ Export ครบถ้วน ส่งผู้บริหาร
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year            — ปีหลัก (required)
 * @param {number} [options.month]         — ถ้าระบุ: export รายเดือน + yearly
 * @param {number} [options.compare_year]  — ปีเปรียบเทียบ
 * @param {string} [options.meter_type]    — 'ALL'|'ELECTRICITY'|'WATER'
 * @returns {Object} ExcelResult
 */
function xlExportMultiSheet(token, options) {
  requireAuth(token, 'canExport');
  options = _xlNormalizeOptions(options);

  if (!options.year) {
    return _xlErrorResult('xlExportMultiSheet', 'ต้องระบุ year');
  }

  options.compare_year = options.compare_year || (options.year - 1);

  var startTime = Date.now();
  log('INFO', 'ExcelExport', 'เริ่มสร้าง Multi-Sheet Excel: ' + options.year);

  try {
    var data      = _xlLoadData(options);
    var allBills  = data.bills;
    var meterMap  = tcBuildMeterMap(data.meters);

    // กรองตามปี
    var billsMain = allBills.filter(function(b) {
      return String(b.bill_year) === String(options.year);
    });
    var billsComp = allBills.filter(function(b) {
      return String(b.bill_year) === String(options.compare_year);
    });

    var titleTh = 'รายงานครบถ้วน ปี ' + (options.year + 543);
    var ss      = _xlCreateSpreadsheet(titleTh);
    var sheetLog = [];
    var totalRows = 0;

    // ── Sheet 1: Summary ────────────────────────────────
    var summarySheet = _xlGetOrRenameFirstSheet(ss, XL_CONFIG.SHEET_NAMES.SUMMARY);
    _xlBuildSummarySheet(summarySheet, billsMain, data.sites, data.meters, options, 'MULTI');
    sheetLog.push(XL_CONFIG.SHEET_NAMES.SUMMARY);

    // ── Sheet 2: Yearly Comparison ──────────────────────
    var yearlySheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.YEARLY);
    _xlBuildYearlySheet(yearlySheet, billsMain, billsComp, data.sites, data.meters, options);
    sheetLog.push(XL_CONFIG.SHEET_NAMES.YEARLY);
    totalRows += billsMain.length;

    // ── Sheet 3: Monthly (ของปีหลัก) ────────────────────
    var monthlySheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.MONTHLY);
    _xlBuildMonthlySheet(monthlySheet, billsMain, data.sites, data.meters, options);
    sheetLog.push(XL_CONFIG.SHEET_NAMES.MONTHLY);

    // ── Sheet 4-5: แยก meter type ─────────────────────
    ['ELECTRICITY', 'WATER'].forEach(function(mt) {
      var filtered = tcFilterByMeterType(billsMain, mt, meterMap);
      if (filtered.length > 0) {
        var sheetName = (mt === 'ELECTRICITY')
          ? XL_CONFIG.SHEET_NAMES.ELECTRICITY
          : XL_CONFIG.SHEET_NAMES.WATER;
        var typeSheet = ss.insertSheet(sheetName);
        _xlBuildTypeSheet(typeSheet, filtered, data.sites, data.meters, mt, options);
        sheetLog.push(sheetName);
        totalRows += filtered.length;
      }
    });

    // ── Sheet 6: Raw Data ────────────────────────────────
    var rawSheet = ss.insertSheet(XL_CONFIG.SHEET_NAMES.RAW_DATA);
    _xlBuildRawDataSheet(rawSheet, billsMain, data.sites, data.meters);
    sheetLog.push(XL_CONFIG.SHEET_NAMES.RAW_DATA);

    // ── ย้าย Summary ไปหน้าแรก ──────────────────────────
    ss.setActiveSheet(ss.getSheetByName(XL_CONFIG.SHEET_NAMES.SUMMARY));
    ss.moveActiveSheet(1);

    var filename   = _xlGenerateFilename('MULTI', options);
    var saveResult = _xlSaveToDrive(ss, filename);
    _xlCleanupTempSheet(ss);

    var result = _xlBuildResult(
      saveResult, filename, sheetLog.length,
      totalRows, Date.now() - startTime
    );

    log('INFO', 'ExcelExport',
        'Multi-Sheet Excel สำเร็จ: ' + result.export_id +
        ' sheets=' + sheetLog.length + ' (' + result.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ExcelExport', 'xlExportMultiSheet ERROR: ' + e.message);
    return _xlErrorResult('xlExportMultiSheet', e.message);
  }
}


/**
 * Site-Separated Export — 1 sheet ต่อ 1 site
 * เหมาะสำหรับ report ที่ต้องแยก site ชัดเจน
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year            — ปีหลัก (required)
 * @param {number} [options.month]         — ถ้าระบุ: กรองเฉพาะเดือน
 * @param {string[]} [options.site_ids]    — กรองเฉพาะบาง site (null = ทั้งหมด)
 * @param {string} [options.meter_type]    — 'ALL'|'ELECTRICITY'|'WATER'
 * @returns {Object} ExcelResult
 */
function xlExportBySite(token, options) {
  requireAuth(token, 'canExport');
  options = _xlNormalizeOptions(options);

  if (!options.year) {
    return _xlErrorResult('xlExportBySite', 'ต้องระบุ year');
  }

  var startTime = Date.now();
  log('INFO', 'ExcelExport', 'เริ่มสร้าง Site-Separated Excel: ' + options.year);

  try {
    var data     = _xlLoadData(options);
    var siteMap  = tcBuildSiteMap(data.sites);
    var meterMap = tcBuildMeterMap(data.meters);

    // กรองบิลตามปี (และเดือนถ้าระบุ)
    var bills = data.bills.filter(function(b) {
      if (String(b.bill_year) !== String(options.year)) return false;
      if (options.month && String(b.bill_month) !== String(options.month)) return false;
      return true;
    });

    // กรอง meter type
    if (options.meter_type && options.meter_type !== 'ALL') {
      bills = tcFilterByMeterType(bills, options.meter_type, meterMap);
    }

    // จัดกลุ่มตาม site
    var siteGroups = tcGroupBySite(bills);
    var siteIds    = Object.keys(siteGroups);

    // กรองเฉพาะ site ที่ระบุ (ถ้ามี)
    if (options.site_ids && options.site_ids.length > 0) {
      siteIds = siteIds.filter(function(sid) {
        return options.site_ids.indexOf(sid) !== -1;
      });
    }

    // จำกัด site สูงสุด (ป้องกัน timeout)
    if (siteIds.length > XL_CONFIG.MAX_SITES_PER_EXPORT) {
      log('WARN', 'ExcelExport',
          'จำนวน site (' + siteIds.length + ') เกิน MAX_SITES_PER_EXPORT (' +
          XL_CONFIG.MAX_SITES_PER_EXPORT + ') — ตัดเหลือ ' + XL_CONFIG.MAX_SITES_PER_EXPORT);
      siteIds = siteIds.slice(0, XL_CONFIG.MAX_SITES_PER_EXPORT);
    }

    var periodTh = options.month
      ? _xlMonthTh(options.month) + ' ' + (options.year + 543)
      : 'ปี ' + (options.year + 543);
    var ss       = _xlCreateSpreadsheet('รายงานแยกสถานที่ — ' + periodTh);
    var sheetLog = [];
    var totalRows = 0;

    // ── Sheet 1: Summary รวมทุก site ────────────────────
    var summarySheet = _xlGetOrRenameFirstSheet(ss, XL_CONFIG.SHEET_NAMES.SUMMARY);
    _xlBuildSummarySheet(summarySheet, bills, data.sites, data.meters, options, 'SITE');
    sheetLog.push(XL_CONFIG.SHEET_NAMES.SUMMARY);

    // ── สร้าง 1 sheet ต่อ 1 site ─────────────────────────
    siteIds.forEach(function(siteId) {
      var siteBills = siteGroups[siteId] || [];
      if (siteBills.length === 0) return;

      var siteObj  = siteMap[siteId] || {};
      var siteName = siteObj.site_name || siteId;

      // ทำความสะอาดชื่อ sheet (Google Sheets จำกัด 100 ตัวอักษร + ห้ามมี :/\?*[])
      var sheetName = _xlSanitizeSheetName(
        XL_CONFIG.SHEET_NAMES.SITE_PREFIX + siteName, siteId
      );

      var siteSheet = ss.insertSheet(sheetName);
      _xlBuildSiteSheet(siteSheet, siteBills, siteObj, data.meters, options);
      sheetLog.push(sheetName);
      totalRows += siteBills.length;
    });

    // ── ย้าย Summary ไปหน้าแรก ──────────────────────────
    ss.setActiveSheet(ss.getSheetByName(XL_CONFIG.SHEET_NAMES.SUMMARY));
    ss.moveActiveSheet(1);

    var filename   = _xlGenerateFilename('SITE', options);
    var saveResult = _xlSaveToDrive(ss, filename);
    _xlCleanupTempSheet(ss);

    var result = _xlBuildResult(
      saveResult, filename, sheetLog.length,
      totalRows, Date.now() - startTime
    );

    log('INFO', 'ExcelExport',
        'Site-Separated Excel สำเร็จ: ' + result.export_id +
        ' sites=' + siteIds.length +
        ' sheets=' + sheetLog.length + ' (' + result.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ExcelExport', 'xlExportBySite ERROR: ' + e.message);
    return _xlErrorResult('xlExportBySite', e.message);
  }
}


// ============================================================
// SECTION 3 — PUBLIC API: FILE MANAGEMENT
// ============================================================

/**
 * ดึง Download URL ของ Excel file จาก Drive File ID
 *
 * @param {string} fileId
 * @returns {string|null}
 */
function xlGetDownloadUrl(fileId) {
  try {
    // URL ดาวน์โหลดตรง (export เป็น .xlsx)
    return 'https://drive.google.com/uc?export=download&id=' + fileId;
  } catch (e) {
    log('WARN', 'ExcelExport', 'xlGetDownloadUrl ERROR: ' + e.message);
    return null;
  }
}


/**
 * ลบ Excel file จาก Google Drive
 *
 * @param {string} fileId
 * @returns {boolean}
 */
function xlDeleteFile(fileId) {
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    log('INFO', 'ExcelExport', 'ลบ Excel file สำเร็จ: ' + fileId);
    return true;
  } catch (e) {
    log('ERROR', 'ExcelExport', 'xlDeleteFile ERROR: ' + e.message);
    return false;
  }
}


// ============================================================
// SECTION 4 — INTERNAL: SHEET BUILDERS
// ============================================================

/**
 * สร้าง Summary Sheet — KPI + Grand Total ทุก site
 * รองรับทุก export type: MONTHLY, YEARLY, SITE, MULTI
 *
 * @param {Sheet}    sheet
 * @param {Object[]} bills
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @param {string}   exportType  — 'MONTHLY'|'YEARLY'|'SITE'|'MULTI'
 * @private
 */
function _xlBuildSummarySheet(sheet, bills, sites, meters, options, exportType) {
  var fmt = SpreadsheetFormatter;  // alias สั้น
  var meterMap = tcBuildMeterMap(meters);
  var siteMap  = tcBuildSiteMap(sites);

  // ── Title Block (แถว 1-2) ──────────────────────────────
  _xlWriteTitleBlock(sheet, exportType, options);
  var startRow = 4;  // เริ่มข้อมูลจากแถว 4

  // ── KPI Cards (สรุป 4 ช่อง) ────────────────────────────
  var kpiRow = startRow;
  _xlWriteKPIBlock(sheet, bills, meterMap, kpiRow);
  startRow += 6;  // KPI block ใช้ 5 แถว + 1 spacer

  // ── Header: Site Summary Table ─────────────────────────
  var headers = [
    '#', 'รหัสสถานที่', 'ชื่อสถานที่',
    'ไฟฟ้า (หน่วย)', 'ไฟฟ้า (บาท)',
    'น้ำประปา (หน่วย)', 'น้ำประปา (บาท)',
    'รวม (บาท)', 'จำนวนบิล', 'หมายเหตุ',
  ];
  var headerRange = sheet.getRange(startRow, 1, 1, headers.length);
  headerRange.setValues([headers]);
  fmt.applyHeaderStyle(headerRange);

  var dataStartRow = startRow + 1;
  var dataRows = [];
  var siteGroups = tcGroupBySite(bills);
  var siteIds    = Object.keys(siteGroups).sort();
  var rowNum     = 1;

  siteIds.forEach(function(siteId) {
    var siteBills = siteGroups[siteId];
    var siteObj   = siteMap[siteId] || {};
    var siteName  = siteObj.site_name || siteId;

    // แยกบิลตาม meter type
    var elecBills  = tcFilterByMeterType(siteBills, 'ELECTRICITY', meterMap);
    var waterBills = tcFilterByMeterType(siteBills, 'WATER', meterMap);

    var elecUnits  = _xlSum(elecBills,  'units_used');
    var elecAmt    = _xlSum(elecBills,  'amount_total');
    var waterUnits = _xlSum(waterBills, 'units_used');
    var waterAmt   = _xlSum(waterBills, 'amount_total');
    var totalAmt   = elecAmt + waterAmt;

    dataRows.push([
      rowNum++,
      siteId,
      siteName,
      elecUnits,
      elecAmt,
      waterUnits,
      waterAmt,
      totalAmt,
      siteBills.length,
      '',
    ]);
  });

  if (dataRows.length > 0) {
    sheet.getRange(dataStartRow, 1, dataRows.length, headers.length)
         .setValues(dataRows);

    // ── Format columns ───────────────────────────────────
    var dataRange = sheet.getRange(dataStartRow, 1, dataRows.length, headers.length);
    fmt.applyAlternatingRows(dataRange, dataStartRow);

    // Number format สำหรับ columns หน่วย/บาท (col 4-8)
    var numCols = [4, 5, 6, 7, 8];
    numCols.forEach(function(col) {
      sheet.getRange(dataStartRow, col, dataRows.length, 1)
           .setNumberFormat('#,##0.00');
    });
  }

  // ── Grand Total Row (ใช้ FORMULA) ──────────────────────
  var grandTotalRow = dataStartRow + dataRows.length;
  if (dataRows.length > 0) {
    var lastDataRow = grandTotalRow - 1;
    var grandValues = [
      ['', 'รวมทั้งหมด', '',
       // SUM formulas สำหรับ col D-H
       '=SUM(D' + dataStartRow + ':D' + lastDataRow + ')',
       '=SUM(E' + dataStartRow + ':E' + lastDataRow + ')',
       '=SUM(F' + dataStartRow + ':F' + lastDataRow + ')',
       '=SUM(G' + dataStartRow + ':G' + lastDataRow + ')',
       '=SUM(H' + dataStartRow + ':H' + lastDataRow + ')',
       '=SUM(I' + dataStartRow + ':I' + lastDataRow + ')',
       '',
      ]
    ];
    var grandRange = sheet.getRange(grandTotalRow, 1, 1, headers.length);
    grandRange.setValues(grandValues);
    fmt.applyGrandTotalStyle(grandRange);
  }

  // ── Column widths ───────────────────────────────────────
  sheet.setColumnWidth(1, 40);   // #
  sheet.setColumnWidth(2, 100);  // รหัส
  sheet.setColumnWidth(3, 200);  // ชื่อสถานที่
  sheet.setColumnWidths(4, 6, 110); // หน่วย/บาท
  sheet.setColumnWidth(10, 200); // หมายเหตุ

  // ── Freeze rows ─────────────────────────────────────────
  sheet.setFrozenRows(startRow);

  // ── Generated At ────────────────────────────────────────
  var genRow = grandTotalRow + 2;
  sheet.getRange(genRow, 1).setValue(
    'สร้างโดย: ' + XL_CONFIG.COMPANY_NAME +
    '  |  วันที่สร้าง: ' + _xlFormatDateTimeTh(new Date())
  ).setFontColor('#888888').setFontSize(8);
}


/**
 * สร้าง Monthly Detail Sheet
 * แสดงบิลทุกใบแยกตามเดือน พร้อม running total
 *
 * @param {Sheet}    sheet
 * @param {Object[]} bills
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @private
 */
function _xlBuildMonthlySheet(sheet, bills, sites, meters, options) {
  var fmt      = SpreadsheetFormatter;
  var meterMap = tcBuildMeterMap(meters);
  var siteMap  = tcBuildSiteMap(sites);

  // ── Title ────────────────────────────────────────────────
  _xlWriteTitleBlock(sheet, 'MONTHLY_DETAIL', options);

  // ── Headers ──────────────────────────────────────────────
  var headers = [
    '#', 'เดือน', 'ปี (พ.ศ.)', 'รหัสสถานที่', 'ชื่อสถานที่',
    'รหัสมิเตอร์', 'ประเภท', 'หน่วยที่ใช้', 'ค่าใช้จ่าย (บาท)',
    'บาท/หน่วย', 'สถานะบิล', 'วันที่ครบกำหนด',
  ];
  var headerRow = 4;
  var headerRange = sheet.getRange(headerRow, 1, 1, headers.length);
  headerRange.setValues([headers]);
  fmt.applyHeaderStyle(headerRange);

  // ── เรียงบิลตาม ปี > เดือน > site ─────────────────────
  var sorted = bills.slice().sort(function(a, b) {
    if (a.bill_year  !== b.bill_year)  return a.bill_year  - b.bill_year;
    if (a.bill_month !== b.bill_month) return a.bill_month - b.bill_month;
    return (a.site_id || '').localeCompare(b.site_id || '');
  });

  var dataRows = [];
  sorted.forEach(function(bill, idx) {
    var siteObj  = siteMap[bill.site_id] || {};
    var meterObj = meterMap[bill.meter_id] || {};
    var mTypeTh  = _xlMeterTypeTh(meterObj.meter_type || bill.meter_type || '');
    var units    = parseFloat(bill.units_used   || 0);
    var amount   = parseFloat(bill.amount_total || 0);
    var cpu      = (units > 0 && amount > 0) ? (amount / units) : 0;

    dataRows.push([
      idx + 1,
      _xlMonthShortTh(bill.bill_month),
      (bill.bill_year + 543),
      bill.site_id   || '',
      siteObj.site_name  || bill.site_id || '',
      bill.meter_id  || '',
      mTypeTh,
      units,
      amount,
      cpu,
      bill.bill_status || '',
      bill.due_date    || '',
    ]);
  });

  var dataStartRow = headerRow + 1;
  if (dataRows.length > 0) {
    sheet.getRange(dataStartRow, 1, dataRows.length, headers.length)
         .setValues(dataRows);

    // Format: หน่วย (col 8), บาท (col 9), บาท/หน่วย (col 10)
    sheet.getRange(dataStartRow, 8, dataRows.length, 3)
         .setNumberFormat('#,##0.00');

    // Format: ปี (col 3)
    sheet.getRange(dataStartRow, 3, dataRows.length, 1)
         .setNumberFormat('0');

    fmt.applyAlternatingRows(
      sheet.getRange(dataStartRow, 1, dataRows.length, headers.length),
      dataStartRow
    );
  }

  // ── Total Row ─────────────────────────────────────────────
  var totalRow = dataStartRow + dataRows.length;
  if (dataRows.length > 0) {
    var lastRow = totalRow - 1;
    sheet.getRange(totalRow, 1, 1, headers.length).setValues([[
      '', 'รวม', '', '', '',  '', '',
      '=SUM(H' + dataStartRow + ':H' + lastRow + ')',
      '=SUM(I' + dataStartRow + ':I' + lastRow + ')',
      '=AVERAGE(J' + dataStartRow + ':J' + lastRow + ')',
      '', '',
    ]]);
    fmt.applyGrandTotalStyle(sheet.getRange(totalRow, 1, 1, headers.length));
  }

  // ── Auto-resize + Column widths ──────────────────────────
  sheet.setColumnWidth(1, 40);
  sheet.setColumnWidth(2, 70);
  sheet.setColumnWidth(3, 70);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 200);
  sheet.setColumnWidth(6, 130);
  sheet.setColumnWidth(7, 80);
  sheet.setColumnWidths(8, 3, 110);
  sheet.setColumnWidth(11, 100);
  sheet.setColumnWidth(12, 120);

  sheet.setFrozenRows(headerRow);
  sheet.setFrozenColumns(XL_CONFIG.FREEZE_COLS);
}


/**
 * สร้าง Yearly Comparison Sheet
 * เปรียบเทียบ YoY แยกตาม site + เดือน พร้อม % change formula
 *
 * @param {Sheet}    sheet
 * @param {Object[]} billsMain    — บิลปีหลัก
 * @param {Object[]} billsComp    — บิลปีเปรียบเทียบ
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {Object}   options
 * @private
 */
function _xlBuildYearlySheet(sheet, billsMain, billsComp, sites, meters, options) {
  var fmt     = SpreadsheetFormatter;
  var siteMap = tcBuildSiteMap(sites);

  _xlWriteTitleBlock(sheet, 'YEARLY', options);

  // ── Column headers รวม YoY columns ─────────────────────
  var yearMain = options.year + 543;
  var yearComp = options.compare_year + 543;
  var headers  = [
    '#', 'รหัสสถานที่', 'ชื่อสถานที่',
    'ปี ' + yearMain + ' (บาท)',
    'ปี ' + yearComp + ' (บาท)',
    'เปลี่ยนแปลง (บาท)',
    'เปลี่ยนแปลง (%)',
    'ปี ' + yearMain + ' (หน่วย)',
    'ปี ' + yearComp + ' (หน่วย)',
    'เปลี่ยนแปลง (หน่วย %)',
    'บิลปีปัจจุบัน',
  ];

  var headerRow   = 4;
  var headerRange = sheet.getRange(headerRow, 1, 1, headers.length);
  headerRange.setValues([headers]);
  fmt.applyHeaderStyle(headerRange);

  // Aggregate ต่อ site สำหรับทั้ง 2 ปี
  var mainMap = _xlAggregateBysite(billsMain);
  var compMap = _xlAggregateBysite(billsComp);

  // รวม site ID จากทั้ง 2 ปี (union)
  var siteIds = _xlUnionKeys(mainMap, compMap);
  var dataStartRow = headerRow + 1;
  var dataRows     = [];

  siteIds.forEach(function(siteId, idx) {
    var siteObj  = siteMap[siteId] || {};
    var siteName = siteObj.site_name || siteId;
    var mainAgg  = mainMap[siteId] || { amount: 0, units: 0, count: 0 };
    var compAgg  = compMap[siteId] || { amount: 0, units: 0, count: 0 };

    // บันทึกค่าดิบ — จะใส่ formula ใน % change cells หลัง setValues
    dataRows.push([
      idx + 1,
      siteId,
      siteName,
      mainAgg.amount,
      compAgg.amount,
      0,              // placeholder — จะถูกแทนด้วย formula
      0,              // placeholder
      mainAgg.units,
      compAgg.units,
      0,              // placeholder
      mainAgg.count,
    ]);
  });

  if (dataRows.length > 0) {
    sheet.getRange(dataStartRow, 1, dataRows.length, headers.length)
         .setValues(dataRows);

    // ── ใส่ Formulas หลัง setValues ──────────────────────
    // col F = D - E (amount change)
    // col G = (D-E)/E  (% change amount)
    // col J = (H-I)/I  (% change units)
    for (var i = 0; i < dataRows.length; i++) {
      var r    = dataStartRow + i;
      var dRef = 'D' + r;
      var eRef = 'E' + r;
      var hRef = 'H' + r;
      var iRef = 'I' + r;

      sheet.getRange(r, 6).setFormula('=' + dRef + '-' + eRef);
      sheet.getRange(r, 7).setFormula(
        '=IF(' + eRef + '<>0,(' + dRef + '-' + eRef + ')/' + eRef + ',"")'
      );
      sheet.getRange(r, 10).setFormula(
        '=IF(' + iRef + '<>0,(' + hRef + '-' + iRef + ')/' + iRef + ',"")'
      );
    }

    // Number formats
    sheet.getRange(dataStartRow, 4, dataRows.length, 3).setNumberFormat('#,##0.00');  // D-F บาท
    sheet.getRange(dataStartRow, 7, dataRows.length, 1).setNumberFormat('0.00%');     // G %
    sheet.getRange(dataStartRow, 8, dataRows.length, 2).setNumberFormat('#,##0.00');  // H-I หน่วย
    sheet.getRange(dataStartRow, 10, dataRows.length, 1).setNumberFormat('0.00%');    // J %

    fmt.applyAlternatingRows(
      sheet.getRange(dataStartRow, 1, dataRows.length, headers.length),
      dataStartRow
    );

    // Color code % change: แดง = เพิ่มขึ้น (ค่าสูงขึ้น = ไม่ดี), เขียว = ลดลง
    // (ตามธรรมชาติค่าสาธารณูปโภค — ลดลง = ดี)
    var pctColG = sheet.getRange(dataStartRow, 7, dataRows.length, 1);
    fmt.applyConditionalColorRule(pctColG, 'DECREASE_IS_GOOD');
  }

  // ── Grand Total Row ──────────────────────────────────────
  var grandRow = dataStartRow + dataRows.length;
  if (dataRows.length > 0) {
    var lastRow = grandRow - 1;
    sheet.getRange(grandRow, 1, 1, headers.length).setValues([[
      '', 'รวมทั้งหมด', '',
      '=SUM(D' + dataStartRow + ':D' + lastRow + ')',
      '=SUM(E' + dataStartRow + ':E' + lastRow + ')',
      '=SUM(F' + dataStartRow + ':F' + lastRow + ')',
      '=IF(E' + grandRow + '<>0,(D' + grandRow + '-E' + grandRow + ')/E' + grandRow + ',"")',
      '=SUM(H' + dataStartRow + ':H' + lastRow + ')',
      '=SUM(I' + dataStartRow + ':I' + lastRow + ')',
      '=IF(I' + grandRow + '<>0,(H' + grandRow + '-I' + grandRow + ')/I' + grandRow + ',"")',
      '=SUM(K' + dataStartRow + ':K' + lastRow + ')',
    ]]);
    fmt.applyGrandTotalStyle(sheet.getRange(grandRow, 1, 1, headers.length));
    sheet.getRange(grandRow, 7, 1, 1).setNumberFormat('0.00%');
    sheet.getRange(grandRow, 10, 1, 1).setNumberFormat('0.00%');
  }

  // Column widths
  sheet.setColumnWidth(1, 40);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 200);
  sheet.setColumnWidths(4, 7, 120);
  sheet.setColumnWidths(8, 3, 110);
  sheet.setColumnWidth(11, 80);
  sheet.setFrozenRows(headerRow);
  sheet.setFrozenColumns(XL_CONFIG.FREEZE_COLS);
}


/**
 * สร้าง Type Sheet (Electricity หรือ Water)
 * แสดง detail เฉพาะ meter type นั้น
 *
 * @param {Sheet}    sheet
 * @param {Object[]} bills     — บิลที่กรองแล้ว
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @param {string}   meterType — 'ELECTRICITY'|'WATER'
 * @param {Object}   options
 * @private
 */
function _xlBuildTypeSheet(sheet, bills, sites, meters, meterType, options) {
  var fmt     = SpreadsheetFormatter;
  var siteMap = tcBuildSiteMap(sites);
  var meterMap= tcBuildMeterMap(meters);

  _xlWriteTitleBlock(sheet, meterType, options);

  var headers = [
    '#', 'เดือน', 'ปี (พ.ศ.)', 'รหัสสถานที่', 'ชื่อสถานที่',
    'รหัสมิเตอร์', 'เลขมิเตอร์ต้น', 'เลขมิเตอร์ปลาย',
    'หน่วยที่ใช้', 'อัตรา (บาท/หน่วย)', 'ค่าใช้จ่าย (บาท)', 'หมายเหตุ',
  ];

  var headerRow   = 4;
  var headerRange = sheet.getRange(headerRow, 1, 1, headers.length);
  headerRange.setValues([headers]);

  // สีตาม meter type
  var bgColor = (meterType === 'ELECTRICITY')
    ? XL_CONFIG.COLORS.ELECTRICITY_BG
    : XL_CONFIG.COLORS.WATER_BG;
  fmt.applyHeaderStyle(headerRange, bgColor);

  // เรียงลำดับ
  var sorted = bills.slice().sort(function(a, b) {
    if (a.bill_year  !== b.bill_year)  return a.bill_year  - b.bill_year;
    if (a.bill_month !== b.bill_month) return a.bill_month - b.bill_month;
    return (a.site_id || '').localeCompare(b.site_id || '');
  });

  var dataRows = [];
  sorted.forEach(function(bill, idx) {
    var siteObj  = siteMap[bill.site_id]   || {};
    var meterObj = meterMap[bill.meter_id] || {};
    var units    = parseFloat(bill.units_used   || 0);
    var amount   = parseFloat(bill.amount_total || 0);
    var cpu      = (units > 0 && amount > 0) ? (amount / units) : 0;

    dataRows.push([
      idx + 1,
      _xlMonthShortTh(bill.bill_month),
      (bill.bill_year + 543),
      bill.site_id  || '',
      siteObj.site_name || bill.site_id || '',
      bill.meter_id || '',
      parseFloat(bill.reading_start || 0),
      parseFloat(bill.reading_end   || 0),
      units,
      cpu,
      amount,
      bill.notes || '',
    ]);
  });

  var dataStartRow = headerRow + 1;
  if (dataRows.length > 0) {
    sheet.getRange(dataStartRow, 1, dataRows.length, headers.length)
         .setValues(dataRows);

    // Number formats
    sheet.getRange(dataStartRow, 7, dataRows.length, 5)
         .setNumberFormat('#,##0.00');
    sheet.getRange(dataStartRow, 3, dataRows.length, 1)
         .setNumberFormat('0');

    fmt.applyAlternatingRows(
      sheet.getRange(dataStartRow, 1, dataRows.length, headers.length),
      dataStartRow, bgColor
    );
  }

  // Total Row
  var totalRow = dataStartRow + dataRows.length;
  if (dataRows.length > 0) {
    var lastRow = totalRow - 1;
    sheet.getRange(totalRow, 1, 1, headers.length).setValues([[
      '', 'รวม', '', '', '', '', '', '',
      '=SUM(I' + dataStartRow + ':I' + lastRow + ')',
      '=AVERAGE(J' + dataStartRow + ':J' + lastRow + ')',
      '=SUM(K' + dataStartRow + ':K' + lastRow + ')',
      '',
    ]]);
    fmt.applyGrandTotalStyle(sheet.getRange(totalRow, 1, 1, headers.length));
  }

  sheet.setColumnWidth(1, 40);
  sheet.setColumnWidth(2, 70);
  sheet.setColumnWidth(3, 65);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 200);
  sheet.setColumnWidth(6, 130);
  sheet.setColumnWidths(7, 5, 110);
  sheet.setColumnWidth(12, 200);
  sheet.setFrozenRows(headerRow);
  sheet.setFrozenColumns(XL_CONFIG.FREEZE_COLS);
}


/**
 * สร้าง Site-Specific Sheet — 1 site ทุก bill
 *
 * @param {Sheet}    sheet
 * @param {Object[]} bills     — บิลของ site นี้เท่านั้น
 * @param {Object}   siteObj   — site object
 * @param {Object[]} meters
 * @param {Object}   options
 * @private
 */
function _xlBuildSiteSheet(sheet, bills, siteObj, meters, options) {
  var fmt      = SpreadsheetFormatter;
  var meterMap = tcBuildMeterMap(meters);
  var siteName = siteObj.site_name || siteObj.site_id || 'ไม่ระบุ';

  // ── Title พิเศษสำหรับ site ─────────────────────────────
  sheet.getRange(1, 1).setValue(XL_CONFIG.COMPANY_NAME + ' | รายงานแยกสถานที่');
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(13)
       .setFontColor(XL_CONFIG.COLORS.HEADER_BG);

  sheet.getRange(2, 1).setValue(siteName);
  sheet.getRange(2, 1).setFontSize(11).setFontColor(XL_CONFIG.COLORS.SUBHEADER_BG);

  var headers = [
    '#', 'เดือน', 'ปี (พ.ศ.)', 'รหัสมิเตอร์', 'ประเภท',
    'หน่วยที่ใช้', 'ค่าใช้จ่าย (บาท)', 'บาท/หน่วย',
    'สถานะ', 'วันครบกำหนด', 'หมายเหตุ',
  ];

  var headerRow   = 4;
  var headerRange = sheet.getRange(headerRow, 1, 1, headers.length);
  headerRange.setValues([headers]);
  fmt.applyHeaderStyle(headerRange);

  var sorted = bills.slice().sort(function(a, b) {
    if (a.bill_year  !== b.bill_year)  return a.bill_year  - b.bill_year;
    return a.bill_month - b.bill_month;
  });

  var dataRows = [];
  sorted.forEach(function(bill, idx) {
    var meterObj = meterMap[bill.meter_id] || {};
    var units    = parseFloat(bill.units_used   || 0);
    var amount   = parseFloat(bill.amount_total || 0);
    var cpu      = (units > 0 && amount > 0) ? (amount / units) : 0;

    dataRows.push([
      idx + 1,
      _xlMonthShortTh(bill.bill_month),
      (bill.bill_year + 543),
      bill.meter_id || '',
      _xlMeterTypeTh(meterObj.meter_type || ''),
      units,
      amount,
      cpu,
      bill.bill_status || '',
      bill.due_date    || '',
      bill.notes       || '',
    ]);
  });

  var dataStartRow = headerRow + 1;
  if (dataRows.length > 0) {
    sheet.getRange(dataStartRow, 1, dataRows.length, headers.length)
         .setValues(dataRows);

    sheet.getRange(dataStartRow, 6, dataRows.length, 3)
         .setNumberFormat('#,##0.00');
    sheet.getRange(dataStartRow, 3, dataRows.length, 1)
         .setNumberFormat('0');

    fmt.applyAlternatingRows(
      sheet.getRange(dataStartRow, 1, dataRows.length, headers.length),
      dataStartRow
    );
  }

  var totalRow = dataStartRow + dataRows.length;
  if (dataRows.length > 0) {
    var lastRow = totalRow - 1;
    sheet.getRange(totalRow, 1, 1, headers.length).setValues([[
      '', 'รวม', '', '', '',
      '=SUM(F' + dataStartRow + ':F' + lastRow + ')',
      '=SUM(G' + dataStartRow + ':G' + lastRow + ')',
      '=AVERAGE(H' + dataStartRow + ':H' + lastRow + ')',
      '', '', '',
    ]]);
    fmt.applyGrandTotalStyle(sheet.getRange(totalRow, 1, 1, headers.length));
  }

  sheet.setColumnWidth(1, 40);
  sheet.setColumnWidth(2, 70);
  sheet.setColumnWidth(3, 65);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 80);
  sheet.setColumnWidths(6, 3, 110);
  sheet.setColumnWidth(9, 100);
  sheet.setColumnWidth(10, 120);
  sheet.setColumnWidth(11, 200);
  sheet.setFrozenRows(headerRow);
}


/**
 * สร้าง Raw Data Sheet — dump ข้อมูลดิบทุก field
 * ใช้สำหรับ audit / นำไปวิเคราะห์เพิ่มเติม
 *
 * @param {Sheet}    sheet
 * @param {Object[]} bills
 * @param {Object[]} sites
 * @param {Object[]} meters
 * @private
 */
function _xlBuildRawDataSheet(sheet, bills, sites, meters) {
  var fmt      = SpreadsheetFormatter;
  var siteMap  = tcBuildSiteMap(sites);
  var meterMap = tcBuildMeterMap(meters);

  sheet.getRange(1, 1).setValue('ข้อมูลดิบ (Raw Data) — ' + XL_CONFIG.COMPANY_NAME)
       .setFontWeight('bold').setFontColor(XL_CONFIG.COLORS.HEADER_BG);

  var headers = [
    'bill_id', 'site_id', 'site_name', 'meter_id', 'meter_type',
    'bill_year', 'bill_month', 'bill_year_th',
    'reading_start', 'reading_end', 'units_used',
    'rate_per_unit', 'amount_base', 'amount_tax', 'amount_total',
    'bill_status', 'due_date', 'paid_date', 'notes',
  ];

  var headerRow   = 3;
  var headerRange = sheet.getRange(headerRow, 1, 1, headers.length);
  headerRange.setValues([headers]);
  fmt.applySubHeaderStyle(headerRange);

  var dataRows = bills.slice()
    .sort(function(a, b) {
      if (a.bill_year  !== b.bill_year)  return a.bill_year  - b.bill_year;
      if (a.bill_month !== b.bill_month) return a.bill_month - b.bill_month;
      return (a.site_id || '').localeCompare(b.site_id || '');
    })
    .map(function(bill) {
      var siteObj  = siteMap[bill.site_id]   || {};
      var meterObj = meterMap[bill.meter_id] || {};
      return [
        bill.bill_id       || '',
        bill.site_id       || '',
        siteObj.site_name  || '',
        bill.meter_id      || '',
        meterObj.meter_type|| bill.meter_type || '',
        bill.bill_year     || '',
        bill.bill_month    || '',
        (bill.bill_year ? bill.bill_year + 543 : ''),
        parseFloat(bill.reading_start  || 0),
        parseFloat(bill.reading_end    || 0),
        parseFloat(bill.units_used     || 0),
        parseFloat(bill.rate_per_unit  || 0),
        parseFloat(bill.amount_base    || 0),
        parseFloat(bill.amount_tax     || 0),
        parseFloat(bill.amount_total   || 0),
        bill.bill_status   || '',
        bill.due_date      || '',
        bill.paid_date     || '',
        bill.notes         || '',
      ];
    });

  var dataStartRow = headerRow + 1;
  if (dataRows.length > 0) {
    // แบ่ง batch เพื่อป้องกัน timeout ใน large export
    _xlWriteInBatches(sheet, dataRows, dataStartRow, headers.length);

    // Number format สำหรับ numeric columns (9-15)
    sheet.getRange(dataStartRow, 9, dataRows.length, 7)
         .setNumberFormat('#,##0.00');
  }

  sheet.setFrozenRows(headerRow);
}


// ============================================================
// SECTION 5 — INTERNAL: TITLE + KPI BLOCK WRITERS
// ============================================================

/**
 * เขียน Title Block แถว 1-2 ของ sheet
 *
 * @param {Sheet}  sheet
 * @param {string} exportType
 * @param {Object} options
 * @private
 */
function _xlWriteTitleBlock(sheet, exportType, options) {
  var titleMap = {
    MONTHLY:         'รายงานค่าสาธารณูปโภค รายเดือน',
    MONTHLY_DETAIL:  'รายละเอียดค่าสาธารณูปโภค รายเดือน',
    YEARLY:          'รายงานค่าสาธารณูปโภค รายปี (เปรียบเทียบ YoY)',
    ELECTRICITY:     'รายงานค่าไฟฟ้า',
    WATER:           'รายงานค่าน้ำประปา',
    SITE:            'รายงานแยกสถานที่',
    MULTI:           'รายงานครบถ้วน (Multi-Sheet)',
  };

  var titleTh = titleMap[exportType] || exportType;

  // แถว 1: ชื่อระบบ
  sheet.getRange(1, 1).setValue(XL_CONFIG.COMPANY_NAME + ' — ' + XL_CONFIG.COMPANY_SUB)
       .setFontWeight('bold').setFontSize(12)
       .setFontColor(XL_CONFIG.COLORS.HEADER_BG);

  // แถว 2: ชื่อ report + ช่วงเวลา
  var periodLabel = _xlBuildPeriodLabel(options);
  sheet.getRange(2, 1).setValue(titleTh + (periodLabel ? '  |  ' + periodLabel : ''))
       .setFontSize(10).setFontColor(XL_CONFIG.COLORS.SUBHEADER_BG);
}


/**
 * เขียน KPI Block (5 แถว) — grand totals และ summary stats
 *
 * @param {Sheet}    sheet
 * @param {Object[]} bills
 * @param {Object}   meterMap
 * @param {number}   startRow
 * @private
 */
function _xlWriteKPIBlock(sheet, bills, meterMap, startRow) {
  var elecBills  = tcFilterByMeterType(bills, 'ELECTRICITY', meterMap);
  var waterBills = tcFilterByMeterType(bills, 'WATER', meterMap);

  var kpiData = [
    ['จำนวนบิลทั้งหมด',    bills.length,                          'รายการ'],
    ['ค่าไฟฟ้ารวม',        _xlSum(elecBills,  'amount_total'),    'บาท'],
    ['ค่าน้ำประปารวม',     _xlSum(waterBills, 'amount_total'),    'บาท'],
    ['ค่าสาธารณูปโภครวม',  _xlSum(bills,      'amount_total'),    'บาท'],
    ['หน่วยรวมทั้งหมด',    _xlSum(bills,      'units_used'),      'หน่วย'],
  ];

  kpiData.forEach(function(item, i) {
    var row = startRow + i;
    sheet.getRange(row, 1).setValue(item[0]).setFontWeight('bold')
         .setFontColor(XL_CONFIG.COLORS.HEADER_BG);
    sheet.getRange(row, 2).setValue(item[1])
         .setNumberFormat('#,##0.00')
         .setFontWeight('bold').setFontSize(12)
         .setHorizontalAlignment('right');
    sheet.getRange(row, 3).setValue(item[2])
         .setFontColor('#666666');
  });

  // Highlight ยอดรวม (แถว 4 = ค่ารวม)
  sheet.getRange(startRow + 3, 2)
       .setBackground(XL_CONFIG.COLORS.SUMMARY_BG)
       .setFontColor(XL_CONFIG.COLORS.HEADER_BG);
}


// ============================================================
// SECTION 6 — INTERNAL: GOOGLE DRIVE HELPERS
// ============================================================

/**
 * สร้าง Spreadsheet ชั่วคราวใน Drive สำหรับ build และ export
 *
 * @param {string} title
 * @returns {Spreadsheet} Google Sheets Spreadsheet object
 * @private
 */
function _xlCreateSpreadsheet(title) {
  return SpreadsheetApp.create(
    XL_CONFIG.COMPANY_NAME + ' | ' + title
  );
}


/**
 * Rename sheet แรก (Sheet1) ให้เป็นชื่อที่ต้องการ
 *
 * @param {Spreadsheet} ss
 * @param {string}      name
 * @returns {Sheet}
 * @private
 */
function _xlGetOrRenameFirstSheet(ss, name) {
  var firstSheet = ss.getSheets()[0];
  firstSheet.setName(name);
  return firstSheet;
}


/**
 * Export Spreadsheet เป็น .xlsx แล้วบันทึกลง Google Drive
 * ใช้ Drive API export URL วิธีมาตรฐาน
 *
 * @param {Spreadsheet} ss
 * @param {string}      filename    — ไม่มี extension
 * @returns {{ fileId: string, folderId: string }}
 * @private
 */
function _xlSaveToDrive(ss, filename) {
  var ssId = ss.getId();

  // ── Export Spreadsheet เป็น xlsx Blob ──────────────────
  // ใช้ Google Sheets export URL (รองรับ multi-sheet)
  var exportUrl = 'https://docs.google.com/spreadsheets/d/' + ssId +
                  '/export?format=xlsx&id=' + ssId;

  var response  = UrlFetchApp.fetch(exportUrl, {
    headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Export xlsx ล้มเหลว HTTP ' + response.getResponseCode());
  }

  var xlsxBlob = response.getBlob().setName(filename + '.xlsx');

  // ── หา/สร้าง target folder ─────────────────────────────
  var targetFolder = _xlGetOrCreateExportFolder();

  // ── บันทึกไฟล์ ─────────────────────────────────────────
  var file     = targetFolder.createFile(xlsxBlob);

  log('INFO', 'ExcelExport',
      'บันทึก Excel ลน Drive: ' + file.getId() + ' → ' + filename + '.xlsx');

  return {
    fileId:   file.getId(),
    folderId: targetFolder.getId(),
  };
}


/**
 * ลบ Spreadsheet ชั่วคราวหลัง export สำเร็จ
 * เพื่อประหยัด Drive storage
 *
 * @param {Spreadsheet} ss
 * @private
 */
function _xlCleanupTempSheet(ss) {
  try {
    DriveApp.getFileById(ss.getId()).setTrashed(true);
  } catch (e) {
    log('WARN', 'ExcelExport', '_xlCleanupTempSheet: ' + e.message);
  }
}


/**
 * ดึงหรือสร้าง Export folder ใน Drive
 * ใช้ CONFIG.FOLDERS.EXPORTS → subfolder 'Excel'
 *
 * @returns {DriveFolder}
 * @private
 */
function _xlGetOrCreateExportFolder() {
  var parentFolder;

  // ลองใช้ CONFIG.FOLDERS.EXPORTS
  try {
    var exportsFolderId = getConfig('FOLDERS.EXPORTS');
    if (exportsFolderId && exportsFolderId.length > 10) {
      parentFolder = DriveApp.getFolderById(exportsFolderId);
    }
  } catch (e) { /* ไม่มี CONFIG → ใช้ root */ }

  // Fallback: ใช้ root Drive
  if (!parentFolder) {
    parentFolder = DriveApp.getRootFolder();
  }

  // สร้าง/ดึง subfolder 'Excel'
  var subName  = XL_CONFIG.SUBFOLDER;
  var existing = parentFolder.getFoldersByName(subName);
  return existing.hasNext()
    ? existing.next()
    : parentFolder.createFolder(subName);
}


// ============================================================
// SECTION 7 — INTERNAL: DATA HELPERS
// ============================================================

/**
 * Batch load ข้อมูลทั้งหมดที่ Excel engine ต้องใช้
 * อ่าน Sheet ครั้งเดียว (ใช้ TrendCalculator batch loader)
 *
 * @param {Object} [options]
 * @returns {{ bills, sites, meters }}
 * @private
 */
function _xlLoadData(options) {
  options = options || {};
  var raw   = tcLoadAllData();
  var bills = tcFilterValidBills(raw.bills);

  // กรอง meter type ถ้าระบุ (ไม่ใช่ ALL)
  if (options.meter_type && options.meter_type !== 'ALL') {
    var meterMap = tcBuildMeterMap(raw.meters || []);
    bills = tcFilterByMeterType(bills, options.meter_type, meterMap);
  }

  return {
    bills:  bills,
    sites:  raw.sites  || [],
    meters: raw.meters || [],
  };
}


/**
 * Sum field จาก array ของ objects
 *
 * @param {Object[]} arr
 * @param {string}   field
 * @returns {number}
 * @private
 */
function _xlSum(arr, field) {
  return (arr || []).reduce(function(acc, obj) {
    return acc + parseFloat(obj[field] || 0);
  }, 0);
}


/**
 * Aggregate bills ตาม site_id
 * คืน { site_id: { amount, units, count } }
 *
 * @param {Object[]} bills
 * @returns {Object}
 * @private
 */
function _xlAggregateBysite(bills) {
  var result = {};
  (bills || []).forEach(function(b) {
    var sid = b.site_id || 'UNKNOWN';
    if (!result[sid]) result[sid] = { amount: 0, units: 0, count: 0 };
    result[sid].amount += parseFloat(b.amount_total || 0);
    result[sid].units  += parseFloat(b.units_used   || 0);
    result[sid].count  += 1;
  });
  return result;
}


/**
 * Union ของ keys จาก 2 object maps
 *
 * @param {Object} mapA
 * @param {Object} mapB
 * @returns {string[]}
 * @private
 */
function _xlUnionKeys(mapA, mapB) {
  var keySet = {};
  Object.keys(mapA).forEach(function(k) { keySet[k] = true; });
  Object.keys(mapB).forEach(function(k) { keySet[k] = true; });
  return Object.keys(keySet).sort();
}


/**
 * เขียนข้อมูลเป็น batch เพื่อป้องกัน timeout
 * แบ่งทุก MAX_ROWS_PER_BATCH แถว
 *
 * @param {Sheet}     sheet
 * @param {Array[][]} rows
 * @param {number}    startRow
 * @param {number}    numCols
 * @private
 */
function _xlWriteInBatches(sheet, rows, startRow, numCols) {
  var batchSize = XL_CONFIG.MAX_ROWS_PER_BATCH;
  var offset    = 0;

  while (offset < rows.length) {
    var batch = rows.slice(offset, offset + batchSize);
    sheet.getRange(startRow + offset, 1, batch.length, numCols)
         .setValues(batch);
    offset += batchSize;

    // Flush ทุก batch เพื่อป้องกัน memory overflow
    SpreadsheetApp.flush();
  }
}


// ============================================================
// SECTION 8 — INTERNAL: STRING / FORMAT HELPERS
// ============================================================

/**
 * ชื่อเดือนภาษาไทยเต็ม
 * @param {number} month — 1-12
 * @returns {string}
 * @private
 */
function _xlMonthTh(month) {
  return XL_CONFIG.MONTHS_TH[(month || 1) - 1] || String(month);
}


/**
 * ชื่อเดือนภาษาไทยย่อ
 * @param {number} month — 1-12
 * @returns {string}
 * @private
 */
function _xlMonthShortTh(month) {
  return XL_CONFIG.MONTHS_SHORT_TH[(month || 1) - 1] || String(month);
}


/**
 * ชื่อ meter type ภาษาไทย
 * @param {string} meterType
 * @returns {string}
 * @private
 */
function _xlMeterTypeTh(meterType) {
  var map = {
    'ELECTRICITY': 'ไฟฟ้า',
    'WATER':       'น้ำประปา',
    'ALL':         'ทุกประเภท',
  };
  return map[String(meterType).toUpperCase()] || meterType || '—';
}


/**
 * สร้าง period label ภาษาไทย จาก options
 * @param {Object} options
 * @returns {string}
 * @private
 */
function _xlBuildPeriodLabel(options) {
  if (options.month && options.year) {
    return _xlMonthTh(options.month) + ' ' + (options.year + 543);
  }
  if (options.year) {
    return 'ปี ' + (options.year + 543);
  }
  return '';
}


/**
 * Format วันเวลาภาษาไทย: "22 พฤษภาคม 2568 เวลา 14:30 น."
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _xlFormatDateTimeTh(date) {
  var d  = date.getDate();
  var m  = XL_CONFIG.MONTHS_TH[date.getMonth()];
  var y  = date.getFullYear() + 543;
  var hh = String(date.getHours()).padStart(2, '0');
  var mm = String(date.getMinutes()).padStart(2, '0');
  return d + ' ' + m + ' ' + y + ' เวลา ' + hh + ':' + mm + ' น.';
}


/**
 * สร้างชื่อไฟล์ Excel
 * รูปแบบ: UM_MONTHLY_2568_05_ม.ค._20250522_143055
 *
 * @param {string} exportType
 * @param {Object} options
 * @returns {string} filename (ไม่มี extension)
 * @private
 */
function _xlGenerateFilename(exportType, options) {
  var parts = [XL_CONFIG.COMPANY_NAME, exportType];

  if (options.year) {
    parts.push(String(options.year + 543));
  }
  if (options.month) {
    var mm   = ('0' + options.month).slice(-2);
    var mth  = XL_CONFIG.MONTHS_SHORT_TH[options.month - 1] || '';
    parts.push(mm);
    if (mth) parts.push(mth);
  }
  if (options.site_id) {
    parts.push(options.site_id);
  }

  var now  = new Date();
  var date = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd');
  var time = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HHmmss');
  parts.push(date + '_' + time);

  return parts.join('_');
}


/**
 * ทำความสะอาดชื่อ sheet
 * ลบอักขระที่ Google Sheets ไม่รองรับ + จำกัด 100 ตัวอักษร
 *
 * @param {string} name
 * @param {string} [fallback] — ใช้ถ้า name ว่างหลัง sanitize
 * @returns {string}
 * @private
 */
function _xlSanitizeSheetName(name, fallback) {
  var cleaned = String(name || '')
    .replace(/[:/\\?*[\]]/g, '_')   // อักขระต้องห้ามของ Sheets
    .replace(/\s+/g, '_')           // space → underscore
    .substring(0, 99);              // จำกัด 99 ตัวอักษร

  return cleaned.length > 0 ? cleaned : (fallback || 'Sheet');
}


// ============================================================
// SECTION 9 — INTERNAL: OPTIONS + RESPONSE HELPERS
// ============================================================

/**
 * Normalize options — ตั้งค่า default ถ้าไม่ระบุ
 *
 * @param {Object} [options]
 * @returns {Object}
 * @private
 */
function _xlNormalizeOptions(options) {
  options = options || {};
  return {
    year:                     options.year                     || null,
    month:                    options.month                    || null,
    compare_year:             options.compare_year             || null,
    site_id:                  options.site_id                  || null,
    site_ids:                 options.site_ids                 || null,
    meter_type:               String(options.meter_type || 'ALL').toUpperCase(),
    include_summary:          options.include_summary          !== false,
    include_monthly_breakdown:options.include_monthly_breakdown !== false,
    save_to_drive:            options.save_to_drive            !== false,
  };
}


/**
 * สร้าง ExcelResult จาก saveResult
 *
 * @param {{ fileId, folderId }} saveResult
 * @param {string}  filename
 * @param {number}  sheetCount
 * @param {number}  rowCount
 * @param {number}  durationMs
 * @returns {Object} ExcelResult
 * @private
 */
function _xlBuildResult(saveResult, filename, sheetCount, rowCount, durationMs) {
  var exportId = XL_CONFIG.ID_PREFIX + '_' +
                 Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd') +
                 '_' + generateId();

  return {
    success:      true,
    export_id:    exportId,
    file_id:      saveResult.fileId,
    filename:     filename + '.xlsx',
    download_url: xlGetDownloadUrl(saveResult.fileId),
    folder_id:    saveResult.folderId,
    sheet_count:  sheetCount,
    row_count:    rowCount,
    generated_at: nowISO(),
    duration_ms:  durationMs,
  };
}


/**
 * สร้าง Error result object
 *
 * @param {string} fn      — ชื่อ function ที่ error
 * @param {string} message — error message
 * @returns {Object}
 * @private
 */
function _xlErrorResult(fn, message) {
  return {
    success:      false,
    export_id:    null,
    file_id:      null,
    filename:     null,
    download_url: null,
    folder_id:    null,
    sheet_count:  0,
    row_count:    0,
    generated_at: nowISO(),
    duration_ms:  0,
    error:        '[' + fn + '] ' + message,
  };
}
