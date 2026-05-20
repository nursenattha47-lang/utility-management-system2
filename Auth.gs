// ============================================================
// Auth.gs — Authentication & Role-Based Access Control
// UtilityManager | PHASE 2 — Backend Foundation
// ============================================================
// ทุก API endpoint ต้องผ่าน requireAuth() ก่อนเสมอ
// ============================================================
// Dependencies: Config.gs, Utils.gs, Database.gs
// ============================================================


// ============================================================
// SECTION 1 — PERMISSION MATRIX
// ============================================================

const PERMISSIONS = {
  ADMIN: {
    canRead:        true,
    canWrite:       true,
    canDelete:      true,
    canManageUsers: true,
    canExport:      true,
    canViewAudit:   true,
    canApprove:     true,
  },
  EXECUTIVE: {
    canRead:        true,
    canWrite:       false,
    canDelete:      false,
    canManageUsers: false,
    canExport:      true,
    canViewAudit:   false,
    canApprove:     false,
  },
  STAFF: {
    canRead:        true,
    canWrite:       true,
    canDelete:      false,
    canManageUsers: false,
    canExport:      false,
    canViewAudit:   false,
    canApprove:     false,
  },
};


// ============================================================
// SECTION 2 — SESSION MANAGEMENT
// ============================================================

/**
 * สร้าง Session Token สำหรับ user ที่ login สำเร็จ
 * เก็บใน PropertiesService (server-side, ปลอดภัย)
 *
 * @param {string} userEmail
 * @returns {string} session token (UUID)
 */
function createSession(userEmail) {
  const token = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();

  const sessionData = {
    email:   userEmail,
    created: Date.now(),
    expires: Date.now() + (CONFIG.SESSION.EXPIRE_HOURS * 60 * 60 * 1000),
  };

  props.setProperty(CONFIG.SESSION.TOKEN_PREFIX + token, JSON.stringify(sessionData));

  // อัปเดต last_login ใน Users sheet
  const user = _getUserByEmail(userEmail);
  if (user) {
    dbUpdate(CONFIG.SHEETS.USERS, 'user_id', user.user_id, {
      last_login: nowISO(),
    });
  }

  log('INFO', 'createSession', `Session created for: ${userEmail}`);
  return token;
}

/**
 * ตรวจสอบ Session Token
 * คืน session data ถ้า valid, null ถ้า invalid/expired
 *
 * @param {string} token
 * @returns {{ email: string, created: number, expires: number }|null}
 */
function validateSession(token) {
  if (!token) return null;

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(CONFIG.SESSION.TOKEN_PREFIX + token);
  if (!raw) return null;

  let session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  if (Date.now() > session.expires) {
    // ลบ session ที่หมดอายุ
    props.deleteProperty(CONFIG.SESSION.TOKEN_PREFIX + token);
    log('INFO', 'validateSession', `Session expired: ${session.email}`);
    return null;
  }

  return session;
}

/**
 * ยกเลิก Session (logout)
 *
 * @param {string} token
 * @returns {boolean}
 */
function destroySession(token) {
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(CONFIG.SESSION.TOKEN_PREFIX + token);
  log('INFO', 'destroySession', `Session destroyed: ${token.slice(0, 8)}...`);
  return true;
}

/**
 * ลบ session ที่หมดอายุทั้งหมด (Cleanup)
 * เรียกจาก Time-driven Trigger ทุกสัปดาห์
 */
function cleanupExpiredSessions() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  let removed = 0;

  Object.entries(allProps).forEach(([key, val]) => {
    if (!key.startsWith(CONFIG.SESSION.TOKEN_PREFIX)) return;
    try {
      const session = JSON.parse(val);
      if (Date.now() > session.expires) {
        props.deleteProperty(key);
        removed++;
      }
    } catch (e) {
      props.deleteProperty(key); // ลบ corrupt session
      removed++;
    }
  });

  log('INFO', 'cleanupExpiredSessions', `Removed ${removed} expired sessions`);
  return { removed };
}


// ============================================================
// SECTION 3 — AUTHENTICATION
// ============================================================

/**
 * Login ด้วย Google Email (ใช้ Google OAuth ของ GAS Web App)
 * เหมาะสำหรับ "Execute as: User accessing the web app"
 *
 * @returns {{ token: string, user: Object }}
 * @throws {Error} ถ้า user ไม่ได้รับอนุญาต
 */
function loginCurrentUser() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('ไม่สามารถระบุตัวตนได้ กรุณา login ด้วย Google Account');

  const user = _getUserByEmail(email);
  if (!user) throw new Error(`User ไม่ได้รับอนุญาต: ${email}`);
  if (!user.is_active || user.is_active === 'FALSE' || user.is_active === false) {
    throw new Error(`User ถูกระงับการใช้งาน: ${email}`);
  }

  const token = createSession(email);
  return {
    token,
    user: _sanitizeUser(user),
  };
}

/**
 * ดึง user info จาก token (ใช้ใน frontend เพื่อ check role)
 *
 * @param {string} token
 * @returns {Object} user object (sanitized)
 * @throws {Error} ถ้า token invalid
 */
function getSessionUser(token) {
  const session = validateSession(token);
  if (!session) throw new Error('Session หมดอายุ กรุณา login ใหม่');

  const user = _getUserByEmail(session.email);
  if (!user || !user.is_active) throw new Error('User ไม่พบหรือถูกระงับ');

  return _sanitizeUser(user);
}


