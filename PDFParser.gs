// ============================================================
// PDFParser.gs — PDF Upload, Text Extraction & Field Parsing
// UtilityManager | PHASE 3 — PDF Parser Module
// ============================================================
// รับผิดชอบ:
//   - รับไฟล์ PDF base64 จาก frontend แล้วบันทึกลง Google Drive
//   - สกัดข้อความจาก Digital PDF (ไม่ใช้ OCR เป็นหลัก)
//   - ส่งต่อข้อความให้ TemplateMatcher.gs จับ pattern
//   - คำนวณ Confidence Score รวม
//   - บันทึกผล parse ลง sheet PdfParseLog
//   - ส่งข้อมูลที่ parse ได้ให้ BillService.gs สร้างบิล
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs, Auth.gs,
//               TemplateMatcher.gs, PDFValidator.gs,
//               BillService.gs
// ============================================================
// หมายเหตุ:
//   ระบบนี้รองรับเฉพาะ Digital PDF (text-based) เท่านั้น
//   หากพบว่า PDF เป็น scanned image จะ flag needsManualEntry = true
//   และไม่พยายาม parse ข้อมูลออกมา
// ============================================================


// ============================================================
// SECTION 1 — CONSTANTS
// ============================================================

/** ขนาดไฟล์สูงสุดที่ยอมรับ (10 MB) */
const PDF_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * จำนวนอักขระขั้นต่ำที่ถือว่า PDF มีข้อความจริง
 * ถ้าสกัดได้น้อยกว่านี้ → น่าจะเป็น scanned PDF
 */
const PDF_MIN_TEXT_CHARS = 100;

/**
 * หมวด MIME type ที่ยอมรับ
 * Google Drive อาจส่งมาหลาย variant
 */
const PDF_ALLOWED_MIME = [
  'application/pdf',
  'application/x-pdf',
  'binary/octet-stream', // บาง browser ส่ง PDF มาแบบนี้
];

/** โฟลเดอร์ย่อยที่ใช้จัดเก็บตาม Provider */
const PDF_SUBFOLDER_MAP = {
  PEA: 'PEA_Electricity',
  MEA: 'MEA_Electricity',
  PWA: 'PWA_Water',
  PTT: 'PTT_Gas',
  OTHER: 'Other',
};


// ============================================================
// SECTION 2 — MAIN ENTRY POINT
// ============================================================

/**
 * จุดเริ่มต้นหลัก: รับ PDF จาก frontend แล้วประมวลผลทั้งหมด
 *
 * Flow:
 *   1. Validate token & permissions
 *   2. Validate ไฟล์ (ขนาด, MIME, ชื่อ)
 *   3. บันทึกไฟล์ลง Google Drive
 *   4. สกัดข้อความจาก PDF
 *   5. ตรวจสอบว่าเป็น Digital PDF หรือ Scanned
 *   6. ระบุ Provider (PEA / MEA / PWA ...)
 *   7. Parse fields ด้วย TemplateMatcher
 *   8. คำนวณ Confidence Score
 *   9. บันทึก parse log
 *  10. สร้าง bill draft ผ่าน BillService (ถ้า confidence ผ่านเกณฑ์)
 *  11. คืนผลลัพธ์กลับ frontend
 *
 * @param {string} token              — session token จาก Auth.gs
 * @param {Object} fileData           — ข้อมูลไฟล์จาก frontend
 * @param {string} fileData.base64    — เนื้อหาไฟล์ encoded เป็น base64
 * @param {string} fileData.fileName  — ชื่อไฟล์ เช่น "pea_bill_jun68.pdf"
 * @param {string} fileData.mimeType  — MIME type จาก browser
 * @param {number} fileData.fileSize  — ขนาดไฟล์ (bytes) จาก browser
 * @param {string} meterId            — meter_id ที่ผู้ใช้เลือกไว้ก่อน upload
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]     — parse อย่างเดียว ไม่สร้าง bill
 * @param {boolean} [options.forceReparse=false] — reparse แม้มีบิลซ้ำอยู่แล้ว
 * @returns {Object} ParseResult object
 */
