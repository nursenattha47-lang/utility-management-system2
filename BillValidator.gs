// ============================================================
// BillValidator.gs — Bill Validation Layer
// UtilityManager | PHASE 2 — Bills Module
// ============================================================
// รับผิดชอบ: ตรวจสอบความถูกต้องของข้อมูลบิลทุกประเภท
// ใช้ก่อน INSERT หรือ UPDATE ทุกครั้ง
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs
// ============================================================


// ============================================================
// SECTION 1 — SCHEMA DEFINITIONS
// โครงสร้างข้อมูลที่ต้องการในแต่ละ operation
// ============================================================

/**
 * Schema สำหรับ Manual Bill Entry (กรอกด้วยมือ)
 * ฟิลด์ที่จำเป็นขั้นต่ำที่ระบบรับได้
 */
const BILL_SCHEMA_MANUAL = {
  meter_id:     { required: true,  type: 'string' },
  bill_year:    { required: true,  type: 'number' },
  bill_month:   { required: true,  type: 'number' },
  amount_total: { required: true,  type: 'number' },
  due_date:     { required: false, type: 'string' },
  units_used:   { required: false, type: 'number' },
};

/**
 * Schema สำหรับ PDF-parsed Bill
 * confidence_score จาก PDFParser มาด้วยเสมอ
 */
const BILL_SCHEMA_PDF = {
  meter_id:        { required: true,  type: 'string' },
  bill_year:       { required: true,  type: 'number' },
  bill_month:      { required: true,  type: 'number' },
  amount_total:    { required: true,  type: 'number' },
  pdf_file_id:     { required: true,  type: 'string' },
  pdf_confidence:  { required: true,  type: 'number' },
  meter_number:    { required: false, type: 'string' }, // สำหรับ cross-check
};

/**
 * Schema สำหรับ Batch Import
 * ผ่อนปรนกว่า manual เพราะข้อมูลมาจากระบบอื่น
 */
const BILL_SCHEMA_BATCH = {
  meter_id:     { required: true,  type: 'string' },
  bill_year:    { required: true,  type: 'number' },
  bill_month:   { required: true,  type: 'number' },
  amount_total: { required: true,  type: 'number' },
};


// ============================================================
// SECTION 2 — PRIMARY VALIDATOR
// ฟังก์ชันหลักที่เรียกจากภายนอก
// ============================================================

/**
 * ตรวจสอบข้อมูลบิลก่อน Insert ทุกประเภท
 * รวม: schema validation, business rules, duplicate check, meter check
 *
 * @param {Object} data         — ข้อมูลบิลที่รับมา
 * @param {string} source       — 'MANUAL' | 'PDF' | 'BATCH'
 * @param {Object} [options]
 * @param {boolean} [options.skipDuplicateCheck=false] — ใช้ตอน re-import
 * @returns {{ valid: boolean, errors: string[], warnings: string[], normalizedData: Object }}
 */
