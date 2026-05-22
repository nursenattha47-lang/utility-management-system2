// ============================================================
// ReportArchive.gs — Report Archive Management
// UtilityManager | PHASE 6A — Report Service
// ============================================================
// รับผิดชอบ:
//   1. บันทึก report metadata ลง Archive sheet
//   2. ดึง report จาก archive (list, get by ID, filter)
//   3. ลบ report (ทั้งจาก Drive และ Archive sheet)
//   4. ทำความสะอาด archive เก่า (cleanup)
//   5. สร้าง Archive sheet ถ้ายังไม่มี (auto-init)
// ============================================================
// Archive Sheet Schema (ReportArchive):
//   report_id     — unique ID (RPT_YYYYMMDD_xxxxx)
//   report_type   — MONTHLY|YEARLY|EXECUTIVE|SITE|WATER|ELECTRICITY
//   filename      — ชื่อไฟล์ (ไม่มี extension)
//   file_id       — Google Drive file ID
//   folder_id     — Google Drive folder ID
//   site_id       — site_id ที่เกี่ยวข้อง (ถ้ามี)
//   year          — ปีที่ report ครอบคลุม
//   month         — เดือนที่ report ครอบคลุม (ถ้ามี)
//   meter_type    — ELECTRICITY|WATER|ALL
//   generated_at  — ISO timestamp
//   generated_by  — email ของผู้สร้าง
//   status        — SAVED|IN_MEMORY|DELETED
// ============================================================
// Public API (เรียกจาก ReportService.gs เท่านั้น):
//   raSaveToArchive(record)        — บันทึก metadata
//   raListArchive(filters)         — ดึงรายการ (พร้อม filter)
//   raGetById(reportId)            — ดึง report เดียว
//   raDeleteReport(reportId)       — ลบ (Drive + Archive)
//   raCleanupOldReports(days)      — ลบ report เก่ากว่า N วัน
//   raInitArchiveSheet()           — สร้าง sheet ถ้ายังไม่มี
//   raGetStats()                   — สถิติ archive
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs
// ============================================================

'use strict';

// ============================================================
// SECTION 1 — ARCHIVE CONFIGURATION
// ============================================================

/**
 * Schema ของ Archive sheet (ลำดับ column สำคัญ)
 * ต้องตรงกับที่สร้างไว้ใน initArchiveSheet
 */
var RA_SCHEMA = [
  'report_id',
  'report_type',
  'filename',
  'file_id',
  'folder_id',
  'site_id',
  'year',
  'month',
  'meter_type',
  'generated_at',
  'generated_by',
  'status',
];

/**
 * ชื่อ Sheet สำหรับ Archive index
 * ใช้ RS_CONFIG.ARCHIVE_SHEET ถ้า load ReportService.gs ก่อน
 * fallback เป็น hardcode เผื่อใช้แยกกัน
 */
var RA_SHEET_NAME = (typeof RS_CONFIG !== 'undefined' && RS_CONFIG.ARCHIVE_SHEET)
  ? RS_CONFIG.ARCHIVE_SHEET
  : 'ReportArchive';

/**
 * จำนวนวันที่เก็บ archive โดยค่า default
 */
var RA_DEFAULT_RETENTION_DAYS = 365; // 1 ปี


// ============================================================
// SECTION 2 — PUBLIC API: SAVE
// ============================================================

/**
 * บันทึก report metadata ลง Archive sheet
 * เรียกหลังจาก ReportService สร้าง report สำเร็จ
 *
 * @param {Object} record
 * @param {string} record.report_id
 * @param {string} record.report_type
 * @param {string} record.filename
 * @param {string} [record.file_id]
 * @param {string} [record.folder_id]
 * @param {string} [record.site_id]
 * @param {number} [record.year]
 * @param {number} [record.month]
 * @param {string} [record.meter_type]
 * @param {string} [record.generated_at]
 * @param {string} [record.generated_by]
 * @param {string} [record.status]
 * @returns {string} report_id
 */
