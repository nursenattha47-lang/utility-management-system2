// ============================================================
// KPIComponents.js — KPI Card Components
// UtilityManager | PHASE 4B — KPI Section
// ============================================================
// Reusable vanilla-JS components for KPI cards.
// No framework required — mounts into any container element.
// ============================================================
// Usage:
//   KPI.mount('#kpi-section', optionalData);
//   KPI.update(newData);
//   KPI.destroy();
// ============================================================


// ============================================================
// SECTION 1 — CONSTANTS & DEFAULTS
// ============================================================

const KPI_CONFIG = {
  animationDuration: 800,
  counterStepMs:     16,
  thresholds: {
    amountHighAlert:  500000,
    pendingWarning:   5,
    overdueAlert:     1,
    anomalyWarning:   3,
    reimbursement:    3,
    momChangeWarn:    15,
    momChangeDanger:  30,
  },
};

const KPI_DEFAULTS = {
  electricity:     { amount: 0, unit: 'บาท', prev: 0, meterCount: 0 },
  water:           { amount: 0, unit: 'บาท', prev: 0, meterCount: 0 },
  outstanding:     { count: 0, totalAmount: 0, overdueCount: 0 },
  anomaly:         { count: 0, highSeverity: 0, sites: [] },
  momComparison:   { currentMonth: 0, prevMonth: 0, label: '' },
  reimbursements:  { pending: 0, totalAmount: 0, oldestDays: 0 },
};


// ============================================================
// SECTION 2 — FORMATTERS
// ============================================================