function pdfParserProcess(token, fileData, meterId, options = {}) {
  const user = requireAuth(token, 'canWrite');
  const { dryRun = false, forceReparse = false } = options;

  log('INFO', 'pdfParserProcess', `เริ่ม process PDF: ${fileData.fileName} | meter: ${meterId}`);

  // ---- 1. Validate ไฟล์เบื้องต้น ----
  const fileValidation = _validateFileInput(fileData);
  if (!fileValidation.valid) {
    return _buildErrorResult(fileValidation.errors, fileData.fileName);
  }

  // ---- 2. ตรวจสอบ meter ก่อน upload (ไม่ต้อง upload ถ้า meter ไม่มีอยู่) ----
  const meterCheck = getMeterForBill(meterId);
  if (!meterCheck.valid) {
    return _buildErrorResult([meterCheck.error], fileData.fileName);
  }

  // ---- 3. Upload ไฟล์ลง Google Drive ----
  let driveFile;
  try {
    driveFile = _uploadPdfToDrive(fileData, meterCheck.meter);
  } catch (e) {
    log('ERROR', 'pdfParserProcess', `Upload failed: ${e.message}`);
    return _buildErrorResult([`อัปโหลดไฟล์ล้มเหลว: ${e.message}`], fileData.fileName);
  }

  // ---- 4. สกัดข้อความจาก PDF ----
  let extractedText;
  try {
    extractedText = _extractTextFromDriveFile(driveFile.fileId);
  } catch (e) {
    log('ERROR', 'pdfParserProcess', `Text extraction failed: ${e.message}`);
    // ไม่ลบไฟล์ที่ upload ไปแล้ว เก็บไว้สำหรับ manual review
    return _buildErrorResult(
      [`สกัดข้อความล้มเหลว: ${e.message}`],
      fileData.fileName,
      { fileId: driveFile.fileId, needsManualEntry: true }
    );
  }

  // ---- 5. ตรวจสอบว่าเป็น Digital PDF หรือ Scanned ----
  const textQuality = _assessTextQuality(extractedText);
  if (!textQuality.isDigital) {
    log('WARN', 'pdfParserProcess', `Scanned PDF detected: ${fileData.fileName}`);
    _savePdfParseLog({
      fileId:        driveFile.fileId,
      fileName:      fileData.fileName,
      meterId:       meterId,
      status:        'SCANNED_PDF',
      confidence:    0,
      errorMessage:  'PDF เป็น scanned image ไม่สามารถ parse อัตโนมัติได้',
      uploadedBy:    user.email,
    });
    return _buildErrorResult(
      ['PDF นี้เป็นภาพสแกน ไม่รองรับการ parse อัตโนมัติ กรุณากรอกข้อมูลด้วยมือ'],
      fileData.fileName,
      { fileId: driveFile.fileId, needsManualEntry: true, isScanned: true }
    );
  }

  // ---- 6. ระบุ Provider ----
  const providerResult = detectProvider(extractedText);

  // ---- 7. Parse fields ด้วย TemplateMatcher ----
  const parseResult = matchAndExtractFields(
    extractedText,
    providerResult.provider,
    meterCheck.meter
  );

  // ---- 8. คำนวณ Confidence Score รวม ----
  const confidence = _calculateOverallConfidence(parseResult, providerResult, textQuality);

  // ---- 9. เตรียม parsed data object ----
  const parsedData = _buildParsedData(parseResult, {
    meterId:       meterId,
    siteId:        meterCheck.meter.site_id,
    fileId:        driveFile.fileId,
    fileName:      fileData.fileName,
    provider:      providerResult.provider,
    confidence:    confidence.score,
    uploadedBy:    user.email,
  });

  // ---- 10. Validate parsed data ผ่าน PDFValidator ----
  const validation = pdfValidatorCheck(parsedData, meterCheck.meter);

  // ---- 11. บันทึก parse log ----
  const logEntry = _savePdfParseLog({
    fileId:          driveFile.fileId,
    fileName:        fileData.fileName,
    meterId:         meterId,
    provider:        providerResult.provider,
    confidence:      confidence.score,
    confidenceDetail:confidence.detail,
    parsedFields:    parseResult.fields,
    validationErrors:validation.errors,
    warnings:        [...parseResult.warnings, ...validation.warnings],
    status:          confidence.score >= CONFIG.THRESHOLDS.PDF_CONFIDENCE_MIN ? 'SUCCESS' : 'LOW_CONFIDENCE',
    uploadedBy:      user.email,
  });

  // ---- 12. สร้าง bill draft (ถ้าไม่ใช่ dryRun และ validation ผ่าน) ----
  let billResult = null;
  if (!dryRun && validation.canCreateBill) {
    try {
      billResult = billServiceCreateFromPDF(token, parsedData);
      log('INFO', 'pdfParserProcess', `Bill created: ${billResult.bill.bill_id}`);
    } catch (e) {
      log('ERROR', 'pdfParserProcess', `Bill creation failed: ${e.message}`);
      validation.billCreationError = e.message;
    }
  }

  // ---- 13. คืนผลลัพธ์ ----
  return {
    success:       true,
    fileId:        driveFile.fileId,
    fileName:      fileData.fileName,
    fileUrl:       driveFile.fileUrl,
    provider:      providerResult.provider,
    providerName:  providerResult.providerName,
    confidence:    confidence.score,
    confidenceDetail: confidence.detail,
    parsedFields:  parseResult.fields,
    rawText:       dryRun ? extractedText.substring(0, 500) : null, // ส่งแค่ตอน dryRun
    warnings:      [...parseResult.warnings, ...validation.warnings],
    errors:        validation.errors,
    needsReview:   confidence.score < CONFIG.THRESHOLDS.PDF_CONFIDENCE_MIN,
    needsManualEntry: false,
    isScanned:     false,
    bill:          billResult?.bill    || null,
    billId:        billResult?.bill?.bill_id || null,
    logId:         logEntry?.log_id    || null,
    dryRun:        dryRun,
  };
}

