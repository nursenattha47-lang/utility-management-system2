// ============================================================
// Database.gs — Google Sheets CRUD Layer
// UtilityManager | PHASE 2 — Backend Foundation
// ============================================================
// ทุก read/write ต้องผ่านไฟล์นี้เท่านั้น
// ห้าม SpreadsheetApp ในไฟล์ API โดยตรง
// ============================================================
// Dependencies: Config.gs, Utils.gs
// ============================================================


// ============================================================
// SECTION 1 — SPREADSHEET ACCESS
// ============================================================

/**
 * เปิด Spreadsheet และ cache instance ไว้ใน script lifetime
 * หลีกเลี่ยงการเปิดซ้ำหลายครั้งใน request เดียวกัน
 */
let _ss = null;

function getSpreadsheet() {
  if (!_ss) {
    _ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  }
  return _ss;
}

/**
 * ดึง Sheet object จากชื่อ Sheet
 * @param {string} sheetName - ใช้ CONFIG.SHEETS.xxx เสมอ
 * @throws {Error} ถ้า Sheet ไม่พบ
 */
function getSheet(sheetName) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`Sheet not found: "${sheetName}". ตรวจสอบ CONFIG.SHEETS และชื่อ Tab ใน Spreadsheet`);
  }
  return sheet;
}


// ============================================================
// SECTION 2 — READ OPERATIONS
// ============================================================

/**
 * อ่านข้อมูลทั้งหมดจาก Sheet คืนเป็น array ของ object
 * อ่านครั้งเดียวทั้ง sheet (batch read) → ประหยัด API call
 *
 * @param {string} sheetName
 * @param {Object} [options]
 * @param {boolean} [options.skipEmpty=true] - ข้าม row ที่ column แรกว่าง
 * @returns {Object[]}
 */
function dbGetAll(sheetName, options = {}) {
  const { skipEmpty = true } = options;
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) return []; // มีแค่ header หรือว่าง

  const headers = data[0].map(h => String(h).trim());
  const rows = data.slice(1);

  return rows
    .map(row => Object.fromEntries(headers.map((h, i) => [h, row[i]])))
    .filter(row => !skipEmpty || (row[headers[0]] !== '' && row[headers[0]] !== null));
}

/**
 * ดึง row เดียวตาม ID
 *
 * @param {string} sheetName
 * @param {string} idField - ชื่อ column ที่เป็น primary key
 * @param {string} idValue - ค่า ID ที่ต้องการ
 * @returns {Object|null}
 */
function dbGetById(sheetName, idField, idValue) {
  const rows = dbGetAll(sheetName);
  return rows.find(row => String(row[idField]) === String(idValue)) || null;
}

/**
 * ดึง rows ที่ตรงกับ filter conditions (AND logic)
 *
 * @param {string} sheetName
 * @param {Object} filters - เช่น { site_id: 'SITE_001', meter_type: 'ELECTRICITY' }
 * @returns {Object[]}
 */
function dbFind(sheetName, filters) {
  const rows = dbGetAll(sheetName);
  return rows.filter(row =>
    Object.entries(filters).every(([k, v]) => String(row[k]) === String(v))
  );
}

/**
 * นับจำนวน rows ที่ตรงกับ filter
 */
function dbCount(sheetName, filters = {}) {
  return dbFind(sheetName, filters).length;
}

/**
 * ตรวจสอบว่ามี row ที่ตรงกับ conditions แล้วหรือยัง (duplicate check)
 *
 * @param {string} sheetName
 * @param {Object} conditions
 * @returns {boolean}
 */
function dbExists(sheetName, conditions) {
  return dbFind(sheetName, conditions).length > 0;
}


// ============================================================
// SECTION 3 — WRITE OPERATIONS
// ============================================================

/**
 * เพิ่ม row ใหม่ต่อท้าย Sheet
 * map ค่าตาม header order อัตโนมัติ — ไม่ต้องสนใจลำดับ column
 *
 * @param {string} sheetName
 * @param {Object} rowObj - object ที่มี key ตรงกับ header
 * @returns {string} - ID ของ row ที่เพิ่ม (column แรก)
 */