function raSaveToArchive(record) {
  // ── ตรวจสอบ required fields ──────────────────────────
  if (!record || !record.report_id || !record.report_type) {
    throw new Error('[ReportArchive] raSaveToArchive: ขาด report_id หรือ report_type');
  }

  // ── auto-init sheet ถ้ายังไม่มี ──────────────────────
  raInitArchiveSheet();

  // ── สร้าง row ตาม schema ──────────────────────────────
  var row = RA_SCHEMA.map(function(field) {
    var val = record[field];
    if (val === null || val === undefined) return '';
    return String(val);
  });

  // ── batch append (single row) ─────────────────────────
  var sheet = _getArchiveSheet();
  sheet.appendRow(row);

  log('INFO', 'ReportArchive',
      'บันทึก archive: ' + record.report_id + ' (' + record.report_type + ')');

  return record.report_id;
}


// ============================================================
// SECTION 3 — PUBLIC API: LIST
// ============================================================

/**
 * ดึงรายการ reports ทั้งหมด พร้อม filter
 * Batch read ครั้งเดียว — ไม่อ่านซ้ำ
 *
 * @param {Object} [filters]
 * @param {string} [filters.report_type]  — กรองตามประเภท
 * @param {number} [filters.year]         — กรองตามปี
 * @param {string} [filters.site_id]      — กรองตาม site
 * @param {string} [filters.meter_type]   — กรองตามประเภทมิเตอร์
 * @param {string} [filters.status]       — กรองตาม status (SAVED/IN_MEMORY/DELETED)
 * @param {number} [filters.limit]        — จำนวนสูงสุด (default: 100)
 * @param {string} [filters.order]        — 'ASC'|'DESC' (default: DESC by generated_at)
 * @returns {Object[]} รายการ report records
 */
function raListArchive(filters) {
  filters = filters || {};

  // ── ตรวจสอบ sheet มีอยู่ ──────────────────────────────
  raInitArchiveSheet();

  // ── Batch read ทั้ง sheet ─────────────────────────────
  var allRecords = _readAllArchive();

  // ── กรองตาม filters ──────────────────────────────────
  var result = allRecords;

  // ยกเว้น deleted โดย default
  if (!filters.status) {
    result = result.filter(function(r) { return r.status !== 'DELETED'; });
  } else {
    result = result.filter(function(r) { return r.status === filters.status; });
  }

  if (filters.report_type) {
    result = result.filter(function(r) {
      return r.report_type === filters.report_type;
    });
  }

  if (filters.year) {
    result = result.filter(function(r) {
      return String(r.year) === String(filters.year);
    });
  }

  if (filters.site_id) {
    result = result.filter(function(r) {
      return r.site_id === filters.site_id;
    });
  }

  if (filters.meter_type) {
    result = result.filter(function(r) {
      return r.meter_type === filters.meter_type;
    });
  }

  // ── เรียงตาม generated_at ─────────────────────────────
  var order = (filters.order || 'DESC').toUpperCase();
  result.sort(function(a, b) {
    var cmp = String(a.generated_at).localeCompare(String(b.generated_at));
    return order === 'ASC' ? cmp : -cmp;
  });

  // ── จำกัดจำนวน ────────────────────────────────────────
  var limit = filters.limit || 100;
  result = result.slice(0, limit);

  log('INFO', 'ReportArchive',
      'raListArchive: คืน ' + result.length + ' records');

  return result;
}


// ============================================================
// SECTION 4 — PUBLIC API: GET BY ID
// ============================================================

/**
 * ดึง report metadata โดย report_id
 *
 * @param {string} reportId
 * @returns {Object|null}  — report record หรือ null ถ้าไม่พบ
 */
function raGetById(reportId) {
  if (!reportId) return null;

  raInitArchiveSheet();
  var allRecords = _readAllArchive();

  var found = allRecords.find(function(r) {
    return r.report_id === reportId;
  });

  if (!found) {
    log('WARN', 'ReportArchive', 'raGetById: ไม่พบ ' + reportId);
    return null;
  }

  // ถ้ามี file_id ให้ดึง Google Drive URL ด้วย
  if (found.file_id) {
    found.drive_url = _buildDriveUrl(found.file_id);
  }

  return found;
}


