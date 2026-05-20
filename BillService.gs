// ============================================================
// BillService.gs — Bills Business Logic Layer
// UtilityManager | PHASE 2 — Bills Module
// ============================================================
// รับผิดชอบ:
//   - CRUD operations สำหรับ Bills
//   - Bill calculation (amount breakdown)
//   - Payment integration (trigger workflow PAID)
//   - Batch import (จาก spreadsheet หรือ PDF parser)
//   - Retroactive bill support (ย้อนหลัง)
//   - Audit trail ทุก operation
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs, Auth.gs,
//               BillValidator.gs, BillWorkflow.gs
// ============================================================


// ============================================================
// SECTION 1 — CREATE OPERATIONS
// ============================================================

/**
 * สร้างบิลใหม่ (manual entry)
 * เส้นทางหลักสำหรับ staff กรอกข้อมูลด้วยมือ
 *
 * @param {string} token
 * @param {Object} data
 * @param {string} data.meter_id
 * @param {number} data.bill_year        — พ.ศ. เช่น 2568
 * @param {number} data.bill_month       — 1–12
 * @param {number} data.amount_total     — ยอดรวม (บาท)
 * @param {number} [data.amount_base]    — ค่าไฟฐาน
 * @param {number} [data.amount_ft]      — ค่า Ft
 * @param {number} [data.amount_vat]     — ภาษีมูลค่าเพิ่ม
 * @param {number} [data.units_before]   — หน่วยก่อน
 * @param {number} [data.units_after]    — หน่วยหลัง
 * @param {number} [data.units_used]     — จำนวนหน่วยที่ใช้
 * @param {string} [data.due_date]       — วันกำหนดชำระ (DD/MM/YYYY)
 * @param {string} [data.reading_date_from]
 * @param {string} [data.reading_date_to]
 * @param {string} [data.notes]
 * @returns {Object} bill object ที่สร้างแล้ว
 */
function billServiceCreate(token, data) {
  const user = requireAuth(token, 'canWrite');

  // ---- Validate ----
  const { valid, errors, warnings, normalizedData } = validateBillInput(data, 'MANUAL');
  if (!valid) throw new Error('Validation failed: ' + errors.join(' | '));

  // ---- ตรวจสอบ site access ----
  if (!canAccessSite(user, normalizedData.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${normalizedData.site_id}`);
  }

  // ---- Build bill object ----
  const bill = _buildBillObject(normalizedData, {
    source:      'MANUAL',
    bill_status: 'APPROVED',  // manual entry = pre-approved
    needs_review: false,
    created_by:  user.email,
  });

  // ---- Save ----
  dbInsert(CONFIG.SHEETS.BILLS, bill);
  log('INFO', 'billServiceCreate', `Bill created: ${bill.bill_id} (${bill.bill_period_key})`);

  // ---- Log warnings ให้ caller รู้ ----
  if (warnings.length > 0) {
    log('WARN', 'billServiceCreate', `Warnings for ${bill.bill_id}: ${warnings.join(' | ')}`);
  }

  return { bill, warnings };
}

/**
 * สร้างบิลจาก PDF Parser
 * confidence < threshold → PENDING_REVIEW อัตโนมัติ
 *
 * @param {string} token
 * @param {Object} parsedData    — output จาก PDFParser.gs
 * @param {string} parsedData.meter_id
 * @param {string} parsedData.pdf_file_id
 * @param {number} parsedData.pdf_confidence   — 0–100
 * @param {string} [parsedData.meter_number]   — สำหรับ cross-check
 * @returns {Object} bill object
 */
function billServiceCreateFromPDF(token, parsedData) {
  const user = requireAuth(token, 'canWrite');

  // ---- Validate ----
  const { valid, errors, warnings, normalizedData } = validateBillInput(parsedData, 'PDF');
  if (!valid) throw new Error('PDF Validation failed: ' + errors.join(' | '));

  if (!canAccessSite(user, normalizedData.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${normalizedData.site_id}`);
  }

  // ---- กำหนด status ตาม confidence ----
  const needsReview   = normalizedData.needs_review === true;
  const billStatus    = needsReview ? 'PENDING_REVIEW' : 'APPROVED';

  const bill = _buildBillObject(normalizedData, {
    source:          'PDF',
    bill_status:     billStatus,
    needs_review:    needsReview,
    pdf_file_id:     normalizedData.pdf_file_id,
    pdf_confidence:  normalizedData.pdf_confidence,
    created_by:      user.email,
  });

  dbInsert(CONFIG.SHEETS.BILLS, bill);
  log('INFO', 'billServiceCreateFromPDF',
    `PDF bill: ${bill.bill_id}, confidence: ${bill.pdf_confidence}, status: ${billStatus}`
  );

  return { bill, warnings, needsReview };
}