function validateBillInput(data, source = 'MANUAL', options = {}) {
  const errors   = [];
  const warnings = [];
  let   normalized = deepClone(data);

  // --- 1. Schema validation ---
  const schema = _selectSchema(source);
  const { valid: schemaValid, errors: schemaErrors } = validateSchema(data, schema);
  if (!schemaValid) errors.push(...schemaErrors);

  // หยุดถ้า schema ผิด (ข้อมูลพื้นฐานไม่ครบ)
  if (errors.length > 0) return { valid: false, errors, warnings, normalizedData: null };

  // --- 2. Normalize & type-cast ---
  normalized = _normalizeBillData(normalized);

  // --- 3. ตรวจสอบค่า business rules ---
  const bizErrors = _validateBusinessRules(normalized, source);
  errors.push(...bizErrors.errors);
  warnings.push(...bizErrors.warnings);

  // --- 4. ตรวจสอบ meter มีอยู่จริงและ active ---
  const meterCheck = _validateMeterExists(normalized.meter_id);
  if (!meterCheck.valid) {
    errors.push(...meterCheck.errors);
  } else {
    // เติม site_id จาก meter (denormalization)
    normalized.site_id   = meterCheck.meter.site_id;
    normalized.meter_ref = meterCheck.meter; // ใช้ใน step ถัดไป (ไม่ save ลง sheet)
  }

  // --- 5. Duplicate check ---
  if (!options.skipDuplicateCheck && errors.length === 0) {
    const dupCheck = _checkDuplicateBill(normalized.meter_id, normalized.bill_year, normalized.bill_month);
    if (!dupCheck.valid) errors.push(...dupCheck.errors);
  }

  // --- 6. Cross-check meter_number (PDF เท่านั้น) ---
  if (source === 'PDF' && normalized.meter_number && normalized.meter_ref) {
    const crossCheck = _crossCheckMeterNumber(normalized.meter_ref, normalized.meter_number);
    if (!crossCheck.valid) warnings.push(...crossCheck.warnings);
  }

  // --- 7. PDF confidence check ---
  if (source === 'PDF') {
    const confCheck = _validatePdfConfidence(normalized.pdf_confidence);
    warnings.push(...confCheck.warnings);
    normalized.needs_review = confCheck.needsReview;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedData: errors.length === 0 ? normalized : null,
  };
}

/**
 * ตรวจสอบข้อมูลก่อน Update Bill
 * เฉพาะ field ที่อนุญาตให้แก้ไขตาม status ปัจจุบัน
 *
 * @param {Object} existingBill  — bill object ปัจจุบันจาก sheet
 * @param {Object} updates       — field ที่ต้องการแก้ไข
 * @returns {{ valid: boolean, errors: string[], allowedUpdates: Object }}
 */
function validateBillUpdate(existingBill, updates) {
  const errors = [];

  // ตรวจสอบว่า status ปัจจุบันอนุญาตให้แก้ไขได้
  const editableStatuses = ['PENDING_REVIEW', 'APPROVED', 'OVERDUE'];
  if (!editableStatuses.includes(existingBill.bill_status)) {
    errors.push(`ไม่สามารถแก้ไขบิลที่มี status: "${existingBill.bill_status}"`);
    return { valid: false, errors, allowedUpdates: {} };
  }

  // Field ที่อนุญาตตาม status
  const alwaysAllowed = ['notes', 'due_date'];
  const approvedAllowed = [
    'units_before', 'units_after', 'units_used',
    'amount_base', 'amount_ft', 'amount_vat', 'amount_total',
    'reading_date_from', 'reading_date_to',
  ];

  const allowedFields = existingBill.bill_status === 'PAID'
    ? alwaysAllowed
    : [...alwaysAllowed, ...approvedAllowed];

  const allowedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowedFields.includes(k))
  );

  // ตรวจค่าตัวเลขถ้ามี
  ['amount_total', 'amount_base', 'amount_ft', 'amount_vat'].forEach(field => {
    if (allowedUpdates[field] !== undefined) {
      const val = parseNumber(allowedUpdates[field]);
      if (val < 0) errors.push(`${field}: ต้องเป็นค่า >= 0`);
    }
  });

  if (allowedUpdates.amount_total !== undefined && allowedUpdates.amount_total === 0) {
    errors.push('amount_total: ไม่สามารถตั้งเป็น 0 ได้');
  }

  return { valid: errors.length === 0, errors, allowedUpdates };
}

/**
 * ตรวจสอบ Batch rows ก่อน import
 * คืน summary ของแต่ละ row
 *
 * @param {Object[]} rows         — array ของ bill objects
 * @param {string}   source       — 'BATCH' | 'PDF'
 * @returns {{ summary: Object, validRows: Object[], invalidRows: Object[] }}
 */