// ============================================================
// SECTION 5 — PUBLIC API: DELETE
// ============================================================

/**
 * ลบ report (Soft delete ใน Archive + ลบไฟล์จาก Drive)
 *
 * กลยุทธ์: Soft delete ก่อน (เปลี่ยน status → DELETED)
 * แล้วค่อยลบไฟล์จาก Drive (Drive อาจ fail แต่ soft delete ยังทำงานได้)
 *
 * @param {string} reportId
 * @returns {{ deleted_from_archive: boolean, deleted_from_drive: boolean }}
 */
function raDeleteReport(reportId) {
  if (!reportId) throw new Error('[ReportArchive] raDeleteReport: ต้องระบุ reportId');

  raInitArchiveSheet();

  // ── หา record ─────────────────────────────────────────
  var record = raGetById(reportId);
  if (!record) {
    throw new Error('[ReportArchive] ไม่พบ report: ' + reportId);
  }

  if (record.status === 'DELETED') {
    log('WARN', 'ReportArchive', 'raDeleteReport: ' + reportId + ' ถูกลบแล้ว');
    return { deleted_from_archive: false, deleted_from_drive: false };
  }

  // ── Soft delete ใน Archive sheet ─────────────────────
  var archiveDeleted = _softDeleteInSheet(reportId);

  // ── ลบไฟล์จาก Google Drive ────────────────────────────
  var driveDeleted = false;
  if (record.file_id) {
    driveDeleted = _deleteFromDrive(record.file_id);
  }

  log('INFO', 'ReportArchive',
      'ลบ report: ' + reportId + ' (archive=' + archiveDeleted + ', drive=' + driveDeleted + ')');

  return {
    deleted_from_archive: archiveDeleted,
    deleted_from_drive:   driveDeleted,
  };
}


// ============================================================
// SECTION 6 — PUBLIC API: CLEANUP
// ============================================================

/**
 * ลบ reports เก่ากว่า N วัน (Bulk cleanup)
 * เหมาะสำหรับ Time-driven trigger ทำความสะอาดรายเดือน
 *
 * @param {number} [days]  — default: RA_DEFAULT_RETENTION_DAYS (365)
 * @returns {{ scanned: number, deleted: number, errors: number }}
 */
function raCleanupOldReports(days) {
  days = days || RA_DEFAULT_RETENTION_DAYS;

  raInitArchiveSheet();

  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  var cutoffISO = cutoffDate.toISOString();

  var allRecords = _readAllArchive();
  var toDelete   = allRecords.filter(function(r) {
    return r.status !== 'DELETED' && r.generated_at < cutoffISO;
  });

  var deletedCount = 0;
  var errorCount   = 0;

  toDelete.forEach(function(record) {
    try {
      // Soft delete ใน sheet
      _softDeleteInSheet(record.report_id);

      // ลบไฟล์จาก Drive (ถ้ามี)
      if (record.file_id) {
        _deleteFromDrive(record.file_id);
      }

      deletedCount++;
    } catch (e) {
      log('ERROR', 'ReportArchive',
          'raCleanupOldReports: ลบ ' + record.report_id + ' ไม่สำเร็จ: ' + e.message);
      errorCount++;
    }
  });

  log('INFO', 'ReportArchive',
      'raCleanupOldReports: สแกน=' + allRecords.length +
      ', ลบ=' + deletedCount + ', error=' + errorCount);

  return {
    scanned:  allRecords.length,
    deleted:  deletedCount,
    errors:   errorCount,
    cutoff:   cutoffISO,
  };
}


// ============================================================
// SECTION 7 — PUBLIC API: STATS
// ============================================================

