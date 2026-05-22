// ============================================================
// PDFExport.gs — PDF Export Engine
// UtilityManager | PHASE 6B — PDF Export
// ============================================================
// รับผิดชอบ:
//   1. แปลง report data → PDF ผ่าน HtmlService
//   2. สร้าง Executive Summary PDF
//   3. สร้าง Monthly / Yearly / Site PDF
//   4. รองรับ Logo บริษัท (base64 image)
//   5. Dynamic multi-page layout A4
//   6. บันทึก PDF ลง Google Drive
//   7. รองรับภาษาไทย (Sarabun font via Google Fonts)
// ============================================================
// Dependencies:
//   Config.gs        — CONFIG, getConfig()
//   Utils.gs         — log(), generateId(), nowISO()
//   Auth.gs          — requireAuth()
//   ReportService.gs — RS_CONFIG, report data structures
//   ReportGenerator.gs — rgBuildExecutiveContent(), etc.
// ============================================================
// Public API:
//   pdfExportMonthly(token, options)    → DriveFile
//   pdfExportYearly(token, options)     → DriveFile
//   pdfExportExecutive(token, options)  → DriveFile
//   pdfExportSite(token, options)       → DriveFile
//   pdfGetDownloadUrl(fileId)           → string (URL)
//   pdfDeleteFile(fileId)              → boolean
// ============================================================
// Response shape (ทุก pdfExport* function):
// {
//   success:      boolean,
//   pdf_id:       string,   — report ID (RPT_...)
//   file_id:      string,   — Google Drive file ID
//   filename:     string,   — ชื่อไฟล์ .pdf
//   download_url: string,   — URL ดาวน์โหลด
//   folder_id:    string,
//   pages:        number,
//   generated_at: string,
//   size_bytes:   number,
//   error?:       string,
// }
// ============================================================

'use strict';

// ============================================================
// SECTION 1 — PDF ENGINE CONFIGURATION
// ============================================================

/**
 * Config เฉพาะของ PDF Export Engine
 */