function validateBillBatch(rows, source = 'BATCH') {
  const validRows   = [];
  const invalidRows = [];

  rows.forEach((row, idx) => {
    const result = validateBillInput(row, source, { skipDuplicateCheck: false });
    if (result.valid) {
      validRows.push({ index: idx, data: result.normalizedData, warnings: result.warnings });
    } else {
      invalidRows.push({ index: idx, originalData: row, errors: result.errors });
    }
  });

  const summary = {
    total:   rows.length,
    valid:   validRows.length,
    invalid: invalidRows.length,
    rate:    rows.length > 0 ? ((validRows.length / rows.length) * 100).toFixed(1) + '%' : '0%',
  };

  log('INFO', 'validateBillBatch', `Batch validation: ${summary.valid}/${summary.total} valid`);
  return { summary, validRows, invalidRows };
}


// ============================================================
// SECTION 3 — BUSINESS RULE VALIDATORS
// ตรวจสอบ logic ทางธุรกิจที่ซับซ้อน
// ============================================================

/**
 * ตรวจสอบ business rules ทั้งหมดสำหรับบิล
 * @private
 */
function _validateBusinessRules(data, source) {
  const errors   = [];
  const warnings = [];

  // ---- bill_year ----
  const year  = parseInt(data.bill_year);
  const month = parseInt(data.bill_month);
  const currentYearBE = toBuddhistYear(new Date().getFullYear());

  if (year < 2560 || year > currentYearBE + 1) {
    errors.push(`bill_year: ปี ${year} ไม่สมเหตุสมผล (ควรอยู่ระหว่าง 2560–${currentYearBE + 1})`);
  }

  // ---- bill_month ----
  if (month < 1 || month > 12) {
    errors.push(`bill_month: เดือน ${month} ไม่ถูกต้อง (1–12)`);
  }

  // ---- ห้ามบิลอนาคตเกิน 1 เดือน ----
  if (errors.length === 0) {
    const billDateBE = year * 100 + month;
    const todayBE    = currentYearBE * 100 + (new Date().getMonth() + 1);
    if (billDateBE > todayBE + 1) {
      warnings.push(`bill_year/month: บิลเดือน ${month}/${year} เป็นอนาคตมากกว่า 1 เดือน`);
    }
  }

  // ---- amount_total ----
  const amount = parseNumber(data.amount_total);
  if (amount <= 0) {
    errors.push('amount_total: ต้องมากกว่า 0');
  }
  if (amount > 10000000) {
    // เกิน 10 ล้านบาท — น่าสงสัยมาก
    warnings.push(`amount_total: ${formatAmount(amount)} บาท สูงผิดปกติ กรุณาตรวจสอบ`);
  }

  // ---- units validation ----
  const unitsBefore = parseNumber(data.units_before || 0);
  const unitsAfter  = parseNumber(data.units_after  || 0);
  const unitsUsed   = parseNumber(data.units_used   || 0);

  if (unitsBefore > 0 && unitsAfter > 0) {
    if (unitsAfter < unitsBefore) {
      // มิเตอร์ overflow หรือเปลี่ยนมิเตอร์ใหม่
      warnings.push(`units: หน่วยหลัง (${unitsAfter}) < หน่วยก่อน (${unitsBefore}) — อาจเป็น meter overflow หรือเปลี่ยนมิเตอร์ใหม่`);
    } else {
      const calcUnits = unitsAfter - unitsBefore;
      if (unitsUsed > 0 && Math.abs(calcUnits - unitsUsed) > 1) {
        // ต่างกันเกิน 1 หน่วย — อาจ input ผิด
        warnings.push(`units: จำนวนหน่วยที่คำนวณได้ (${calcUnits}) ≠ units_used (${unitsUsed})`);
      }
    }
  }

  if (unitsUsed === 0 && source !== 'PDF') {
    // ไม่ใช่ error แต่ให้รู้ (PDF อาจ parse ไม่ได้หน่วย)
    warnings.push('units_used = 0 — กรุณาตรวจสอบว่าถูกต้อง');
  }

  // ---- amount breakdown consistency ----
  const base = parseNumber(data.amount_base || 0);
  const ft   = parseNumber(data.amount_ft   || 0);
  const vat  = parseNumber(data.amount_vat  || 0);
  if (base > 0 && ft >= 0 && vat >= 0) {
    const sumParts = base + ft + vat;
    // อนุญาตต่างกันได้ 1 บาท (rounding)
    if (Math.abs(sumParts - amount) > 1) {
      warnings.push(`amount: base+ft+vat (${formatAmount(sumParts)}) ≠ amount_total (${formatAmount(amount)}) — อาจมีค่าธรรมเนียมอื่น`);
    }
  }

  // ---- due_date ต้องไม่ก่อนวันออกบิล ----
  if (data.due_date && data.reading_date_to) {
    const dueDateISO = parseDateStr(data.due_date);
    const readToISO  = parseDateStr(data.reading_date_to);
    if (dueDateISO && readToISO && dueDateISO < readToISO) {
      warnings.push('due_date: วันกำหนดชำระก่อนวันสิ้นสุดการอ่านมิเตอร์');
    }
  }

  return { errors, warnings };
}