/**
 * ดึงสถิติ Archive (ใช้ใน dashboard หรือ admin panel)
 *
 * @returns {Object}
 * {
 *   total_reports:    number,    — รวมทั้งหมด (ไม่รวม deleted)
 *   by_type:          Object,    — { MONTHLY: N, YEARLY: N, ... }
 *   by_year:          Object,    — { 2568: N, 2567: N, ... }
 *   oldest_report:    string,    — generated_at เก่าสุด
 *   newest_report:    string,    — generated_at ใหม่สุด
 *   saved_to_drive:   number,    — มี file_id
 *   in_memory_only:   number,    — ไม่มี file_id
 * }
 */
function raGetStats() {
  raInitArchiveSheet();

  var allRecords = _readAllArchive();
  var active     = allRecords.filter(function(r) { return r.status !== 'DELETED'; });

  // จัดกลุ่มตาม type
  var byType = {};
  active.forEach(function(r) {
    byType[r.report_type] = (byType[r.report_type] || 0) + 1;
  });

  // จัดกลุ่มตาม year
  var byYear = {};
  active.forEach(function(r) {
    if (r.year) {
      byYear[r.year] = (byYear[r.year] || 0) + 1;
    }
  });

  // หา oldest/newest
  var dates    = active.map(function(r) { return r.generated_at; }).filter(Boolean).sort();
  var oldest   = dates.length > 0 ? dates[0]               : null;
  var newest   = dates.length > 0 ? dates[dates.length - 1] : null;

  var savedCount    = active.filter(function(r) { return r.file_id && r.file_id !== ''; }).length;
  var inMemoryCount = active.filter(function(r) { return !r.file_id || r.file_id === ''; }).length;

  return {
    total_reports:  active.length,
    by_type:        byType,
    by_year:        byYear,
    oldest_report:  oldest,
    newest_report:  newest,
    saved_to_drive: savedCount,
    in_memory_only: inMemoryCount,
  };
}


// ============================================================
// SECTION 8 — PUBLIC API: SHEET INITIALIZATION
// ============================================================

/**
 * สร้าง ReportArchive sheet ถ้ายังไม่มี
 * ปลอดภัยที่จะเรียกซ้ำ (idempotent)
 *
 * @returns {boolean} true ถ้าสร้างใหม่, false ถ้ามีอยู่แล้ว
 */
function raInitArchiveSheet() {
  try {
    var ss    = getSpreadsheet();
    var sheet = ss.getSheetByName(RA_SHEET_NAME);

    if (sheet) return false; // มีอยู่แล้ว ไม่ต้องทำอะไร

    // สร้าง sheet ใหม่
    sheet = ss.insertSheet(RA_SHEET_NAME);

    // ใส่ headers
    var headerRange = sheet.getRange(1, 1, 1, RA_SCHEMA.length);
    headerRange.setValues([RA_SCHEMA]);

    // จัดสไตล์ header
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a73e8');
    headerRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);

    // ปรับความกว้าง column หลัก
    sheet.setColumnWidth(1,  140);  // report_id
    sheet.setColumnWidth(2,  120);  // report_type
    sheet.setColumnWidth(3,  250);  // filename
    sheet.setColumnWidth(4,  200);  // file_id
    sheet.setColumnWidth(5,  200);  // folder_id
    sheet.setColumnWidth(6,  100);  // site_id
    sheet.setColumnWidth(7,  60);   // year
    sheet.setColumnWidth(8,  60);   // month
    sheet.setColumnWidth(9,  100);  // meter_type
    sheet.setColumnWidth(10, 160);  // generated_at
    sheet.setColumnWidth(11, 180);  // generated_by
    sheet.setColumnWidth(12, 90);   // status

    log('INFO', 'ReportArchive', 'สร้าง sheet ใหม่: ' + RA_SHEET_NAME);
    return true;

  } catch (e) {
    log('ERROR', 'ReportArchive', 'raInitArchiveSheet ERROR: ' + e.message);
    return false;
  }
}


// ============================================================
// SECTION 9 — INTERNAL: SHEET READ/WRITE
// ============================================================

/**
 * อ่านข้อมูลทั้งหมดจาก Archive sheet
 * Batch read ครั้งเดียว (getDataRange)
 * @returns {Object[]}
 * @private
 */
