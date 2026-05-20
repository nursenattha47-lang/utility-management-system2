ขอบคุณที่แชร์ระบบที่ต้องการอย่างละเอียด ผมจะออกแบบและพัฒนาให้ครบทั้ง 20 หัวข้อ แบ่งเป็นหลายส่วนเพื่อให้อ่านง่ายและใช้งานได้จริง

---

# ส่วนที่ 1 — System Architecture & Tech Stack

## 1. System Architecture Overview

สถาปัตยกรรมระบบนี้ออกแบบแบบ **3-Tier Architecture** บน Google Workspace ทั้งหมด ฟรี 100% ไม่มีค่า server ไม่มีค่า hosting## 2. Tech Stack Recommendation (ละเอียด)

**Frontend — GAS Web App (หลัก)**
ระบบนี้ใช้ Google Apps Script Web App เป็น frontend หลัก เหตุผลคือ deploy ได้ทันที ใช้ HTML/CSS/JS ธรรมดา ฝัง Chart.js ได้ ทำ responsive ได้ ไม่ต้องจ่ายค่า hosting และ integrate กับ Google Sheets โดยตรงโดยไม่ต้องผ่าน API key เพิ่มเติม

**Frontend — AppSheet (Mobile + Non-dev Admin)**
ใช้ AppSheet เป็น companion app สำหรับทีมที่ต้องกรอกข้อมูลในมือถือ เช่น พนักงานที่ต้องบันทึกมิเตอร์ในสถานที่ AppSheet connect กับ Google Sheets ได้โดยตรง ฟรีสำหรับ personal/small team

**Backend — Google Apps Script**
เป็น server-side JS ที่รัน on Google infrastructure ฟรีทั้งหมด มี `doGet()` / `doPost()` สำหรับรับ HTTP request มี Time-driven Triggers สำหรับ automation มี `SpreadsheetApp` / `DriveApp` / `GmailApp` built-in

**Database — Google Sheets**
ออกแบบเป็น relational-like structure โดยแต่ละ Sheet = 1 Table มีการทำ Foreign Key ด้วย ID references ใช้ Apps Script ในการ join และ query ข้อมูล

**Dashboard — Looker Studio**
Connect กับ Google Sheets โดยตรง ฟรี สร้าง interactive dashboard ได้แบบ professional ใช้สำหรับ Executive View ที่ไม่ต้องการแก้ไขข้อมูล

---

# ส่วนที่ 2 — Database Design & Table Structure## 3. Google Sheets Table Structure (ครบทุก Table)

ด้านล่างคือโครงสร้างทุก Sheet ที่ต้องสร้างใน Google Sheets Workbook เดียวกัน---

# ส่วนที่ 3 — PDF Parsing System Architecture## Regex Pattern สำหรับบิลไทย (PEA / MEA / PWA)

นี่คือ regex pattern จริงที่ใช้ใน `BillTemplates` table:

```javascript
// ===== PROVIDER DETECTION =====
const PROVIDERS = {
  PEA: { keywords: ['การไฟฟ้าส่วนภูมิภาค','PEA'] },
  MEA: { keywords: ['การไฟฟ้านครหลวง','MEA'] },
  PWA: { keywords: ['ประปา','PWA','การประปา'] }
};

// ===== PEA ELECTRICITY TEMPLATE =====
const PEA_TEMPLATE = {
  meter_number: /เลขที่มิเตอร์[:\s]*([0-9\-]+)/,
  units_before:  /หน่วยก่อน[:\s]*([\d,]+\.?\d*)/,
  units_after:   /หน่วยหลัง[:\s]*([\d,]+\.?\d*)/,
  units_used:    /จำนวนหน่วย[:\s]*([\d,]+\.?\d*)/,
  amount:        /ยอดรวม[:\s]*([\d,]+\.?\d*)\s*บาท/,
  due_date:      /กำหนดชำระ[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
  bill_month:    /ประจำเดือน[:\s]*([ก-ฮ]+)\s*(\d{4})/
};

// ===== MEA ELECTRICITY TEMPLATE =====
const MEA_TEMPLATE = {
  meter_number: /Meter No[.:\s]*([0-9\s]+)/i,
  amount:       /NET AMOUNT[:\s]*([\d,]+\.?\d*)/i,
  due_date:     /DUE DATE[:\s]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
  units_used:   /UNIT[S]?\s*USED[:\s]*([\d,]+)/i
};

// ===== CONFIDENCE SCORING =====
function calcConfidence(parsed) {
  const weights = {
    meter_number: 30,  // สำคัญที่สุด
    amount:       25,
    units_used:   20,
    due_date:     15,
    bill_month:   10
  };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (parsed[key] && parsed[key].trim() !== '') score += weight;
  }
  return score; // 0–100
}
```