function dbInsert(sheetName, rowObj) {
  const sheet = getSheet(sheetName);

  // อ่าน headers แบบ single-row read (เร็วกว่าอ่านทั้ง sheet)
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h).trim());

  const newRow = headers.map(h => {
    const val = rowObj[h];
    return (val !== undefined && val !== null) ? val : '';
  });

  sheet.appendRow(newRow);

  // บันทึก Audit Log
  const recordId = rowObj[headers[0]];
  _writeAuditLog('INSERT', sheetName, recordId, null, rowObj);

  log('INFO', 'dbInsert', `${sheetName} ← ${recordId}`);
  return recordId;
}

/**
 * อัปเดต row ตาม ID
 * อัปเดตเฉพาะ field ที่ส่งมาใน updates เท่านั้น (partial update)
 *
 * @param {string} sheetName
 * @param {string} idField - ชื่อ column ที่เป็น PK
 * @param {string} idValue - ค่า ID
 * @param {Object} updates - fields ที่ต้องการแก้ไข
 * @returns {boolean} - true ถ้าอัปเดตสำเร็จ
 */
function dbUpdate(sheetName, idField, idValue, updates) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim());
  const idCol = headers.indexOf(idField);

  if (idCol === -1) throw new Error(`Column "${idField}" ไม่พบใน ${sheetName}`);

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) !== String(idValue)) continue;

    // batch write: เก็บ changes แล้ว setValues ครั้งเดียว
    const oldRow = Object.fromEntries(headers.map((h, j) => [h, data[i][j]]));
    let changed = false;

    Object.entries(updates).forEach(([key, val]) => {
      const col = headers.indexOf(key);
      if (col === -1) return; // ข้าม field ที่ไม่มีใน sheet
      sheet.getRange(i + 1, col + 1).setValue(val);
      changed = true;
    });

    if (changed) {
      // อัปเดต updated_at อัตโนมัติ (ถ้า column มีอยู่)
      const updatedAtCol = headers.indexOf('updated_at');
      if (updatedAtCol !== -1) {
        sheet.getRange(i + 1, updatedAtCol + 1).setValue(nowISO());
      }
      _writeAuditLog('UPDATE', sheetName, idValue, oldRow, updates);
      log('INFO', 'dbUpdate', `${sheetName}[${idValue}]`, updates);
    }
    return changed;
  }

  log('WARN', 'dbUpdate', `${sheetName}[${idValue}] ไม่พบ record`);
  return false;
}

/**
 * Soft delete — เปลี่ยน status เป็น INACTIVE แทนการลบจริง
 * ป้องกันการสูญหายของข้อมูล
 *
 * @param {string} sheetName
 * @param {string} idField
 * @param {string} idValue
 * @param {string} [statusField='is_active'] - ชื่อ column ที่ใช้ soft delete
 * @returns {boolean}
 */
function dbSoftDelete(sheetName, idField, idValue, statusField = 'is_active') {
  const result = dbUpdate(sheetName, idField, idValue, { [statusField]: false });
  if (result) {
    _writeAuditLog('DELETE', sheetName, idValue, null, null);
    log('INFO', 'dbSoftDelete', `${sheetName}[${idValue}]`);
  }
  return result;
}

/**
 * Upsert — Insert ถ้าไม่มี, Update ถ้ามีแล้ว
 *
 * @param {string} sheetName
 * @param {string} idField
 * @param {Object} rowObj - ต้องมี idField อยู่ใน object
 * @returns {{ action: 'inserted'|'updated', id: string }}
 */
function dbUpsert(sheetName, idField, rowObj) {
  const idValue = rowObj[idField];
  const existing = dbGetById(sheetName, idField, idValue);

  if (existing) {
    dbUpdate(sheetName, idField, idValue, rowObj);
    return { action: 'updated', id: idValue };
  } else {
    dbInsert(sheetName, rowObj);
    return { action: 'inserted', id: idValue };
  }
}


// ============================================================
// SECTION 4 — BATCH OPERATIONS
// ============================================================

/**
 * Insert หลาย rows พร้อมกัน (batch) — เร็วกว่า loop dbInsert
 * ใช้สำหรับ import ข้อมูลจำนวนมาก
 *
 * @param {string} sheetName
 * @param {Object[]} rowObjects
 * @returns {number} - จำนวน rows ที่ insert สำเร็จ
 */