var PDF_CONFIG = {

  // ── Branding ───────────────────────────────────────────
  COMPANY_NAME:    'UtilityManager',
  COMPANY_SUB:     'ระบบบริหารจัดการสาธารณูปโภค',
  COMPANY_VERSION: 'v6.0',

  // ── Logo ────────────────────────────────────────────────
  // วางไฟล์ logo ใน Google Drive แล้วใส่ File ID ที่นี่
  // ถ้าไม่มี logo ระบบจะ fallback เป็น SVG icon
  LOGO_FILE_ID:    '',   // ← ใส่ Drive File ID ของ logo ที่นี่

  // ── Page settings ──────────────────────────────────────
  PAGE_SIZE:       'A4',       // A4 เสมอ
  ORIENTATION:     'portrait', // portrait | landscape
  MARGIN_MM:       20,         // margin ทุกด้าน (mm)

  // ── Template file ──────────────────────────────────────
  HTML_TEMPLATE:   'PDFTemplate', // ชื่อ HtmlTemplate file (ไม่มี .html)

  // ── Font ────────────────────────────────────────────────
  // Sarabun รองรับภาษาไทยได้ดีที่สุดใน Google Fonts
  FONT_FAMILY:     "'Sarabun', 'DM Sans', sans-serif",
  FONT_URL:        'https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap',

  // ── Folder ID (ใน CONFIG.FOLDERS) ──────────────────────
  // ใช้ CONFIG.FOLDERS.REPORTS ถ้า CONFIG load ก่อน
  FALLBACK_FOLDER_ID: '',  // ← fallback ถ้า CONFIG.FOLDERS.REPORTS ไม่มี

  // ── ประเภท report (map ไป subfolder) ───────────────────
  SUBFOLDER_MAP: {
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

  // ── Timeout ────────────────────────────────────────────
  RENDER_TIMEOUT_MS: 30000, // 30 วินาที

  // ── ID prefix ──────────────────────────────────────────
  ID_PREFIX: 'PDF',
};


// ============================================================
// SECTION 2 — PUBLIC API: EXPORT FUNCTIONS
// ============================================================

/**
 * สร้าง Monthly Report PDF
 * รวมบิลทุก site ของเดือนที่ระบุ
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year            — ปี พ.ศ. (required)
 * @param {number} options.month           — เดือน 1-12 (required)
 * @param {string} [options.site_id]       — กรองเฉพาะ site
 * @param {string} [options.meter_type]    — 'ALL'|'ELECTRICITY'|'WATER'
 * @param {boolean}[options.save_to_drive] — บันทึกลง Drive (default: true)
 * @returns {Object} PDFResult
 */
function pdfExportMonthly(token, options) {
  requireAuth(token, 'canExport');
  options = _pdfNormalizeOptions(options);

  if (!options.year || !options.month) {
    return _pdfErrorResult('pdfExportMonthly', 'ต้องระบุ year และ month');
  }

  log('INFO', 'PDFExport', 'เริ่มสร้าง Monthly PDF: ' + options.year + '/' + options.month);

  try {
    // ── 1. สร้าง report content จาก ReportService ────────
    var reportResult = generateMonthlyReport(token, options);
    if (!reportResult.success) {
      return _pdfErrorResult('pdfExportMonthly', reportResult.error || 'ไม่สามารถสร้าง report ได้');
    }

    // ── 2. เตรียม template data ────────────────────────
    var monthName = PDF_CONFIG.MONTHS_TH[(options.month - 1)] || String(options.month);
    var templateData = {
      reportType:   'MONTHLY',
      reportTitle:  'รายงานค่าสาธารณูปโภคประจำเดือน',
      reportSubtitle: monthName + ' ' + (options.year + 543),
      period:       monthName + ' ' + (options.year + 543),
      generatedAt:  _pdfFormatDateTimeTh(new Date()),
      content:      reportResult,
      options:      options,
      meterTypeTh:  _pdfMeterTypeTh(options.meter_type || 'ALL'),
    };

    // ── 3. Render HTML → PDF ───────────────────────────
    var filename = _pdfGenerateFilename('MONTHLY', options);
    return _pdfRenderAndSave(templateData, filename, 'MONTHLY', options);

  } catch (e) {
    log('ERROR', 'PDFExport', 'pdfExportMonthly ERROR: ' + e.message + '\n' + e.stack);
    return _pdfErrorResult('pdfExportMonthly', e.message);
  }
}


/**
 * สร้าง Yearly Report PDF
 * สรุปทั้งปี แยกรายเดือน
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} options.year            — ปี พ.ศ. (required)
 * @param {string} [options.site_id]
 * @param {string} [options.meter_type]
 * @returns {Object} PDFResult
 */
function pdfExportYearly(token, options) {
  requireAuth(token, 'canExport');
  options = _pdfNormalizeOptions(options);

  if (!options.year) {
    return _pdfErrorResult('pdfExportYearly', 'ต้องระบุ year');
  }

  log('INFO', 'PDFExport', 'เริ่มสร้าง Yearly PDF: ' + options.year);

  try {
    var reportResult = generateYearlyReport(token, options);
    if (!reportResult.success) {
      return _pdfErrorResult('pdfExportYearly', reportResult.error || 'ไม่สามารถสร้าง report ได้');
    }

    var templateData = {
      reportType:    'YEARLY',
      reportTitle:   'รายงานสรุปประจำปี',
      reportSubtitle: 'ปีงบประมาณ ' + (options.year + 543),
      period:        'ปีงบประมาณ ' + (options.year + 543),
      generatedAt:   _pdfFormatDateTimeTh(new Date()),
      content:       reportResult,
      options:       options,
      meterTypeTh:   _pdfMeterTypeTh(options.meter_type || 'ALL'),
    };

    var filename = _pdfGenerateFilename('YEARLY', options);
    return _pdfRenderAndSave(templateData, filename, 'YEARLY', options);

  } catch (e) {
    log('ERROR', 'PDFExport', 'pdfExportYearly ERROR: ' + e.message);
    return _pdfErrorResult('pdfExportYearly', e.message);
  }
}


/**
 * สร้าง Executive Summary PDF
 * รายงานสรุปผู้บริหาร — ภาพรวมทุก site ทุก meter type
 *
 * @param {string} token
 * @param {Object} options
 * @param {number} [options.year]   — default = ปีล่าสุดในข้อมูล
 * @returns {Object} PDFResult
 */
function pdfExportExecutive(token, options) {
  requireAuth(token, 'canExport');
  options = _pdfNormalizeOptions(options);

  log('INFO', 'PDFExport', 'เริ่มสร้าง Executive Summary PDF');

  try {
    var reportResult = generateExecutiveSummary(token, options);
    if (!reportResult.success) {
      return _pdfErrorResult('pdfExportExecutive', reportResult.error || 'ไม่สามารถสร้าง report ได้');
    }

    var templateData = {
      reportType:    'EXECUTIVE',
      reportTitle:   'รายงานสรุปผู้บริหาร',
      reportSubtitle: 'Executive Summary Report',
      period:        options.year ? 'ปี ' + (options.year + 543) : 'ทุกช่วงเวลา',
      generatedAt:   _pdfFormatDateTimeTh(new Date()),
      content:       reportResult,
      options:       options,
      isExecutive:   true,
      meterTypeTh:   'ทุกประเภท',
    };

    var filename = _pdfGenerateFilename('EXECUTIVE', options);
    return _pdfRenderAndSave(templateData, filename, 'EXECUTIVE', options);

  } catch (e) {
    log('ERROR', 'PDFExport', 'pdfExportExecutive ERROR: ' + e.message);
    return _pdfErrorResult('pdfExportExecutive', e.message);
  }
}


/**
 * สร้าง Site-Specific Report PDF
 * รายงานเฉพาะสถานที่
 *
 * @param {string} token
 * @param {Object} options
 * @param {string} options.site_id         — (required)
 * @param {number} [options.year]
 * @param {string} [options.meter_type]
 * @returns {Object} PDFResult
 */
function pdfExportSite(token, options) {
  requireAuth(token, 'canExport');
  options = _pdfNormalizeOptions(options);

  if (!options.site_id) {
    return _pdfErrorResult('pdfExportSite', 'ต้องระบุ site_id');
  }

  log('INFO', 'PDFExport', 'เริ่มสร้าง Site PDF: ' + options.site_id);

  try {
    var reportResult = generateSiteReport(token, options);
    if (!reportResult.success) {
      return _pdfErrorResult('pdfExportSite', reportResult.error || 'ไม่สามารถสร้าง report ได้');
    }

    var siteName = (reportResult.meta && reportResult.meta.site_name) || options.site_id;

    var templateData = {
      reportType:    'SITE',
      reportTitle:   'รายงานค่าสาธารณูปโภค',
      reportSubtitle: siteName,
      period:        options.year ? 'ปี ' + (options.year + 543) : 'ทุกช่วงเวลา',
      generatedAt:   _pdfFormatDateTimeTh(new Date()),
      content:       reportResult,
      options:       options,
      siteName:      siteName,
      meterTypeTh:   _pdfMeterTypeTh(options.meter_type || 'ALL'),
    };

    var filename = _pdfGenerateFilename('SITE', options);
    return _pdfRenderAndSave(templateData, filename, 'SITE', options);

  } catch (e) {
    log('ERROR', 'PDFExport', 'pdfExportSite ERROR: ' + e.message);
    return _pdfErrorResult('pdfExportSite', e.message);
  }
}


// ============================================================
// SECTION 3 — PUBLIC API: FILE MANAGEMENT
// ============================================================

/**
 * ดึง download URL ของ PDF จาก Drive File ID
 *
 * @param {string} fileId — Google Drive file ID
 * @returns {string|null} URL หรือ null ถ้าไม่พบ
 */
function pdfGetDownloadUrl(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    // URL สำหรับ download ตรง (ไม่ต้อง login ถ้า file เป็น public)
    return 'https://drive.google.com/uc?export=download&id=' + fileId;
  } catch (e) {
    log('WARN', 'PDFExport', 'pdfGetDownloadUrl: ไม่พบไฟล์ ' + fileId + ': ' + e.message);
    return null;
  }
}