/**
 * Reparse ไฟล์ที่ upload ไปแล้ว
 * ใช้เมื่อ staff แก้ไข template แล้วต้องการ parse ใหม่
 *
 * @param {string} token
 * @param {string} fileId      — Google Drive file ID
 * @param {string} meterId
 * @param {string} [provider]  — บังคับ provider (ถ้าต้องการ override auto-detect)
 * @returns {Object} ParseResult
 */
function pdfParserReparse(token, fileId, meterId, provider) {
  requireAuth(token, 'canWrite');

  log('INFO', 'pdfParserReparse', `Reparse fileId: ${fileId} | meter: ${meterId}`);

  const extractedText = _extractTextFromDriveFile(fileId);
  const textQuality   = _assessTextQuality(extractedText);

  if (!textQuality.isDigital) {
    return _buildErrorResult(['PDF เป็น scanned image ไม่สามารถ reparse ได้'], fileId);
  }

  const providerResult = provider
    ? { provider, providerName: _getProviderName(provider), confidence: 100 }
    : detectProvider(extractedText);

  const meterCheck = getMeterForBill(meterId);
  if (!meterCheck.valid) return _buildErrorResult([meterCheck.error], fileId);

  const parseResult = matchAndExtractFields(extractedText, providerResult.provider, meterCheck.meter);
  const confidence  = _calculateOverallConfidence(parseResult, providerResult, textQuality);

  return {
    success:      true,
    fileId:       fileId,
    provider:     providerResult.provider,
    confidence:   confidence.score,
    parsedFields: parseResult.fields,
    warnings:     parseResult.warnings,
    needsReview:  confidence.score < CONFIG.THRESHOLDS.PDF_CONFIDENCE_MIN,
  };
}

/**
 * ดึงรายการ PDF ที่รอ review
 *
 * @param {string} token
 * @param {Object} [filters]
 * @returns {Object[]}
 */
function pdfParserGetPendingReview(token, filters = {}) {
  requireAuth(token, 'canRead');
  return dbFind(CONFIG.SHEETS.BILLS, {
    source:       'PDF',
    bill_status:  'PENDING_REVIEW',
    ...filters,
  });
}


// ============================================================
// SECTION 3 — GOOGLE DRIVE OPERATIONS
// ============================================================

/**
 * Upload PDF ไฟล์ไปยัง Google Drive
 * จัดโครงสร้างโฟลเดอร์ตาม: PDFBills/{ปี พ.ศ.}/{เดือน}/{site_code}/
 *
 * @param {Object} fileData
 * @param {Object} meter     — meter object สำหรับดึง site_id
 * @returns {{ fileId: string, fileUrl: string, folderPath: string }}
 * @private
 */
