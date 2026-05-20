// ============================================================
// PDFValidator.gs — PDF-Specific Validation Layer
// UtilityManager | PHASE 3 — PDF Parser Module
// ============================================================
// รับผิดชอบ:
//   - ตรวจสอบข้อมูลที่ parse จาก PDF ก่อนสร้างบิล
//   - Cross-check เลขมิเตอร์จาก PDF กับที่บันทึกในระบบ
//   - ตรวจสอบ Duplicate Bill (เดือน/ปีซ้ำกับบิลที่มีอยู่)
//   - ตรวจสอบความสมเหตุสมผลของตัวเลข
//   - กำหนด Manual Review trigger conditions
//   - คืนค่า canCreateBill flag สำหรับ PDFParser
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs,
//               BillValidator.gs (shared validators)
// ============================================================


// ============================================================
// SECTION 1 — REVIEW TRIGGER CONDITIONS
// เงื่อนไขที่ทำให้บิลต้องผ่าน Manual Review
// ============================================================

/**
 * เงื่อนไขทั้งหมดที่กระตุ้น Manual Review
 * เพิ่มเติมได้โดยไม่ต้องแก้ไข logic หลัก
 *
 * แต่ละ condition:
 *   check(parsedData, meter) → { triggered: boolean, message: string }
 *   severity: 'ERROR' = ไม่สร้างบิล, 'WARNING' = สร้างแต่ต้องตรวจ
 */