function _readAllArchive() {
  var sheet = _getArchiveSheet();
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];

  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows    = data.slice(1);

  return rows
    .map(function(row) {
      var obj = {};
      headers.forEach(function(h, i) { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
      return obj;
    })
    .filter(function(r) {
      // ข้าม row ที่ report_id ว่าง
      return r.report_id && r.report_id.trim() !== '';
    });
}

/**
 * Soft delete — เปลี่ยน status → DELETED ในแถวที่ตรง report_id
 * (ไม่ลบ row จริง เพื่อรักษา audit trail)
 *
 * @param {string} reportId
 * @returns {boolean}
 * @private
 */
function _softDeleteInSheet(reportId) {
  var sheet = _getArchiveSheet();
  if (!sheet) return false;

  var data     = sheet.getDataRange().getValues();
  if (data.length < 2) return false;

  var headers  = data[0].map(function(h) { return String(h).trim(); });
  var idCol    = headers.indexOf('report_id');
  var statusCol = headers.indexOf('status');

  if (idCol < 0 || statusCol < 0) {
    log('WARN', 'ReportArchive', '_softDeleteInSheet: ไม่พบ column report_id หรือ status');
    return false;
  }

  // Loop หา row (จาก ล่างขึ้นบน ถ้า ID ซ้ำ)
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]) === reportId) {
      // อัพเดทเฉพาะ cell status (เร็วกว่าอัพเดททั้ง row)
      sheet.getRange(i + 1, statusCol + 1).setValue('DELETED');
      log('INFO', 'ReportArchive', '_softDeleteInSheet: ' + reportId + ' → DELETED (row ' + (i + 1) + ')');
      return true;
    }
  }

  log('WARN', 'ReportArchive', '_softDeleteInSheet: ไม่พบ ' + reportId + ' ใน sheet');
  return false;
}

/**
 * ดึง Archive sheet object
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null}
 * @private
 */
function _getArchiveSheet() {
  try {
    var ss = getSpreadsheet();
    return ss.getSheetByName(RA_SHEET_NAME);
  } catch (e) {
    log('ERROR', 'ReportArchive', '_getArchiveSheet ERROR: ' + e.message);
    return null;
  }
}


// ============================================================
// SECTION 10 — INTERNAL: GOOGLE DRIVE HELPERS
// ============================================================

/**
 * ลบไฟล์จาก Google Drive โดย file ID
 * ไม่ throw ถ้าไฟล์ไม่พบ (อาจถูกลบไปแล้ว)
 *
 * @param {string} fileId
 * @returns {boolean}
 * @private
 */
function _deleteFromDrive(fileId) {
  if (!fileId || fileId.trim() === '') return false;

  try {
    var file = DriveApp.getFileById(fileId);
    file.setTrashed(true); // ส่งไป Trash แทนลบถาวร (ปลอดภัยกว่า)
    log('INFO', 'ReportArchive', 'ย้ายไป Trash: ' + fileId);
    return true;

  } catch (e) {
    // ไฟล์อาจไม่พบ หรือไม่มีสิทธิ์ — ไม่ throw เพื่อไม่ block soft delete
    log('WARN', 'ReportArchive', '_deleteFromDrive: ' + fileId + ' → ' + e.message);
    return false;
  }
}

/**
 * สร้าง Google Drive URL จาก file ID
 * @param {string} fileId
 * @returns {string}
 * @private
 */
function _buildDriveUrl(fileId) {
  if (!fileId) return '';
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}

/**
 * สร้าง Google Drive Folder URL จาก folder ID
 * @param {string} folderId
 * @returns {string}
 * @private
 */
function _buildFolderUrl(folderId) {
  if (!folderId) return '';
  return 'https://drive.google.com/drive/folders/' + folderId;
}


// ============================================================
// SECTION 11 — TRIGGER-READY FUNCTIONS
// ============================================================

