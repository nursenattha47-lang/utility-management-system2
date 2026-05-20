// ============================================================
// API.gs — All Domain API Handlers
// UtilityManager | PHASE 2 — Backend Foundation
// ============================================================
// Covers: Sites, Meters, Bills, BillPayments, Advances
// ทุก function รับ params object และคืน plain Object
// การ serialize/deserialize JSON อยู่ใน Code.gs (entry point)
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs, Auth.gs
// ============================================================


// ============================================================
// ── SITES API ──────────────────────────────────────────────
// ============================================================

/**
 * ดึงรายการ Sites ทั้งหมด
 * @param {string} token
 * @param {Object} [filters] - { status: 'ACTIVE' }
 */
function sitesGetAll(token, filters = {}) {
  requireAuth(token, 'canRead');
  let sites = dbGetAll(CONFIG.SHEETS.SITES);
  if (filters.status) {
    sites = sites.filter(s => s.status === filters.status);
  }
  return sites;
}

/**
 * ดึง Site เดียวตาม ID
 */
function sitesGetById(token, siteId) {
  requireAuth(token, 'canRead');
  const site = dbGetById(CONFIG.SHEETS.SITES, 'site_id', siteId);
  if (!site) throw new Error(`Site ไม่พบ: ${siteId}`);
  return site;
}

/**
 * สร้าง Site ใหม่
 * @param {string} token
 * @param {Object} data
 */
