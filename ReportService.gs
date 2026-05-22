// ============================================================
// ReportService.gs — Report Service Orchestrator
// UtilityManager | PHASE 6A — Report Service
// ============================================================
// รับผิดชอบ:
//   1. Public API สำหรับทุก report type
//   2. Batch data load ครั้งเดียว (ไม่อ่าน Sheet ซ้ำ)
//   3. Coordinate ReportGenerator.gs + ReportArchive.gs
//   4. Auth validation + permission check
//   5. Auto filename generation (Thai date format)
//   6. Structured response สำหรับทุก caller
// ============================================================
// Dependencies (load order matters in GAS):
//   Config.gs          — CONFIG constants + folder IDs
//   Utils.gs           — utility helpers (generateId, nowISO, etc.)
//   Database.gs        — dbGetAll(), dbBatchInsert()
//   Auth.gs            — requireAuth()
//   TrendCalculator.gs — tcLoadAllData(), tcBuildMeterMap(),
//                        tcBuildSiteMap(), tcFilterValidBills(),
//                        tcFilterByMeterType(), tcGroupBySite()
//   ReportGenerator.gs — สร้างเนื้อหา report แต่ละประเภท
//   ReportArchive.gs   — บันทึก/ดึง/ลบ archive
// ============================================================
// Public API (เรียกจาก Code.gs หรือ Triggers.gs):
//   generateMonthlyReport(token, options)    — รายงานรายเดือน
//   generateYearlyReport(token, options)     — รายงานรายปี
//   generateExecutiveSummary(token, options) — สรุปผู้บริหาร
//   generateSiteReport(token, options)       — รายงานแยกสถานที่
//   generateWaterReport(token, options)      — รายงานน้ำ
//   generateElectricityReport(token, options)— รายงานไฟฟ้า
//   listReports(token, options)              — รายการรายงานทั้งหมด
//   getReportById(token, reportId)           — ดึง report เดียว
//   deleteReport(token, reportId)            — ลบ report
// ============================================================
// Response shape (ทุก generate function):
// {
//   success:     boolean,
//   report_id:   string,
//   report_type: string,
//   filename:    string,
//   file_id:     string,    — Google Drive file ID
//   folder_id:   string,
//   generated_at: string,
//   meta:        { ... },
//   error?:      string,
// }
// ============================================================

'use strict';

// ============================================================
// SECTION 1 — SERVICE CONFIGURATION
// ============================================================

/**
 * Config เฉพาะของ ReportService
 * ปรับได้โดยไม่กระทบโค้ดอื่น
 */
var RS_CONFIG = {

  // ── รหัสประเภท report ──────────────────────────────────
  REPORT_TYPES: {
    MONTHLY:     'MONTHLY',
    YEARLY:      'YEARLY',
    EXECUTIVE:   'EXECUTIVE',
    SITE:        'SITE',
    WATER:       'WATER',
    ELECTRICITY: 'ELECTRICITY',
  },

  // ── ชื่อ Sheet สำหรับ archive index ────────────────────
  // Sheet นี้ใช้เก็บ metadata ของ report ที่สร้างแล้ว
  ARCHIVE_SHEET: 'ReportArchive',

  // ── Folder structure ใน Google Drive ──────────────────
  // Sub-folder ภายใต้ CONFIG.FOLDERS.REPORTS
  SUBFOLDERS: {
    MONTHLY:     'Monthly',
    YEARLY:      'Annual',
    EXECUTIVE:   'Executive',
    SITE:        'Site',
    WATER:       'Water',
    ELECTRICITY: 'Electricity',
  },

  // ── ชื่อเดือนภาษาไทย ───────────────────────────────────
  MONTHS_TH: [
    'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
    'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
    'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม',
  ],

  MONTHS_SHORT_TH: [
    'ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
    'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.',
  ],

  // ── ขีดจำกัด ──────────────────────────────────────────
  MAX_SITES_PER_BATCH: 50,   // จำนวน site สูงสุดต่อ batch
  MAX_YEARS_HISTORY:   5,    // ปีย้อนหลังสูงสุดสำหรับ yearly report

  // ── ID prefix ─────────────────────────────────────────
  ID_PREFIX: 'RPT',
};