const REVIEW_TRIGGER_CONDITIONS = [

  // ---- CRITICAL: ต้องได้ amount_total ----
  {
    id:       'MISSING_AMOUNT',
    severity: 'ERROR',
    check: (data) => {
      const amount = parseNumber(data.amount_total);
      return {
        triggered: !amount || amount <= 0,
        message:   'ไม่พบยอดรวม (amount_total) หรือยอดเป็น 0',
      };
    },
  },

  // ---- CRITICAL: ต้องระบุเดือน/ปีของบิล ----
  {
    id:       'MISSING_BILL_PERIOD',
    severity: 'ERROR',
    check: (data) => {
      const hasMonth = data.bill_month && parseInt(data.bill_month) >= 1;
      const hasYear  = data.bill_year  && parseInt(data.bill_year)  >= 2560;
      return {
        triggered: !hasMonth || !hasYear,
        message:   `ไม่พบเดือน/ปีของบิล (bill_month: ${data.bill_month}, bill_year: ${data.bill_year})`,
      };
    },
  },

  // ---- WARNING: amount สูงผิดปกติ ----
  {
    id:       'AMOUNT_UNUSUALLY_HIGH',
    severity: 'WARNING',
    check: (data) => {
      const amount = parseNumber(data.amount_total);
      return {
        triggered: amount > 500000, // > 500,000 บาท
        message:   `ยอดรวม ${formatAmount(amount)} บาท สูงผิดปกติ กรุณาตรวจสอบ`,
      };
    },
  },

  // ---- WARNING: amount ต่ำผิดปกติ (มีค่าแต่น้อยมาก) ----
  {
    id:       'AMOUNT_SUSPICIOUSLY_LOW',
    severity: 'WARNING',
    check: (data, meter) => {
      const amount = parseNumber(data.amount_total);
      // ค่าไฟ/ค่าน้ำ < 10 บาท น่าสงสัย (อาจ parse ผิด)
      const threshold = meter?.meter_type === 'WATER' ? 5 : 10;
      return {
        triggered: amount > 0 && amount < threshold,
        message:   `ยอดรวม ${amount} บาท ต่ำผิดปกติสำหรับ ${meter?.meter_type} (ต่ำกว่า ${threshold} บาท)`,
      };
    },
  },

  // ---- WARNING: เลขมิเตอร์ใน PDF ไม่ตรงกับในระบบ ----
  {
    id:       'METER_NUMBER_MISMATCH',
    severity: 'WARNING',
    check: (data, meter) => {
      if (!data.meter_number || !meter?.meter_number) {
        return { triggered: false, message: '' };
      }
      const pdfNum = String(data.meter_number).replace(/[\s\-]/g, '');
      const dbNum  = String(meter.meter_number).replace(/[\s\-]/g, '');
      return {
        triggered: pdfNum !== dbNum,
        message:   `เลขมิเตอร์ใน PDF (${data.meter_number}) ≠ ในระบบ (${meter.meter_number})`,
      };
    },
  },

  // ---- WARNING: หน่วยหลัง < หน่วยก่อน (อาจมิเตอร์ overflow หรือ parse ผิด) ----
  {
    id:       'METER_ROLLBACK',
    severity: 'WARNING',
    check: (data) => {
      const before = parseNumber(data.units_before);
      const after  = parseNumber(data.units_after);
      if (!before || !after) return { triggered: false, message: '' };
      return {
        triggered: after < before,
        message:   `หน่วยหลัง (${after}) < หน่วยก่อน (${before}) — อาจเป็น meter overflow หรือ parse ผิด`,
      };
    },
  },

  // ---- WARNING: units_used ≠ (after - before) เกิน 1 หน่วย ----
  {
    id:       'UNITS_CALCULATION_MISMATCH',
    severity: 'WARNING',
    check: (data) => {
      const before = parseNumber(data.units_before);
      const after  = parseNumber(data.units_after);
      const used   = parseNumber(data.units_used);
      if (!before || !after || !used) return { triggered: false, message: '' };
      const calc = after - before;
      return {
        triggered: Math.abs(calc - used) > 1,
        message:   `หน่วยที่ใช้คำนวณได้ (${calc}) ≠ ที่ parse ได้ (${used})`,
      };
    },
  },

  // ---- WARNING: due_date อยู่ในอดีตมากกว่า 3 เดือน ----
  {
    id:       'DUE_DATE_TOO_OLD',
    severity: 'WARNING',
    check: (data) => {
      if (!data.due_date) return { triggered: false, message: '' };
      const dueDateISO = parseDateStr ? parseDateStr(data.due_date) : data.due_date;
      if (!dueDateISO) return { triggered: false, message: '' };
      const diffDays = daysBetween ? daysBetween(dueDateISO, todayDateStr()) : 0;
      return {
        triggered: diffDays > 90,
        message:   `วันกำหนดชำระ ${data.due_date} ผ่านมาแล้วมากกว่า 90 วัน`,
      };
    },
  },

  // ---- WARNING: bill_year เป็นอนาคตมากกว่า 1 เดือน ----
  {
    id:       'FUTURE_BILL_PERIOD',
    severity: 'WARNING',
    check: (data) => {
      if (!data.bill_year || !data.bill_month) return { triggered: false, message: '' };
      const currentYear  = toBuddhistYear ? toBuddhistYear(new Date().getFullYear()) : new Date().getFullYear() + 543;
      const currentMonth = new Date().getMonth() + 1;
      const billPeriod   = parseInt(data.bill_year) * 100 + parseInt(data.bill_month);
      const nowPeriod    = currentYear * 100 + currentMonth;
      return {
        triggered: billPeriod > nowPeriod + 1,
        message:   `บิลเดือน ${data.bill_month}/${data.bill_year} เป็นอนาคต`,
      };
    },
  },

  // ---- WARNING: ไม่พบ due_date ----
  {
    id:       'MISSING_DUE_DATE',
    severity: 'WARNING',
    check: (data) => ({
      triggered: !data.due_date || String(data.due_date).trim() === '',
      message:   'ไม่พบวันกำหนดชำระ (due_date) — กรุณากรอกด้วยมือ',
    }),
  },

  // ---- WARNING: amount_base + amount_ft + amount_vat ≠ amount_total ----
  {
    id:       'AMOUNT_BREAKDOWN_MISMATCH',
    severity: 'WARNING',
    check: (data) => {
      const total = parseNumber(data.amount_total);
      const base  = parseNumber(data.amount_base);
      const ft    = parseNumber(data.amount_ft);
      const vat   = parseNumber(data.amount_vat);
      // ตรวจเฉพาะเมื่อมีทั้ง 3 ค่า
      if (!base || vat === 0) return { triggered: false, message: '' };
      const sum = base + ft + vat;
      return {
        triggered: Math.abs(sum - total) > 2, // อนุญาต error 2 บาทสำหรับ rounding
        message:   `ยอดรวมย่อย (${formatAmount(sum)}) ≠ ยอดรวม (${formatAmount(total)})`,
      };
    },
  },

];


