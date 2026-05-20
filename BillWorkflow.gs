// ============================================================
// BillWorkflow.gs — Bill Status Workflow & Approval Flow
// UtilityManager | PHASE 2 — Bills Module
// ============================================================
// รับผิดชอบ: จัดการ state machine ของ bill_status
//   PENDING_REVIEW → APPROVED → PAID
//                 ↘ CANCELLED
//                            ↘ OVERDUE (auto by trigger)
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs, Auth.gs,
//               BillValidator.gs
// ============================================================


// ============================================================
// SECTION 1 — STATUS TRANSITION MATRIX
// กำหนดว่า status ไหนสามารถเปลี่ยนไปเป็นอะไรได้บ้าง
// และต้องการสิทธิ์อะไร
// ============================================================

/**
 * Transition Matrix
 * key   = status ปัจจุบัน
 * value = { to: status ปลายทาง, permission: สิทธิ์ที่ต้องการ, label: ชื่อ action }
 */
const BILL_TRANSITIONS = {
  PENDING_REVIEW: [
    { to: 'APPROVED',   permission: 'canApprove', label: 'Approve'  },
    { to: 'CANCELLED',  permission: 'canDelete',  label: 'ยกเลิก'  },
  ],
  APPROVED: [
    { to: 'PAID',       permission: 'canWrite',   label: 'ชำระเงิน' },
    { to: 'OVERDUE',    permission: 'canWrite',   label: 'เลยกำหนด' }, // auto trigger
    { to: 'CANCELLED',  permission: 'canDelete',  label: 'ยกเลิก'  },
  ],
  OVERDUE: [
    { to: 'PAID',       permission: 'canWrite',   label: 'ชำระเงิน' },
    { to: 'CANCELLED',  permission: 'canDelete',  label: 'ยกเลิก'  },
  ],
  PAID:      [],   // terminal state — ไม่สามารถเปลี่ยนได้
  CANCELLED: [],   // terminal state — ไม่สามารถเปลี่ยนได้
};


// ============================================================
// SECTION 2 — TRANSITION VALIDATOR
// ตรวจสอบว่าการเปลี่ยน status นั้น valid หรือไม่
// ============================================================

/**
 * ตรวจสอบว่าสามารถเปลี่ยน status ได้หรือไม่
 *
 * @param {string} fromStatus  — status ปัจจุบัน
 * @param {string} toStatus    — status ที่ต้องการเปลี่ยนไป
 * @param {Object} user        — user object จาก requireAuth()
 * @returns {{ valid: boolean, error: string|null }}
 */
function canTransitionBill(fromStatus, toStatus, user) {
  const allowedTransitions = BILL_TRANSITIONS[fromStatus] || [];
  const transition = allowedTransitions.find(t => t.to === toStatus);

  if (!transition) {
    return {
      valid: false,
      error: `ไม่สามารถเปลี่ยนสถานะจาก "${fromStatus}" ไปเป็น "${toStatus}" ได้`,
    };
  }

  const perms = PERMISSIONS[user.role] || {};
  if (!perms[transition.permission]) {
    return {
      valid: false,
      error: `Role "${user.role}" ไม่มีสิทธิ์ดำเนินการ: ${transition.label}`,
    };
  }

  return { valid: true, error: null };
}

/**
 * คืนรายการ transitions ที่ทำได้สำหรับ user คนนี้
 * ใช้สร้าง UI button ที่ถูกต้อง
 *
 * @param {string} currentStatus
 * @param {Object} user
 * @returns {{ to: string, label: string }[]}
 */
function getAvailableTransitions(currentStatus, user) {
  const allowed = BILL_TRANSITIONS[currentStatus] || [];
  const perms   = PERMISSIONS[user.role] || {};
  return allowed.filter(t => perms[t.permission]).map(t => ({ to: t.to, label: t.label }));
}


// ============================================================
// SECTION 3 — WORKFLOW ACTIONS
// ฟังก์ชัน action แต่ละประเภท พร้อม audit trail
// ============================================================

/**
 * Approve bill — เปลี่ยน PENDING_REVIEW → APPROVED
 * เรียกโดย ADMIN หรือ user ที่มีสิทธิ์ canApprove
 *
 * @param {string} token
 * @param {string} billId
 * @param {string} [notes]  — หมายเหตุเพิ่มเติม (optional)
 * @returns {Object} bill ที่ updated
 */