---

# ส่วนที่ 4 — Dashboard & UX/UI Mockup---

# ส่วนที่ 5 — Anomaly Detection Logic & Automation

## Abnormal Detection Algorithm (ใช้งานจริงใน GAS)

```javascript
// ===== ANOMALY DETECTION ENGINE =====
// เรียกใช้ทุกต้นเดือน ด้วย Time-driven Trigger

function detectAnomalies() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const bills = getSheetData(ss, 'Bills');
  const meters = getSheetData(ss, 'Meters');
  const anomalies = [];

  // จัดกลุ่มบิลตาม meter_id
  const billsByMeter = groupBy(bills, 'meter_id');

  for (const [meterId, meterBills] of Object.entries(billsByMeter)) {
    // เรียงตามวันที่ (เก่า→ใหม่)
    const sorted = meterBills.sort((a, b) =>
      new Date(a.bill_year, a.bill_month) - new Date(b.bill_year, b.bill_month)
    );

    if (sorted.length < 3) continue; // ต้องมีอย่างน้อย 3 เดือน

    const latest = sorted[sorted.length - 1];
    const prev    = sorted[sorted.length - 2];

    // --- Rule 1: เพิ่มเกิน 30% จากเดือนก่อน ---
    const changePct = ((latest.amount - prev.amount) / prev.amount) * 100;
    if (changePct > 30) {
      anomalies.push({
        meter_id: meterId,
        type: 'SPIKE_30PCT',
        severity: changePct > 50 ? 'HIGH' : 'MEDIUM',
        message: `ค่าใช้จ่ายเพิ่มขึ้น ${changePct.toFixed(1)}%`,
        month: latest.bill_month,
        year: latest.bill_year,
        value: latest.amount,
        prev_value: prev.amount
      });
    }

    // --- Rule 2: ใช้ 0 หน่วย (มิเตอร์อาจเสีย) ---
    if (latest.units_used <= 0) {
      anomalies.push({
        meter_id: meterId,
        type: 'ZERO_USAGE',
        severity: 'HIGH',
        message: 'ใช้ 0 หน่วย — มิเตอร์อาจขัดข้อง',
        month: latest.bill_month,
        year: latest.bill_year
      });
    }

    // --- Rule 3: เทียบค่าเฉลี่ย 6 เดือน ---
    const last6 = sorted.slice(-7, -1);
    if (last6.length >= 3) {
      const avg6 = last6.reduce((s, b) => s + b.amount, 0) / last6.length;
      const diffFromAvg = ((latest.amount - avg6) / avg6) * 100;
      if (diffFromAvg > 40) {
        anomalies.push({
          meter_id: meterId,
          type: 'ABOVE_6M_AVG',
          severity: 'MEDIUM',
          message: `สูงกว่าค่าเฉลี่ย 6 เดือน ${diffFromAvg.toFixed(1)}%`,
          month: latest.bill_month,
          year: latest.bill_year,
          avg6m: avg6
        });
      }
    }

    // --- Rule 4: ลดลงผิดปกติ (น้ำ — อาจมีรั่ว/ปิดใช้) ---
    const meter = meters.find(m => m.meter_id === meterId);
    if (meter?.meter_type === 'WATER' && changePct < -50) {
      anomalies.push({
        meter_id: meterId,
        type: 'DROP_WATER',
        severity: 'LOW',
        message: `ค่าน้ำลดลง ${Math.abs(changePct).toFixed(1)}% ผิดปกติ`,
        month: latest.bill_month,
        year: latest.bill_year
      });
    }
  }

  // Save anomalies ลง Anomalies sheet
  saveAnomalies(ss, anomalies);

  // ส่ง email แจ้งเตือนถ้ามี HIGH severity
  const highAlerts = anomalies.filter(a => a.severity === 'HIGH');
  if (highAlerts.length > 0) sendAnomalyAlert(highAlerts);

  return anomalies;
}
```