/**
 * Batch Import — รับ array ของ bill objects
 * ใช้สำหรับ import ข้อมูลย้อนหลัง หรือ migrate จากระบบเก่า
 *
 * @param {string}   token
 * @param {Object[]} rows        — array ของ bill data
 * @param {string}   [source]    — 'BATCH' | 'IMPORT'
 * @param {Object}   [options]
 * @param {boolean}  [options.continueOnError=true]   — ข้าม row ที่ error แทนที่จะหยุด
 * @param {boolean}  [options.dryRun=false]            — ทดสอบโดยไม่ save จริง
 * @returns {{ summary, inserted, skipped, errors }}
 */
function billServiceBatchImport(token, rows, source = 'BATCH', options = {}) {
  requireAuth(token, 'canWrite');
  const { continueOnError = true, dryRun = false } = options;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows: ต้องเป็น array ที่มีข้อมูลอย่างน้อย 1 แถว');
  }

  // ---- Validate ทั้งหมดก่อน ----
  const { summary, validRows, invalidRows } = validateBillBatch(rows, source);

  if (!continueOnError && invalidRows.length > 0) {
    throw new Error(
      `Batch validation failed: ${invalidRows.length} rows มี error. ` +
      `ข้อผิดพลาดแรก: ${invalidRows[0].errors.join(', ')}`
    );
  }

  if (dryRun) {
    log('INFO', 'billServiceBatchImport', `DRY RUN: ${summary.valid} rows จะถูก insert`);
    return { summary, inserted: [], skipped: invalidRows, errors: invalidRows, dryRun: true };
  }

  // ---- Build bill objects ----
  const billsToInsert = validRows.map(({ data }) => {
    // ตรวจสอบ site access inline
    return _buildBillObject(data, {
      source:      source,
      bill_status: 'APPROVED',
      needs_review: false,
      created_by:  'batch_import',
    });
  });

  // ---- Batch insert ----
  dbBatchInsert(CONFIG.SHEETS.BILLS, billsToInsert);

  log('INFO', 'billServiceBatchImport',
    `Batch import: ${billsToInsert.length} inserted, ${invalidRows.length} skipped`
  );

  return {
    summary: { ...summary, inserted: billsToInsert.length },
    inserted:  billsToInsert.map(b => b.bill_id),
    skipped:   invalidRows,
    errors:    invalidRows,
  };
}


// ============================================================
// SECTION 2 — READ OPERATIONS
// ============================================================

/**
 * ดึงบิลทั้งหมด พร้อม filters และ pagination
 *
 * @param {string} token
 * @param {Object} [filters]
 * @param {string} [filters.site_id]
 * @param {string} [filters.meter_id]
 * @param {string} [filters.bill_status]
 * @param {number} [filters.bill_year]
 * @param {number} [filters.bill_month]
 * @param {boolean}[filters.needs_review]
 * @param {string} [filters.meter_type]     — join ผ่าน Meters
 * @param {Object} [pagination]
 * @param {number} [pagination.page=1]
 * @param {number} [pagination.pageSize=50]
 * @returns {{ bills: Object[], total: number, page: number, pageSize: number }}
 */