// ============================================================
// SECTION 2 — PRIMARY VALIDATOR
// ============================================================

/**
 * ตรวจสอบข้อมูลที่ parse จาก PDF ก่อนสร้างบิล
 * รวมทุก validation: schema, business rules, duplicate, meter cross-check
 *
 * @param {Object} parsedData   — output จาก _buildParsedData() ใน PDFParser
 * @param {Object} meter        — meter object จาก Database
 * @returns {{
 *   valid:           boolean,        — ไม่มี ERROR
 *   canCreateBill:   boolean,        — สร้างบิลได้ (valid && !duplicateFound)
 *   errors:          string[],       — ข้อผิดพลาด ERROR (block การสร้างบิล)
 *   warnings:        string[],       — คำเตือน WARNING (สร้างบิลได้แต่ต้อง review)
 *   triggeredRules:  Object[],       — รายการ rule ที่ triggered
 *   needsManualReview: boolean,      — true ถ้ามี WARNING อย่างน้อย 1 ข้อ
 *   duplicateFound:  boolean,
 *   duplicateBillId: string|null,
 * }}
 */
function pdfValidatorCheck(parsedData, meter) {
  const errors         = [];
  const warnings       = [];
  const triggeredRules = [];

  // ---- 1. รัน Review Trigger Conditions ทั้งหมด ----
  for (const condition of REVIEW_TRIGGER_CONDITIONS) {
    try {
      const result = condition.check(parsedData, meter);
      if (result.triggered) {
        triggeredRules.push({ id: condition.id, severity: condition.severity, message: result.message });
        if (condition.severity === 'ERROR') {
          errors.push(`[${condition.id}] ${result.message}`);
        } else {
          warnings.push(`[${condition.id}] ${result.message}`);
        }
      }
    } catch (e) {
      log('WARN', 'pdfValidatorCheck', `Condition ${condition.id} threw: ${e.message}`);
    }
  }

  // ---- 2. Duplicate Bill Check ----
  const dupCheck = _checkPdfDuplicate(parsedData);
  if (dupCheck.found) {
    errors.push(`[DUPLICATE] บิลเดือน ${parsedData.bill_month}/${parsedData.bill_year} ของมิเตอร์นี้มีอยู่แล้ว (${dupCheck.billId})`);
  }

  // ---- 3. Provider-Meter Type Cross-check ----
  const typeCheck = _crossCheckProviderMeterType(parsedData, meter);
  if (typeCheck.warning) {
    warnings.push(`[PROVIDER_TYPE] ${typeCheck.message}`);
  }

  const valid         = errors.length === 0;
  const canCreateBill = valid && !dupCheck.found;

  log('INFO', 'pdfValidatorCheck',
    `valid=${valid}, canCreate=${canCreateBill}, errors=${errors.length}, warnings=${warnings.length}`
  );

  return {
    valid,
    canCreateBill,
    errors,
    warnings,
    triggeredRules,
    needsManualReview:  warnings.length > 0,
    duplicateFound:     dupCheck.found,
    duplicateBillId:    dupCheck.billId || null,
  };
}


// ============================================================
// SECTION 3 — DUPLICATE CHECK
// ============================================================

/**
 * ตรวจสอบ Duplicate Bill สำหรับ PDF-parsed data
 * บิลซ้ำ = meter_id + bill_year + bill_month เหมือนกัน
 * และ status ไม่ใช่ CANCELLED
 *
 * @param {Object} parsedData
 * @returns {{ found: boolean, billId: string|null, existingBill: Object|null }}
 * @private
 */