## Automation Triggers ที่ต้องตั้งใน GAS

```javascript
// ===== TIME-DRIVEN TRIGGERS =====

// 1. ทุกวัน 08:00 — ตรวจบิลค้าง Due Date
ScriptApp.newTrigger('checkOverdueBills')
  .timeBased().everyDays(1).atHour(8).create();

// 2. ทุกต้นเดือน — คำนวณ Monthly Summary
ScriptApp.newTrigger('generateMonthlySummary')
  .timeBased().onMonthDay(1).atHour(7).create();

// 3. ทุกต้นเดือน — Anomaly Detection
ScriptApp.newTrigger('detectAnomalies')
  .timeBased().onMonthDay(2).atHour(8).create();

// 4. ทุกสัปดาห์ — ตรวจเงินสำรองค้างคืน
ScriptApp.newTrigger('checkPendingAdvances')
  .timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).create();
```

---

# ส่วนที่ 6 — Folder Structure & GAS Architecture

## Google Drive Folder Structure

```
📁 UtilityManager/
├── 📁 Database/
│   └── 📊 UtilityDB.xlsx          ← Google Sheets (12 sheets/tables)
├── 📁 PDFBills/
│   ├── 📁 2568/
│   │   ├── 📁 01_มกราคม/
│   │   │   ├── 📁 SITE_001_โรงแรม_A/
│   │   │   └── 📁 SITE_002_โรงงาน_B/
│   │   └── 📁 06_มิถุนายน/
│   └── 📁 2567/
├── 📁 Reports/
│   ├── 📁 Monthly/
│   └── 📁 Annual/
├── 📁 Scripts/
│   └── 📁 GAS_WebApp/             ← GAS Project
└── 📁 Exports/
    ├── 📁 PDF/
    └── 📁 Excel/
```

## GAS Project File Structure

```
📁 GAS Project: UtilityManager/
├── Code.gs              ← doGet() / doPost() entry point
├── Auth.gs              ← Session, Role check
├── SitesAPI.gs          ← CRUD Sites / Addresses
├── MetersAPI.gs         ← CRUD Meters
├── BillsAPI.gs          ← CRUD Bills + Duplicate check
├── PaymentsAPI.gs       ← BillPayments + Accounts
├── AdvanceAPI.gs        ← Advance / Refund
├── PDFParser.gs         ← Upload, Extract, Regex, Validate
├── Analytics.gs         ← KPI, Trend, Anomaly, Summary
├── Triggers.gs          ← Time-driven trigger setup
├── EmailNotify.gs       ← Alert emails
├── ExportPDF.gs         ← PDF/Excel export
├── SheetHelper.gs       ← CRUD helpers (getRows, appendRow, etc.)
├── Config.gs            ← SHEET_ID, FOLDER_IDs, THRESHOLDS
└── 📁 frontend/
    ├── index.html       ← Main SPA shell
    ├── dashboard.html   ← Dashboard partial
    ├── bills.html       ← Bill entry form
    ├── pdfupload.html   ← PDF upload screen
    ├── anomaly.html     ← Anomaly analysis
    ├── style.css        ← Global CSS (CSS vars, layout)
    └── app.js           ← Client-side JS (fetch, render)
```

---

# ส่วนที่ 7 — Bill Status Workflow & Security## Security & Permission System