/**
 * ดึง View URL ของ PDF (เปิดดูใน Drive)
 *
 * @param {string} fileId
 * @returns {string|null}
 */
function pdfGetViewUrl(fileId) {
  try {
    return DriveApp.getFileById(fileId).getUrl();
  } catch (e) {
    log('WARN', 'PDFExport', 'pdfGetViewUrl: ' + e.message);
    return null;
  }
}


/**
 * ลบไฟล์ PDF จาก Google Drive
 *
 * @param {string} fileId
 * @returns {boolean} true ถ้าลบสำเร็จ
 */
function pdfDeleteFile(fileId) {
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    log('INFO', 'PDFExport', 'ลบไฟล์ PDF สำเร็จ: ' + fileId);
    return true;
  } catch (e) {
    log('ERROR', 'PDFExport', 'pdfDeleteFile ERROR: ' + e.message);
    return false;
  }
}


/**
 * ดึง Logo เป็น base64 data URL (ใช้ใน template)
 * คืน null ถ้าไม่มี logo file ID หรือ load ไม่ได้
 *
 * @returns {string|null} data:image/...;base64,...
 */
function pdfGetLogoBase64() {
  var fileId = PDF_CONFIG.LOGO_FILE_ID;
  if (!fileId) return null;

  try {
    var file    = DriveApp.getFileById(fileId);
    var blob    = file.getBlob();
    var bytes   = blob.getBytes();
    var b64     = Utilities.base64Encode(bytes);
    var mime    = blob.getContentType() || 'image/png';
    return 'data:' + mime + ';base64,' + b64;
  } catch (e) {
    log('WARN', 'PDFExport', 'pdfGetLogoBase64: ไม่สามารถโหลด logo: ' + e.message);
    return null;
  }
}