/**
 * ตรวจสอบว่า Meter มีอยู่จริงและยัง active อยู่
 * @private
 */
function _validateMeterExists(meterId) {
  if (!meterId) return { valid: false, errors: ['meter_id: จำเป็นต้องระบุ'] };

  const meter = dbGetById(CONFIG.SHEETS.METERS, 'meter_id', meterId);
  if (!meter) {
    return { valid: false, errors: [`meter_id: ไม่พบมิเตอร์ "${meterId}"` ] };
  }
  if (meter.status === 'INACTIVE') {
    return { valid: false, errors: [`meter_id: มิเตอร์ "${meterId}" ถูกปิดใช้งานแล้ว`] };
  }

  // ตรวจสอบ site ที่ meter อยู่ด้วย
  const site = dbGetById(CONFIG.SHEETS.SITES, 'site_id', meter.site_id);
  if (!site) {
    return { valid: false, errors: [`meter_id: มิเตอร์ "${meterId}" อ้างอิง site ที่ไม่มีอยู่`] };
  }
  if (site.status === 'INACTIVE') {
    return { valid: false, errors: [`site: สถานที่ "${meter.site_id}" ถูกปิดใช้งานแล้ว`] };
  }

  return { valid: true, errors: [], meter, site };
}

/**
 * ตรวจสอบ duplicate bill (meter_id + year + month ต้องไม่ซ้ำ)
 * @private
 */
function _checkDuplicateBill(meterId, billYear, billMonth) {
  const existing = dbFind(CONFIG.SHEETS.BILLS, {
    meter_id:   String(meterId),
    bill_year:  String(billYear),
    bill_month: String(billMonth),
  });

  // กรอง cancelled ออก (อนุญาตให้ re-enter ถ้าเคย cancel)
  const activeDups = existing.filter(b => b.bill_status !== 'CANCELLED');
  if (activeDups.length > 0) {
    const dup = activeDups[0];
    return {
      valid: false,
      errors: [`duplicate: บิลเดือน ${billMonth}/${billYear} ของมิเตอร์ "${meterId}" มีอยู่แล้ว (${dup.bill_id}, status: ${dup.bill_status})`],
    };
  }

  return { valid: true, errors: [] };
}

/**
 * Cross-check meter_number จาก PDF กับที่บันทึกในระบบ
 * เพื่อป้องกันการอัปโหลดบิลผิดมิเตอร์
 * @private
 */
function _crossCheckMeterNumber(meterFromDB, meterNumberFromPDF) {
  const warnings = [];
  const dbNum  = String(meterFromDB.meter_number || '').replace(/[\s\-]/g, '');
  const pdfNum = String(meterNumberFromPDF || '').replace(/[\s\-]/g, '');

  if (dbNum && pdfNum && dbNum !== pdfNum) {
    warnings.push(
      `meter_number: เลขมิเตอร์ใน PDF (${meterNumberFromPDF}) ` +
      `ไม่ตรงกับที่บันทึกในระบบ (${meterFromDB.meter_number}) — กรุณาตรวจสอบ`
    );
  }

  return { valid: true, warnings };
}

/**
 * ตรวจสอบ PDF confidence score
 * @private
 */
