// ============================================================
// Utils.gs — Shared Utility Functions
// UtilityManager | PHASE 2 — Backend Foundation
// ============================================================
// ฟังก์ชันกลางที่ทุก module เรียกใช้ได้
// ไม่มี dependency กับ module อื่น (pure utilities)
// ============================================================


// ============================================================
// SECTION 1 — ID GENERATOR
// ============================================================

/**
 * สร้าง unique ID สำหรับแต่ละ entity
 * format: {PREFIX}_{TIMESTAMP}_{RANDOM5}
 * ตัวอย่าง: BILL_1717123456789_AB3X2
 *
 * @param {string} prefix - ดูได้จาก CONFIG.ID_PREFIX
 * @returns {string}
 */
function generateId(prefix) {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}_${Date.now()}_${rand}`;
}


// ============================================================
// SECTION 2 — DATE & TIME UTILITIES
// ============================================================

/**
 * คืน timestamp ปัจจุบันเป็น ISO 8601 string (ค.ศ.)
 * ตัวอย่าง: "2025-06-15T08:30:00.000+07:00"
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * คืนวันที่ปัจจุบันเป็น string YYYY-MM-DD (ค.ศ.)
 */
function todayDateStr() {
  const d = new Date();
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

/**
 * แปลงปี พ.ศ. → ค.ศ.
 * @param {number} buddhistYear - เช่น 2568
 * @returns {number} - เช่น 2025
 */
function toGregorianYear(buddhistYear) {
  return parseInt(buddhistYear) - 543;
}

/**
 * แปลงปี ค.ศ. → พ.ศ.
 * @param {number} gregorianYear - เช่น 2025
 * @returns {number} - เช่น 2568
 */
function toBuddhistYear(gregorianYear) {
  return parseInt(gregorianYear) + 543;
}

/**
 * สร้าง bill_period_key จาก bill_year (พ.ศ.) + bill_month
 * ตัวอย่าง: makePeriodKey(2568, 6) → "2568-06"
 *
 * @param {number} buddhistYear
 * @param {number} month - 1-12
 * @returns {string}
 */
function makePeriodKey(buddhistYear, month) {
  return `${buddhistYear}-${String(month).padStart(2, '0')}`;
}

/**
 * แปลงวันที่ DD/MM/YYYY หรือ DD-MM-YYYY → ISO date string YYYY-MM-DD
 * รองรับปี พ.ศ. และ ค.ศ. อัตโนมัติ (ถ้า year > 2500 = พ.ศ.)
 *
 * @param {string} dateStr - เช่น "15/06/2568" หรือ "15-06-2025"
 * @returns {string|null} - "2025-06-15" หรือ null ถ้า parse ไม่ได้
 */
function parseDateStr(dateStr) {
  if (!dateStr) return null;
  const cleaned = String(dateStr).trim();
  const match = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!match) return null;

  let [, d, m, y] = match;
  d = parseInt(d);
  m = parseInt(m);
  y = parseInt(y);

  // ปี 2 หลัก → เติมเป็น 4 หลัก
  if (y < 100) y += (y < 70 ? 2000 : 1900);
  // แปลง พ.ศ. → ค.ศ.
  if (y > 2500) y = toGregorianYear(y);

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * คืนจำนวนวันระหว่างวันที่ 2 วัน (ISO string)
 * ค่าลบ = date1 อยู่หลัง date2
 */
function daysBetween(isoDate1, isoDate2) {
  const d1 = new Date(isoDate1);
  const d2 = new Date(isoDate2);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}


// ============================================================
// SECTION 3 — NUMBER & CURRENCY UTILITIES
// ============================================================

/**
 * แปลง string ที่มี comma เป็น number
 * ตัวอย่าง: "1,234.56" → 1234.56
 */
function parseNumber(str) {
  if (str === null || str === undefined || str === '') return 0;
  if (typeof str === 'number') return str;
  return parseFloat(String(str).replace(/,/g, '')) || 0;
}

/**
 * จัดรูปแบบตัวเลขเป็น string ทศนิยม 2 ตำแหน่ง
 * ตัวอย่าง: formatAmount(1234.5) → "1,234.50"
 */
function formatAmount(num) {
  return parseFloat(num || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * คำนวณ % เปลี่ยนแปลง
 * ตัวอย่าง: pctChange(100, 130) → 30.0
 */
function pctChange(oldVal, newVal) {
  if (!oldVal || oldVal === 0) return null;
  return ((newVal - oldVal) / oldVal) * 100;
}


// ============================================================
// SECTION 4 — VALIDATION UTILITIES
// ============================================================

/**
 * ตรวจสอบว่า value อยู่ใน ENUM list หรือไม่
 *
 * @param {string} value
 * @param {string[]} enumArray - เช่น CONFIG.ENUMS.METER_TYPE
 * @returns {boolean}
 */
function isValidEnum(value, enumArray) {
  return enumArray.includes(value);
}

/**
 * Validate object ตาม schema rules
 * schema format: { fieldName: { required: bool, type: 'string'|'number'|'boolean', enum: [] } }
 *
 * @param {Object} data
 * @param {Object} schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSchema(data, schema) {
  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const val = data[field];
    const isEmpty = val === null || val === undefined || val === '';

    if (rules.required && isEmpty) {
      errors.push(`${field}: จำเป็นต้องกรอก`);
      continue;
    }
    if (isEmpty) continue;

    if (rules.type === 'number' && isNaN(parseNumber(val))) {
      errors.push(`${field}: ต้องเป็นตัวเลข`);
    }
    if (rules.enum && !isValidEnum(String(val), rules.enum)) {
      errors.push(`${field}: ค่าไม่ถูกต้อง (${rules.enum.join(', ')})`);
    }
    if (rules.maxLength && String(val).length > rules.maxLength) {
      errors.push(`${field}: ยาวเกิน ${rules.maxLength} ตัวอักษร`);
    }
  }

  return { valid: errors.length === 0, errors };
}


// ============================================================
// SECTION 5 — ARRAY & OBJECT UTILITIES
// ============================================================

/**
 * จัดกลุ่ม array ของ object ตาม key
 * ตัวอย่าง: groupBy([{type:'A'},{type:'B'},{type:'A'}], 'type')
 * → { A: [{...},{...}], B: [{...}] }
 */
function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key];
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

/**
 * คำนวณค่าเฉลี่ยของ array ตัวเลข
 */
function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * ลบ key ที่ค่าเป็น undefined/null/'' ออกจาก object
 */
function cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

/**
 * Deep clone object อย่างง่าย (JSON safe)
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}


// ============================================================
// SECTION 6 — RESPONSE BUILDER
// ============================================================

/**
 * สร้าง standard API response object สำหรับ doGet/doPost
 *
 * @param {boolean} success
 * @param {*} data
 * @param {string} [message]
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function buildResponse(success, data, message = '') {
  const payload = {
    success,
    data: data ?? null,
    message,
    timestamp: nowISO(),
  };
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * สร้าง error response
 */
function buildError(message, statusCode = 400) {
  return buildResponse(false, null, `[${statusCode}] ${message}`);
}


// ============================================================
// SECTION 7 — LOGGING
// ============================================================

/**
 * Log message พร้อม timestamp (ใช้แทน Logger.log ทั่วไป)
 * @param {string} level - 'INFO' | 'WARN' | 'ERROR'
 * @param {string} fn - ชื่อฟังก์ชัน
 * @param {string} message
 * @param {*} [data]
 */
function log(level, fn, message, data) {
  const ts = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const line = `[${ts}][${level}][${fn}] ${message}`;
  Logger.log(line);
  if (data) Logger.log(JSON.stringify(data));
}
