// ============================================================
// Config.gs — Central Configuration
// UtilityManager | PHASE 2 — Backend Foundation
// ============================================================
// แก้ไขค่าในไฟล์นี้เพื่อปรับแต่งระบบ
// ห้าม hardcode ค่าเหล่านี้ในไฟล์อื่น ให้ import จากที่นี่เสมอ
// ============================================================

// ============================================================
// SECTION 1 — GOOGLE SHEETS & DRIVE IDs
// ============================================================

const CONFIG = {

  // ---- Google Sheets ----
  // วิธีหา SHEET_ID: เปิด Google Sheets → ดู URL
  // https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit
  SHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',

  // ---- Google Drive Folder IDs ----
  // วิธีหา FOLDER_ID: เปิด Google Drive Folder → ดู URL
  // https://drive.google.com/drive/folders/{FOLDER_ID}
  FOLDERS: {
    ROOT:        'YOUR_ROOT_FOLDER_ID',         // 📁 UtilityManager/
    PDF_BILLS:   'YOUR_PDF_BILLS_FOLDER_ID',    // 📁 PDFBills/
    REPORTS:     'YOUR_REPORTS_FOLDER_ID',      // 📁 Reports/
    EXPORTS:     'YOUR_EXPORTS_FOLDER_ID',      // 📁 Exports/
  },

  // ============================================================
  // SECTION 2 — SHEET (TABLE) NAMES
  // ต้องตรงกับชื่อ Tab ใน Google Sheets ทุกตัวอักษร
  // ============================================================
  SHEETS: {
    SITES:          'Sites',
    METERS:         'Meters',
    BILLS:          'Bills',
    BILL_PAYMENTS:  'BillPayments',
    ACCOUNTS:       'Accounts',
    ADVANCES:       'Advances',
    USERS:          'Users',
    ANOMALIES:      'Anomalies',
    AUDIT_LOG:      'AuditLog',
    BILL_TEMPLATES: 'BillTemplates',
    MONTHLY_SUMMARY:'MonthlySummary',
    ARCHIVE_BILLS:  'ArchiveBills',
  },

  // ============================================================
  // SECTION 3 — ANOMALY DETECTION THRESHOLDS
  // ปรับค่าตามความเหมาะสมของธุรกิจ
  // ============================================================
  THRESHOLDS: {
    SPIKE_PCT:          30,    // % เพิ่มจากเดือนก่อน → MEDIUM alert
    SPIKE_PCT_HIGH:     50,    // % เพิ่มจากเดือนก่อน → HIGH alert
    AVG6M_PCT:          40,    // % สูงกว่าค่าเฉลี่ย 6 เดือน
    WATER_DROP_PCT:     50,    // % ลดลงของน้ำ → ผิดปกติ
    MIN_MONTHS_DETECT:  3,     // จำนวนเดือนขั้นต่ำก่อนเริ่ม detect
    PDF_CONFIDENCE_MIN: 70,    // confidence score ขั้นต่ำ (0-100)
  },

  // ============================================================
  // SECTION 4 — SESSION & AUTH
  // ============================================================
  SESSION: {
    EXPIRE_HOURS:  8,          // session หมดอายุใน 8 ชั่วโมง
    TOKEN_PREFIX:  'session_', // prefix ของ key ใน PropertiesService
  },

  // ============================================================
  // SECTION 5 — EMAIL NOTIFICATIONS
  // ============================================================
  EMAIL: {
    ADMIN_EMAILS:    ['admin@yourcompany.com'],   // รับแจ้งเตือน HIGH severity
    SENDER_NAME:     'UtilityManager System',
    OVERDUE_DAYS:    3,   // แจ้งเตือนก่อน due date กี่วัน
  },

  // ============================================================
  // SECTION 6 — ID PREFIXES
  // ============================================================
  ID_PREFIX: {
    SITE:     'SITE',
    METER:    'MTR',
    BILL:     'BILL',
    PAYMENT:  'PAY',
    ADVANCE:  'ADV',
    ACCOUNT:  'ACC',
    ANOMALY:  'ANM',
    AUDIT:    'AUD',
  },

  // ============================================================
  // SECTION 7 — VALID ENUM VALUES
  // ใช้ validate input ก่อน write ลง Sheet
  // ============================================================
  ENUMS: {
    METER_TYPE:   ['ELECTRICITY', 'WATER', 'GAS', 'INTERNET'],
    PROVIDER:     ['PEA', 'MEA', 'PWA', 'PTT', 'TRUE', 'AIS', 'OTHER'],
    BILL_STATUS:  ['PENDING_REVIEW', 'APPROVED', 'PAID', 'OVERDUE', 'CANCELLED'],
    SEVERITY:     ['LOW', 'MEDIUM', 'HIGH'],
    ANOMALY_TYPE: ['SPIKE_30PCT', 'ZERO_USAGE', 'ABOVE_6M_AVG', 'DROP_WATER'],
    USER_ROLE:    ['ADMIN', 'EXECUTIVE', 'STAFF'],
    SITE_STATUS:  ['ACTIVE', 'INACTIVE'],
    METER_STATUS: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'],
    PAY_METHOD:   ['BANK_TRANSFER', 'COUNTER', 'ONLINE', 'AUTO_DEBIT', 'OTHER'],
    ADV_STATUS:   ['PENDING', 'APPROVED', 'SETTLED', 'CANCELLED'],
  },

  // ============================================================
  // SECTION 8 — TIMEZONE
  // ============================================================
  TIMEZONE: 'Asia/Bangkok',

};

// ============================================================
// HELPER — ดึงค่า Config แบบ safe (throw ถ้า key ไม่มี)
// ============================================================
function getConfig(path) {
  const keys = path.split('.');
  let val = CONFIG;
  for (const k of keys) {
    if (val === undefined || val === null) throw new Error(`Config not found: ${path}`);
    val = val[k];
  }
  if (val === undefined) throw new Error(`Config not found: ${path}`);
  return val;
}

// ============================================================
// SETUP CHECK — รัน 1 ครั้งหลัง deploy เพื่อยืนยัน config
// ============================================================
function validateConfig() {
  const required = ['SHEET_ID', 'FOLDERS.ROOT', 'FOLDERS.PDF_BILLS'];
  const errors = [];

  required.forEach(path => {
    const val = getConfig(path);
    if (!val || val.includes('YOUR_')) {
      errors.push(`⚠️  ยังไม่ได้ตั้งค่า: CONFIG.${path}`);
    }
  });

  if (errors.length > 0) {
    Logger.log('=== CONFIG VALIDATION FAILED ===');
    errors.forEach(e => Logger.log(e));
    Logger.log('แก้ไขค่าใน Config.gs ก่อนใช้งาน');
  } else {
    Logger.log('✅ Config validation passed');
  }
  return errors;
}