function _uploadPdfToDrive(fileData, meter) {
  // ---- หาโฟลเดอร์ปลายทาง ----
  const rootFolder = DriveApp.getFolderById(CONFIG.FOLDERS.PDF_BILLS);

  // สร้างโฟลเดอร์ตาม ปี พ.ศ. → เดือน → site_code
  const yearBE   = toBuddhistYear(new Date().getFullYear());
  const monthStr = _padMonth(new Date().getMonth() + 1);
  const yearFolder  = _getOrCreateSubfolder(rootFolder, String(yearBE));
  const monthFolder = _getOrCreateSubfolder(yearFolder, monthStr);

  // ดึง site_code จาก meter.site_id
  const site       = dbGetById(CONFIG.SHEETS.SITES, 'site_id', meter.site_id);
  const siteCode   = site?.site_code || meter.site_id;
  const siteFolder = _getOrCreateSubfolder(monthFolder, siteCode);

  // ---- แปลง base64 เป็น Blob ----
  const decoded  = Utilities.newBlob(
    Utilities.base64Decode(fileData.base64),
    'application/pdf',
    fileData.fileName
  );

  // ---- ตรวจสอบขนาดจริงหลัง decode ----
  const actualSize = decoded.getBytes().length;
  if (actualSize > PDF_MAX_SIZE_BYTES) {
    throw new Error(`ไฟล์ใหญ่เกินไป: ${(actualSize / 1024 / 1024).toFixed(1)} MB (สูงสุด 10 MB)`);
  }

  // ---- สร้างชื่อไฟล์ unique ไม่ให้ชนกัน ----
  const safeFileName = _buildSafeFileName(fileData.fileName, meter.meter_id);

  // ---- Upload ----
  const file    = siteFolder.createFile(decoded.setName(safeFileName));
  const fileId  = file.getId();
  const fileUrl = file.getUrl();

  log('INFO', '_uploadPdfToDrive', `Uploaded: ${safeFileName} → ${fileId}`);

  return {
    fileId,
    fileUrl,
    folderPath: `${yearBE}/${monthStr}/${siteCode}`,
    fileName:   safeFileName,
  };
}

/**
 * สกัดข้อความจาก PDF file ใน Google Drive
 * ใช้วิธี convert-to-Google-Doc แล้วอ่านข้อความ
 * วิธีนี้รองรับ Digital PDF ที่มี text layer เท่านั้น
 *
 * @param {string} fileId   — Google Drive file ID ของ PDF
 * @returns {string} raw text ที่สกัดได้
 * @private
 */
function _extractTextFromDriveFile(fileId) {
  const pdfFile = DriveApp.getFileById(fileId);

  // ---- วิธีที่ 1: Convert PDF → Google Doc แล้วอ่าน text ----
  // วิธีนี้เร็วที่สุดสำหรับ Digital PDF และไม่ต้องใช้ external API
  const tempFolder = DriveApp.getFolderById(CONFIG.FOLDERS.ROOT);

  let googleDoc;
  try {
    // insertBlob with convert=true จะแปลง PDF เป็น Google Doc อัตโนมัติ
    const blob = pdfFile.getBlob().setContentType('application/pdf');
    const resource = { title: 'temp_parse_' + fileId, mimeType: MimeType.GOOGLE_DOCS };

    // ใช้ Drive API v2 ผ่าน UrlFetchApp เพื่อ convert
    googleDoc = _convertPdfToGoogleDoc(blob, tempFolder.getId());
    const docId = googleDoc.getId();

    // อ่านข้อความจาก Google Doc
    const doc  = DocumentApp.openById(docId);
    const body = doc.getBody();
    const text = body.getText();

    // ลบ temp doc ทิ้งหลังอ่านเสร็จ
    DriveApp.getFileById(docId).setTrashed(true);

    log('INFO', '_extractTextFromDriveFile', `Extracted ${text.length} chars from ${fileId}`);
    return text;

  } catch (e) {
    // ---- fallback: ลองอ่านด้วย Drive API โดยตรง ----
    log('WARN', '_extractTextFromDriveFile', `Method 1 failed, trying fallback: ${e.message}`);
    return _extractTextFallback(pdfFile);
  }
}

/**
 * Convert PDF blob เป็น Google Doc ผ่าน Drive API
 * ต้องการ Drive API service enabled ใน GAS project
 * @private
 */