/**
 * ฟังก์ชันสำหรับ Time-driven Trigger: ลบ archive เก่า
 * ตั้ง trigger: onMonthDay(1) → ต้นเดือนทุกเดือน
 *
 * ตัวอย่าง setup ใน Triggers.gs:
 *   ScriptApp.newTrigger('triggerCleanupReportArchive')
 *     .timeBased().onMonthDay(1).atHour(3).create();
 */
function triggerCleanupReportArchive() {
  try {
    log('INFO', 'ReportArchive', 'triggerCleanupReportArchive: เริ่ม cleanup...');
    var result = raCleanupOldReports(RA_DEFAULT_RETENTION_DAYS);
    log('INFO', 'ReportArchive',
        'triggerCleanupReportArchive: สำเร็จ — ลบ ' + result.deleted + ' รายการ');
  } catch (e) {
    log('ERROR', 'ReportArchive', 'triggerCleanupReportArchive ERROR: ' + e.message);
  }
}

/**
 * ฟังก์ชันสำหรับ Time-driven Trigger: สร้าง Monthly Report อัตโนมัติ
 * ตั้ง trigger: onMonthDay(5) → สร้างรายงานเดือนก่อน ทุกวันที่ 5 ของเดือน
 *
 * ตัวอย่าง setup ใน Triggers.gs:
 *   ScriptApp.newTrigger('triggerAutoMonthlyReport')
 *     .timeBased().onMonthDay(5).atHour(7).create();
 */
function triggerAutoMonthlyReport() {
  try {
    log('INFO', 'ReportArchive', 'triggerAutoMonthlyReport: เริ่มสร้าง Monthly Report อัตโนมัติ...');

    // คำนวณเดือนก่อนหน้า
    var now      = new Date();
    var prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var year     = prevMonth.getFullYear() + 543; // พ.ศ.
    var month    = prevMonth.getMonth() + 1;      // 1-12

    // ใช้ system token (trigger ไม่มี user token)
    // ต้องตั้งค่า SYSTEM_TOKEN ใน Config.gs
    var token = CONFIG.SYSTEM_TOKEN || _getSystemToken();

    var result = generateMonthlyReport(token, {
      year:          year,
      month:         month,
      meter_type:    'ALL',
      save_to_drive: true,
    });

    if (result.success) {
      log('INFO', 'ReportArchive',
          'triggerAutoMonthlyReport: สำเร็จ — ' + result.report_id);
    } else {
      log('ERROR', 'ReportArchive',
          'triggerAutoMonthlyReport: ล้มเหลว — ' + result.error);
    }

  } catch (e) {
    log('ERROR', 'ReportArchive', 'triggerAutoMonthlyReport ERROR: ' + e.message);
  }
}

/**
 * ดึง System Token สำหรับ trigger (ไม่มี user context)
 * อ่านจาก ScriptProperties
 * @private
 */
function _getSystemToken() {
  try {
    var props = PropertiesService.getScriptProperties();
    return props.getProperty('SYSTEM_TOKEN') || '';
  } catch (e) {
    return '';
  }
}


// ============================================================
// SECTION 12 — BATCH OPERATIONS
// ============================================================

/**
 * สร้าง report ทุก site พร้อมกัน (Batch Site Reports)
 * ใช้สำหรับ trigger ปลายเดือนที่ต้องการรายงานทุก site
 *
 * @param {string} token
 * @param {number} year
 * @param {string} [meterType]  — 'ALL'|'ELECTRICITY'|'WATER'
 * @returns {{ success: number, failed: number, results: Object[] }}
 */