const KPIFormat = {
  /** แสดงยอดเงินแบบสั้น: 1,234,567 → "1.23M" */
  compact(amount) {
    if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(2) + 'M';
    if (amount >= 1_000)     return (amount / 1_000).toFixed(1) + 'K';
    return amount.toLocaleString('th-TH', { maximumFractionDigits: 0 });
  },

  /** แสดงยอดเงินเต็ม: 1,234,567.89 */
  full(amount) {
    return parseFloat(amount || 0).toLocaleString('th-TH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },

  /** % เปลี่ยนแปลง พร้อม sign */
  pct(current, prev) {
    if (!prev || prev === 0) return null;
    const p = ((current - prev) / Math.abs(prev)) * 100;
    return {
      value: Math.abs(p),
      sign:  p >= 0 ? '+' : '−',
      raw:   p,
    };
  },

  /** สร้างข้อความงวดบิล เช่น "พ.ค. 2568" */
  period(buddhistYear, month) {
    const months = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                    'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    return `${months[month] || ''} ${buddhistYear || ''}`.trim();
  },
};


// ============================================================
// SECTION 3 — SEVERITY HELPER
// ============================================================

/**
 * คืน severity class ตามค่าและเกณฑ์
 * @returns 'normal' | 'warning' | 'danger'
 */
function _getSeverity(value, warnThreshold, dangerThreshold) {
  if (dangerThreshold !== undefined && value >= dangerThreshold) return 'danger';
  if (warnThreshold  !== undefined && value >= warnThreshold)  return 'warning';
  return 'normal';
}

/**
 * คืน trend object สำหรับแสดง % เปลี่ยนแปลง
 */
function _buildTrend(current, prev) {
  const pct = KPIFormat.pct(current, prev);
  if (!pct) return null;
  return {
    label:     `${pct.sign}${pct.value.toFixed(1)}%`,
    direction: pct.raw >= 0 ? 'up' : 'down',
    value:     pct.raw,
  };
}


// ============================================================
// SECTION 4 — ANIMATED COUNTER
// ============================================================

/**
 * เล่น counter animation จาก 0 → targetValue
 * @param {HTMLElement} el
 * @param {number} target
 * @param {Function} formatter   — fn(value) → displayString
 * @param {number} [duration]
 */
function animateCounter(el, target, formatter, duration = KPI_CONFIG.animationDuration) {
  if (!el) return;
  const start     = performance.now();
  const startVal  = parseFloat(el.dataset.currentVal || '0') || 0;

  function easeOutQuart(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  function step(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = easeOutQuart(progress);
    const current  = startVal + (target - startVal) * eased;

    el.textContent      = formatter(current);
    el.dataset.currentVal = String(current);

    if (progress < 1) requestAnimationFrame(step);
    else {
      el.textContent      = formatter(target);
      el.dataset.currentVal = String(target);
    }
  }

  requestAnimationFrame(step);
}


// ============================================================
// SECTION 5 — INDIVIDUAL CARD RENDERERS
// ============================================================

/**
 * Render: Electricity total card
 * Shows: ยอดค่าไฟฟ้ารวม + เทียบเดือนก่อน + จำนวนมิเตอร์
 */
function renderElectricityCard(data) {
  const d        = { ...KPI_DEFAULTS.electricity, ...data };
  const trend    = _buildTrend(d.amount, d.prev);
  const severity = _getSeverity(d.amount,
    KPI_CONFIG.thresholds.amountHighAlert,
    KPI_CONFIG.thresholds.amountHighAlert * 2
  );

  return {
    id:       'kpi-electricity',
    icon:     'bolt',
    accent:   'blue',
    label:    'ค่าไฟฟ้ารวมเดือนนี้',
    value:    d.amount,
    valueFmt: (v) => '฿' + KPIFormat.compact(v),
    fullFmt:  '฿' + KPIFormat.full(d.amount),
    trend,
    severity,
    sub:      d.meterCount > 0 ? `${d.meterCount} มิเตอร์ไฟฟ้า` : 'เทียบกับเดือนก่อน',
    badge:    null,
  };
}

/**
 * Render: Water total card
 */
function renderWaterCard(data) {
  const d        = { ...KPI_DEFAULTS.water, ...data };
  const trend    = _buildTrend(d.amount, d.prev);
  const severity = _getSeverity(d.amount,
    KPI_CONFIG.thresholds.amountHighAlert * 0.4,
    KPI_CONFIG.thresholds.amountHighAlert
  );

  return {
    id:       'kpi-water',
    icon:     'droplet',
    accent:   'teal',
    label:    'ค่าน้ำประปารวมเดือนนี้',
    value:    d.amount,
    valueFmt: (v) => '฿' + KPIFormat.compact(v),
    fullFmt:  '฿' + KPIFormat.full(d.amount),
    trend,
    severity,
    sub:      d.meterCount > 0 ? `${d.meterCount} มิเตอร์น้ำ` : 'เทียบกับเดือนก่อน',
    badge:    null,
  };
}

/**
 * Render: Outstanding bills card (ค้างชำระ)
 */
function renderOutstandingCard(data) {
  const d        = { ...KPI_DEFAULTS.outstanding, ...data };
  const severity = d.overdueCount > 0 ? 'danger'
                 : _getSeverity(d.count, KPI_CONFIG.thresholds.pendingWarning);

  return {
    id:       'kpi-outstanding',
    icon:     'file-invoice',
    accent:   severity === 'danger' ? 'red' : severity === 'warning' ? 'amber' : 'gray',
    label:    'บิลค้างชำระ',
    value:    d.count,
    valueFmt: (v) => Math.round(v) + ' รายการ',
    fullFmt:  d.count + ' รายการ (฿' + KPIFormat.compact(d.totalAmount) + ')',
    trend:    null,
    severity,
    sub:      d.overdueCount > 0
      ? `เลยกำหนด ${d.overdueCount} รายการ — ดำเนินการด่วน`
      : d.count > 0 ? `ยอดรวม ฿${KPIFormat.compact(d.totalAmount)}` : 'ไม่มีบิลค้างชำระ',
    badge:    d.overdueCount > 0 ? { text: `${d.overdueCount} เลยกำหนด`, severity: 'danger' } : null,
  };
}

/**
 * Render: Anomaly sites card (สถานที่ผิดปกติ)
 */
function renderAnomalyCard(data) {
  const d        = { ...KPI_DEFAULTS.anomaly, ...data };
  const severity = _getSeverity(
    d.highSeverity,
    KPI_CONFIG.thresholds.anomalyWarning * 0.5,
    KPI_CONFIG.thresholds.anomalyWarning
  );

  return {
    id:       'kpi-anomaly',
    icon:     'alert-triangle',
    accent:   severity === 'danger' ? 'red' : severity === 'warning' ? 'amber' : 'purple',
    label:    'สถานที่ใช้พลังงานผิดปกติ',
    value:    d.count,
    valueFmt: (v) => Math.round(v) + ' แห่ง',
    fullFmt:  d.count + ' แห่ง',
    trend:    null,
    severity,
    sub:      d.highSeverity > 0
      ? `HIGH severity ${d.highSeverity} แห่ง — ต้องตรวจสอบ`
      : d.count > 0 ? 'ตรวจพบเดือนนี้' : 'ปกติ ไม่พบความผิดปกติ',
    badge:    d.highSeverity > 0 ? { text: 'HIGH ' + d.highSeverity, severity: 'danger' } : null,
  };
}

/**
 * Render: Month-over-month comparison card (เทียบเดือน)
 */
function renderMoMCard(data) {
  const d        = { ...KPI_DEFAULTS.momComparison, ...data };
  const trend    = _buildTrend(d.currentMonth, d.prevMonth);
  const pctVal   = trend ? Math.abs(trend.value) : 0;
  const severity = _getSeverity(
    pctVal,
    KPI_CONFIG.thresholds.momChangeWarn,
    KPI_CONFIG.thresholds.momChangeDanger
  );

  return {
    id:       'kpi-mom',
    icon:     'chart-bar',
    accent:   trend && trend.raw < 0 ? 'teal' : severity === 'danger' ? 'red' : severity === 'warning' ? 'amber' : 'blue',
    label:    'เทียบเดือนก่อนหน้า (รวมทุกประเภท)',
    value:    d.currentMonth,
    valueFmt: (v) => '฿' + KPIFormat.compact(v),
    fullFmt:  '฿' + KPIFormat.full(d.currentMonth),
    trend,
    severity,
    sub:      d.label
      ? `${d.label} — เดือนก่อน ฿${KPIFormat.compact(d.prevMonth)}`
      : `เดือนก่อน ฿${KPIFormat.compact(d.prevMonth)}`,
    badge:    null,
  };
}

/**
 * Render: Pending reimbursements card (เงินสำรองรอคืน)
 */
function renderReimbursementCard(data) {
  const d        = { ...KPI_DEFAULTS.reimbursements, ...data };
  const severity = _getSeverity(
    d.pending,
    KPI_CONFIG.thresholds.reimbursement * 0.6,
    KPI_CONFIG.thresholds.reimbursement
  );

  return {
    id:       'kpi-reimbursement',
    icon:     'coin',
    accent:   severity === 'danger' ? 'amber' : severity === 'warning' ? 'amber' : 'gray',
    label:    'เงินสำรองจ่ายรอคืน',
    value:    d.pending,
    valueFmt: (v) => Math.round(v) + ' รายการ',
    fullFmt:  d.pending + ' รายการ (฿' + KPIFormat.compact(d.totalAmount) + ')',
    trend:    null,
    severity,
    sub:      d.pending > 0
      ? d.oldestDays > 30
        ? `เก่าสุด ${d.oldestDays} วัน — ควรเร่งรัด`
        : `ยอดรวม ฿${KPIFormat.compact(d.totalAmount)}`
      : 'ไม่มีรายการค้างอยู่',
    badge:    d.oldestDays > 30
      ? { text: `ค้าง ${d.oldestDays} วัน`, severity: 'warning' }
      : null,
  };
}


// ============================================================
// SECTION 6 — HTML BUILDER
// ============================================================

/**
 * สร้าง HTML string สำหรับ card 1 ใบ
 * @param {Object} card  — output จาก renderXxxCard()
 */
function buildCardHTML(card) {
  const trendHTML = card.trend
    ? (() => {
        const isUp  = card.trend.direction === 'up';
        const cls   = card.severity === 'danger'  ? 'kpi-trend--danger'
                    : card.severity === 'warning' ? 'kpi-trend--warning'
                    : isUp ? 'kpi-trend--up' : 'kpi-trend--down';
        const icon  = isUp ? 'ti-trending-up' : 'ti-trending-down';
        return `<span class="kpi-trend ${cls}" aria-label="เปลี่ยนแปลง ${card.trend.label}">
                  <i class="ti ${icon}" aria-hidden="true"></i>
                  ${card.trend.label}
                </span>`;
      })()
    : '';

  const badgeHTML = card.badge
    ? `<span class="kpi-badge kpi-badge--${card.badge.severity}" role="status">${card.badge.text}</span>`
    : '';

  const severityAttr = card.severity !== 'normal' ? `data-severity="${card.severity}"` : '';

  return `
<article class="kpi-card kpi-card--${card.accent} kpi-card--${card.severity}"
         id="${card.id}"
         ${severityAttr}
         aria-label="${card.label}"
         title="${card.fullFmt}">

  <header class="kpi-card__header">
    <span class="kpi-card__label">${card.label}</span>
    <span class="kpi-card__icon-wrap kpi-icon--${card.accent}" aria-hidden="true">
      <i class="ti ti-${card.icon}"></i>
    </span>
  </header>

  <div class="kpi-card__body">
    <strong class="kpi-card__value"
            id="${card.id}-value"
            data-target="${card.value}"
            data-current-val="0"
            aria-live="polite">
      ${card.valueFmt(card.value)}
    </strong>
    ${trendHTML}
    ${badgeHTML}
  </div>

  <p class="kpi-card__sub" id="${card.id}-sub">${card.sub}</p>
</article>`.trim();
}


// ============================================================
// SECTION 7 — KPI MODULE (public API)
// ============================================================

const KPI = (() => {

  let _container = null;
  let _lastData  = null;
  let _isInit    = false;

  /** รวบรวม card configs จาก raw data */
  function _buildCards(data) {
    return [
      renderElectricityCard(data.electricity),
      renderWaterCard(data.water),
      renderOutstandingCard(data.outstanding),
      renderAnomalyCard(data.anomaly),
      renderMoMCard(data.momComparison),
      renderReimbursementCard(data.reimbursements),
    ];
  }

  /** Play counter animations บน cards ที่ render แล้ว */
  function _animateAll(cards) {
    cards.forEach(card => {
      const el = document.getElementById(card.id + '-value');
      if (!el) return;
      animateCounter(el, card.value, card.valueFmt);
    });
  }

  /** Mount KPI section ลงใน container */
  function mount(selectorOrEl, data = {}) {
    _container = typeof selectorOrEl === 'string'
      ? document.querySelector(selectorOrEl)
      : selectorOrEl;

    if (!_container) {
      console.warn('[KPI] Container not found:', selectorOrEl);
      return;
    }

    _lastData = { ...KPI_DEFAULTS, ...data };
    const cards = _buildCards(_lastData);

    _container.setAttribute('role', 'region');
    _container.setAttribute('aria-label', 'ตัวชี้วัดหลัก');
    _container.innerHTML = `
      <h2 class="sr-only">ตัวชี้วัดหลักของระบบ</h2>
      <div class="kpi-grid" role="list">
        ${cards.map(c => `<div role="listitem">${buildCardHTML(c)}</div>`).join('\n')}
      </div>`;

    _isInit = true;

    // Animate after next paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => _animateAll(cards));
    });

    return KPI;
  }

  /** อัปเดต data โดยไม่ re-render ทั้งหมด (in-place update) */
  function update(newData = {}) {
    if (!_isInit || !_container) {
      console.warn('[KPI] Call KPI.mount() before KPI.update()');
      return KPI;
    }

    _lastData = { ..._lastData, ...newData };
    const cards = _buildCards(_lastData);

    cards.forEach(card => {
      const el = document.getElementById(card.id);
      if (!el) return;

      // อัปเดต class severity
      el.className = el.className
        .replace(/kpi-card--(normal|warning|danger)/g, '')
        .trim() + ` kpi-card--${card.severity}`;

      if (card.severity !== 'normal') {
        el.dataset.severity = card.severity;
      } else {
        delete el.dataset.severity;
      }

      // อัปเดต sub text
      const subEl = document.getElementById(card.id + '-sub');
      if (subEl) subEl.textContent = card.sub;

      // อัปเดต badge
      const existingBadge = el.querySelector('.kpi-badge');
      if (card.badge && !existingBadge) {
        const bodyEl = el.querySelector('.kpi-card__body');
        if (bodyEl) {
          const badge = document.createElement('span');
          badge.className  = `kpi-badge kpi-badge--${card.badge.severity}`;
          badge.role       = 'status';
          badge.textContent = card.badge.text;
          bodyEl.appendChild(badge);
        }
      } else if (!card.badge && existingBadge) {
        existingBadge.remove();
      } else if (card.badge && existingBadge) {
        existingBadge.className  = `kpi-badge kpi-badge--${card.badge.severity}`;
        existingBadge.textContent = card.badge.text;
      }
    });

    // Animate counters
    _animateAll(cards);

    return KPI;
  }

  /** Unmount และ cleanup */
  function destroy() {
    if (_container) {
      _container.innerHTML = '';
      _container.removeAttribute('role');
      _container.removeAttribute('aria-label');
    }
    _container = null;
    _lastData  = null;
    _isInit    = false;
    return KPI;
  }

  /** ดึง card config ปัจจุบัน (ใช้ debug / test) */
  function getCards() {
    return _lastData ? _buildCards(_lastData) : [];
  }

  return { mount, update, destroy, getCards, format: KPIFormat };
})();


// ============================================================
// SECTION 8 — INTEGRATION HELPERS
// ============================================================

/**
 * แปลง API response จาก BillService/API.gs → KPI data format
 * เรียกหลังจาก fetch ข้อมูลจาก GAS Web App endpoint
 *
 * @param {Object} apiResponse  — raw response จาก doGet
 * @returns {Object} data object พร้อมส่ง KPI.mount() หรือ KPI.update()
 */
function mapAPIResponseToKPIData(apiResponse) {
  if (!apiResponse || !apiResponse.success) return {};

  const bills  = apiResponse.data?.bills  || [];
  const meters = apiResponse.data?.meters || [];
  const anomalies  = apiResponse.data?.anomalies  || [];
  const advances   = apiResponse.data?.advances   || [];
  const summary    = apiResponse.data?.summary    || {};

  const thisPeriod   = summary.currentPeriod || {};
  const prevPeriod   = summary.prevPeriod    || {};

  // ---- electricity ----
  const elecBills = bills.filter(b => b.meter_type === 'ELECTRICITY' && b.bill_status !== 'CANCELLED');
  const elecAmt   = elecBills.reduce((s, b) => s + parseFloat(b.amount_total || 0), 0);
  const elecPrev  = prevPeriod.electricity_amount || 0;
  const elecMeters = meters.filter(m => m.meter_type === 'ELECTRICITY' && m.status === 'ACTIVE');

  // ---- water ----
  const waterBills = bills.filter(b => b.meter_type === 'WATER' && b.bill_status !== 'CANCELLED');
  const waterAmt   = waterBills.reduce((s, b) => s + parseFloat(b.amount_total || 0), 0);
  const waterPrev  = prevPeriod.water_amount || 0;
  const waterMeters = meters.filter(m => m.meter_type === 'WATER' && m.status === 'ACTIVE');

  // ---- outstanding ----
  const unpaid     = bills.filter(b => ['APPROVED', 'PENDING_REVIEW', 'OVERDUE'].includes(b.bill_status));
  const overdue    = bills.filter(b => b.bill_status === 'OVERDUE');
  const unpaidAmt  = unpaid.reduce((s, b) => s + parseFloat(b.amount_total || 0), 0);

  // ---- anomaly ----
  const anomalyCount  = anomalies.length;
  const highSeverity  = anomalies.filter(a => a.severity === 'HIGH').length;
  const anomalySites  = [...new Set(anomalies.map(a => a.site_id))];

  // ---- MoM ----
  const currentTotal = thisPeriod.total_amount  || elecAmt + waterAmt;
  const prevTotal    = prevPeriod.total_amount   || 0;

  // ---- reimbursements ----
  const pendingAdv   = advances.filter(a => ['PENDING', 'APPROVED'].includes(a.status));
  const advAmt       = pendingAdv.reduce((s, a) => s + parseFloat(a.amount_requested || 0), 0);
  const today        = new Date();
  const oldestDays   = pendingAdv.reduce((max, a) => {
    if (!a.advance_date) return max;
    const days = Math.floor((today - new Date(a.advance_date)) / 86400000);
    return Math.max(max, days);
  }, 0);

  return {
    electricity:    { amount: elecAmt,  prev: elecPrev,  meterCount: elecMeters.length  },
    water:          { amount: waterAmt, prev: waterPrev, meterCount: waterMeters.length },
    outstanding:    { count: unpaid.length, totalAmount: unpaidAmt, overdueCount: overdue.length },
    anomaly:        { count: anomalyCount, highSeverity, sites: anomalySites },
    momComparison:  { currentMonth: currentTotal, prevMonth: prevTotal, label: thisPeriod.label || '' },
    reimbursements: { pending: pendingAdv.length, totalAmount: advAmt, oldestDays },
  };
}

/**
 * Fetch data จาก GAS Web App แล้ว update KPI cards
 * เรียกใน dashboard JS หลังจาก KPI.mount() แล้ว
 *
 * @param {string} baseUrl    — GAS Web App URL
 * @param {string} token      — session token
 * @param {string} [period]   — bill_period_key เช่น "2568-06" (optional)
 */
async function KPIFetchAndUpdate(baseUrl, token, period) {
  try {
    const params = new URLSearchParams({ action: 'dashboard.kpi', token });
    if (period) params.set('period', period);

    const res  = await fetch(`${baseUrl}?${params.toString()}`);
    const data = await res.json();

    if (data.success) {
      KPI.update(mapAPIResponseToKPIData(data));
    } else {
      console.warn('[KPI] API error:', data.message);
    }
  } catch (err) {
    console.error('[KPI] Fetch failed:', err);
  }
}


// ============================================================
// SECTION 9 — EXPORT
// ============================================================

// ถ้าอยู่ใน module environment ให้ export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KPI,
    KPIFormat,
    KPIFetchAndUpdate,
    mapAPIResponseToKPIData,
    animateCounter,
    renderElectricityCard,
    renderWaterCard,
    renderOutstandingCard,
    renderAnomalyCard,
    renderMoMCard,
    renderReimbursementCard,
  };
}