function _convertPdfToGoogleDoc(pdfBlob, folderId) {
  const metadata = {
    title:    'temp_parse_' + Utilities.getUuid(),
    mimeType: MimeType.GOOGLE_DOCS,
    parents:  [{ id: folderId }],
  };

  // ใช้ multipart upload ของ Drive API
  const boundary = '-------314159265358979323846';
  const delimiter = '\r\n--' + boundary + '\r\n';
  const closeDelimiter = '\r\n--' + boundary + '--';

  const metadataString = JSON.stringify(metadata);
  const pdfBase64 = Utilities.base64Encode(pdfBlob.getBytes());

  const multipartBody =
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    metadataString +
    delimiter +
    'Content-Type: application/pdf\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    pdfBase64 +
    closeDelimiter;

  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v2/files?uploadType=multipart&convert=true',
    {
      method:  'POST',
      contentType: 'multipart/mixed; boundary="' + boundary + '"',
      payload: multipartBody,
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    }
  );

  const result = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    throw new Error(`Drive API error: ${result.error?.message || 'Unknown error'}`);
  }

  return DriveApp.getFileById(result.id);
}

/**
 * Fallback: อ่านข้อความจาก PDF โดยใช้ SpreadsheetApp (วิธีสำรอง)
 * ใช้เมื่อ convert-to-doc ล้มเหลว
 * @private
 */
function _extractTextFallback(pdfFile) {
  try {
    // พยายาม get text content โดยตรง
    const blob = pdfFile.getBlob();
    const bytes = blob.getBytes();
    const rawContent = String.fromCharCode.apply(null, bytes.map(b => b < 0 ? b + 256 : b));

    // สกัด text streams จาก PDF structure แบบ basic
    const textMatches = rawContent.match(/\(([\x20-\x7E\u0E00-\u0E7F]{2,})\)/g) || [];
    const extractedTexts = textMatches
      .map(m => m.slice(1, -1))
      .filter(t => t.length > 2)
      .join(' ');

    log('INFO', '_extractTextFallback', `Fallback extracted ${extractedTexts.length} chars`);
    return extractedTexts;

  } catch (e) {
    throw new Error(`ไม่สามารถสกัดข้อความได้: ${e.message}`);
  }
}

/**
 * ดึง/สร้าง subfolder ตามชื่อ
 * @private
 */
function _getOrCreateSubfolder(parentFolder, name) {
  const existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parentFolder.createFolder(name);
}

/**
 * สร้างชื่อไฟล์ที่ปลอดภัยและ unique
 * format: {meter_id}_{YYYY-MM-DD}_{timestamp}.pdf
 * @private
 */
function _buildSafeFileName(originalName, meterId) {
  const date      = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const ts        = Date.now().toString().slice(-6);
  const cleanName = originalName.replace(/[^a-zA-Z0-9ก-๙._-]/g, '_').replace(/\.pdf$/i, '');
  return `${meterId}_${date}_${ts}_${cleanName}.pdf`;
}

/**
 * Pad เลขเดือนเป็น 2 หลัก
 * @private
 */
function _padMonth(month) {
  const thaiMonths = [
    '01_มกราคม', '02_กุมภาพันธ์', '03_มีนาคม',
    '04_เมษายน', '05_พฤษภาคม', '06_มิถุนายน',
    '07_กรกฎาคม', '08_สิงหาคม', '09_กันยายน',
    '10_ตุลาคม', '11_พฤศจิกายน', '12_ธันวาคม',
  ];
  return thaiMonths[month - 1] || String(month).padStart(2, '0');
}


// ============================================================
// SECTION 4 — TEXT QUALITY ASSESSMENT
// ============================================================

/**
 * ประเมินคุณภาพข้อความที่สกัดได้
 * ตรวจว่าเป็น Digital PDF จริงหรือเป็น Scanned image
 *
 * @param {string} text  — raw text จาก PDF
 * @returns {{ isDigital: boolean, charCount: number, thaiCharCount: number, qualityScore: number }}
 * @private
 */