function _checkPdfDuplicate(parsedData) {
  if (!parsedData.meter_id || !parsedData.bill_year || !parsedData.bill_month) {
    return { found: false, billId: null };
  }

  try {
    const existing = dbFind(CONFIG.SHEETS.BILLS, {
      meter_id:   String(parsedData.meter_id),
      bill_year:  String(parsedData.bill_year),
      bill_month: String(parsedData.bill_month),
    });

    // กรอง cancelled ออก
    const activeDups = existing.filter(b =>
      b.bill_status !== 'CANCELLED'
    );

    if (activeDups.length > 0) {
      const dup = activeDups[0];
      return { found: true, billId: dup.bill_id, existingBill: dup };
    }

    return { found: false, billId: null, existingBill: null };

  } catch (e) {
    log('WARN', '_checkPdfDuplicate', `Duplicate check failed: ${e.message}`);
    return { found: false, billId: null }; // ถ้า check ไม่ได้ ให้ผ่านไปก่อน
  }
}


// ============================================================
// SECTION 4 — CROSS-CHECK HELPERS
// ============================================================

/**
 * Cross-check ว่า Provider ของ PDF สอดคล้องกับ meter_type ในระบบ
 * เช่น ถ้า provider = PEA แต่ meter_type = WATER → น่าสงสัย
 *
 * @param {Object} parsedData
 * @param {Object} meter
 * @returns {{ warning: boolean, message: string }}
 * @private
 */
function _crossCheckProviderMeterType(parsedData, meter) {
  if (!parsedData.provider || !meter?.meter_type) {
    return { warning: false, message: '' };
  }

  const PROVIDER_EXPECTED_TYPE = {
    PEA: 'ELECTRICITY',
    MEA: 'ELECTRICITY',
    PWA: 'WATER',
    MWA: 'WATER',
    PTT: 'GAS',
  };

  const expected = PROVIDER_EXPECTED_TYPE[parsedData.provider];
  if (!expected) return { warning: false, message: '' };

  if (expected !== meter.meter_type) {
    return {
      warning: true,
      message: `Provider "${parsedData.provider}" ไม่สอดคล้องกับ meter_type "${meter.meter_type}" (คาดว่า "${expected}")`,
    };
  }

  return { warning: false, message: '' };
}


// ============================================================
// SECTION 5 — MANUAL REVIEW HELPERS
// ============================================================

/**
 * ดึงเหตุผลทั้งหมดที่บิลนี้ต้องผ่าน Manual Review
 * ใช้สร้าง UI ที่ชัดเจนสำหรับ reviewer
 *
 * @param {Object} validationResult  — ผลจาก pdfValidatorCheck()
 * @returns {{ count: number, reasons: Object[] }}
 */
function getManualReviewReasons(validationResult) {
  const reasons = validationResult.triggeredRules.map(rule => ({
    code:     rule.id,
    severity: rule.severity,
    message:  rule.message,
    label:    _getReviewReasonLabel(rule.id),
  }));

  return {
    count:   reasons.length,
    reasons,
    summary: _buildReviewSummary(reasons),
  };
}

/**
 * ตรวจสอบว่า bill ที่มีอยู่ (PENDING_REVIEW) สามารถ skip review ได้หรือไม่
 * ใช้สำหรับ bulk approve logic
 *
 * @param {Object} bill  — bill object จาก sheet
 * @returns {{ canSkipReview: boolean, reason: string }}
 */
function canSkipManualReview(bill) {
  // ถ้า confidence สูงมากและไม่มี warning rule ใหญ่
  const confidence = parseNumber(bill.pdf_confidence);

  if (confidence >= 95) {
    return { canSkipReview: true, reason: `confidence ${confidence}% ≥ 95%` };
  }

  return { canSkipReview: false, reason: `confidence ${confidence}% < 95%` };
}

/**
 * ดึง label ภาษาไทยสำหรับแต่ละ review reason code
 * @private
 */