// ============================================================
// SECTION 4 — INTERNAL: HTML RENDER → PDF
// ============================================================

/**
 * Render HTML template เป็น PDF แล้วบันทึกลง Drive
 *
 * @param {Object} templateData — ข้อมูลที่ส่งเข้า template
 * @param {string} filename     — ชื่อไฟล์ (ไม่มี .pdf)
 * @param {string} reportType   — 'MONTHLY'|'YEARLY'|'EXECUTIVE'|'SITE'
 * @param {Object} options      — options จาก caller
 * @returns {Object} PDFResult
 * @private
 */
function _pdfRenderAndSave(templateData, filename, reportType, options) {

  // ── 1. โหลด HTML Template ─────────────────────────────
  var tmpl;
  try {
    tmpl = HtmlService.createTemplateFromFile(PDF_CONFIG.HTML_TEMPLATE);
  } catch (e) {
    throw new Error('ไม่พบ HTML Template "' + PDF_CONFIG.HTML_TEMPLATE + '": ' + e.message);
  }

  // ── 2. ส่งข้อมูลเข้า Template ─────────────────────────
  tmpl.data          = templateData;
  tmpl.companyName   = PDF_CONFIG.COMPANY_NAME;
  tmpl.companySub    = PDF_CONFIG.COMPANY_SUB;
  tmpl.companyVersion= PDF_CONFIG.COMPANY_VERSION;
  tmpl.logoBase64    = pdfGetLogoBase64();   // null = ใช้ SVG fallback
  tmpl.fontUrl       = PDF_CONFIG.FONT_URL;
  tmpl.fontFamily    = PDF_CONFIG.FONT_FAMILY;
  tmpl.generatedAt   = _pdfFormatDateTimeTh(new Date());

  // ── 3. Evaluate template → HTML string ────────────────
  var htmlOutput = tmpl.evaluate().getContent();

  // ── 4. แปลง HTML → PDF Blob ───────────────────────────
  // Google Drive แปลง HTML Blob เป็น PDF ได้โดยตรง
  var htmlBlob = Utilities.newBlob(htmlOutput, 'text/html', filename + '.html');
  var pdfBlob  = htmlBlob.getAs('application/pdf');
  pdfBlob.setName(filename + '.pdf');

  // ── 5. บันทึกลง Google Drive ──────────────────────────
  var saveResult = _pdfSaveToDrive(pdfBlob, filename, reportType, options);

  // ── 6. สร้าง response ─────────────────────────────────
  var pdfId = PDF_CONFIG.ID_PREFIX + '_' + generateId();

  log('INFO', 'PDFExport', 'PDF สร้างสำเร็จ: ' + saveResult.fileId + ' (' + filename + '.pdf)');

  return {
    success:      true,
    pdf_id:       pdfId,
    file_id:      saveResult.fileId,
    filename:     filename + '.pdf',
    download_url: pdfGetDownloadUrl(saveResult.fileId),
    view_url:     pdfGetViewUrl(saveResult.fileId),
    folder_id:    saveResult.folderId,
    report_type:  reportType,
    generated_at: nowISO(),
    size_bytes:   pdfBlob.getBytes().length,
  };
}


/**
 * บันทึก PDF Blob ลง Google Drive
 * สร้าง subfolder ตาม reportType ถ้ายังไม่มี
 *
 * @param {Blob}   pdfBlob
 * @param {string} filename
 * @param {string} reportType
 * @param {Object} options
 * @returns {{ fileId: string, folderId: string }}
 * @private
 */