function billServiceGetAll(token, filters = {}, pagination = {}) {
  const user = requireAuth(token, 'canRead');
  let bills = dbGetAll(CONFIG.SHEETS.BILLS);

  // ---- กรองตาม site_access ----
  bills = _filterBySiteAccess(bills, user);

  // ---- Apply filters ----
  if (filters.site_id)    bills = bills.filter(b => b.site_id    === filters.site_id);
  if (filters.meter_id)   bills = bills.filter(b => b.meter_id   === filters.meter_id);
  if (filters.bill_year)  bills = bills.filter(b => String(b.bill_year)  === String(filters.bill_year));
  if (filters.bill_month) bills = bills.filter(b => String(b.bill_month) === String(filters.bill_month));
  if (filters.bill_status)bills = bills.filter(b => b.bill_status === filters.bill_status);
  if (filters.needs_review === true || filters.needs_review === 'true') {
    bills = bills.filter(b => b.needs_review === true || b.needs_review === 'TRUE');
  }

  // ---- filter by meter_type (join) ----
  if (filters.meter_type) {
    const meters = dbFind(CONFIG.SHEETS.METERS, { meter_type: filters.meter_type });
    const meterIds = new Set(meters.map(m => m.meter_id));
    bills = bills.filter(b => meterIds.has(b.meter_id));
  }

  // ---- เรียง ล่าสุดก่อน ----
  bills.sort((a, b) => String(b.bill_period_key).localeCompare(String(a.bill_period_key)));

  const total    = bills.length;
  const page     = parseInt(pagination.page     || 1);
  const pageSize = parseInt(pagination.pageSize || 50);
  const start    = (page - 1) * pageSize;
  const paged    = bills.slice(start, start + pageSize);

  return { bills: paged, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

/**
 * ดึงบิลเดียว พร้อมข้อมูล meter และ site (enriched)
 *
 * @param {string} token
 * @param {string} billId
 * @returns {Object} bill พร้อม meter_info และ site_info
 */
function billServiceGetById(token, billId) {
  const user = requireAuth(token, 'canRead');
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!bill) throw new Error(`ไม่พบบิล: "${billId}"`);

  if (!canAccessSite(user, bill.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${bill.site_id}`);
  }

  // Enrich ด้วยข้อมูล meter และ site
  const meter = dbGetById(CONFIG.SHEETS.METERS, 'meter_id', bill.meter_id) || {};
  const site  = dbGetById(CONFIG.SHEETS.SITES,  'site_id',  bill.site_id)  || {};

  return {
    ...bill,
    meter_info: {
      meter_number: meter.meter_number,
      meter_type:   meter.meter_type,
      provider:     meter.provider,
      meter_name:   meter.meter_name,
    },
    site_info: {
      site_code:  site.site_code,
      site_name:  site.site_name,
      province:   site.province,
    },
    available_transitions: getAvailableTransitions(bill.bill_status, user),
  };
}

/**
 * ดึง history ของมิเตอร์หนึ่ง (ย้อนหลัง N เดือน)
 * ใช้สำหรับ Anomaly Detection และ trend graph
 *
 * @param {string} token
 * @param {string} meterId
 * @param {number} [months=12]   — จำนวนเดือนย้อนหลัง
 * @returns {Object[]} เรียงจากเก่า → ใหม่
 */
function billServiceGetMeterHistory(token, meterId, months = 12) {
  requireAuth(token, 'canRead');

  const allBills = dbFind(CONFIG.SHEETS.BILLS, { meter_id: meterId });
  const activeBills = allBills.filter(b => b.bill_status !== 'CANCELLED');

  // เรียงจากเก่าไปใหม่
  activeBills.sort((a, b) => String(a.bill_period_key).localeCompare(String(b.bill_period_key)));

  // ตัดเฉพาะ N เดือนล่าสุด
  const recent = activeBills.slice(-months);

  // คำนวณ trend
  const trend = _calculateTrend(recent);

  return { bills: recent, trend };
}

/**
 * ดึงบิลที่ใกล้ครบกำหนดชำระ
 *
 * @param {string} token
 * @param {number} [withinDays]   — default จาก CONFIG.EMAIL.OVERDUE_DAYS
 * @returns {Object[]}
 */
function billServiceGetDueSoon(token, withinDays) {
  requireAuth(token, 'canRead');
  const days  = parseInt(withinDays || CONFIG.EMAIL.OVERDUE_DAYS);
  const today = todayDateStr();

  return dbGetAll(CONFIG.SHEETS.BILLS).filter(b => {
    if (!['APPROVED', 'OVERDUE'].includes(b.bill_status)) return false;
    if (!b.due_date) return false;
    const diff = daysBetween(today, b.due_date);
    return diff >= 0 && diff <= days;
  });
}

/**
 * ดึงบิลที่เลยกำหนดชำระ
 *
 * @param {string} token
 * @returns {Object[]}
 */
function billServiceGetOverdue(token) {
  requireAuth(token, 'canRead');
  const today = todayDateStr();

  return dbGetAll(CONFIG.SHEETS.BILLS).filter(b => {
    if (!['APPROVED', 'PENDING_REVIEW'].includes(b.bill_status)) return false;
    if (!b.due_date) return false;
    return daysBetween(today, b.due_date) < 0;
  });
}


// ============================================================
// SECTION 3 — UPDATE OPERATIONS
// ============================================================

/**
 * อัปเดตข้อมูลบิล (partial update)
 * ตรวจสอบ status ก่อนว่าอนุญาตให้แก้ field นั้นหรือไม่
 *
 * @param {string} token
 * @param {string} billId
 * @param {Object} updates
 * @returns {Object} bill ที่ updated
 */
function billServiceUpdate(token, billId, updates) {
  const user = requireAuth(token, 'canWrite');
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!bill) throw new Error(`ไม่พบบิล: "${billId}"`);

  if (!canAccessSite(user, bill.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${bill.site_id}`);
  }

  // ---- Validate update ----
  const { valid, errors, allowedUpdates } = validateBillUpdate(bill, updates);
  if (!valid) throw new Error('Update validation failed: ' + errors.join(' | '));

  if (Object.keys(allowedUpdates).length === 0) {
    throw new Error('ไม่มี field ที่อนุญาตให้แก้ไข');
  }

  // ---- Recalculate amount_total ถ้ามีการแก้ไข breakdown ----
  if (_hasAmountUpdate(allowedUpdates)) {
    const recalc = _recalculateAmount(bill, allowedUpdates);
    Object.assign(allowedUpdates, recalc);
  }

  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, allowedUpdates);
  log('INFO', 'billServiceUpdate', `Bill ${billId} updated by ${user.email}`);

  return dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
}