function sitesCreate(token, data) {
  requireAuth(token, 'canWrite');

  const schema = {
    site_code: { required: true, type: 'string', maxLength: 20 },
    site_name: { required: true, type: 'string', maxLength: 100 },
    province:  { required: true, type: 'string' },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Validation: ' + errors.join(', '));

  // ตรวจ duplicate site_code
  if (dbExists(CONFIG.SHEETS.SITES, { site_code: data.site_code })) {
    throw new Error(`site_code ซ้ำ: "${data.site_code}"`);
  }

  const site = {
    site_id:       generateId(CONFIG.ID_PREFIX.SITE),
    site_code:     data.site_code.trim().toUpperCase(),
    site_name:     data.site_name.trim(),
    site_type:     data.site_type || '',
    address:       data.address || '',
    district:      data.district || '',
    province:      data.province.trim(),
    postcode:      data.postcode || '',
    contact_name:  data.contact_name || '',
    contact_phone: data.contact_phone || '',
    contact_email: data.contact_email || '',
    status:        'ACTIVE',
    notes:         data.notes || '',
    created_at:    nowISO(),
    updated_at:    nowISO(),
  };

  dbInsert(CONFIG.SHEETS.SITES, site);
  log('INFO', 'sitesCreate', `Site created: ${site.site_id} (${site.site_code})`);
  return site;
}

/**
 * อัปเดต Site
 */
function sitesUpdate(token, siteId, data) {
  requireAuth(token, 'canWrite');

  const existing = dbGetById(CONFIG.SHEETS.SITES, 'site_id', siteId);
  if (!existing) throw new Error(`Site ไม่พบ: ${siteId}`);

  const allowedFields = [
    'site_name', 'site_type', 'address', 'district', 'province',
    'postcode', 'contact_name', 'contact_phone', 'contact_email',
    'status', 'notes',
  ];
  const updates = Object.fromEntries(
    Object.entries(data).filter(([k]) => allowedFields.includes(k))
  );

  if (updates.status && !isValidEnum(updates.status, CONFIG.ENUMS.SITE_STATUS)) {
    throw new Error(`status ไม่ถูกต้อง: ${updates.status}`);
  }

  dbUpdate(CONFIG.SHEETS.SITES, 'site_id', siteId, updates);
  return { ...existing, ...updates };
}

/**
 * Deactivate Site (soft delete)
 */
function sitesDeactivate(token, siteId) {
  requireAuth(token, 'canDelete');
  return sitesUpdate(token, siteId, { status: 'INACTIVE' });
}


// ============================================================
// ── METERS API ─────────────────────────────────────────────
// ============================================================

/**
 * ดึง Meters ทั้งหมด (กรองตาม site ได้)
 */
function metersGetAll(token, filters = {}) {
  const user = requireAuth(token, 'canRead');
  let meters = dbGetAll(CONFIG.SHEETS.METERS);

  if (filters.site_id) {
    if (!canAccessSite(user, filters.site_id)) {
      throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${filters.site_id}`);
    }
    meters = meters.filter(m => m.site_id === filters.site_id);
  } else {
    // กรองตาม site_access ของ user
    if (user.role !== 'ADMIN' && user.site_access !== 'ALL') {
      const allowed = String(user.site_access).split(',').map(s => s.trim());
      meters = meters.filter(m => allowed.includes(m.site_id));
    }
  }

  if (filters.meter_type) {
    meters = meters.filter(m => m.meter_type === filters.meter_type);
  }
  if (filters.status) {
    meters = meters.filter(m => m.status === filters.status);
  }

  return meters;
}

/**
 * ดึง Meter เดียวตาม ID
 */
function metersGetById(token, meterId) {
  requireAuth(token, 'canRead');
  const meter = dbGetById(CONFIG.SHEETS.METERS, 'meter_id', meterId);
  if (!meter) throw new Error(`Meter ไม่พบ: ${meterId}`);
  return meter;
}

/**
 * สร้าง Meter ใหม่
 */
function metersCreate(token, data) {
  const user = requireAuth(token, 'canWrite');

  const schema = {
    site_id:      { required: true, type: 'string' },
    meter_number: { required: true, type: 'string' },
    meter_type:   { required: true, enum: CONFIG.ENUMS.METER_TYPE },
    provider:     { required: true, enum: CONFIG.ENUMS.PROVIDER },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Validation: ' + errors.join(', '));

  // ตรวจสอบ site มีอยู่จริง
  const site = dbGetById(CONFIG.SHEETS.SITES, 'site_id', data.site_id);
  if (!site) throw new Error(`Site ไม่พบ: ${data.site_id}`);
  if (!canAccessSite(user, data.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${data.site_id}`);
  }

  // ตรวจ duplicate meter_number ภายใน site เดียวกัน
  if (dbExists(CONFIG.SHEETS.METERS, {
    site_id: data.site_id,
    meter_number: data.meter_number,
  })) {
    throw new Error(`meter_number "${data.meter_number}" มีอยู่แล้วใน site นี้`);
  }

  const meter = {
    meter_id:        generateId(CONFIG.ID_PREFIX.METER),
    site_id:         data.site_id,
    meter_number:    data.meter_number.trim(),
    meter_type:      data.meter_type,
    provider:        data.provider,
    meter_name:      data.meter_name || `${data.meter_type}-${data.meter_number}`,
    location_detail: data.location_detail || '',
    rate_type:       data.rate_type || '',
    contract_number: data.contract_number || '',
    install_date:    data.install_date || '',
    status:          'ACTIVE',
    notes:           data.notes || '',
    created_at:      nowISO(),
    updated_at:      nowISO(),
  };

  dbInsert(CONFIG.SHEETS.METERS, meter);
  log('INFO', 'metersCreate', `Meter created: ${meter.meter_id}`);
  return meter;
}

/**
 * อัปเดต Meter
 */
function metersUpdate(token, meterId, data) {
  requireAuth(token, 'canWrite');
  const existing = dbGetById(CONFIG.SHEETS.METERS, 'meter_id', meterId);
  if (!existing) throw new Error(`Meter ไม่พบ: ${meterId}`);

  const allowedFields = [
    'meter_name', 'location_detail', 'rate_type',
    'contract_number', 'status', 'notes',
  ];
  const updates = Object.fromEntries(
    Object.entries(data).filter(([k]) => allowedFields.includes(k))
  );

  if (updates.status && !isValidEnum(updates.status, CONFIG.ENUMS.METER_STATUS)) {
    throw new Error(`status ไม่ถูกต้อง: ${updates.status}`);
  }

  dbUpdate(CONFIG.SHEETS.METERS, 'meter_id', meterId, updates);
  return { ...existing, ...updates };
}


// ============================================================
// ── BILLS API ──────────────────────────────────────────────
// ============================================================

/**
 * ดึง Bills (กรองหลายแบบ)
 */
function billsGetAll(token, filters = {}) {
  const user = requireAuth(token, 'canRead');
  let bills = dbGetAll(CONFIG.SHEETS.BILLS);

  // กรองตาม site_access
  if (user.role !== 'ADMIN' && user.site_access !== 'ALL') {
    const allowed = String(user.site_access).split(',').map(s => s.trim());
    bills = bills.filter(b => allowed.includes(b.site_id));
  }

  if (filters.site_id)       bills = bills.filter(b => b.site_id === filters.site_id);
  if (filters.meter_id)      bills = bills.filter(b => b.meter_id === filters.meter_id);
  if (filters.bill_status)   bills = bills.filter(b => b.bill_status === filters.bill_status);
  if (filters.bill_year)     bills = bills.filter(b => String(b.bill_year) === String(filters.bill_year));
  if (filters.bill_month)    bills = bills.filter(b => String(b.bill_month) === String(filters.bill_month));
  if (filters.needs_review)  bills = bills.filter(b => String(b.needs_review) === 'TRUE');

  // เรียงตาม period_key ล่าสุดก่อน
  bills.sort((a, b) => String(b.bill_period_key).localeCompare(String(a.bill_period_key)));
  return bills;
}

/**
 * ดึง Bill เดียว
 */
function billsGetById(token, billId) {
  requireAuth(token, 'canRead');
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!bill) throw new Error(`Bill ไม่พบ: ${billId}`);
  return bill;
}