function _pdfSaveToDrive(pdfBlob, filename, reportType, options) {

  // ── หา parent folder ───────────────────────────────────
  var parentFolderId = _pdfGetParentFolderId();
  var parentFolder;
  try {
    parentFolder = DriveApp.getFolderById(parentFolderId);
  } catch (e) {
    // ถ้าหา folder ไม่ได้ → บันทึกใน root
    log('WARN', 'PDFExport', 'ใช้ root Drive เนื่องจากหา folder ไม่ได้: ' + e.message);
    parentFolder = DriveApp.getRootFolder();
  }

  // ── หรือสร้าง subfolder ตาม report type ────────────────
  var subfolderName = PDF_CONFIG.SUBFOLDER_MAP[reportType] || reportType;
  var targetFolder  = _pdfGetOrCreateSubfolder(parentFolder, subfolderName);

  // ── สร้างไฟล์ใน Drive ─────────────────────────────────
  var file = targetFolder.createFile(pdfBlob);

  return {
    fileId:   file.getId(),
    folderId: targetFolder.getId(),
  };
}


/**
 * ดึง Parent Folder ID จาก CONFIG หรือ PDF_CONFIG
 * @returns {string} folder ID
 * @private
 */
function _pdfGetParentFolderId() {
  // ลองใช้ CONFIG.FOLDERS.REPORTS ก่อน (ถ้า Config.gs load แล้ว)
  try {
    var folderId = getConfig('FOLDERS.REPORTS');
    if (folderId && folderId.length > 10) return folderId;
  } catch (e) { /* ไม่มี CONFIG → ใช้ fallback */ }

  // fallback จาก PDF_CONFIG เอง
  if (PDF_CONFIG.FALLBACK_FOLDER_ID) {
    return PDF_CONFIG.FALLBACK_FOLDER_ID;
  }

  // สุดท้าย: สร้าง folder "UtilityManager_Reports" ใน root
  return _pdfGetOrCreateRootReportsFolder().getId();
}


/**
 * สร้าง folder "UtilityManager_Reports" ใน Drive root ถ้ายังไม่มี
 * @returns {DriveFolder}
 * @private
 */
function _pdfGetOrCreateRootReportsFolder() {
  var folderName = 'UtilityManager_Reports';
  var folders    = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}


/**
 * หรือสร้าง subfolder ภายใต้ parent
 *
 * @param {DriveFolder} parent
 * @param {string}      name
 * @returns {DriveFolder}
 * @private
 */
function _pdfGetOrCreateSubfolder(parent, name) {
  var existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}


// ============================================================
// SECTION 5 — INTERNAL: DATA FORMATTERS
// ============================================================

/**
 * Format วันเวลาภาษาไทย: "22 พฤษภาคม 2568 เวลา 14:30 น."
 *
 * @param {Date} date
 * @returns {string}
 */
function _pdfFormatDateTimeTh(date) {
  var d   = date.getDate();
  var m   = PDF_CONFIG.MONTHS_TH[date.getMonth()];
  var y   = date.getFullYear() + 543;  // แปลงเป็น พ.ศ.
  var hh  = String(date.getHours()).padStart(2, '0');
  var mm  = String(date.getMinutes()).padStart(2, '0');
  return d + ' ' + m + ' ' + y + ' เวลา ' + hh + ':' + mm + ' น.';
}


/**
 * Format วันที่ภาษาไทย (ไม่มีเวลา): "22 พ.ค. 2568"
 *
 * @param {Date|string} date
 * @returns {string}
 */
function _pdfFormatDateTh(date) {
  var d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);
  var day   = d.getDate();
  var month = PDF_CONFIG.MONTHS_SHORT_TH[d.getMonth()];
  var year  = d.getFullYear() + 543;
  return day + ' ' + month + ' ' + year;
}


/**
 * Format ตัวเลขเงิน: 1234567.89 → "1,234,567.89"
 *
 * @param {number} amount
 * @param {number} [decimals=2]
 * @returns {string}
 */
function _pdfFormatAmount(amount, decimals) {
  decimals = (decimals !== undefined) ? decimals : 2;
  var n = parseFloat(amount) || 0;
  return n.toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}


/**
 * Label ประเภทมิเตอร์ภาษาไทย
 *
 * @param {string} type
 * @returns {string}
 */
function _pdfMeterTypeTh(type) {
  var map = {
    ELECTRICITY: 'ไฟฟ้า',
    WATER:       'น้ำประปา',
    GAS:         'แก๊ส',
    INTERNET:    'อินเทอร์เน็ต',
    ALL:         'ทุกประเภท',
  };
  return map[String(type).toUpperCase()] || type;
}


/**
 * สร้างชื่อไฟล์ PDF
 *
 * @param {string} reportType
 * @param {Object} options
 * @returns {string} filename (ไม่มี .pdf)
 * @private
 */