function _assessTextQuality(text) {
  if (!text || typeof text !== 'string') {
    return { isDigital: false, charCount: 0, thaiCharCount: 0, qualityScore: 0 };
  }

  const charCount     = text.length;
  const cleanText     = text.replace(/\s+/g, ' ').trim();
  const thaiChars     = (cleanText.match(/[\u0E00-\u0E7F]/g) || []).length;
  const digitChars    = (cleanText.match(/\d/g) || []).length;
  const meaningfulChars = thaiChars + digitChars;

  // Digital PDF ต้องมีอักขระที่ meaningful เพียงพอ
  const isDigital     = charCount >= PDF_MIN_TEXT_CHARS && meaningfulChars >= 20;

  // Quality score 0-100 สำหรับ confidence calculation
  const qualityScore  = isDigital
    ? Math.min(100, Math.floor((meaningfulChars / charCount) * 200))
    : 0;

  log('DEBUG', '_assessTextQuality',
    `chars=${charCount}, thai=${thaiChars}, digits=${digitChars}, isDigital=${isDigital}`
  );

  return { isDigital, charCount, thaiCharCount: thaiChars, digitChars, qualityScore };
}


// ============================================================
// SECTION 5 — CONFIDENCE SCORING
// ============================================================

/**
 * คำนวณ Overall Confidence Score (0-100)
 * รวม: text quality + provider detection + field completeness
 *
 * @param {Object} parseResult      — ผลจาก matchAndExtractFields()
 * @param {Object} providerResult   — ผลจาก detectProvider()
 * @param {Object} textQuality      — ผลจาก _assessTextQuality()
 * @returns {{ score: number, detail: Object }}
 * @private
 */
function _calculateOverallConfidence(parseResult, providerResult, textQuality) {
  // น้ำหนักของแต่ละองค์ประกอบ
  const WEIGHTS = {
    textQuality:       15,  // คุณภาพข้อความโดยรวม
    providerDetection: 15,  // ความมั่นใจในการระบุ provider
    fieldScore:        70,  // ความครบถ้วนของ fields ที่สำคัญ
  };

  const textScore     = Math.min(100, textQuality.qualityScore);
  const providerScore = providerResult.confidence || 0;
  const fieldScore    = parseResult.confidenceScore || 0;

  const overall = Math.round(
    (textScore     * WEIGHTS.textQuality       / 100) +
    (providerScore * WEIGHTS.providerDetection / 100) +
    (fieldScore    * WEIGHTS.fieldScore        / 100)
  );

  return {
    score: Math.min(100, Math.max(0, overall)),
    detail: {
      textQuality:        textScore,
      providerDetection:  providerScore,
      fieldCompleteness:  fieldScore,
      weights:            WEIGHTS,
    },
  };
}


// ============================================================
// SECTION 6 — DATA BUILDERS
// ============================================================

/**
 * รวม parsed fields กับ metadata เพื่อส่งต่อ BillService
 *
 * @param {Object} parseResult  — fields จาก TemplateMatcher
 * @param {Object} meta         — metadata (meterId, fileId, ...)
 * @returns {Object} data object พร้อมส่ง billServiceCreateFromPDF()
 * @private
 */
function _buildParsedData(parseResult, meta) {
  const fields = parseResult.fields || {};

  return {
    // ข้อมูลจาก parse
    meter_id:            meta.meterId,
    site_id:             meta.siteId,
    bill_year:           fields.bill_year   || null,
    bill_month:          fields.bill_month  || null,
    amount_total:        fields.amount_total || 0,
    amount_base:         fields.amount_base  || 0,
    amount_ft:           fields.amount_ft    || 0,
    amount_vat:          fields.amount_vat   || 0,
    units_before:        fields.units_before || 0,
    units_after:         fields.units_after  || 0,
    units_used:          fields.units_used   || 0,
    due_date:            fields.due_date     || '',
    reading_date_from:   fields.reading_date_from || '',
    reading_date_to:     fields.reading_date_to   || '',
    contract_number:     fields.contract_number   || '',
    meter_number:        fields.meter_number      || '',

    // metadata
    pdf_file_id:         meta.fileId,
    pdf_confidence:      meta.confidence,
    source:              'PDF',
    notes:               `[PDF] ${meta.fileName} | Provider: ${meta.provider} | Confidence: ${meta.confidence}%`,
  };
}

/**
 * สร้าง error result object มาตรฐาน
 * @private
 */
function _buildErrorResult(errors, fileName, extra = {}) {
  return {
    success:          false,
    fileName:         fileName || '',
    errors:           errors,
    warnings:         [],
    parsedFields:     null,
    confidence:       0,
    needsReview:      true,
    needsManualEntry: extra.needsManualEntry || false,
    isScanned:        extra.isScanned        || false,
    fileId:           extra.fileId           || null,
    bill:             null,
    billId:           null,
    ...extra,
  };
}