/**
 * สร้าง Bill ใหม่ (manual entry)
 */
function billsCreate(token, data) {
  const user = requireAuth(token, 'canWrite');

  const schema = {
    meter_id:     { required: true, type: 'string' },
    bill_year:    { required: true, type: 'number' },
    bill_month:   { required: true, type: 'number' },
    amount_total: { required: true, type: 'number' },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Validation: ' + errors.join(', '));

  // ตรวจสอบ meter มีอยู่จริง
  const meter = dbGetById(CONFIG.SHEETS.METERS, 'meter_id', data.meter_id);
  if (!meter) throw new Error(`Meter ไม่พบ: ${data.meter_id}`);

  if (!canAccessSite(user, meter.site_id)) {
    throw new Error(`FORBIDDEN: ไม่มีสิทธิ์เข้าถึง site: ${meter.site_id}`);
  }

  // ตรวจ duplicate: meter_id + year + month ต้องไม่ซ้ำ
  if (dbExists(CONFIG.SHEETS.BILLS, {
    meter_id:   data.meter_id,
    bill_year:  String(data.bill_year),
    bill_month: String(data.bill_month),
  })) {
    throw new Error(`บิลซ้ำ: ${data.meter_id} เดือน ${data.bill_month}/${data.bill_year} มีอยู่แล้ว`);
  }

  const amountTotal = parseNumber(data.amount_total);
  const amountBase  = parseNumber(data.amount_base || 0);
  const amountFt    = parseNumber(data.amount_ft || 0);
  const amountVat   = parseNumber(data.amount_vat || 0);

  const bill = {
    bill_id:          generateId(CONFIG.ID_PREFIX.BILL),
    meter_id:         data.meter_id,
    site_id:          meter.site_id,         // denormalize
    bill_year:        parseInt(data.bill_year),
    bill_month:       parseInt(data.bill_month),
    bill_period_key:  makePeriodKey(data.bill_year, data.bill_month),
    units_before:     parseNumber(data.units_before || 0),
    units_after:      parseNumber(data.units_after || 0),
    units_used:       parseNumber(data.units_used || 0),
    amount_base:      amountBase,
    amount_ft:        amountFt,
    amount_vat:       amountVat,
    amount_total:     amountTotal,
    reading_date_from: parseDateStr(data.reading_date_from) || '',
    reading_date_to:   parseDateStr(data.reading_date_to) || '',
    due_date:         parseDateStr(data.due_date) || '',
    bill_status:      'APPROVED',            // manual entry = pre-approved
    needs_review:     false,
    pdf_file_id:      data.pdf_file_id || '',
    pdf_confidence:   data.pdf_confidence || 100,
    source:           data.source || 'MANUAL',
    notes:            data.notes || '',
    created_by:       user.email,
    created_at:       nowISO(),
    updated_at:       nowISO(),
  };

  dbInsert(CONFIG.SHEETS.BILLS, bill);
  log('INFO', 'billsCreate', `Bill created: ${bill.bill_id}`);
  return bill;
}

/**
 * Approve bill (เปลี่ยน status จาก PENDING_REVIEW → APPROVED)
 */
function billsApprove(token, billId) {
  requireAuth(token, 'canApprove');
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!bill) throw new Error(`Bill ไม่พบ: ${billId}`);
  if (bill.bill_status !== 'PENDING_REVIEW') {
    throw new Error(`Bill status ปัจจุบันคือ "${bill.bill_status}" ไม่สามารถ approve ได้`);
  }
  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, {
    bill_status:  'APPROVED',
    needs_review: false,
  });
  return { ...bill, bill_status: 'APPROVED', needs_review: false };
}