function dbBatchInsert(sheetName, rowObjects) {
  if (!rowObjects || rowObjects.length === 0) return 0;

  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h).trim());

  const newRows = rowObjects.map(obj =>
    headers.map(h => (obj[h] !== undefined && obj[h] !== null) ? obj[h] : '')
  );

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);

  _writeAuditLog('BATCH_INSERT', sheetName, `${rowObjects.length} rows`, null, null);
  log('INFO', 'dbBatchInsert', `${sheetName} ← ${rowObjects.length} rows`);
  return rowObjects.length;
}


// ============================================================
// SECTION 5 — SHEET INITIALIZATION
// ============================================================

/**
 * สร้าง Sheet ทั้งหมดพร้อม headers ถ้ายังไม่มี
 * รัน 1 ครั้งตอน initial setup
 */
function initializeAllSheets() {
  const ss = getSpreadsheet();
  const schemas = _getSheetSchemas();

  let created = 0;
  let skipped = 0;

  for (const [sheetName, headers] of Object.entries(schemas)) {
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      // Format header row
      const headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#1a73e8');
      headerRange.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      created++;
      log('INFO', 'initializeAllSheets', `✅ สร้าง Sheet: ${sheetName}`);
    } else {
      skipped++;
      log('INFO', 'initializeAllSheets', `⏭️  มีอยู่แล้ว: ${sheetName}`);
    }
  }

  Logger.log(`\n=== Sheet Initialization Complete ===`);
  Logger.log(`สร้างใหม่: ${created} | มีอยู่แล้ว: ${skipped}`);
  return { created, skipped };
}

/**
 * Schema definitions — headers แต่ละ Sheet
 * ลำดับ column สำคัญ: ต้องตรงกับที่ออกแบบไว้
 * @private
 */
function _getSheetSchemas() {
  return {
    [CONFIG.SHEETS.SITES]: [
      'site_id', 'site_code', 'site_name', 'site_type',
      'address', 'district', 'province', 'postcode',
      'contact_name', 'contact_phone', 'contact_email',
      'status', 'notes', 'created_at', 'updated_at',
    ],
    [CONFIG.SHEETS.METERS]: [
      'meter_id', 'site_id', 'meter_number', 'meter_type',
      'provider', 'meter_name', 'location_detail',
      'rate_type', 'contract_number', 'install_date',
      'status', 'notes', 'created_at', 'updated_at',
    ],
    [CONFIG.SHEETS.BILLS]: [
      'bill_id', 'meter_id', 'site_id',
      'bill_year', 'bill_month', 'bill_period_key',
      'units_before', 'units_after', 'units_used',
      'amount_base', 'amount_ft', 'amount_vat', 'amount_total',
      'reading_date_from', 'reading_date_to', 'due_date',
      'bill_status', 'needs_review',
      'pdf_file_id', 'pdf_confidence', 'source',
      'notes', 'created_by', 'created_at', 'updated_at',
    ],
    [CONFIG.SHEETS.BILL_PAYMENTS]: [
      'payment_id', 'bill_id', 'meter_id', 'site_id',
      'amount_paid', 'payment_date', 'payment_method',
      'account_id', 'reference_number', 'receipt_file_id',
      'notes', 'created_by', 'created_at',
    ],
    [CONFIG.SHEETS.ACCOUNTS]: [
      'account_id', 'account_name', 'bank_name',
      'account_number', 'account_type',
      'is_active', 'notes', 'created_at',
    ],
    [CONFIG.SHEETS.ADVANCES]: [
      'advance_id', 'site_id', 'requested_by', 'approved_by',
      'amount_requested', 'amount_used', 'amount_remaining',
      'purpose', 'advance_date', 'due_settle_date', 'settled_date',
      'status', 'notes', 'created_at', 'updated_at',
    ],
    [CONFIG.SHEETS.USERS]: [
      'user_id', 'email', 'display_name', 'role',
      'site_access', 'is_active',
      'last_login', 'created_at', 'updated_at',
    ],
    [CONFIG.SHEETS.ANOMALIES]: [
      'anomaly_id', 'meter_id', 'site_id',
      'anomaly_type', 'severity',
      'bill_year', 'bill_month', 'bill_period_key',
      'current_value', 'previous_value', 'avg6m_value',
      'change_pct', 'message',
      'is_acknowledged', 'acknowledged_by', 'acknowledged_at',
      'created_at',
    ],
    [CONFIG.SHEETS.AUDIT_LOG]: [
      'audit_id', 'action', 'sheet_name', 'record_id',
      'old_values', 'new_values',
      'performed_by', 'performed_at',
    ],
    [CONFIG.SHEETS.MONTHLY_SUMMARY]: [
      'summary_id', 'site_id', 'bill_period_key',
      'bill_year', 'bill_month',
      'total_electricity_amount', 'total_water_amount',
      'total_gas_amount', 'total_internet_amount',
      'total_amount', 'bill_count',
      'paid_count', 'unpaid_count',
      'created_at',
    ],
  };
}


