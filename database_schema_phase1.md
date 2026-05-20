ผมจะออกแบบ Schema ทั้ง 4 ตารางอย่างละเอียดสำหรับ Phase 1 ครับ

---

## PHASE 1 — DATABASE FOUNDATION

Schema ออกแบบตาม 3 หลักการหลัก: **Looker Studio compatible** (column names ไม่มี space, type ชัดเจน), **Apps Script friendly** (headers row 1, ไม่มี merged cells), **extensible** (FK ชัดเจน, status fields รองรับ workflow)

---

### TABLE 1 — `Sites`

ตารางแม่สุด รู้ทุกสถานที่ที่ดูแลอยู่---

## Relationship Diagram---

## Design Decisions สำคัญ

**Duplicate bill prevention** — ใน Bills ให้สร้าง composite unique constraint ด้วย GAS: `meter_id + bill_year + bill_month` ต้องไม่ซ้ำกัน เช็คก่อน `appendRow` ทุกครั้ง

**Denormalization ตั้งใจ** — `Bills.site_id` เก็บซ้ำทั้งที่มี FK ผ่าน Meters แล้ว เพราะ Looker Studio filter by site โดยตรงเร็วกว่าการ join ข้ามชีท

**ปี พ.ศ. vs ค.ศ.** — `bill_year` เก็บเป็น พ.ศ. (2568) ตามบิลจริง แต่ `reading_date_from/to` เก็บเป็น ค.ศ. ISO 8601 เพื่อให้ Apps Script คำนวณวันได้ถูกต้อง

**`bill_period_key`** format `"2568-06"` ทำให้ Looker Studio sort ได้ถูกต้องโดย default (lexicographic = chronological)

**PDF confidence < 70** → `needs_review = TRUE` อัตโนมัติ และ `bill_status = PENDING_REVIEW` รอ staff ตรวจ ป้องกันข้อมูลผิดเข้า workflow ชำระเงิน

---

เมื่อพร้อมให้บอกได้เลยครับ จะไปต่อ **PHASE 1 ส่วนที่ 2** — ตาราง `BillPayments`, `Advances`, `Users`, `Anomalies`, `AuditLog` และส่วนที่เหลือ