```javascript
// ===== ROLE-BASED ACCESS CONTROL =====
// ทุก doPost() ต้องผ่าน checkPermission() ก่อน

const PERMISSIONS = {
  ADMIN: {
    canRead: true, canWrite: true,
    canDelete: true, canManageUsers: true,
    canExport: true, canViewAudit: true
  },
  EXECUTIVE: {
    canRead: true, canWrite: false,
    canDelete: false, canManageUsers: false,
    canExport: true, canViewAudit: false
  },
  STAFF: {
    canRead: true, canWrite: true,
    canDelete: false, canManageUsers: false,
    canExport: false, canViewAudit: false
  }
};

function checkPermission(action, userEmail) {
  const user = getUserByEmail(userEmail);
  if (!user || !user.is_active) throw new Error('Unauthorized');
  const perms = PERMISSIONS[user.role];
  if (!perms[action]) throw new Error('Forbidden: ' + action);
  return user;
}

// ===== SESSION via PropertiesService =====
function createSession(userEmail) {
  const token = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('session_' + token, JSON.stringify({
    email: userEmail,
    created: Date.now(),
    expires: Date.now() + (8 * 60 * 60 * 1000) // 8 hours
  }));
  return token;
}
```

---

# ส่วนที่ 8 — Step-by-Step Implementation Plan---

# ส่วนที่ 9 — Scalability & Best Practices

## ข้อจำกัดของ GAS ที่ต้องรู้ และวิธีรับมือ

**ปัญหา: Google Sheets ช้าเมื่อข้อมูลมาก**
แก้ไขด้วยการใช้ `getDataRange().getValues()` แทนการ loop อ่านทีละ row การ batch write ด้วย `setValues()` แทน `appendRow()` ทีละบรรทัด และการแยก Archive Sheet เก็บข้อมูลเก่ากว่า 2 ปี

**ปัญหา: GAS Execution timeout 6 นาที**
แก้ไขด้วยการแยก heavy task เป็น batch ใช้ Continuation Tokens ใน Trigger-based tasks และ offload งาน monthly summary ไปรัน trigger กลางคืน

**Scalability path — เมื่อโตขึ้น:**
หาก transaction เกิน 50,000 รายการต่อปี ให้พิจารณา migrate Database ไป Supabase (PostgreSQL ฟรี tier) โดยที่ GAS Web App ยังใช้ได้เดิม เพียงเปลี่ยน data source จาก Sheets เป็น REST API แค่ที่ `SheetHelper.gs`

## Google Apps Script SheetHelper ตัวอย่าง

```javascript
// ===== SheetHelper.gs — Reusable CRUD Layer =====

const SHEET_ID = 'YOUR_SPREADSHEET_ID'; // ใส่ใน Config.gs

function getSheetRows(sheetName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i]]))
  ).filter(row => row[headers[0]] !== ''); // skip empty rows
}

function appendSheetRow(sheetName, rowObj) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newRow = headers.map(h => rowObj[h] ?? '');
  sheet.appendRow(newRow);
  logAudit('INSERT', sheetName, rowObj[headers[0]]);
}

function updateSheetRow(sheetName, idField, idValue, updates) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf(idField);
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === idValue) {
      Object.entries(updates).forEach(([key, val]) => {
        const col = headers.indexOf(key);
        if (col >= 0) sheet.getRange(i + 1, col + 1).setValue(val);
      });
      logAudit('UPDATE', sheetName, idValue, updates);
      return true;
    }
  }
  return false;
}

function generateId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7).toUpperCase();
}
// ตัวอย่าง: generateId('BILL') → "BILL_1717123456789_AB3X2"
```

---

# สรุปภาพรวมทั้งระบบ

ระบบนี้ครบถ้วนสำหรับการใช้งานจริงในธุรกิจที่มีหลายสถานที่ โดยใช้ Google Workspace ทั้งหมดโดยไม่มีค่าใช้จ่าย เวลาพัฒนาประมาณ 10–12 สัปดาห์สำหรับนักพัฒนา 1–2 คน

สิ่งที่ควรทำก่อนเริ่มพัฒนาคือนั่งกำหนด `site_id` ให้ครบก่อน เพราะมันเป็น root ของทุกอย่าง จากนั้นสร้าง Sheets ให้ครบ แล้วค่อย build API ทีละ module ตาม Phase 1–8

หากต้องการให้ช่วยพัฒนาโค้ดเต็มของ module ใดเป็นพิเศษ เช่น `PDFParser.gs` ทั้งไฟล์, หน้า Dashboard HTML เต็ม, หรือ Looker Studio configuration — บอกได้เลยครับ