function workflowApproveBill(token, billId, notes) {
  const user = requireAuth(token, 'canApprove');
  const bill = _getBillOrThrow(billId);

  const check = canTransitionBill(bill.bill_status, 'APPROVED', user);
  if (!check.valid) throw new Error(check.error);

  const updates = {
    bill_status:  'APPROVED',
    needs_review: false,
    notes:        _appendNote(bill.notes, `[APPROVED by ${user.email}] ${notes || ''}`, user),
  };

  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, updates);
  log('INFO', 'workflowApproveBill', `${billId} → APPROVED by ${user.email}`);

  return { ...bill, ...updates };
}

/**
 * Cancel bill — เปลี่ยนเป็น CANCELLED (soft)
 * ไม่ลบข้อมูล — เก็บไว้ใน sheet พร้อม reason
 *
 * @param {string} token
 * @param {string} billId
 * @param {string} reason  — เหตุผลการยกเลิก (บังคับ)
 * @returns {Object} bill ที่ updated
 */
function workflowCancelBill(token, billId, reason) {
  const user = requireAuth(token, 'canDelete');
  if (!reason || String(reason).trim() === '') {
    throw new Error('กรุณาระบุเหตุผลการยกเลิก');
  }

  const bill = _getBillOrThrow(billId);

  const check = canTransitionBill(bill.bill_status, 'CANCELLED', user);
  if (!check.valid) throw new Error(check.error);

  const updates = {
    bill_status: 'CANCELLED',
    notes:       _appendNote(bill.notes, `[CANCELLED by ${user.email}] เหตุผล: ${reason}`, user),
  };

  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, updates);
  log('INFO', 'workflowCancelBill', `${billId} → CANCELLED by ${user.email}. เหตุผล: ${reason}`);

  return { ...bill, ...updates };
}

/**
 * Mark bill as PAID — เรียกอัตโนมัติจาก paymentsCreate() ใน BillService
 * ไม่ expose โดยตรงผ่าน API (ใช้ payments.create แทน)
 *
 * @param {string} billId
 * @param {string} paymentId  — FK อ้างอิง payment ที่เกิดขึ้น
 * @param {string} paidByEmail
 * @returns {boolean}
 */
function workflowMarkPaid(billId, paymentId, paidByEmail) {
  const bill = _getBillOrThrow(billId);

  // ใช้ system user สำหรับ auto transition
  const systemUser = { role: 'ADMIN', email: paidByEmail || 'system' };
  const check = canTransitionBill(bill.bill_status, 'PAID', systemUser);
  if (!check.valid) throw new Error(check.error);

  const updates = {
    bill_status: 'PAID',
    notes:       _appendNote(bill.notes, `[PAID] payment_id: ${paymentId}`, systemUser),
  };

  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, updates);
  log('INFO', 'workflowMarkPaid', `${billId} → PAID, payment: ${paymentId}`);
  return true;
}

/**
 * Mark bill as OVERDUE — เรียกโดย Time-driven Trigger
 * ตรวจบิลที่เลย due_date แล้วยังไม่ชำระ
 *
 * @returns {{ marked: number, billIds: string[] }}
 */
function workflowMarkOverdue() {
  const today  = todayDateStr();
  const bills  = dbGetAll(CONFIG.SHEETS.BILLS);
  const marked = [];

  bills.forEach(bill => {
    // เฉพาะ APPROVED ที่มี due_date และเลยกำหนดแล้ว
    if (bill.bill_status !== 'APPROVED') return;
    if (!bill.due_date) return;
    if (daysBetween(today, bill.due_date) >= 0) return; // ยังไม่เลย

    dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', bill.bill_id, {
      bill_status: 'OVERDUE',
      notes:       _appendNote(bill.notes, `[OVERDUE] เลยกำหนดชำระวันที่ ${bill.due_date}`, { email: 'system' }),
    });
    marked.push(bill.bill_id);
  });

  log('INFO', 'workflowMarkOverdue', `Marked ${marked.length} bills as OVERDUE`);
  return { marked: marked.length, billIds: marked };
}

/**
 * Reopen bill — เปลี่ยน OVERDUE กลับเป็น APPROVED
 * กรณี due_date ถูกขยายออกไปหรือ error ในระบบ
 * ADMIN only
 *
 * @param {string} token
 * @param {string} billId
 * @param {string} reason
 * @returns {Object} bill ที่ updated
 */
