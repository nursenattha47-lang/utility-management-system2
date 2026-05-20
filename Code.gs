// ============================================================
// Code.gs — HTTP Entry Point (doGet / doPost)
// UtilityManager | PHASE 2 — Backend Foundation
// ============================================================
// ไฟล์นี้รับ HTTP request ทั้งหมด และ route ไปยัง handler
// ทุก response กลับเป็น JSON เสมอ
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs, Auth.gs, API.gs
// ============================================================


// ============================================================
// SECTION 1 — HTTP GET HANDLER
// ============================================================

/**
 * doGet — สำหรับ request ที่ไม่ต้องการ body
 * ใช้ query params แทน: ?action=xxx&token=yyy&param=zzz
 *
 * Actions: ping, login, sites.list, meters.list, bills.list,
 *          payments.list, accounts.list, advances.list, users.list
 */
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || '';
    const token  = params.token || '';

    log('INFO', 'doGet', `action=${action}`);

    switch (action) {

      // ---- System ----
      case 'ping':
        return buildResponse(true, { message: 'pong', version: '2.0' });

      case 'login':
        const loginResult = loginCurrentUser();
        return buildResponse(true, loginResult, 'Login สำเร็จ');

      case 'logout':
        destroySession(token);
        return buildResponse(true, null, 'Logout สำเร็จ');

      case 'me':
        const me = getSessionUser(token);
        return buildResponse(true, me);

      // ---- Sites ----
      case 'sites.list':
        return buildResponse(true, sitesGetAll(token, {
          status: params.status || undefined,
        }));

      case 'sites.get':
        return buildResponse(true, sitesGetById(token, params.site_id));

      // ---- Meters ----
      case 'meters.list':
        return buildResponse(true, metersGetAll(token, {
          site_id:    params.site_id    || undefined,
          meter_type: params.meter_type || undefined,
          status:     params.status     || undefined,
        }));

      case 'meters.get':
        return buildResponse(true, metersGetById(token, params.meter_id));

      // ---- Bills ----
      case 'bills.list':
        return buildResponse(true, billsGetAll(token, {
          site_id:      params.site_id      || undefined,
          meter_id:     params.meter_id     || undefined,
          bill_status:  params.bill_status  || undefined,
          bill_year:    params.bill_year    || undefined,
          bill_month:   params.bill_month   || undefined,
          needs_review: params.needs_review || undefined,
        }));

      case 'bills.get':
        return buildResponse(true, billsGetById(token, params.bill_id));

      case 'bills.due_soon':
        return buildResponse(true, billsGetDueSoon(parseInt(params.days || CONFIG.EMAIL.OVERDUE_DAYS)));

      case 'bills.overdue':
        return buildResponse(true, billsGetOverdue());

      // ---- Payments ----
      case 'payments.list':
        return buildResponse(true, paymentsGetAll(token, {
          bill_id: params.bill_id || undefined,
          site_id: params.site_id || undefined,
        }));

      case 'accounts.list':
        return buildResponse(true, accountsGetAll(token));

      // ---- Advances ----
      case 'advances.list':
        return buildResponse(true, advancesGetAll(token, {
          status:  params.status  || undefined,
          site_id: params.site_id || undefined,
        }));

      // ---- Users (ADMIN) ----
      case 'users.list':
        requireAuth(token, 'canManageUsers');
        return buildResponse(true, listUsers());

      // ---- Audit Log (ADMIN) ----
      case 'audit.list':
        requireAuth(token, 'canViewAudit');
        const auditRows = dbGetAll(CONFIG.SHEETS.AUDIT_LOG);
        const limit = parseInt(params.limit || 200);
        return buildResponse(true, auditRows.slice(-limit).reverse());

      default:
        return buildError(`Unknown action: "${action}"`, 404);
    }

  } catch (err) {
    log('ERROR', 'doGet', err.message);
    const statusCode = err.message.startsWith('UNAUTHORIZED') ? 401
                     : err.message.startsWith('FORBIDDEN')    ? 403
                     : 400;
    return buildError(err.message, statusCode);
  }
}


// ============================================================
// SECTION 2 — HTTP POST HANDLER
// ============================================================

/**
 * doPost — สำหรับ mutation (create, update, delete)
 * Body: JSON { action, token, data }
 */