/**
 * อัปเดต Bill (เฉพาะ field ที่อนุญาต)
 */
function billsUpdate(token, billId, data) {
  requireAuth(token, 'canWrite');
  const existing = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!existing) throw new Error(`Bill ไม่พบ: ${billId}`);

  // ห้ามแก้ PAID bill
  if (existing.bill_status === 'PAID') {
    throw new Error('ไม่สามารถแก้ไขบิลที่ชำระเงินแล้ว');
  }

  const allowedFields = [
    'units_before', 'units_after', 'units_used',
    'amount_base', 'amount_ft', 'amount_vat', 'amount_total',
    'reading_date_from', 'reading_date_to', 'due_date',
    'bill_status', 'notes',
  ];
  const updates = Object.fromEntries(
    Object.entries(data).filter(([k]) => allowedFields.includes(k))
  );

  if (updates.bill_status && !isValidEnum(updates.bill_status, CONFIG.ENUMS.BILL_STATUS)) {
    throw new Error(`bill_status ไม่ถูกต้อง: ${updates.bill_status}`);
  }

  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, updates);
  return { ...existing, ...updates };
}

/**
 * ยกเลิก Bill
 */
function billsCancel(token, billId, reason) {
  requireAuth(token, 'canDelete');
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!bill) throw new Error(`Bill ไม่พบ: ${billId}`);
  if (bill.bill_status === 'PAID') {
    throw new Error('ไม่สามารถยกเลิกบิลที่ชำระเงินแล้ว');
  }
  return billsUpdate(token, billId, {
    bill_status: 'CANCELLED',
    notes: `[CANCELLED] ${reason || ''} — ${nowISO()}`,
  });
}

/**
 * ดึง Bills ที่ใกล้ Due Date (ใช้ใน Email Notification)
 * @param {number} [withinDays=3] - แจ้งเตือนภายในกี่วัน
 */
function billsGetDueSoon(withinDays = CONFIG.EMAIL.OVERDUE_DAYS) {
  const today = todayDateStr();
  const bills = dbGetAll(CONFIG.SHEETS.BILLS);

  return bills.filter(b => {
    if (b.bill_status !== 'APPROVED' || !b.due_date) return false;
    const days = daysBetween(today, b.due_date);
    return days >= 0 && days <= withinDays;
  });
}

/**
 * ดึง Bills ที่เลย Due Date แล้ว (overdue)
 */