// ============================================================
// SECTION 4 — AUTHORIZATION
// ============================================================

/**
 * Middleware: ตรวจสอบ token และ permission
 * เรียกต้น API handler ทุกตัว
 *
 * @param {string} token - session token จาก request
 * @param {string} requiredPermission - เช่น 'canWrite', 'canDelete'
 * @returns {Object} user object ถ้าผ่าน
 * @throws {Error} ถ้า unauthorized หรือ forbidden
 */
function requireAuth(token, requiredPermission = 'canRead') {
  const session = validateSession(token);
  if (!session) throw new Error('UNAUTHORIZED: Session หมดอายุ กรุณา login ใหม่');

  const user = _getUserByEmail(session.email);
  if (!user) throw new Error('UNAUTHORIZED: ไม่พบ User ในระบบ');
  if (!user.is_active || user.is_active === 'FALSE' || user.is_active === false) {
    throw new Error('UNAUTHORIZED: User ถูกระงับการใช้งาน');
  }

  const perms = PERMISSIONS[user.role];
  if (!perms) throw new Error(`UNAUTHORIZED: Role ไม่ถูกต้อง: ${user.role}`);
  if (!perms[requiredPermission]) {
    throw new Error(`FORBIDDEN: Role "${user.role}" ไม่มีสิทธิ์: ${requiredPermission}`);
  }

  return _sanitizeUser(user);
}

/**
 * ตรวจสอบว่า user มีสิทธิ์เข้าถึง site นั้นหรือไม่
 * ADMIN → เข้าถึงได้ทุก site
 * STAFF/EXECUTIVE → เฉพาะ site ที่ระบุใน site_access
 *
 * @param {Object} user - จาก requireAuth()
 * @param {string} siteId
 * @returns {boolean}
 */
function canAccessSite(user, siteId) {
  if (user.role === 'ADMIN') return true;
  if (!user.site_access) return false;

  // site_access เก็บเป็น comma-separated เช่น "SITE_001,SITE_002"
  const allowedSites = String(user.site_access).split(',').map(s => s.trim());
  return allowedSites.includes(siteId) || allowedSites.includes('ALL');
}


// ============================================================
// SECTION 5 — USER MANAGEMENT
// ============================================================

/**
 * เพิ่ม User ใหม่ (ADMIN only)
 *
 * @param {Object} userData
 * @param {string} userData.email
 * @param {string} userData.display_name
 * @param {string} userData.role - ADMIN | EXECUTIVE | STAFF
 * @param {string} [userData.site_access] - 'ALL' หรือ comma-separated site_ids
 * @returns {Object} user ที่สร้าง
 */
function createUser(userData) {
  const schema = {
    email:        { required: true, type: 'string' },
    display_name: { required: true, type: 'string' },
    role:         { required: true, enum: CONFIG.ENUMS.USER_ROLE },
  };

  const { valid, errors } = validateSchema(userData, schema);
  if (!valid) throw new Error('Validation error: ' + errors.join(', '));

  // ตรวจ duplicate email
  if (dbExists(CONFIG.SHEETS.USERS, { email: userData.email })) {
    throw new Error(`Email มีอยู่แล้วในระบบ: ${userData.email}`);
  }

  const user = {
    user_id:      generateId('USR'),
    email:        userData.email.toLowerCase().trim(),
    display_name: userData.display_name,
    role:         userData.role,
    site_access:  userData.site_access || 'ALL',
    is_active:    true,
    last_login:   '',
    created_at:   nowISO(),
    updated_at:   nowISO(),
  };

  dbInsert(CONFIG.SHEETS.USERS, user);
  log('INFO', 'createUser', `User created: ${user.email} (${user.role})`);
  return _sanitizeUser(user);
}

/**
 * อัปเดตข้อมูล User (ADMIN only)
 */
function updateUser(userId, updates) {
  const allowedFields = ['display_name', 'role', 'site_access', 'is_active'];
  const filtered = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowedFields.includes(k))
  );
  filtered.updated_at = nowISO();
  return dbUpdate(CONFIG.SHEETS.USERS, 'user_id', userId, filtered);
}

/**
 * ดึงรายการ User ทั้งหมด (ADMIN only)
 */
function listUsers() {
  return dbGetAll(CONFIG.SHEETS.USERS).map(_sanitizeUser);
}


// ============================================================
// SECTION 6 — INTERNAL HELPERS
// ============================================================

/**
 * ค้นหา user จาก email (case-insensitive)
 * @private
 */
function _getUserByEmail(email) {
  const rows = dbGetAll(CONFIG.SHEETS.USERS);
  return rows.find(u => String(u.email).toLowerCase() === String(email).toLowerCase()) || null;
}

/**
 * ลบข้อมูล sensitive ออกจาก user object ก่อนส่ง response
 * @private
 */
function _sanitizeUser(user) {
  const { ...safe } = user;
  return {
    user_id:      safe.user_id,
    email:        safe.email,
    display_name: safe.display_name,
    role:         safe.role,
    site_access:  safe.site_access,
    is_active:    safe.is_active,
    permissions:  PERMISSIONS[safe.role] || {},
  };
}