function _pdfGenerateFilename(reportType, options) {
  options = options || {};

  var now      = new Date();
  var datePart = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyyMMdd_HHmmss');

  var parts = ['UM_PDF', reportType];

  if (options.year)    parts.push(String(options.year));
  if (options.month) {
    var monthPad = ('0' + options.month).slice(-2);
    parts.push(monthPad);
  }
  if (options.site_id) parts.push(options.site_id.replace(/[^A-Za-z0-9_-]/g, '_'));

  parts.push(datePart);

  return parts.join('_');
}


// ============================================================
// SECTION 6 — INTERNAL: OPTIONS & ERROR HELPERS
// ============================================================

/**
 * Normalize export options (default values)
 * @param {Object} options
 * @returns {Object}
 * @private
 */
function _pdfNormalizeOptions(options) {
  options = options || {};
  return {
    year:          options.year          || null,
    month:         options.month         || null,
    site_id:       options.site_id       || null,
    meter_type:    (options.meter_type   || 'ALL').toUpperCase(),
    save_to_drive: (options.save_to_drive !== false),  // default: true
    include_charts:options.include_charts !== false,   // default: true
    include_logo:  options.include_logo  !== false,    // default: true
  };
}


/**
 * สร้าง error response มาตรฐาน
 * @param {string} fn     — ชื่อ function
 * @param {string} msg    — ข้อความ error
 * @returns {Object}
 * @private
 */
function _pdfErrorResult(fn, msg) {
  log('ERROR', 'PDFExport', fn + ' failed: ' + msg);
  return {
    success:  false,
    pdf_id:   null,
    file_id:  null,
    filename: null,
    error:    msg,
  };
}


// ============================================================
// SECTION 7 — TEMPLATE HELPER (เรียกจากใน PDFTemplate.html)
// ============================================================

/**
 * Include CSS file เข้าใน HTML Template
 * เรียกใช้ใน PDFTemplate.html ด้วย <?= HtmlService.createHtmlOutputFromFile(...) ?>
 *
 * @param {string} filename — ชื่อไฟล์ไม่มี extension
 * @returns {string} HTML string
 */
function pdfIncludeCss(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/**
 * สร้าง SVG Logo fallback (ใช้เมื่อไม่มี logo image)
 * @returns {string} SVG HTML string
 */
function pdfGetSvgLogo() {
  return '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="40" height="40" rx="10" fill="#2563EB"/>' +
    '<path d="M10 20h6l3-8 5 16 3-8h3" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
}


// ============================================================
// SECTION 8 — BATCH EXPORT (หลาย report พร้อมกัน)
// ============================================================

/**
 * Export หลาย report เป็น PDF ในครั้งเดียว
 * ใช้สำหรับ scheduled export หรือ bulk generation
 *
 * @param {string} token
 * @param {Object[]} exportList — array ของ { type, options }
 * @returns {{ success: boolean, results: Object[], failed: number, total: number }}
 */
function pdfBatchExport(token, exportList) {
  requireAuth(token, 'canExport');

  if (!Array.isArray(exportList) || exportList.length === 0) {
    return { success: false, error: 'exportList ต้องเป็น array และไม่ว่าง' };
  }

  log('INFO', 'PDFExport', 'เริ่ม Batch Export: ' + exportList.length + ' รายการ');

  var results = [];
  var failed  = 0;

  exportList.forEach(function(item, idx) {
    try {
      var type    = String(item.type || '').toUpperCase();
      var options = item.options || {};
      var result;

      // เรียก export function ตาม type
      switch (type) {
        case 'MONTHLY':   result = pdfExportMonthly(token, options);   break;
        case 'YEARLY':    result = pdfExportYearly(token, options);    break;
        case 'EXECUTIVE': result = pdfExportExecutive(token, options); break;
        case 'SITE':      result = pdfExportSite(token, options);      break;
        default:
          result = _pdfErrorResult('pdfBatchExport', 'ไม่รู้จัก report type: ' + type);
      }

      if (!result.success) failed++;
      results.push(result);

    } catch (e) {
      failed++;
      results.push(_pdfErrorResult('pdfBatchExport[' + idx + ']', e.message));
    }
  });

  log('INFO', 'PDFExport',
      'Batch Export เสร็จ: ' + (exportList.length - failed) + '/' + exportList.length + ' สำเร็จ');

  return {
    success: failed === 0,
    results: results,
    failed:  failed,
    total:   exportList.length,
  };
}