function billsGetOverdue() {
  const today = todayDateStr();
  const bills = dbGetAll(CONFIG.SHEETS.BILLS);

  return bills.filter(b => {
    if (!['APPROVED', 'PENDING_REVIEW'].includes(b.bill_status) || !b.due_date) return false;
    return daysBetween(today, b.due_date) < 0;
  });
}


// ============================================================
// ── PAYMENTS API ───────────────────────────────────────────
// ============================================================

/**
 * ดึง Payments ทั้งหมด (กรองได้)
 */
function paymentsGetAll(token, filters = {}) {
  requireAuth(token, 'canRead');
  let payments = dbGetAll(CONFIG.SHEETS.BILL_PAYMENTS);
  if (filters.bill_id)  payments = payments.filter(p => p.bill_id === filters.bill_id);
  if (filters.site_id)  payments = payments.filter(p => p.site_id === filters.site_id);
  return payments;
}

/**
 * บันทึกการชำระเงิน
 * อัปเดต Bill status → PAID อัตโนมัติ
 */
function paymentsCreate(token, data) {
  const user = requireAuth(token, 'canWrite');

  const schema = {
    bill_id:        { required: true, type: 'string' },
    amount_paid:    { required: true, type: 'number' },
    payment_date:   { required: true, type: 'string' },
    payment_method: { required: true, enum: CONFIG.ENUMS.PAY_METHOD },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Validation: ' + errors.join(', '));

  // ตรวจสอบ bill
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', data.bill_id);
  if (!bill) throw new Error(`Bill ไม่พบ: ${data.bill_id}`);
  if (bill.bill_status === 'PAID') throw new Error('บิลนี้ชำระเงินแล้ว');
  if (bill.bill_status === 'CANCELLED') throw new Error('ไม่สามารถชำระบิลที่ยกเลิกแล้ว');

  // ตรวจสอบ account (ถ้ามี)
  if (data.account_id) {
    const account = dbGetById(CONFIG.SHEETS.ACCOUNTS, 'account_id', data.account_id);
    if (!account) throw new Error(`Account ไม่พบ: ${data.account_id}`);
  }

  const payment = {
    payment_id:       generateId(CONFIG.ID_PREFIX.PAYMENT),
    bill_id:          data.bill_id,
    meter_id:         bill.meter_id,
    site_id:          bill.site_id,
    amount_paid:      parseNumber(data.amount_paid),
    payment_date:     parseDateStr(data.payment_date) || data.payment_date,
    payment_method:   data.payment_method,
    account_id:       data.account_id || '',
    reference_number: data.reference_number || '',
    receipt_file_id:  data.receipt_file_id || '',
    notes:            data.notes || '',
    created_by:       user.email,
    created_at:       nowISO(),
  };

  dbInsert(CONFIG.SHEETS.BILL_PAYMENTS, payment);

  // อัปเดต Bill เป็น PAID
  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', data.bill_id, {
    bill_status: 'PAID',
  });

  log('INFO', 'paymentsCreate', `Payment: ${payment.payment_id} → Bill: ${data.bill_id}`);
  return payment;
}

/**
 * ดึงรายการ Bank Accounts
 */
function accountsGetAll(token) {
  requireAuth(token, 'canRead');
  return dbGetAll(CONFIG.SHEETS.ACCOUNTS).filter(a => String(a.is_active) !== 'false' && a.is_active !== false);
}

/**
 * สร้าง Bank Account
 */