function workflowReopenBill(token, billId, reason) {
  const user = requireAuth(token, 'canApprove');
  if (user.role !== 'ADMIN') throw new Error('เฉพาะ ADMIN เท่านั้นที่ reopen bill ได้');
  if (!reason || String(reason).trim() === '') throw new Error('กรุณาระบุเหตุผลการ reopen');

  const bill = _getBillOrThrow(billId);
  if (bill.bill_status !== 'OVERDUE') {
    throw new Error(`Reopen ได้เฉพาะบิลที่มีสถานะ OVERDUE (ปัจจุบัน: ${bill.bill_status})`);
  }

  const updates = {
    bill_status: 'APPROVED',
    notes:       _appendNote(bill.notes, `[REOPENED by ${user.email}] ${reason}`, user),
  };

  dbUpdate(CONFIG.SHEETS.BILLS, 'bill_id', billId, updates);
  log('INFO', 'workflowReopenBill', `${billId} OVERDUE → APPROVED by ${user.email}`);
  return { ...bill, ...updates };
}


// ============================================================
// SECTION 4 — APPROVAL QUEUE
// จัดการ queue บิลที่รอ review / approve
// ============================================================

/**
 * ดึงรายการบิลที่รอ review ทั้งหมด
 * เรียงลำดับตาม: HIGH confidence ก่อน (เพื่อ approve เร็ว)
 *
 * @param {string} token
 * @param {Object} [filters]
 * @param {string} [filters.site_id]
 * @returns {Object[]}
 */
function workflowGetPendingReview(token, filters = {}) {
  const user = requireAuth(token, 'canRead');
  let bills = dbFind(CONFIG.SHEETS.BILLS, { bill_status: 'PENDING_REVIEW' });

  // กรองตาม site_access
  if (user.role !== 'ADMIN' && user.site_access !== 'ALL') {
    const allowed = String(user.site_access).split(',').map(s => s.trim());
    bills = bills.filter(b => allowed.includes(b.site_id));
  }

  if (filters.site_id) {
    bills = bills.filter(b => b.site_id === filters.site_id);
  }

  // เรียง: confidence สูงก่อน (เชื่อถือได้มากกว่า → approve ง่าย)
  bills.sort((a, b) => parseNumber(b.pdf_confidence) - parseNumber(a.pdf_confidence));

  return bills;
}

/**
 * Bulk approve — อนุมัติหลายบิลพร้อมกัน
 * สำหรับ Admin ที่ต้องการ process queue เร็วๆ
 *
 * @param {string}   token
 * @param {string[]} billIds
 * @returns {{ approved: string[], failed: { id: string, error: string }[] }}
 */
function workflowBulkApprove(token, billIds) {
  requireAuth(token, 'canApprove');

  const approved = [];
  const failed   = [];

  billIds.forEach(billId => {
    try {
      workflowApproveBill(token, billId);
      approved.push(billId);
    } catch (e) {
      failed.push({ id: billId, error: e.message });
      log('WARN', 'workflowBulkApprove', `ข้าม ${billId}: ${e.message}`);
    }
  });

  log('INFO', 'workflowBulkApprove',
    `Bulk approved: ${approved.length} สำเร็จ, ${failed.length} ล้มเหลว`
  );
  return { approved, failed };
}

/**
 * ดึงสถิติ workflow — ใช้ใน Dashboard
 *
 * @param {string} token
 * @returns {Object} summary counts by status
 */
function workflowGetStatusSummary(token) {
  requireAuth(token, 'canRead');
  const bills = dbGetAll(CONFIG.SHEETS.BILLS);

  const summary = {
    PENDING_REVIEW: 0,
    APPROVED:       0,
    PAID:           0,
    OVERDUE:        0,
    CANCELLED:      0,
    total:          0,
  };

  bills.forEach(b => {
    if (summary[b.bill_status] !== undefined) summary[b.bill_status]++;
    summary.total++;
  });

  // คำนวณ payment rate
  summary.payment_rate = summary.total > 0
    ? ((summary.PAID / summary.total) * 100).toFixed(1) + '%'
    : '0%';

  return summary;
}


// ============================================================
// SECTION 5 — INTERNAL HELPERS
// ============================================================

/**
 * ดึง bill หรือ throw ถ้าไม่พบ
 * @private
 */
function _getBillOrThrow(billId) {
  const bill = dbGetById(CONFIG.SHEETS.BILLS, 'bill_id', billId);
  if (!bill) throw new Error(`ไม่พบบิล: "${billId}"`);
  return bill;
}

/**
 * เพิ่ม note ใหม่ต่อท้าย notes เดิม พร้อม timestamp
 * format: "[2025-06-15 08:30] note text"
 * @private
 */
function _appendNote(existingNotes, newNote, user) {
  const ts        = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  const noteEntry = `[${ts}] ${newNote}`.trim();
  const current   = String(existingNotes || '').trim();
  return current ? `${current}\n${noteEntry}` : noteEntry;
}