function raBatchGenerateSiteReports(token, year, meterType) {
  requireAuth(token, 'canExport');

  meterType = meterType || 'ALL';

  log('INFO', 'ReportArchive',
      'raBatchGenerateSiteReports: ปี=' + year + ' type=' + meterType);

  // ── โหลด sites ทั้งหมด ───────────────────────────────
  var sites;
  try {
    sites = dbGetAll(CONFIG.SHEETS.SITES).filter(function(s) {
      return s.is_active === 'TRUE' || s.is_active === true;
    });
  } catch (e) {
    log('ERROR', 'ReportArchive', 'raBatchGenerateSiteReports: โหลด sites ไม่สำเร็จ: ' + e.message);
    return { success: 0, failed: 0, results: [] };
  }

  if (sites.length === 0) {
    log('WARN', 'ReportArchive', 'raBatchGenerateSiteReports: ไม่มี active sites');
    return { success: 0, failed: 0, results: [] };
  }

  // จำกัด batch size เพื่อป้องกัน timeout
  var MAX_BATCH = (typeof RS_CONFIG !== 'undefined' ? RS_CONFIG.MAX_SITES_PER_BATCH : 50);
  var batch     = sites.slice(0, MAX_BATCH);

  if (batch.length < sites.length) {
    log('WARN', 'ReportArchive',
        'raBatchGenerateSiteReports: จำกัดที่ ' + MAX_BATCH + ' sites (มี ' + sites.length + ')');
  }

  var results    = [];
  var successCnt = 0;
  var failedCnt  = 0;

  // ── Loop สร้าง report ทีละ site ──────────────────────
  // ใช้ try/catch รายตัว เพื่อไม่ให้ 1 site fail หยุดทั้งหมด
  batch.forEach(function(site) {
    try {
      var result = generateSiteReport(token, {
        site_id:       site.site_id,
        year:          year,
        meter_type:    meterType,
        save_to_drive: true,
      });

      results.push({
        site_id:   site.site_id,
        site_name: site.site_name,
        success:   result.success,
        report_id: result.report_id || null,
        error:     result.error     || null,
      });

      if (result.success) {
        successCnt++;
      } else {
        failedCnt++;
      }

    } catch (e) {
      log('ERROR', 'ReportArchive',
          'raBatchGenerateSiteReports: ' + site.site_id + ' ERROR: ' + e.message);
      results.push({
        site_id:   site.site_id,
        site_name: site.site_name,
        success:   false,
        report_id: null,
        error:     e.message,
      });
      failedCnt++;
    }
  });

  log('INFO', 'ReportArchive',
      'raBatchGenerateSiteReports: สำเร็จ=' + successCnt + ', ล้มเหลว=' + failedCnt);

  return {
    success:  successCnt,
    failed:   failedCnt,
    total:    batch.length,
    results:  results,
  };
}


// ============================================================
// SECTION 13 — EXPORT / SEARCH HELPERS (สำหรับ Code.gs router)
// ============================================================

/**
 * ดึงรายการ reports พร้อม Drive URL (สำหรับ frontend)
 * เพิ่ม drive_url ให้ทุก record ที่มี file_id
 *
 * @param {string} token
 * @param {Object} [filters]
 * @returns {Object[]}
 */
function raListReportsWithUrls(token, filters) {
  requireAuth(token, 'canRead');
  var records = raListArchive(filters || {});

  return records.map(function(r) {
    if (r.file_id) {
      r.drive_url   = _buildDriveUrl(r.file_id);
      r.folder_url  = _buildFolderUrl(r.folder_id);
    }
    return r;
  });
}

/**
 * ค้นหา reports ตาม keyword ในชื่อไฟล์
 *
 * @param {string} token
 * @param {string} keyword
 * @param {number} [limit]
 * @returns {Object[]}
 */
function raSearchReports(token, keyword, limit) {
  requireAuth(token, 'canRead');

  if (!keyword || keyword.trim() === '') {
    return raListArchive({ limit: limit || 50 });
  }

  var keyword_lower = keyword.toLowerCase();
  var allRecords    = raListArchive({ limit: 9999 });

  var matched = allRecords.filter(function(r) {
    return (r.filename     || '').toLowerCase().indexOf(keyword_lower) >= 0 ||
           (r.report_type  || '').toLowerCase().indexOf(keyword_lower) >= 0 ||
           (r.site_id      || '').toLowerCase().indexOf(keyword_lower) >= 0;
  });

  return matched.slice(0, limit || 50);
}