function _validatePdfConfidence(confidence) {
  const score       = parseNumber(confidence || 0);
  const minScore    = CONFIG.THRESHOLDS.PDF_CONFIDENCE_MIN;
  const warnings    = [];
  const needsReview = score < minScore;

  if (needsReview) {
    warnings.push(
      `pdf_confidence: ${score}/100 ต่ำกว่าเกณฑ์ ${minScore} — ` +
      `บิลจะถูกตั้งสถานะ PENDING_REVIEW รอการตรวจสอบ`
    );
  }

  return { warnings, needsReview };
}

/**
 * เลือก schema ตาม source
 * @private
 */
function _selectSchema(source) {
  switch (source) {
    case 'PDF':   return BILL_SCHEMA_PDF;
    case 'BATCH': return BILL_SCHEMA_BATCH;
    default:      return BILL_SCHEMA_MANUAL;
  }
}


// ============================================================
// SECTION 4 — DATA NORMALIZER
// แปลง type, trim, คำนวณค่าที่ derive ได้
// ============================================================

/**
 * Normalize bill data — type cast + derive computed fields
 * ทำก่อน validate business rules และก่อน save
 * @private
 */
function _normalizeBillData(data) {
  const d = deepClone(data);

  // ---- type cast ----
  d.bill_year   = parseInt(d.bill_year);
  d.bill_month  = parseInt(d.bill_month);
  d.amount_total = parseNumber(d.amount_total);
  d.amount_base  = parseNumber(d.amount_base  || 0);
  d.amount_ft    = parseNumber(d.amount_ft    || 0);
  d.amount_vat   = parseNumber(d.amount_vat   || 0);
  d.units_before = parseNumber(d.units_before || 0);
  d.units_after  = parseNumber(d.units_after  || 0);
  d.units_used   = parseNumber(d.units_used   || 0);

  // ---- auto-compute units_used ถ้าไม่ได้ส่งมา ----
  if (d.units_used === 0 && d.units_before > 0 && d.units_after > d.units_before) {
    d.units_used = d.units_after - d.units_before;
  }

  // ---- normalize dates → ISO format ----
  if (d.due_date)            d.due_date            = parseDateStr(d.due_date)            || d.due_date;
  if (d.reading_date_from)   d.reading_date_from   = parseDateStr(d.reading_date_from)   || d.reading_date_from;
  if (d.reading_date_to)     d.reading_date_to     = parseDateStr(d.reading_date_to)     || d.reading_date_to;

  // ---- bill_period_key ----
  d.bill_period_key = makePeriodKey(d.bill_year, d.bill_month);

  // ---- pdf_confidence default ----
  if (d.pdf_confidence === undefined || d.pdf_confidence === null) {
    d.pdf_confidence = d.source === 'PDF' ? 0 : 100;
  }

  // ---- trim strings ----
  ['notes', 'meter_number', 'contract_number'].forEach(f => {
    if (d[f]) d[f] = String(d[f]).trim();
  });

  return d;
}


// ============================================================
// SECTION 5 — EXPORT: ฟังก์ชันช่วยสำหรับ module อื่น
// ============================================================

/**
 * ตรวจสอบอย่างเร็วว่ามีบิลซ้ำหรือไม่ (ใช้ใน BillService)
 * @param {string} meterId
 * @param {number} billYear   — พ.ศ.
 * @param {number} billMonth  — 1–12
 * @returns {boolean}
 */
function billDuplicateExists(meterId, billYear, billMonth) {
  return !_checkDuplicateBill(meterId, billYear, billMonth).valid;
}

/**
 * ตรวจสอบว่า meter ใช้งานได้และคืน meter object
 * @param {string} meterId
 * @returns {{ valid: boolean, meter: Object|null, error: string|null }}
 */
function getMeterForBill(meterId) {
  const result = _validateMeterExists(meterId);
  return {
    valid:  result.valid,
    meter:  result.meter || null,
    site:   result.site  || null,
    error:  result.errors[0] || null,
  };
}