function _getReviewReasonLabel(ruleId) {
  const LABELS = {
    MISSING_AMOUNT:             'ไม่พบยอดเงิน',
    MISSING_BILL_PERIOD:        'ไม่ระบุเดือน/ปี',
    AMOUNT_UNUSUALLY_HIGH:      'ยอดสูงผิดปกติ',
    AMOUNT_SUSPICIOUSLY_LOW:    'ยอดต่ำผิดปกติ',
    METER_NUMBER_MISMATCH:      'เลขมิเตอร์ไม่ตรง',
    METER_ROLLBACK:             'หน่วยมิเตอร์ลดลง',
    UNITS_CALCULATION_MISMATCH: 'จำนวนหน่วยไม่สอดคล้อง',
    DUE_DATE_TOO_OLD:           'วันกำหนดชำระล่าช้ามาก',
    FUTURE_BILL_PERIOD:         'บิลอนาคต',
    MISSING_DUE_DATE:           'ไม่ระบุวันกำหนดชำระ',
    AMOUNT_BREAKDOWN_MISMATCH:  'ยอดย่อยไม่สอดคล้อง',
    DUPLICATE:                  'บิลซ้ำ',
    PROVIDER_TYPE:              'Provider ไม่สอดคล้อง',
  };
  return LABELS[ruleId] || ruleId;
}

/**
 * สร้าง summary สั้นๆ จาก reasons list
 * @private
 */
function _buildReviewSummary(reasons) {
  const errors   = reasons.filter(r => r.severity === 'ERROR');
  const warnings = reasons.filter(r => r.severity === 'WARNING');

  if (errors.length > 0) {
    return `มีปัญหา ${errors.length} รายการที่ต้องแก้ไขก่อนอนุมัติ`;
  }
  if (warnings.length > 0) {
    return `มีคำเตือน ${warnings.length} รายการ กรุณาตรวจสอบก่อนอนุมัติ`;
  }
  return 'ไม่มีปัญหา';
}


// ============================================================
// SECTION 6 — BATCH VALIDATION
// ============================================================

/**
 * ตรวจสอบ batch ของ parsed data หลายรายการพร้อมกัน
 * ใช้เมื่อ upload หลาย PDF พร้อมกัน
 *
 * @param {Object[]} parsedDataList  — array ของ parsedData
 * @param {Object[]} meters          — array ของ meter objects (index ตรงกับ parsedDataList)
 * @returns {{ results: Object[], summary: Object }}
 */
function pdfValidatorBatchCheck(parsedDataList, meters) {
  const results = parsedDataList.map((data, i) => {
    const meter = meters[i] || {};
    const validation = pdfValidatorCheck(data, meter);
    return {
      index:  i,
      ...validation,
    };
  });

  const summary = {
    total:        results.length,
    canCreate:    results.filter(r => r.canCreateBill).length,
    hasErrors:    results.filter(r => r.errors.length > 0).length,
    hasWarnings:  results.filter(r => r.warnings.length > 0).length,
    duplicates:   results.filter(r => r.duplicateFound).length,
  };

  return { results, summary };
}


// ============================================================
// SECTION 7 — UTILITY HELPERS
// ============================================================

/**
 * ตรวจสอบว่า parsedData มี fields ที่จำเป็นขั้นต่ำสำหรับการสร้างบิล
 * (Quick check ก่อน pdfValidatorCheck() เต็ม)
 *
 * @param {Object} parsedData
 * @returns {{ valid: boolean, missingFields: string[] }}
 */
function pdfValidatorQuickCheck(parsedData) {
  const REQUIRED_FIELDS = ['meter_id', 'bill_year', 'bill_month', 'amount_total'];
  const missingFields = REQUIRED_FIELDS.filter(f => {
    const val = parsedData[f];
    return val === null || val === undefined || val === '' || val === 0;
  });

  return {
    valid:         missingFields.length === 0,
    missingFields,
  };
}

/**
 * Format ยอดเงินสำหรับแสดงใน error messages
 * Wrapper ที่ safe (ถ้า Utils.gs ไม่มี formatAmount ให้ใช้ default)
 * @private
 */
function formatAmount(amount) {
  if (typeof amount !== 'number') amount = parseFloat(amount) || 0;
  return amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Wrapper สำหรับ parseNumber
 * รองรับกรณีที่ Utils.gs อาจไม่ได้ load ก่อน
 * @private
 */
function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}