function accountsCreate(token, data) {
  requireAuth(token, 'canWrite');

  const schema = {
    account_name:   { required: true, type: 'string' },
    bank_name:      { required: true, type: 'string' },
    account_number: { required: true, type: 'string' },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Validation: ' + errors.join(', '));

  const account = {
    account_id:     generateId(CONFIG.ID_PREFIX.ACCOUNT),
    account_name:   data.account_name.trim(),
    bank_name:      data.bank_name.trim(),
    account_number: data.account_number.trim(),
    account_type:   data.account_type || 'SAVINGS',
    is_active:      true,
    notes:          data.notes || '',
    created_at:     nowISO(),
  };

  dbInsert(CONFIG.SHEETS.ACCOUNTS, account);
  return account;
}


// ============================================================
// ── ADVANCES API ───────────────────────────────────────────
// ============================================================

/**
 * ดึง Advances ทั้งหมด
 */
function advancesGetAll(token, filters = {}) {
  requireAuth(token, 'canRead');
  let advances = dbGetAll(CONFIG.SHEETS.ADVANCES);
  if (filters.status)  advances = advances.filter(a => a.status === filters.status);
  if (filters.site_id) advances = advances.filter(a => a.site_id === filters.site_id);
  return advances;
}

/**
 * สร้างคำขอเงินสำรอง
 */
function advancesCreate(token, data) {
  const user = requireAuth(token, 'canWrite');

  const schema = {
    site_id:          { required: true, type: 'string' },
    amount_requested: { required: true, type: 'number' },
    purpose:          { required: true, type: 'string' },
    advance_date:     { required: true, type: 'string' },
  };
  const { valid, errors } = validateSchema(data, schema);
  if (!valid) throw new Error('Validation: ' + errors.join(', '));

  const site = dbGetById(CONFIG.SHEETS.SITES, 'site_id', data.site_id);
  if (!site) throw new Error(`Site ไม่พบ: ${data.site_id}`);

  const amount = parseNumber(data.amount_requested);
  const advance = {
    advance_id:       generateId(CONFIG.ID_PREFIX.ADVANCE),
    site_id:          data.site_id,
    requested_by:     user.email,
    approved_by:      '',
    amount_requested: amount,
    amount_used:      0,
    amount_remaining: amount,
    purpose:          data.purpose.trim(),
    advance_date:     parseDateStr(data.advance_date) || data.advance_date,
    due_settle_date:  parseDateStr(data.due_settle_date) || '',
    settled_date:     '',
    status:           'PENDING',
    notes:            data.notes || '',
    created_at:       nowISO(),
    updated_at:       nowISO(),
  };

  dbInsert(CONFIG.SHEETS.ADVANCES, advance);
  log('INFO', 'advancesCreate', `Advance created: ${advance.advance_id}`);
  return advance;
}

/**
 * Approve เงินสำรอง (ADMIN only)
 */
function advancesApprove(token, advanceId) {
  const user = requireAuth(token, 'canApprove');
  const advance = dbGetById(CONFIG.SHEETS.ADVANCES, 'advance_id', advanceId);
  if (!advance) throw new Error(`Advance ไม่พบ: ${advanceId}`);
  if (advance.status !== 'PENDING') {
    throw new Error(`Advance status ปัจจุบันคือ "${advance.status}"`);
  }
  dbUpdate(CONFIG.SHEETS.ADVANCES, 'advance_id', advanceId, {
    status:      'APPROVED',
    approved_by: user.email,
  });
  return { ...advance, status: 'APPROVED', approved_by: user.email };
}

/**
 * Settle เงินสำรอง (บันทึกการคืนเงิน/ใช้จ่าย)
 */
function advancesSettle(token, advanceId, data) {
  requireAuth(token, 'canWrite');
  const advance = dbGetById(CONFIG.SHEETS.ADVANCES, 'advance_id', advanceId);
  if (!advance) throw new Error(`Advance ไม่พบ: ${advanceId}`);
  if (advance.status !== 'APPROVED') {
    throw new Error('ต้อง Approve ก่อนจึงจะ Settle ได้');
  }

  const amountUsed = parseNumber(data.amount_used || advance.amount_requested);
  const remaining  = parseNumber(advance.amount_requested) - amountUsed;

  dbUpdate(CONFIG.SHEETS.ADVANCES, 'advance_id', advanceId, {
    status:           'SETTLED',
    amount_used:      amountUsed,
    amount_remaining: remaining,
    settled_date:     parseDateStr(data.settled_date) || todayDateStr(),
    notes:            data.notes || advance.notes,
  });

  return dbGetById(CONFIG.SHEETS.ADVANCES, 'advance_id', advanceId);
}