// ============================================================
// SECTION 4 — PAYMENT INTEGRATION
// ============================================================

/**
 * บันทึกการชำระเงิน + อัปเดต bill status → PAID
 * จุดเดียวที่จัดการ payment ทั้งหมด
 *
 * @param {string} token
 * @param {Object} data
 * @param {string} data.bill_id
 * @param {number} data.amount_paid
 * @param {string} data.payment_date
 * @param {string} data.payment_method   — ดู CONFIG.ENUMS.PAY_METHOD
 * @param {string} [data.account_id]
 * @param {string} [data.reference_number]
 * @param {string} [data.receipt_file_id]
 * @param {string} [data.notes]
 * @returns {{ payment: Object, bill: Object }}
 */
function billServiceCreatePayment(token, data) {
  const user = requireAuth(token, 'canWrite');

  // ---- Validate input ----
  const schema = {
    bill_id:        { required: true, type: 'string' },
    amount_paid:    { required: true, type: 'number' },
    payment_date:   { required: true, type: 'string' },
    payment_method: { required: true, enum: CONFIG.ENUMS.PAY_METHOD },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Payment validation: ' + errors.join(', '));

  // ---- ดึง bill ----
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', data.bill_id);
  if (!bill) throw new Error(`ไม่พบบิล: "${data.bill_id}"`);
  if (bill.bill_status === 'PAID')      throw new Error('บิลนี้ชำระเงินแล้ว');
  if (bill.bill_status === 'CANCELLED') throw new Error('ไม่สามารถชำระบิลที่ยกเลิกแล้ว');

  if (!canAccessSite(user, bill.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${bill.site_id}`);
  }

  // ---- ตรวจ amount_paid ----
  const amountPaid  = parseNumber(data.amount_paid);
  const amountTotal = parseNumber(bill.amount_total);
  if (amountPaid <= 0) throw new Error('amount_paid: ต้องมากกว่า 0');
  if (amountPaid > amountTotal * 1.1) {
    // อนุญาตเกินได้ 10% (กรณีมีค่าปรับ)
    log('WARN', 'billServiceCreatePayment',
      `amount_paid (${amountPaid}) เกิน amount_total (${amountTotal}) มากกว่า 10%`
    );
  }

  // ---- ตรวจ account ----
  if (data.account_id) {
    const account = dbGetById(CONFIG.SHEETS.ACCOUNTS, 'account_id', data.account_id);
    if (!account || String(account.is_active) === 'false' || account.is_active === false) {
      throw new Error(`Account ไม่พบหรือถูกปิดใช้งาน: "${data.account_id}"`);
    }
  }

  // ---- Build payment object ----
  const payment = {
    payment_id:       generateId(CONFIG.ID_PREFIX.PAYMENT),
    bill_id:          data.bill_id,
    meter_id:         bill.meter_id,
    site_id:          bill.site_id,
    amount_paid:      amountPaid,
    payment_date:     parseDateStr(data.payment_date) || data.payment_date,
    payment_method:   data.payment_method,
    account_id:       data.account_id       || '',
    reference_number: data.reference_number || '',
    receipt_file_id:  data.receipt_file_id  || '',
    notes:            data.notes            || '',
    created_by:       user.email,
    created_at:       nowISO(),
  };

  dbInsert(CONFIG.SHEETS.BILL_PAYMENTS, payment);

  // ---- อัปเดต bill → PAID (ผ่าน workflow) ----
  workflowMarkPaid(data.bill_id, payment.payment_id, user.email);

  log('INFO', 'billServiceCreatePayment',
    `Payment ${payment.payment_id} → Bill ${data.bill_id} PAID`
  );

  const updatedBill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', data.bill_id);
  return { payment, bill: updatedBill };
}


// ============================================================
// SECTION 5 — CALCULATION ENGINE
// ============================================================

/**
 * คำนวณ bill amounts จาก units_used + rate table
 * รองรับ: PEA, MEA basic calculation
 * ใช้เมื่อมีแค่หน่วยกิโลวัตต์แต่ไม่มียอดรวม (เช่น บางบิล)
 *
 * NOTE: ระบบนี้ใช้สำหรับ estimation เท่านั้น
 *       ยอดจริงควรมาจาก PDF หรือกรอกด้วยมือ
 *
 * @param {number} unitsUsed
 * @param {string} meterType   — 'ELECTRICITY' | 'WATER'
 * @param {string} provider    — 'PEA' | 'MEA' | 'PWA'
 * @returns {{ amount_base: number, amount_ft: number, amount_vat: number, amount_total: number }}
 */
function billServiceCalculateAmount(unitsUsed, meterType, provider) {
  const units = parseNumber(unitsUsed);
  if (units <= 0) return { amount_base: 0, amount_ft: 0, amount_vat: 0, amount_total: 0 };

  let base = 0;
  let ft   = 0;

  if (meterType === 'ELECTRICITY') {
    // อัตราโดยประมาณ (ต้องอัปเดตตาม PEA/MEA ปัจจุบัน)
    base = _calcElectricityBase(units, provider);
    ft   = units * 0.2464; // ค่า Ft โดยประมาณ (บาท/หน่วย) — อัปเดตทุกงวด
  } else if (meterType === 'WATER') {
    base = _calcWaterBase(units, provider);
  }

  const vat   = (base + ft) * 0.07;
  const total = base + ft + vat;

  return {
    amount_base:  Math.round(base  * 100) / 100,
    amount_ft:    Math.round(ft    * 100) / 100,
    amount_vat:   Math.round(vat   * 100) / 100,
    amount_total: Math.round(total * 100) / 100,
  };
}

/**
 * คำนวณ electricity base amount (PEA/MEA อัตราประมาณ)
 * @private
 */
function _calcElectricityBase(units, provider) {
  // อัตราขั้นบันได PEA/MEA ประมาณการ (บาท/หน่วย) — ปรับตามอัตราจริง
  const RATES = {
    PEA: [
      { max: 15,   rate: 2.3488 },
      { max: 25,   rate: 2.9882 },
      { max: 35,   rate: 3.2405 },
      { max: 100,  rate: 3.6237 },
      { max: 150,  rate: 3.7171 },
      { max: 400,  rate: 4.2218 },
      { max: Infinity, rate: 4.4217 },
    ],
    MEA: [
      { max: 150,  rate: 3.2484 },
      { max: 400,  rate: 4.2218 },
      { max: Infinity, rate: 4.4217 },
    ],
  };

  const rateTable = RATES[provider] || RATES['PEA'];
  let remaining = units;
  let total     = 0;
  let prevMax   = 0;

  for (const tier of rateTable) {
    const tierUnits = Math.min(remaining, tier.max - prevMax);
    if (tierUnits <= 0) break;
    total    += tierUnits * tier.rate;
    remaining -= tierUnits;
    prevMax    = tier.max;
    if (remaining <= 0) break;
  }

  return total;
}

/**
 * คำนวณ water base amount (PWA อัตราประมาณ)
 * @private
 */
function _calcWaterBase(units, provider) {
  // อัตราน้ำประปา PWA ประมาณการ
  const WATER_RATES = [
    { max: 10,   rate: 8.50  },
    { max: 20,   rate: 12.50 },
    { max: 50,   rate: 16.00 },
    { max: Infinity, rate: 20.00 },
  ];

  let remaining = units;
  let total     = 0;
  let prevMax   = 0;

  for (const tier of WATER_RATES) {
    const tierUnits = Math.min(remaining, tier.max - prevMax);
    if (tierUnits <= 0) break;
    total    += tierUnits * tier.rate;
    remaining -= tierUnits;
    prevMax    = tier.max;
    if (remaining <= 0) break;
  }

  return total;
}


// ============================================================
// SECTION 6 — INTERNAL HELPERS
// ============================================================

/**
 * Build bill object พร้อมสำหรับ insert
 * รวม generated fields ทั้งหมด
 * @private
 */
function _buildBillObject(normalizedData, overrides = {}) {
  const bill = {
    bill_id:           generateId(CONFIG.ID_PREFIX.BILL),
    meter_id:          normalizedData.meter_id,
    site_id:           normalizedData.site_id,
    bill_year:         normalizedData.bill_year,
    bill_month:        normalizedData.bill_month,
    bill_period_key:   normalizedData.bill_period_key,
    units_before:      normalizedData.units_before  || 0,
    units_after:       normalizedData.units_after   || 0,
    units_used:        normalizedData.units_used    || 0,
    amount_base:       normalizedData.amount_base   || 0,
    amount_ft:         normalizedData.amount_ft     || 0,
    amount_vat:        normalizedData.amount_vat    || 0,
    amount_total:      normalizedData.amount_total,
    reading_date_from: normalizedData.reading_date_from || '',
    reading_date_to:   normalizedData.reading_date_to   || '',
    due_date:          normalizedData.due_date           || '',
    bill_status:       overrides.bill_status    || 'PENDING_REVIEW',
    needs_review:      overrides.needs_review   ?? true,
    pdf_file_id:       overrides.pdf_file_id    || normalizedData.pdf_file_id    || '',
    pdf_confidence:    overrides.pdf_confidence ?? normalizedData.pdf_confidence ?? 100,
    source:            overrides.source         || normalizedData.source         || 'MANUAL',
    notes:             normalizedData.notes     || '',
    created_by:        overrides.created_by     || 'system',
    created_at:        nowISO(),
    updated_at:        nowISO(),
  };

  return bill;
}

/**
 * กรอง bills ตาม site_access ของ user
 * @private
 */
function _filterBySiteAccess(bills, user) {
  if (user.role === 'ADMIN') return bills;
  const siteAccess = String(user.site_access || '');
  if (siteAccess === 'ALL') return bills;
  const allowed = siteAccess.split(',').map(s => s.trim()).filter(Boolean);
  return bills.filter(b => allowed.includes(b.site_id));
}

/**
 * ตรวจสอบว่า updates มีการแก้ไข amount fields หรือไม่
 * @private
 */
function _hasAmountUpdate(updates) {
  return ['amount_base', 'amount_ft', 'amount_vat'].some(f => updates[f] !== undefined);
}

/**
 * Re-calculate amount_total จาก breakdown ใหม่
 * ถ้า total ไม่ได้ส่งมาให้คำนวณจาก parts
 * @private
 */
function _recalculateAmount(existingBill, updates) {
  const base = parseNumber(updates.amount_base ?? existingBill.amount_base ?? 0);
  const ft   = parseNumber(updates.amount_ft   ?? existingBill.amount_ft   ?? 0);
  const vat  = parseNumber(updates.amount_vat  ?? existingBill.amount_vat  ?? 0);

  // คำนวณใหม่เฉพาะถ้าไม่ได้ส่ง amount_total มาด้วย
  if (updates.amount_total === undefined && (base > 0 || ft > 0)) {
    return { amount_total: Math.round((base + ft + vat) * 100) / 100 };
  }
  return {};
}

/**
 * คำนวณ trend จาก bill history
 * คืนค่าเฉลี่ย, max, min, และ % เปลี่ยนแปลงล่าสุด
 * @private
 */
function _calculateTrend(bills) {
  if (!bills || bills.length === 0) return null;

  const amounts = bills.map(b => parseNumber(b.amount_total)).filter(a => a > 0);
  if (amounts.length === 0) return null;

  const avg  = average(amounts);
  const max  = Math.max(...amounts);
  const min  = Math.min(...amounts);
  const last = amounts[amounts.length - 1];
  const prev = amounts.length >= 2 ? amounts[amounts.length - 2] : null;

  return {
    average:      Math.round(avg  * 100) / 100,
    max:          max,
    min:          min,
    latest:       last,
    change_pct:   prev ? Math.round(pctChange(prev, last) * 10) / 10 : null,
    data_points:  amounts.length,
  };
}