// ============================================================
// SECTION 6 — AUDIT LOG (internal)
// ============================================================

/**
 * บันทึก Audit Log ทุกการเปลี่ยนแปลงข้อมูล
 * เรียกอัตโนมัติจาก dbInsert/dbUpdate/dbSoftDelete
 * @private
 */
function _writeAuditLog(action, sheetName, recordId, oldValues, newValues) {
  try {
    // ใช้ getSheet โดยตรงเพื่อหลีกเลี่ยง infinite loop
    const ss = getSpreadsheet();
    const auditSheet = ss.getSheetByName(CONFIG.SHEETS.AUDIT_LOG);
    if (!auditSheet) return; // ถ้ายังไม่มี sheet ให้ข้ามไปก่อน

    const performer = _getCurrentUserEmail();
    const auditId = generateId(CONFIG.ID_PREFIX.AUDIT);

    auditSheet.appendRow([
      auditId,
      action,
      sheetName,
      String(recordId || ''),
      oldValues ? JSON.stringify(oldValues) : '',
      newValues ? JSON.stringify(newValues) : '',
      performer,
      nowISO(),
    ]);
  } catch (e) {
    // ไม่ throw เพื่อไม่ให้ Audit ทำให้ main operation ล้มเหลว
    Logger.log(`[WARN][_writeAuditLog] ${e.message}`);
  }
}

/**
 * ดึง email ของ user ที่กำลัง execute script
 * @private
 */
function _getCurrentUserEmail() {
  try {
    return Session.getActiveUser().getEmail() || 'system';
  } catch (e) {
    return 'system';
  }
}


// ============================================================
// SECTION 7 — ARCHIVE
// ============================================================

/**
 * ย้าย Bills เก่ากว่า 2 ปีไป ArchiveBills Sheet
 * เรียกจาก Time-driven Trigger ปีละครั้ง
 *
 * @returns {{ archived: number }}
 */
function archiveOldBills() {
  const currentYear = toBuddhistYear(new Date().getFullYear());
  const cutoffYear = currentYear - 2;

  const allBills = dbGetAll(CONFIG.SHEETS.BILLS);
  const toArchive = allBills.filter(b => parseInt(b.bill_year) <= cutoffYear);

  if (toArchive.length === 0) {
    log('INFO', 'archiveOldBills', 'ไม่มีข้อมูลที่ต้อง archive');
    return { archived: 0 };
  }

  // Insert ลง Archive sheet
  const ss = getSpreadsheet();
  let archiveSheet = ss.getSheetByName(CONFIG.SHEETS.ARCHIVE_BILLS);
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet(CONFIG.SHEETS.ARCHIVE_BILLS);
  }

  // ใช้ Bills schema headers
  const billsSheet = getSheet(CONFIG.SHEETS.BILLS);
  const headers = billsSheet.getRange(1, 1, 1, billsSheet.getLastColumn()).getValues()[0];

  // ถ้า archive sheet ว่างอยู่ → เพิ่ม header
  if (archiveSheet.getLastRow() === 0) {
    archiveSheet.appendRow(headers);
  }

  const archiveRows = toArchive.map(bill => headers.map(h => bill[h] ?? ''));
  const startRow = archiveSheet.getLastRow() + 1;
  archiveSheet.getRange(startRow, 1, archiveRows.length, headers.length).setValues(archiveRows);

  // ลบออกจาก Bills sheet (จาก ล่างขึ้นบน เพื่อไม่ให้ row index เพี้ยน)
  const billsData = billsSheet.getDataRange().getValues();
  const billIds = new Set(toArchive.map(b => b.bill_id));

  for (let i = billsData.length - 1; i >= 1; i--) {
    if (billIds.has(billsData[i][0])) {
      billsSheet.deleteRow(i + 1);
    }
  }

  log('INFO', 'archiveOldBills', `Archived ${toArchive.length} bills (ปี ≤ ${cutoffYear})`);
  return { archived: toArchive.length };
}
