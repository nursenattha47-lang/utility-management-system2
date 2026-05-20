# PHASE 2 — GAS Backend Foundation
## UtilityManager | Deployment Guide

---

## ไฟล์ที่ได้รับ (5 ไฟล์)

```
GAS_UtilityManager/
├── Config.gs      ← ตั้งค่าระบบ (แก้ก่อน deploy)
├── Utils.gs       ← Utility functions (ไม่ต้องแตะ)
├── Database.gs    ← CRUD layer สำหรับ Google Sheets
├── Auth.gs        ← Session + RBAC
├── API.gs         ← Business logic (Sites/Meters/Bills/Payments/Advances)
└── Code.gs        ← HTTP entry point (doGet/doPost router)
```

---

## Architecture Overview

```
HTTP Request (GET/POST)
        │
        ▼
    Code.gs          ← router รับทุก request
        │
        ├── Auth.gs  ← requireAuth() → validate token + permission
        │
        ├── API.gs   ← business logic (validate → check FK → transform)
        │
        └── Database.gs ← batch read/write Google Sheets
                              └── Utils.gs (helpers ทุกอย่าง)
```

---

## วิธี Deploy (Step-by-Step)

### Step 1 — สร้าง Google Sheets

1. สร้าง Google Sheets ใหม่ใน Drive
2. Copy **Spreadsheet ID** จาก URL  
   `https://docs.google.com/spreadsheets/d/**{ID}**/edit`
3. สร้าง Folders ใน Google Drive ตาม structure ด้านล่าง  
   Copy **Folder IDs** จาก URL ของแต่ละ folder

### Step 2 — สร้าง GAS Project

1. เปิด `script.google.com` → New Project
2. ตั้งชื่อ project: `UtilityManager`
3. Copy code จากแต่ละไฟล์ไปวางใน GAS Editor  
   (สร้างไฟล์ใหม่ใน GAS ชื่อตรงกันทุกไฟล์)

### Step 3 — แก้ไข Config.gs

```javascript
// แก้ค่าเหล่านี้ก่อนใช้งาน
SHEET_ID:          'your-actual-spreadsheet-id',
FOLDERS.ROOT:      'your-root-folder-id',
FOLDERS.PDF_BILLS: 'your-pdf-folder-id',
EMAIL.ADMIN_EMAILS: ['your-admin@company.com'],
```

### Step 4 — Initialize Sheets

1. เปิด GAS Editor → เลือก function `initializeAllSheets`
2. กด **Run** → อนุญาต Permissions
3. ตรวจสอบ Google Sheets → ควรมี Tab ใหม่ 11 Sheets

### Step 5 — สร้าง Admin User คนแรก

เพิ่ม row แรกลงใน `Users` sheet ด้วยมือ:

| user_id | email | display_name | role | site_access | is_active | created_at |
|---|---|---|---|---|---|---|
| USR_001 | admin@company.com | Admin | ADMIN | ALL | TRUE | 2025-06-01 |

### Step 6 — Deploy as Web App

1. GAS Editor → **Deploy** → **New Deployment**
2. Select type: **Web App**
3. ตั้งค่า:
   - Execute as: **Me** (ใช้สิทธิ์เจ้าของ script)
   - Who has access: **Anyone** (หรือ `Anyone in organization` ถ้าใช้ Workspace)
4. Copy **Web App URL** → ใช้เป็น base URL ของทุก API call

---

## API Reference

### GET Endpoints

```
GET {URL}?action=ping
GET {URL}?action=login
GET {URL}?action=me&token={TOKEN}
GET {URL}?action=sites.list&token={TOKEN}&status=ACTIVE
GET {URL}?action=sites.get&token={TOKEN}&site_id=SITE_xxx
GET {URL}?action=meters.list&token={TOKEN}&site_id=SITE_xxx
GET {URL}?action=bills.list&token={TOKEN}&bill_year=2568
GET {URL}?action=bills.due_soon&token={TOKEN}&days=3
GET {URL}?action=bills.overdue&token={TOKEN}
GET {URL}?action=payments.list&token={TOKEN}&bill_id=BILL_xxx
GET {URL}?action=accounts.list&token={TOKEN}
GET {URL}?action=advances.list&token={TOKEN}&status=PENDING
```

### POST Endpoints

POST body: `{ "action": "...", "token": "...", "data": {...} }`

```
sites.create      → data: { site_code, site_name, province, ... }
sites.update      → data: { site_id, ...fields }
meters.create     → data: { site_id, meter_number, meter_type, provider }
meters.update     → data: { meter_id, ...fields }
bills.create      → data: { meter_id, bill_year, bill_month, amount_total }
bills.approve     → data: { bill_id }
bills.cancel      → data: { bill_id, reason }
payments.create   → data: { bill_id, amount_paid, payment_date, payment_method }
accounts.create   → data: { account_name, bank_name, account_number }
advances.create   → data: { site_id, amount_requested, purpose, advance_date }
advances.approve  → data: { advance_id }
advances.settle   → data: { advance_id, amount_used, settled_date }
users.create      → data: { email, display_name, role }
```

### Response Format (ทุก endpoint)

```json
{
  "success": true,
  "data": { ... },
  "message": "สร้าง Site สำเร็จ",
  "timestamp": "2025-06-15T08:30:00.000Z"
}
```

Error:
```json
{
  "success": false,
  "data": null,
  "message": "[401] UNAUTHORIZED: Session หมดอายุ กรุณา login ใหม่",
  "timestamp": "..."
}
```

---

## Google Sheets Structure (11 Sheets)

| Sheet Name | Description |
|---|---|
| Sites | สถานที่ทั้งหมด |
| Meters | มิเตอร์ทั้งหมด (FK → Sites) |
| Bills | บิลทั้งหมด (FK → Meters, Sites) |
| BillPayments | การชำระเงิน (FK → Bills) |
| Accounts | บัญชีธนาคาร |
| Advances | เงินสำรองจ่าย (FK → Sites) |
| Users | ผู้ใช้งานระบบ |
| Anomalies | การตรวจจับความผิดปกติ |
| AuditLog | บันทึกการเปลี่ยนแปลงทั้งหมด |
| MonthlySummary | สรุปรายเดือน |
| ArchiveBills | บิลเก่ากว่า 2 ปี |

---

## PHASE ถัดไป

| Phase | Content |
|---|---|
| Phase 3 | Triggers.gs + EmailNotify.gs (Automation) |
| Phase 4 | Analytics.gs (Anomaly Detection + Monthly Summary) |
| Phase 5 | PDFParser.gs (PDF Upload + Regex Extract) |
| Phase 6 | Frontend HTML/CSS/JS |
| Phase 7 | Looker Studio Dashboard |