// ============================================================
// SECTION 7 — PARSE LOG
// ============================================================

/**
 * บันทึก log การ parse ลง sheet PdfParseLog
 * ใช้สำหรับ audit trail และ debug
 *
 * @param {Object} logData
 * @returns {Object} log entry ที่บันทึกไว้
 * @private
 */
function _savePdfParseLog(logData) {
  const entry = {
    log_id:           generateId('LOG'),
    file_id:          logData.fileId          || '',
    file_name:        logData.fileName        || '',
    meter_id:         logData.meterId         || '',
    provider:         logData.provider        || '',
    confidence:       logData.confidence      || 0,
    confidence_detail:JSON.stringify(logData.confidenceDetail || {}),
    parsed_fields:    JSON.stringify(logData.parsedFields || {}),
    validation_errors:JSON.stringify(logData.validationErrors || []),
    warnings:         JSON.stringify(logData.warnings || []),
    status:           logData.status          || 'UNKNOWN',
    error_message:    logData.errorMessage    || '',
    uploaded_by:      logData.uploadedBy      || '',
    created_at:       nowISO(),
  };

  try {
    // ถ้า sheet PdfParseLog ยังไม่มี ให้ข้าม (optional logging)
    if (sheetExists(CONFIG.SHEETS.PDF_PARSE_LOG || 'PdfParseLog')) {
      dbInsert(CONFIG.SHEETS.PDF_PARSE_LOG || 'PdfParseLog', entry);
    }
  } catch (e) {
    // Log to Logger แต่ไม่ throw — logging ไม่ควรทำให้ flow หลักพัง
    log('WARN', '_savePdfParseLog', `Cannot save log: ${e.message}`);
  }

  return entry;
}


// ============================================================
// SECTION 8 — INPUT VALIDATOR
// ============================================================

/**
 * ตรวจสอบ fileData ที่รับมาจาก frontend
 * @private
 */
function _validateFileInput(fileData) {
  const errors = [];

  if (!fileData) {
    return { valid: false, errors: ['ไม่พบข้อมูลไฟล์'] };
  }

  if (!fileData.base64 || fileData.base64.trim() === '') {
    errors.push('base64: ไม่พบเนื้อหาไฟล์');
  }

  if (!fileData.fileName || fileData.fileName.trim() === '') {
    errors.push('fileName: ไม่พบชื่อไฟล์');
  } else if (!fileData.fileName.toLowerCase().endsWith('.pdf')) {
    errors.push('fileName: รองรับเฉพาะไฟล์ .pdf เท่านั้น');
  }

  // ตรวจ MIME type (ถ้าส่งมา)
  if (fileData.mimeType && !PDF_ALLOWED_MIME.includes(fileData.mimeType.toLowerCase())) {
    errors.push(`mimeType: ไม่รองรับ "${fileData.mimeType}"`);
  }

  // ตรวจขนาด (จาก client-reported size)
  if (fileData.fileSize && fileData.fileSize > PDF_MAX_SIZE_BYTES) {
    errors.push(`fileSize: ไฟล์ใหญ่เกินไป (${(fileData.fileSize / 1024 / 1024).toFixed(1)} MB, สูงสุด 10 MB)`);
  }

  // ตรวจ base64 format เบื้องต้น
  if (fileData.base64) {
    const cleanBase64 = fileData.base64.replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(cleanBase64.replace(/\s/g, ''))) {
      errors.push('base64: รูปแบบ base64 ไม่ถูกต้อง');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * ดึงชื่อ Provider ภาษาไทย
 * @private
 */
function _getProviderName(provider) {
  const names = {
    PEA:   'การไฟฟ้าส่วนภูมิภาค (PEA)',
    MEA:   'การไฟฟ้านครหลวง (MEA)',
    PWA:   'การประปาส่วนภูมิภาค (PWA)',
    MWA:   'การประปานครหลวง (MWA)',
    PTT:   'ปตท. (PTT)',
    OTHER: 'อื่นๆ',
  };
  return names[provider] || provider || 'ไม่ทราบ';
}

/**
 * ตรวจสอบว่า sheet มีอยู่จริงหรือไม่
 * ใช้สำหรับ optional sheets เช่น PdfParseLog
 * @private
 */
function sheetExists(sheetName) {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    return ss.getSheetByName(sheetName) !== null;
  } catch (e) {
    return false;
  }
}