// ============================================================
// SECTION 2 — PUBLIC API: GENERATE FUNCTIONS
// ============================================================

/**
 * สร้างรายงานรายเดือน (Monthly Report)
 * รวมทุก site, แยกตามประเภทมิเตอร์
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year           — ปี พ.ศ. (required)
 * @param {number} options.month          — เดือน 1-12 (required)
 * @param {string} [options.site_id]      — กรองเฉพาะ site (null = ทั้งหมด)
 * @param {string} [options.meter_type]   — 'ALL'|'ELECTRICITY'|'WATER'
 * @param {boolean}[options.save_to_drive]— บันทึกลง Drive (default: true)
 * @returns {Object} ReportResult
 */
function generateMonthlyReport(token, options) {
  requireAuth(token, 'canExport');
  options = _normalizeReportOptions(options);

  // ตรวจสอบ parameter จำเป็น
  if (!options.year || !options.month) {
    return _errorResult('generateMonthlyReport', 'ต้องระบุ year และ month');
  }

  var startTime = Date.now();
  log('INFO', 'ReportService', 'เริ่มสร้าง Monthly Report: ' +
      options.year + '/' + options.month);

  try {
    // ── 1. Batch load data ──────────────────────────────
    var data = _loadReportData(options);

    // ── 2. กรองเฉพาะเดือนที่ต้องการ ──────────────────
    var bills = data.bills.filter(function(b) {
      return String(b.bill_year)  === String(options.year) &&
             String(b.bill_month) === String(options.month);
    });

    // ── 3. สร้างเนื้อหา report ─────────────────────────
    var content = rgBuildMonthlyContent(bills, data.sites, data.meters, options);

    // ── 4. สร้าง filename ──────────────────────────────
    var filename = rsGenerateFilename(
      RS_CONFIG.REPORT_TYPES.MONTHLY,
      { year: options.year, month: options.month, site_id: options.site_id }
    );

    // ── 5. บันทึกลง Drive + Archive ────────────────────
    var result = _saveAndArchive(
      content, filename,
      RS_CONFIG.REPORT_TYPES.MONTHLY,
      RS_CONFIG.SUBFOLDERS.MONTHLY,
      options
    );

    result.meta = {
      year:         options.year,
      month:        options.month,
      month_name:   RS_CONFIG.MONTHS_TH[options.month - 1],
      bill_count:   bills.length,
      site_count:   _countUnique(bills, 'site_id'),
      duration_ms:  Date.now() - startTime,
    };

    log('INFO', 'ReportService',
        'Monthly Report สำเร็จ: ' + result.report_id + ' (' + result.meta.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ReportService', 'generateMonthlyReport ERROR: ' + e.message);
    return _errorResult('generateMonthlyReport', e.message);
  }
}


/**
 * สร้างรายงานรายปี (Yearly Report)
 * สรุปทุกเดือนใน 1 ปี พร้อม YoY comparison
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year           — ปี พ.ศ. (required)
 * @param {number} [options.compare_year] — ปีเปรียบเทียบ (default: year-1)
 * @param {string} [options.site_id]      — กรองเฉพาะ site
 * @param {string} [options.meter_type]   — 'ALL'|'ELECTRICITY'|'WATER'
 * @param {boolean}[options.save_to_drive]
 * @returns {Object} ReportResult
 */
function generateYearlyReport(token, options) {
  requireAuth(token, 'canExport');
  options = _normalizeReportOptions(options);

  if (!options.year) {
    return _errorResult('generateYearlyReport', 'ต้องระบุ year');
  }

  // ปีเปรียบเทียบ default = ปีก่อน
  if (!options.compare_year) {
    options.compare_year = options.year - 1;
  }

  var startTime = Date.now();
  log('INFO', 'ReportService', 'เริ่มสร้าง Yearly Report: ' + options.year);

  try {
    // ── 1. Load data (รวม 2 ปีเพื่อ YoY) ──────────────
    var data = _loadReportData(options);

    // กรองบิลปีหลักและปีเปรียบเทียบ
    var billsMain    = data.bills.filter(function(b) {
      return String(b.bill_year) === String(options.year);
    });
    var billsCompare = data.bills.filter(function(b) {
      return String(b.bill_year) === String(options.compare_year);
    });

    // ── 2. สร้างเนื้อหา ────────────────────────────────
    var content = rgBuildYearlyContent(
      billsMain, billsCompare,
      data.sites, data.meters, options
    );

    // ── 3. Filename + บันทึก ───────────────────────────
    var filename = rsGenerateFilename(
      RS_CONFIG.REPORT_TYPES.YEARLY,
      { year: options.year, site_id: options.site_id }
    );

    var result = _saveAndArchive(
      content, filename,
      RS_CONFIG.REPORT_TYPES.YEARLY,
      RS_CONFIG.SUBFOLDERS.YEARLY,
      options
    );

    result.meta = {
      year:           options.year,
      compare_year:   options.compare_year,
      bill_count:     billsMain.length,
      site_count:     _countUnique(billsMain, 'site_id'),
      month_coverage: _countUnique(billsMain, 'bill_month'),
      duration_ms:    Date.now() - startTime,
    };

    log('INFO', 'ReportService',
        'Yearly Report สำเร็จ: ' + result.report_id + ' (' + result.meta.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ReportService', 'generateYearlyReport ERROR: ' + e.message);
    return _errorResult('generateYearlyReport', e.message);
  }
}


/**
 * สร้าง Executive Summary Report
 * ภาพรวมระดับผู้บริหาร: KPIs, top/bottom sites, alerts, trend
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} [options.year]         — default = ปีล่าสุดในข้อมูล
 * @param {number} [options.months]       — จำนวนเดือนย้อนหลัง (default: 12)
 * @param {boolean}[options.save_to_drive]
 * @returns {Object} ReportResult
 */
function generateExecutiveSummary(token, options) {
  requireAuth(token, 'canExport');
  options = _normalizeReportOptions(options);

  var startTime = Date.now();
  log('INFO', 'ReportService', 'เริ่มสร้าง Executive Summary');

  try {
    // ── 1. Load ข้อมูลเต็ม (ไม่กรอง site) ─────────────
    var data       = _loadReportData({ meter_type: 'ALL' });
    var allBills   = data.bills;
    var anomalies  = data.anomalies;
    var payments   = data.payments;

    // กำหนดปีหลักจากข้อมูลจริง
    if (!options.year) {
      options.year = _getLatestYear(allBills);
    }

    // ── 2. สร้างเนื้อหา Executive ──────────────────────
    var content = rgBuildExecutiveContent(
      allBills, data.sites, data.meters,
      anomalies, payments, options
    );

    // ── 3. Filename + บันทึก ───────────────────────────
    var filename = rsGenerateFilename(
      RS_CONFIG.REPORT_TYPES.EXECUTIVE,
      { year: options.year }
    );

    var result = _saveAndArchive(
      content, filename,
      RS_CONFIG.REPORT_TYPES.EXECUTIVE,
      RS_CONFIG.SUBFOLDERS.EXECUTIVE,
      options
    );

    result.meta = {
      year:          options.year,
      total_bills:   allBills.length,
      total_sites:   data.sites.length,
      total_anomaly: anomalies.length,
      duration_ms:   Date.now() - startTime,
    };

    log('INFO', 'ReportService',
        'Executive Summary สำเร็จ: ' + result.report_id + ' (' + result.meta.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ReportService', 'generateExecutiveSummary ERROR: ' + e.message);
    return _errorResult('generateExecutiveSummary', e.message);
  }
}


/**
 * สร้างรายงานแยกสถานที่ (Site-Specific Report)
 * รายละเอียดบิลทุกเดือนของ site เดียว
 *
 * @param {string} token
 * @param {Object} options
 * @param {string} options.site_id        — (required)
 * @param {number} [options.year]         — default = ปีล่าสุด
 * @param {string} [options.meter_type]   — 'ALL'|'ELECTRICITY'|'WATER'
 * @param {boolean}[options.save_to_drive]
 * @returns {Object} ReportResult
 */
function generateSiteReport(token, options) {
  requireAuth(token, 'canExport');
  options = _normalizeReportOptions(options);

  if (!options.site_id) {
    return _errorResult('generateSiteReport', 'ต้องระบุ site_id');
  }

  var startTime = Date.now();
  log('INFO', 'ReportService', 'เริ่มสร้าง Site Report: ' + options.site_id);

  try {
    var data = _loadReportData(options);

    // กรองเฉพาะ site ที่ระบุ
    var siteBills = data.bills.filter(function(b) {
      return b.site_id === options.site_id;
    });

    // กรองตามปี (ถ้าระบุ)
    if (options.year) {
      siteBills = siteBills.filter(function(b) {
        return String(b.bill_year) === String(options.year);
      });
    }

    // หาข้อมูล site
    var site = _findById(data.sites, 'site_id', options.site_id);
    if (!site) {
      return _errorResult('generateSiteReport', 'ไม่พบ site_id: ' + options.site_id);
    }

    // ── สร้างเนื้อหา ───────────────────────────────────
    var content = rgBuildSiteContent(
      siteBills, site, data.meters,
      data.anomalies, data.payments, options
    );

    var filename = rsGenerateFilename(
      RS_CONFIG.REPORT_TYPES.SITE,
      { year: options.year, site_id: options.site_id, site_name: site.site_name }
    );

    var result = _saveAndArchive(
      content, filename,
      RS_CONFIG.REPORT_TYPES.SITE,
      RS_CONFIG.SUBFOLDERS.SITE,
      options
    );

    result.meta = {
      site_id:     options.site_id,
      site_name:   site.site_name,
      year:        options.year || 'ALL',
      bill_count:  siteBills.length,
      duration_ms: Date.now() - startTime,
    };

    log('INFO', 'ReportService',
        'Site Report สำเร็จ: ' + result.report_id + ' (' + result.meta.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ReportService', 'generateSiteReport ERROR: ' + e.message);
    return _errorResult('generateSiteReport', e.message);
  }
}


/**
 * สร้างรายงานน้ำ (Water Report)
 * กรองเฉพาะมิเตอร์ประเภท WATER
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} [options.year]
 * @param {number} [options.month]        — null = ทั้งปี
 * @param {string} [options.site_id]
 * @param {boolean}[options.save_to_drive]
 * @returns {Object} ReportResult
 */
function generateWaterReport(token, options) {
  requireAuth(token, 'canExport');
  options = _normalizeReportOptions(options);
  options.meter_type = 'WATER'; // บังคับเสมอ

  var startTime = Date.now();
  log('INFO', 'ReportService', 'เริ่มสร้าง Water Report');

  try {
    var data  = _loadReportData(options);

    // กรองเฉพาะ WATER bills (ผ่าน meter_type)
    var meterMap   = tcBuildMeterMap(data.meters);
    var waterBills = tcFilterByMeterType(data.bills, 'WATER', meterMap);

    // กรองตาม year/month/site ถ้าระบุ
    waterBills = _applyBillFilters(waterBills, options);

    var content = rgBuildWaterContent(waterBills, data.sites, data.meters, options);

    var filename = rsGenerateFilename(
      RS_CONFIG.REPORT_TYPES.WATER,
      { year: options.year, month: options.month, site_id: options.site_id }
    );

    var result = _saveAndArchive(
      content, filename,
      RS_CONFIG.REPORT_TYPES.WATER,
      RS_CONFIG.SUBFOLDERS.WATER,
      options
    );

    result.meta = {
      meter_type:  'WATER',
      year:        options.year || 'ALL',
      month:       options.month || 'ALL',
      bill_count:  waterBills.length,
      site_count:  _countUnique(waterBills, 'site_id'),
      duration_ms: Date.now() - startTime,
    };

    log('INFO', 'ReportService',
        'Water Report สำเร็จ: ' + result.report_id + ' (' + result.meta.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ReportService', 'generateWaterReport ERROR: ' + e.message);
    return _errorResult('generateWaterReport', e.message);
  }
}


/**
 * สร้างรายงานไฟฟ้า (Electricity Report)
 * กรองเฉพาะมิเตอร์ประเภท ELECTRICITY
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} [options.year]
 * @param {number} [options.month]        — null = ทั้งปี
 * @param {string} [options.site_id]
 * @param {boolean}[options.save_to_drive]
 * @returns {Object} ReportResult
 */
function generateElectricityReport(token, options) {
  requireAuth(token, 'canExport');
  options = _normalizeReportOptions(options);
  options.meter_type = 'ELECTRICITY'; // บังคับเสมอ

  var startTime = Date.now();
  log('INFO', 'ReportService', 'เริ่มสร้าง Electricity Report');

  try {
    var data    = _loadReportData(options);
    var meterMap = tcBuildMeterMap(data.meters);
    var elecBills = tcFilterByMeterType(data.bills, 'ELECTRICITY', meterMap);

    elecBills = _applyBillFilters(elecBills, options);

    var content = rgBuildElectricityContent(elecBills, data.sites, data.meters, options);

    var filename = rsGenerateFilename(
      RS_CONFIG.REPORT_TYPES.ELECTRICITY,
      { year: options.year, month: options.month, site_id: options.site_id }
    );

    var result = _saveAndArchive(
      content, filename,
      RS_CONFIG.REPORT_TYPES.ELECTRICITY,
      RS_CONFIG.SUBFOLDERS.ELECTRICITY,
      options
    );

    result.meta = {
      meter_type:  'ELECTRICITY',
      year:        options.year || 'ALL',
      month:       options.month || 'ALL',
      bill_count:  elecBills.length,
      site_count:  _countUnique(elecBills, 'site_id'),
      duration_ms: Date.now() - startTime,
    };

    log('INFO', 'ReportService',
        'Electricity Report สำเร็จ: ' + result.report_id + ' (' + result.meta.duration_ms + 'ms)');
    return result;

  } catch (e) {
    log('ERROR', 'ReportService', 'generateElectricityReport ERROR: ' + e.message);
    return _errorResult('generateElectricityReport', e.message);
  }
}


// ============================================================
// SECTION 3 — PUBLIC API: ARCHIVE MANAGEMENT
// ============================================================

/**
 * ดึงรายการรายงานทั้งหมดที่สร้างแล้ว
 *
 * @param {string} token
 * @param {Object} [filters]
 * @param {string} [filters.report_type]  — กรองตามประเภท
 * @param {number} [filters.year]         — กรองตามปี
 * @param {string} [filters.site_id]      — กรองตาม site
 * @param {number} [filters.limit]        — จำนวนสูงสุด (default: 100)
 * @returns {{ success: boolean, reports: Object[], total: number }}
 */
function listReports(token, filters) {
  requireAuth(token, 'canRead');
  filters = filters || {};

  try {
    var reports = raListArchive(filters);
    return {
      success: true,
      reports: reports,
      total:   reports.length,
    };
  } catch (e) {
    log('ERROR', 'ReportService', 'listReports ERROR: ' + e.message);
    return { success: false, reports: [], total: 0, error: e.message };
  }
}


/**
 * ดึง report เดียวโดย report_id
 *
 * @param {string} token
 * @param {string} reportId
 * @returns {Object}
 */
function getReportById(token, reportId) {
  requireAuth(token, 'canRead');

  if (!reportId) {
    return _errorResult('getReportById', 'ต้องระบุ reportId');
  }

  try {
    var report = raGetById(reportId);
    if (!report) {
      return _errorResult('getReportById', 'ไม่พบ report: ' + reportId);
    }
    return { success: true, report: report };
  } catch (e) {
    log('ERROR', 'ReportService', 'getReportById ERROR: ' + e.message);
    return _errorResult('getReportById', e.message);
  }
}


/**
 * ลบ report (ลบทั้งจาก Drive และ Archive index)
 *
 * @param {string} token
 * @param {string} reportId
 * @returns {{ success: boolean, deleted_id: string }}
 */
function deleteReport(token, reportId) {
  requireAuth(token, 'canDelete');

  if (!reportId) {
    return _errorResult('deleteReport', 'ต้องระบุ reportId');
  }

  try {
    var deleted = raDeleteReport(reportId);
    log('INFO', 'ReportService', 'ลบ report: ' + reportId);
    return { success: true, deleted_id: reportId, result: deleted };
  } catch (e) {
    log('ERROR', 'ReportService', 'deleteReport ERROR: ' + e.message);
    return _errorResult('deleteReport', e.message);
  }
}


// ============================================================
// SECTION 4 — AUTO FILENAME GENERATOR (PUBLIC)
// ============================================================

/**
 * สร้างชื่อไฟล์อัตโนมัติตาม convention
 * Format: [PREFIX]_[TYPE]_[YEAR]_[MONTH]_[SITE]_[TIMESTAMP].txt
 * ตัวอย่าง:
 *   UM_MONTHLY_2568_03_มี.ค._20250315_143022.txt
 *   UM_YEARLY_2568_20250101_080000.txt
 *   UM_SITE_2568_SITE001_โรงแรม_A_20250315.txt
 *   UM_EXECUTIVE_2568_20250101.txt
 *   UM_WATER_2568_06_20250615.txt
 *
 * @param {string} reportType  — RS_CONFIG.REPORT_TYPES.*
 * @param {Object} context
 * @param {number} [context.year]
 * @param {number} [context.month]
 * @param {string} [context.site_id]
 * @param {string} [context.site_name]
 * @returns {string} filename (ไม่มี extension — จัดการใน generator)
 */
function rsGenerateFilename(reportType, context) {
  context = context || {};

  var parts = ['UM', reportType];

  // ── ปี ────────────────────────────────────────────────
  if (context.year) {
    parts.push(String(context.year));
  }

  // ── เดือน (ถ้ามี) ─────────────────────────────────────
  if (context.month) {
    var monthPad  = ('0' + context.month).slice(-2);
    var monthName = RS_CONFIG.MONTHS_SHORT_TH[context.month - 1] || '';
    parts.push(monthPad);
    if (monthName) parts.push(monthName);
  }

  // ── Site (ถ้ามี) ──────────────────────────────────────
  if (context.site_id) {
    parts.push(context.site_id);
  }
  if (context.site_name) {
    // ทำความสะอาดชื่อ (ลบอักขระพิเศษที่ Drive ไม่รองรับ)
    var cleanName = _sanitizeFilename(context.site_name);
    if (cleanName) parts.push(cleanName);
  }

  // ── Timestamp ─────────────────────────────────────────
  var now       = new Date();
  var datePart  = _formatDateCompact(now);   // YYYYMMDD
  var timePart  = _formatTimeCompact(now);   // HHMMSS
  parts.push(datePart + '_' + timePart);

  return parts.join('_');
}


// ============================================================
// SECTION 5 — INTERNAL: DATA LOADING
// ============================================================

/**
 * Batch load ข้อมูลทั้งหมดที่ report ต้องใช้
 * อ่าน Sheet ครั้งเดียว ลด API calls
 *
 * @param {Object} [options]
 * @returns {{ bills, sites, meters, anomalies, payments }}
 * @private
 */
function _loadReportData(options) {
  options = options || {};

  // ── อ่านทุก table ครั้งเดียว ──────────────────────────
  var raw = tcLoadAllData();                         // ใช้ TrendCalculator batch loader
  var bills    = tcFilterValidBills(raw.bills);      // กรองบิลที่ valid
  var sites    = raw.sites  || [];
  var meters   = raw.meters || [];

  // โหลด anomalies และ payments แยก (ไม่อยู่ใน tcLoadAllData)
  var anomalies = _safeDbGetAll(CONFIG.SHEETS.ANOMALIES);
  var payments  = _safeDbGetAll(CONFIG.SHEETS.BILL_PAYMENTS);

  return {
    bills:     bills,
    sites:     sites,
    meters:    meters,
    anomalies: anomalies,
    payments:  payments,
  };
}

/**
 * dbGetAll พร้อม error handling (return [] ถ้า sheet ไม่มี)
 * @private
 */
function _safeDbGetAll(sheetName) {
  try {
    return dbGetAll(sheetName) || [];
  } catch (e) {
    log('WARN', 'ReportService', '_safeDbGetAll: ' + sheetName + ' ไม่พบ: ' + e.message);
    return [];
  }
}


// ============================================================
// SECTION 6 — INTERNAL: SAVE & ARCHIVE
// ============================================================

/**
 * บันทึก report content ลง Google Drive และ Archive sheet
 *
 * @param {Object}  content     — สิ่งที่ ReportGenerator ส่งมา
 * @param {string}  filename    — ชื่อไฟล์ (ไม่มี extension)
 * @param {string}  reportType
 * @param {string}  subfolder   — ชื่อ sub-folder ใน REPORTS
 * @param {Object}  options
 * @returns {Object} ReportResult พื้นฐาน
 * @private
 */
function _saveAndArchive(content, filename, reportType, subfolder, options) {
  var reportId = _generateReportId();
  var now      = nowISO();

  var fileId   = null;
  var folderId = null;

  // ── บันทึกลง Google Drive (ถ้าเปิดใช้) ──────────────
  if (options.save_to_drive !== false) {
    var driveResult = _saveToGoogleDrive(content, filename, subfolder);
    fileId   = driveResult.fileId;
    folderId = driveResult.folderId;
  }

  // ── บันทึก Archive index ───────────────────────────
  raSaveToArchive({
    report_id:    reportId,
    report_type:  reportType,
    filename:     filename,
    file_id:      fileId || '',
    folder_id:    folderId || '',
    site_id:      options.site_id || '',
    year:         options.year    || '',
    month:        options.month   || '',
    meter_type:   options.meter_type || 'ALL',
    generated_at: now,
    generated_by: _getCurrentUser(),
    status:       fileId ? 'SAVED' : 'IN_MEMORY',
  });

  return {
    success:      true,
    report_id:    reportId,
    report_type:  reportType,
    filename:     filename,
    file_id:      fileId   || null,
    folder_id:    folderId || null,
    generated_at: now,
    content:      options.include_content ? content : undefined,
  };
}

/**
 * บันทึกไฟล์ลง Google Drive
 * สร้าง sub-folder ตาม structure อัตโนมัติ
 *
 * @param {Object} content    — { text, rows, summary } จาก generator
 * @param {string} filename
 * @param {string} subfolder  — ชื่อ sub-folder
 * @returns {{ fileId: string, folderId: string }}
 * @private
 */
function _saveToGoogleDrive(content, filename, subfolder) {
  try {
    // ── หา root Reports folder ─────────────────────────
    var rootFolderId = CONFIG.FOLDERS.REPORTS;
    var rootFolder   = DriveApp.getFolderById(rootFolderId);

    // ── หา/สร้าง sub-folder ────────────────────────────
    var targetFolder = _getOrCreateSubfolder(rootFolder, subfolder);

    // ── แปลง content เป็น text ─────────────────────────
    var fileContent = _contentToText(content);
    var fullFilename = filename + '.txt';

    // ── สร้างไฟล์ใน Drive ─────────────────────────────
    var file = targetFolder.createFile(fullFilename, fileContent, MimeType.PLAIN_TEXT);

    log('INFO', 'ReportService',
        'บันทึกไฟล์: ' + fullFilename + ' → ' + targetFolder.getName());

    return {
      fileId:   file.getId(),
      folderId: targetFolder.getId(),
    };

  } catch (e) {
    log('ERROR', 'ReportService', '_saveToGoogleDrive ERROR: ' + e.message);
    // ไม่ throw เพื่อให้ report ยังคืนค่าได้แม้ Drive fail
    return { fileId: null, folderId: null };
  }
}

/**
 * หา sub-folder ใน parent ถ้าไม่มีให้สร้างใหม่
 * @private
 */
function _getOrCreateSubfolder(parentFolder, subfolderName) {
  var iter = parentFolder.getFoldersByName(subfolderName);
  if (iter.hasNext()) {
    return iter.next();
  }
  // สร้างใหม่
  log('INFO', 'ReportService', 'สร้าง sub-folder: ' + subfolderName);
  return parentFolder.createFolder(subfolderName);
}


// ============================================================
// SECTION 7 — INTERNAL: HELPER UTILITIES
// ============================================================

/**
 * Normalize options พร้อม default values
 * @private
 */
function _normalizeReportOptions(options) {
  options = options || {};
  return {
    year:            options.year            || null,
    month:           options.month           || null,
    site_id:         options.site_id         || null,
    meter_type:      options.meter_type      || 'ALL',
    compare_year:    options.compare_year    || null,
    save_to_drive:   options.save_to_drive   !== false, // default true
    include_content: options.include_content || false,
    months:          options.months          || 12,
  };
}

/**
 * กรอง bills ตาม options (year, month, site_id)
 * @private
 */
function _applyBillFilters(bills, options) {
  var result = bills;

  if (options.year) {
    result = result.filter(function(b) {
      return String(b.bill_year) === String(options.year);
    });
  }
  if (options.month) {
    result = result.filter(function(b) {
      return String(b.bill_month) === String(options.month);
    });
  }
  if (options.site_id) {
    result = result.filter(function(b) {
      return b.site_id === options.site_id;
    });
  }

  return result;
}

/**
 * สร้าง report ID unique
 * @private
 */
function _generateReportId() {
  return RS_CONFIG.ID_PREFIX + '_' + _formatDateCompact(new Date()) +
         '_' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

/**
 * หาปีล่าสุดจาก bills
 * @private
 */
function _getLatestYear(bills) {
  if (!bills || bills.length === 0) {
    // fallback = ปีปัจจุบัน (พ.ศ.)
    return new Date().getFullYear() + 543;
  }
  var years = bills.map(function(b) { return parseInt(b.bill_year) || 0; });
  return Math.max.apply(null, years);
}

/**
 * นับค่า unique ใน field
 * @private
 */
function _countUnique(arr, field) {
  var seen = {};
  (arr || []).forEach(function(item) {
    if (item[field]) seen[item[field]] = true;
  });
  return Object.keys(seen).length;
}

/**
 * หา object จาก array โดย field
 * @private
 */
function _findById(arr, field, value) {
  return (arr || []).find(function(item) {
    return String(item[field]) === String(value);
  }) || null;
}

/**
 * แปลง content object เป็น plain text สำหรับบันทึกไฟล์
 * @private
 */
function _contentToText(content) {
  if (typeof content === 'string') return content;
  if (content && content.text)     return content.text;
  try {
    return JSON.stringify(content, null, 2);
  } catch (e) {
    return String(content);
  }
}

/**
 * ล้างชื่อไฟล์ — ลบอักขระที่ Drive ไม่รองรับ
 * @private
 */
function _sanitizeFilename(name) {
  if (!name) return '';
  return String(name)
    .replace(/[\/\\:*?"<>|]/g, '')  // ลบ special chars
    .replace(/\s+/g, '_')            // space → underscore
    .substring(0, 30);               // จำกัดความยาว
}

/**
 * Format วันที่เป็น YYYYMMDD
 * @private
 */
function _formatDateCompact(date) {
  var y  = date.getFullYear();
  var m  = ('0' + (date.getMonth() + 1)).slice(-2);
  var d  = ('0' + date.getDate()).slice(-2);
  return '' + y + m + d;
}

/**
 * Format เวลาเป็น HHMMSS
 * @private
 */
function _formatTimeCompact(date) {
  var h  = ('0' + date.getHours()).slice(-2);
  var mi = ('0' + date.getMinutes()).slice(-2);
  var s  = ('0' + date.getSeconds()).slice(-2);
  return '' + h + mi + s;
}

/**
 * ดึง email ผู้ใช้ปัจจุบัน
 * @private
 */
function _getCurrentUser() {
  try {
    return Session.getActiveUser().getEmail() || 'system';
  } catch (e) {
    return 'system';
  }
}

/**
 * สร้าง error result มาตรฐาน
 * @private
 */
function _errorResult(funcName, message) {
  log('ERROR', 'ReportService', funcName + ': ' + message);
  return {
    success:      false,
    report_id:    null,
    report_type:  null,
    filename:     null,
    file_id:      null,
    generated_at: nowISO(),
    error:        message,
  };
}