function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData?.contents || '{}');
  } catch (err) {
    return buildError('Invalid JSON body', 400);
  }

  const { action = '', token = '', data = {} } = body;

  try {
    log('INFO', 'doPost', `action=${action}`);

    switch (action) {

      // ---- Auth ----
      case 'auth.logout':
        destroySession(token);
        return buildResponse(true, null, 'Logout สำเร็จ');

      // ---- Sites ----
      case 'sites.create':
        return buildResponse(true, sitesCreate(token, data), 'สร้าง Site สำเร็จ');

      case 'sites.update':
        _requireField(data, 'site_id');
        return buildResponse(true, sitesUpdate(token, data.site_id, data), 'อัปเดต Site สำเร็จ');

      case 'sites.deactivate':
        _requireField(data, 'site_id');
        return buildResponse(true, sitesDeactivate(token, data.site_id), 'ปิดการใช้งาน Site สำเร็จ');

      // ---- Meters ----
      case 'meters.create':
        return buildResponse(true, metersCreate(token, data), 'สร้าง Meter สำเร็จ');

      case 'meters.update':
        _requireField(data, 'meter_id');
        return buildResponse(true, metersUpdate(token, data.meter_id, data), 'อัปเดต Meter สำเร็จ');

      // ---- Bills ----
      case 'bills.create':
        return buildResponse(true, billsCreate(token, data), 'บันทึก Bill สำเร็จ');

      case 'bills.update':
        _requireField(data, 'bill_id');
        return buildResponse(true, billsUpdate(token, data.bill_id, data), 'อัปเดต Bill สำเร็จ');

      case 'bills.approve':
        _requireField(data, 'bill_id');
        return buildResponse(true, billsApprove(token, data.bill_id), 'Approve Bill สำเร็จ');

      case 'bills.cancel':
        _requireField(data, 'bill_id');
        return buildResponse(true, billsCancel(token, data.bill_id, data.reason), 'ยกเลิก Bill สำเร็จ');

      // ---- Payments ----
      case 'payments.create':
        return buildResponse(true, paymentsCreate(token, data), 'บันทึกการชำระเงินสำเร็จ');

      case 'accounts.create':
        return buildResponse(true, accountsCreate(token, data), 'สร้าง Account สำเร็จ');

      // ---- Advances ----
      case 'advances.create':
        return buildResponse(true, advancesCreate(token, data), 'ส่งคำขอเงินสำรองสำเร็จ');

      case 'advances.approve':
        _requireField(data, 'advance_id');
        return buildResponse(true, advancesApprove(token, data.advance_id), 'Approve เงินสำรองสำเร็จ');

      case 'advances.settle':
        _requireField(data, 'advance_id');
        return buildResponse(true, advancesSettle(token, data.advance_id, data), 'Settle เงินสำรองสำเร็จ');

      // ---- Users (ADMIN) ----
      case 'users.create':
        requireAuth(token, 'canManageUsers');
        return buildResponse(true, createUser(data), 'สร้าง User สำเร็จ');

      case 'users.update':
        requireAuth(token, 'canManageUsers');
        _requireField(data, 'user_id');
        return buildResponse(true, updateUser(data.user_id, data), 'อัปเดต User สำเร็จ');

      // ---- Setup (ADMIN, รันครั้งเดียว) ----
      case 'setup.init_sheets':
        requireAuth(token, 'canManageUsers');
        return buildResponse(true, initializeAllSheets(), 'Initialize Sheets สำเร็จ');

      case 'setup.archive_bills':
        requireAuth(token, 'canManageUsers');
        return buildResponse(true, archiveOldBills(), 'Archive Bills สำเร็จ');

      default:
        return buildError(`Unknown action: "${action}"`, 404);
    }

  } catch (err) {
    log('ERROR', 'doPost', err.message);
    const statusCode = err.message.startsWith('UNAUTHORIZED') ? 401
                     : err.message.startsWith('FORBIDDEN')    ? 403
                     : 400;
    return buildError(err.message, statusCode);
  }
}


// ============================================================
// SECTION 3 — INTERNAL HELPERS
// ============================================================

/**
 * ตรวจสอบว่า data object มี field ที่จำเป็น
 * @private
 */
function _requireField(data, field) {
  if (!data[field]) throw new Error(`Missing required field: ${field}`);
}


// ============================================================
// SECTION 4 — MANUAL TEST RUNNER
// ============================================================

/**
 * ทดสอบ API โดยตรงจาก Apps Script Editor
 * เปลี่ยน action/data แล้วกด Run เพื่อ debug
 */
function _testManual() {
  // ---- ทดสอบ Config ----
  validateConfig();

  // ---- ทดสอบ Sheet Init ----
  // initializeAllSheets();

  // ---- ทดสอบ Create Site ----
  /*
  const testToken = 'YOUR_SESSION_TOKEN';
  const result = sitesCreate(testToken, {
    site_code: 'TEST001',
    site_name: 'สถานที่ทดสอบ',
    province:  'กรุงเทพมหานคร',
    address:   '123 ถ.ทดสอบ',
    contact_name:  'ผู้ติดต่อ A',
    contact_phone: '02-000-0000',
  });
  Logger.log(JSON.stringify(result, null, 2));
  */

  // ---- ทดสอบ Create Meter ----
  /*
  const meterResult = metersCreate(testToken, {
    site_id:      'SITE_xxx',
    meter_number: '12345678',
    meter_type:   'ELECTRICITY',
    provider:     'PEA',
  });
  Logger.log(JSON.stringify(meterResult, null, 2));
  */

  Logger.log('_testManual done');
}
