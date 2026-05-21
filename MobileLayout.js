/**
 * ============================================================
 * MobileLayout.js — Mobile Responsive Controller
 * UtilityManager | PHASE 4F — Mobile Responsive Optimization
 * ============================================================
 *
 * Responsibilities:
 *   1. Sidebar open / close / overlay + swipe-to-close
 *   2. Hamburger ARIA state management
 *   3. Body scroll lock when sidebar is open
 *   4. Viewport resize handler (debounced) — promotes/demotes
 *      sidebar between overlay mode and persistent mode
 *   5. Chart resize signalling — triggers Chart.js resize
 *      on breakpoint change or orientation change
 *   6. Table horizontal scroll detection — adds/removes
 *      .is-scrollable class for fade-edge CSS
 *   7. Filter bar collapse toggle on mobile
 *   8. Touch swipe gesture (right-edge → open, left swipe → close)
 *   9. KPI counter animation trigger via IntersectionObserver
 *  10. Safe-area CSS variable injection
 *  11. iOS font-size fix for select / input zoom
 *  12. Page-visibility change → pause animations
 *
 * Dependencies:
 *   - Responsive.css (loads before this script)
 *   - Dashboard.html (sidebar, overlay, hamburger IDs)
 *   - KPIComponents.js (optional — KPI.update() integration)
 *   - Charts.js        (optional — Charts.destroyAll() + re-init)
 *
 * Usage:
 *   // Automatic: script tag in HTML (IIFE at bottom of file)
 *   <script src="MobileLayout.js" defer></script>
 *
 *   // Or manual init:
 *   MobileLayout.init({ breakpoint: 1024 });
 *
 *   // Public API:
 *   MobileLayout.openSidebar();
 *   MobileLayout.closeSidebar();
 *   MobileLayout.toggleSidebar();
 *   MobileLayout.getBreakpoint();   // → 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
 *   MobileLayout.isMobile();        // → bool (< breakpoint)
 *   MobileLayout.destroy();
 * ============================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// SECTION 1 — CONSTANTS
// ─────────────────────────────────────────────────────────────

/** Breakpoints mirror Responsive.css */
const BREAKPOINTS = {
  xs:   0,
  sm:   360,
  md:   600,
  lg:   768,
  xl:   1024,   // sidebar becomes persistent above this
  '2xl': 1280,
  '3xl': 1400,
};

/** Sidebar becomes persistent (non-overlay) above this width */
const PERSISTENT_SIDEBAR_BP = BREAKPOINTS.xl;   // 1024px

/** Swipe gesture thresholds */
const SWIPE = {
  edgeZone:       24,    // px from left edge to start open-swipe
  minDistance:    60,    // minimum px swipe to trigger
  maxVertical:    80,    // max vertical drift allowed
  velocityMin:    0.3,   // px/ms minimum flick velocity
};

/** Debounce / throttle delays */
const TIMING = {
  resizeDebounce: 120,   // ms
  scrollThrottle: 80,    // ms
  chartResizeDelay: 200, // ms — let CSS transitions finish first
};


// ─────────────────────────────────────────────────────────────
// SECTION 2 — STATE
// ─────────────────────────────────────────────────────────────

let _config = {
  breakpoint: PERSISTENT_SIDEBAR_BP,
  sidebarId:  'sidebar',
  overlayId:  'sidebarOverlay',
  hamburgerIds: ['hamburgerBtn'],
  contentId:  'mainContent',
  filterBarSelector: '.filter-bar',
  chartWrapSelector: '.chart-wrap, .chart-container, [data-chart-wrap], .panel__chart-area',
  tableContainerSelector: '.table-container, .at-table-container',
  onOpen:    null,
  onClose:   null,
  onResize:  null,
};

const _state = {
  sidebarOpen:    false,
  lastWidth:      0,
  lastBreakpoint: '',
  resizeTimer:    null,
  scrollTimer:    null,
  observers:      [],       // IntersectionObservers
  listeners:      [],       // [element, event, handler] tuples for cleanup
  touch: {
    startX:    0,
    startY:    0,
    startTime: 0,
    tracking:  false,
    direction: null,        // 'open' | 'close'
  },
};


// ─────────────────────────────────────────────────────────────
// SECTION 3 — UTILITY HELPERS
// ─────────────────────────────────────────────────────────────

function _el(id)  { return document.getElementById(id); }
function _qs(sel) { return document.querySelector(sel); }
function _qsa(sel){ return Array.from(document.querySelectorAll(sel)); }

/** Add event listener and track for cleanup */
function _on(el, event, handler, options) {
  if (!el) return;
  el.addEventListener(event, handler, options);
  _state.listeners.push([el, event, handler, options]);
}

/** Remove all tracked event listeners */
function _offAll() {
  _state.listeners.forEach(([el, ev, fn, opts]) => {
    el.removeEventListener(ev, fn, opts);
  });
  _state.listeners.length = 0;
}

/** Simple debounce */
function _debounce(fn, delay) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** Simple throttle */
function _throttle(fn, limit) {
  let inThrottle = false;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

/** Get current breakpoint label */
function _getBreakpoint(width) {
  const w = width ?? window.innerWidth;
  if (w <  360)  return 'xs';
  if (w <  600)  return 'sm';
  if (w <  768)  return 'md';
  if (w < 1024)  return 'lg';
  if (w < 1280)  return 'xl';
  if (w < 1400)  return '2xl';
  return '3xl';
}

/** Is current width in mobile/overlay sidebar mode? */
function _isMobileMode() {
  return window.innerWidth < _config.breakpoint;
}

/** Focus trap: get focusable elements within container */
function _getFocusable(container) {
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), ' +
    '[tabindex]:not([tabindex="-1"])'
  ));
}


// ─────────────────────────────────────────────────────────────
// SECTION 4 — SIDEBAR OPEN / CLOSE
// ─────────────────────────────────────────────────────────────

/**
 * Open the sidebar (mobile overlay mode).
 * Ignored if in persistent mode or already open.
 */
function openSidebar() {
  if (!_isMobileMode() || _state.sidebarOpen) return;

  const sidebar  = _el(_config.sidebarId);
  const overlay  = _el(_config.overlayId);

  if (!sidebar) return;

  // Show
  sidebar.classList.add('sidebar--open');
  if (overlay) {
    overlay.style.display = 'block';
    // Force reflow before transition
    void overlay.offsetHeight;
    overlay.classList.add('active');
  }

  // Body scroll lock
  document.body.classList.add('sidebar-is-open');

  // ARIA
  _setHamburgerAria(true);
  sidebar.setAttribute('aria-hidden', 'false');

  // Focus management: move focus into sidebar
  const firstFocusable = _getFocusable(sidebar)[0];
  if (firstFocusable) {
    requestAnimationFrame(() => firstFocusable.focus());
  }

  _state.sidebarOpen = true;

  if (typeof _config.onOpen === 'function') _config.onOpen();
}

/**
 * Close the sidebar.
 * Ignored if already closed or in persistent mode.
 */
function closeSidebar() {
  if (!_state.sidebarOpen) return;

  const sidebar = _el(_config.sidebarId);
  const overlay = _el(_config.overlayId);

  if (!sidebar) return;

  sidebar.classList.remove('sidebar--open');

  if (overlay) {
    overlay.classList.remove('active');
    // Delay display:none until transition completes
    const dur = parseFloat(
      getComputedStyle(sidebar).transitionDuration || '0.38'
    ) * 1000;
    setTimeout(() => {
      if (!_state.sidebarOpen) overlay.style.display = 'none';
    }, Math.min(dur, 400));
  }

  document.body.classList.remove('sidebar-is-open');
  _setHamburgerAria(false);
  sidebar.setAttribute('aria-hidden', 'true');

  // Return focus to hamburger
  const hamburger = _el(_config.hamburgerIds[0]);
  if (hamburger) hamburger.focus();

  _state.sidebarOpen = false;

  if (typeof _config.onClose === 'function') _config.onClose();
}

/** Toggle sidebar */
function toggleSidebar() {
  _state.sidebarOpen ? closeSidebar() : openSidebar();
}

/** Update hamburger ARIA attributes */
function _setHamburgerAria(isOpen) {
  _config.hamburgerIds.forEach(id => {
    const btn = _el(id);
    if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
}

/** Force close when switching to persistent mode */
function _promoteToPersistent() {
  if (_state.sidebarOpen) {
    _state.sidebarOpen = false;
    document.body.classList.remove('sidebar-is-open');
    _setHamburgerAria(false);
  }

  const sidebar = _el(_config.sidebarId);
  const overlay = _el(_config.overlayId);
  if (sidebar) {
    sidebar.classList.remove('sidebar--open');
    sidebar.removeAttribute('aria-hidden');
  }
  if (overlay) {
    overlay.classList.remove('active');
    overlay.style.display = 'none';
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 5 — KEYBOARD TRAP IN SIDEBAR
// ─────────────────────────────────────────────────────────────

function _handleSidebarKeydown(e) {
  if (!_state.sidebarOpen) return;

  if (e.key === 'Escape') {
    closeSidebar();
    return;
  }

  if (e.key !== 'Tab') return;

  const sidebar    = _el(_config.sidebarId);
  if (!sidebar) return;

  const focusable  = _getFocusable(sidebar);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 6 — TOUCH SWIPE GESTURE
// ─────────────────────────────────────────────────────────────

function _handleTouchStart(e) {
  if (!_isMobileMode()) return;

  const touch = e.touches[0];
  _state.touch.startX    = touch.clientX;
  _state.touch.startY    = touch.clientY;
  _state.touch.startTime = Date.now();
  _state.touch.tracking  = false;
  _state.touch.direction = null;

  // Only track if starting from left edge zone (open gesture)
  // or if sidebar is open (close gesture anywhere)
  if (touch.clientX <= SWIPE.edgeZone || _state.sidebarOpen) {
    _state.touch.tracking = true;
  }
}

function _handleTouchMove(e) {
  if (!_state.touch.tracking) return;

  const touch = e.touches[0];
  const dx = touch.clientX - _state.touch.startX;
  const dy = Math.abs(touch.clientY - _state.touch.startY);

  // If mostly vertical, cancel
  if (dy > SWIPE.maxVertical && !_state.touch.direction) {
    _state.touch.tracking = false;
    return;
  }

  // Determine direction
  if (!_state.touch.direction) {
    if (Math.abs(dx) > 8) {
      _state.touch.direction = dx > 0 ? 'open' : 'close';
    }
  }

  // Prevent page scroll during horizontal swipe on sidebar
  if (_state.touch.direction === 'close' && _state.sidebarOpen) {
    e.preventDefault();
  }
}

function _handleTouchEnd(e) {
  if (!_state.touch.tracking) return;
  _state.touch.tracking = false;

  const touch = e.changedTouches[0];
  const dx    = touch.clientX - _state.touch.startX;
  const dy    = Math.abs(touch.clientY - _state.touch.startY);
  const dt    = Date.now() - _state.touch.startTime;
  const velocity = Math.abs(dx) / dt;

  // Reject vertical swipes
  if (dy > SWIPE.maxVertical) return;

  const isFlick    = velocity >= SWIPE.velocityMin;
  const isFarEnough = Math.abs(dx) >= SWIPE.minDistance;

  if (!isFlick && !isFarEnough) return;

  if (dx > 0 && _state.touch.startX <= SWIPE.edgeZone && !_state.sidebarOpen) {
    // Right swipe from left edge → open
    openSidebar();
  } else if (dx < 0 && _state.sidebarOpen) {
    // Left swipe → close
    closeSidebar();
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 7 — VIEWPORT RESIZE HANDLER
// ─────────────────────────────────────────────────────────────

const _handleResize = _debounce(function () {
  const w  = window.innerWidth;
  const bp = _getBreakpoint(w);

  // Sidebar mode change
  if (w >= _config.breakpoint && _state.sidebarOpen) {
    _promoteToPersistent();
  }

  // Breakpoint changed
  if (bp !== _state.lastBreakpoint) {
    _state.lastBreakpoint = bp;
    _updateTopbarHeight();
    _signalChartResize();
    _checkTableScroll();
    _updateFilterCollapseState();

    if (typeof _config.onResize === 'function') {
      _config.onResize({ breakpoint: bp, width: w });
    }
  }

  _state.lastWidth = w;
}, TIMING.resizeDebounce);

/**
 * Update --topbar-height CSS var dynamically
 * (accounts for safe-area on mobile)
 */
function _updateTopbarHeight() {
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    const h = topbar.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--topbar-height-actual', `${h}px`);
  }
}

/**
 * Signal Chart.js to resize all registered canvases.
 * Waits for CSS transitions to finish first.
 */
function _signalChartResize() {
  setTimeout(() => {
    // Method 1: Charts.js API (if available)
    if (typeof window.Charts !== 'undefined' && typeof window.Charts.destroyAll === 'function') {
      // Only reinit if breakpoint changed significantly
      // Soft resize: just trigger Chart.js resize
      document.querySelectorAll('canvas').forEach(canvas => {
        const chartInstance = window.Chart && window.Chart.getChart
          ? window.Chart.getChart(canvas)
          : null;
        if (chartInstance) {
          chartInstance.resize();
        }
      });
      return;
    }

    // Method 2: Dispatch resize event on chart containers
    document.querySelectorAll(
      '.chart-wrap, .chart-container, [data-chart-wrap], .panel__chart-area'
    ).forEach(container => {
      container.dispatchEvent(new Event('responsiveresize', { bubbles: false }));
    });

    // Method 3: Fire window resize (Chart.js listens to this)
    window.dispatchEvent(new Event('resize'));
  }, TIMING.chartResizeDelay);
}


// ─────────────────────────────────────────────────────────────
// SECTION 8 — TABLE HORIZONTAL SCROLL DETECTION
// ─────────────────────────────────────────────────────────────

const _checkTableScroll = _throttle(function () {
  document.querySelectorAll('.table-container, .at-table-container').forEach(container => {
    const isScrollable = container.scrollWidth > container.clientWidth + 2;
    container.classList.toggle('is-scrollable', isScrollable);
  });
}, TIMING.scrollThrottle);

/** Listen for scroll inside table containers */
function _initTableScrollListeners() {
  document.querySelectorAll('.table-container, .at-table-container').forEach(container => {
    _on(container, 'scroll', _throttle(function () {
      // Hide scroll indicator if scrolled to end
      const atEnd = container.scrollLeft + container.clientWidth >= container.scrollWidth - 2;
      container.classList.toggle('is-scrollable', !atEnd);
    }, 100), { passive: true });
  });
}


// ─────────────────────────────────────────────────────────────
// SECTION 9 — FILTER BAR COLLAPSE (mobile toggle)
// ─────────────────────────────────────────────────────────────

function _updateFilterCollapseState() {
  const isMobile = _isMobileMode();
  document.querySelectorAll('.filter-bar').forEach(bar => {
    // Only apply collapse behaviour on mobile
    if (!isMobile) {
      bar.classList.remove('is-collapsed');
      const toggleBtn = bar.querySelector('.filter-toggle-btn');
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    }
  });
}

function _initFilterToggle() {
  document.querySelectorAll('.filter-toggle-btn').forEach(btn => {
    _on(btn, 'click', function () {
      const bar = btn.closest('.filter-bar');
      if (!bar) return;
      const isCollapsed = bar.classList.toggle('is-collapsed');
      btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      // Animate: update btn icon
      const icon = btn.querySelector('.filter-toggle-icon');
      if (icon) icon.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(180deg)';
    });
  });
}


// ─────────────────────────────────────────────────────────────
// SECTION 10 — ORIENTATION CHANGE
// ─────────────────────────────────────────────────────────────

function _handleOrientationChange() {
  // iOS: innerWidth doesn't update immediately on orientation change
  setTimeout(() => {
    _handleResize();
    _updateTopbarHeight();

    // Close sidebar on orientation change for cleaner UX
    if (_state.sidebarOpen) {
      closeSidebar();
    }
  }, 100);
}


// ─────────────────────────────────────────────────────────────
// SECTION 11 — KPI COUNTER ANIMATION VIA INTERSECTION OBSERVER
// Triggers KPI.mount() or re-runs counter on scroll-into-view
// ─────────────────────────────────────────────────────────────

function _initKPIObserver() {
  if (typeof IntersectionObserver === 'undefined') return;

  const kpiSection = document.querySelector('.kpi-section, .kpi-grid');
  if (!kpiSection) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        // Trigger KPI counter animation
        if (typeof window.KPI !== 'undefined' && typeof window.KPI.animateCounters === 'function') {
          window.KPI.animateCounters();
        }

        // Add visible class for CSS animations
        entry.target.classList.add('kpi-section--visible');

        // Once triggered, stop observing
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.1 }
  );

  observer.observe(kpiSection);
  _state.observers.push(observer);
}

/**
 * Lazy chart rendering: observe chart containers,
 * signal mount when they enter the viewport.
 */
function _initChartObserver() {
  if (typeof IntersectionObserver === 'undefined') return;

  const chartContainers = document.querySelectorAll(
    '.panel__chart-area[data-chart-id], [data-chart-lazy]'
  );
  if (!chartContainers.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const id = entry.target.dataset.chartId || entry.target.dataset.chartLazy;
        if (!id) return;

        // Signal Charts.js to mount this chart
        if (typeof window.Charts !== 'undefined' && typeof window.Charts.mount === 'function') {
          window.Charts.mount(id, entry.target);
        }

        entry.target.dispatchEvent(new CustomEvent('chartenter', {
          bubbles: true,
          detail: { chartId: id },
        }));

        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '100px', threshold: 0 }
  );

  chartContainers.forEach(el => observer.observe(el));
  _state.observers.push(observer);
}


// ─────────────────────────────────────────────────────────────
// SECTION 12 — SAFE-AREA CSS VARIABLE INJECTION
// Exposes env() values as --safe-* vars for JS use
// ─────────────────────────────────────────────────────────────

function _injectSafeAreaVars() {
  // Check support
  if (!CSS.supports('padding', 'env(safe-area-inset-top)')) return;

  // Create hidden element to read computed safe-area values
  const probe = document.createElement('div');
  probe.style.cssText = `
    position: fixed;
    top: env(safe-area-inset-top);
    right: env(safe-area-inset-right);
    bottom: env(safe-area-inset-bottom);
    left: env(safe-area-inset-left);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
  `;
  document.body.appendChild(probe);

  const rect = probe.getBoundingClientRect();
  const top  = parseInt(getComputedStyle(probe).top) || 0;

  // Inject as JS-accessible custom properties
  document.documentElement.style.setProperty('--safe-top-js',    `${top}px`);

  document.body.removeChild(probe);
}


// ─────────────────────────────────────────────────────────────
// SECTION 13 — PAGE VISIBILITY (pause animations)
// ─────────────────────────────────────────────────────────────

function _handleVisibilityChange() {
  if (document.hidden) {
    document.documentElement.classList.add('page-hidden');
  } else {
    document.documentElement.classList.remove('page-hidden');
    // Resume: re-check layout
    _handleResize();
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 14 — SMOOTH SCROLL POLYFILL (iOS Safari)
// ─────────────────────────────────────────────────────────────

/**
 * Smooth-scroll the content area to a target element.
 * Uses native smooth scroll with fallback.
 *
 * @param {string|Element} target — CSS selector or element
 * @param {number} [offset=0]    — additional offset (e.g. sticky header height)
 */
function scrollTo(target, offset = 0) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;

  const content = document.querySelector('.content');
  if (!content) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const elTop     = el.getBoundingClientRect().top;
  const contTop   = content.getBoundingClientRect().top;
  const scrollPos = content.scrollTop + (elTop - contTop) - offset;

  content.scrollTo({ top: scrollPos, behavior: 'smooth' });
}


// ─────────────────────────────────────────────────────────────
// SECTION 15 — TOPBAR SCROLL SHADOW
// Adds .topbar--scrolled class for scroll-depth shadow
// ─────────────────────────────────────────────────────────────

function _initTopbarScrollShadow() {
  const content = document.querySelector('.content');
  const topbar  = document.querySelector('.topbar');
  if (!content || !topbar) return;

  const update = _throttle(function () {
    topbar.classList.toggle('topbar--scrolled', content.scrollTop > 8);
  }, 60);

  _on(content, 'scroll', update, { passive: true });
}


// ─────────────────────────────────────────────────────────────
// SECTION 16 — HAMBURGER & SIDEBAR CLICK WIRING
// ─────────────────────────────────────────────────────────────

function _initHamburgerListeners() {
  // All hamburger buttons
  _config.hamburgerIds.forEach(id => {
    const btn = _el(id);
    _on(btn, 'click', toggleSidebar);
  });

  // Overlay click: close
  const overlay = _el(_config.overlayId);
  _on(overlay, 'click', closeSidebar);

  // Sidebar close button
  const sidebar = _el(_config.sidebarId);
  if (sidebar) {
    const closeBtn = sidebar.querySelector('.sidebar__close');
    _on(closeBtn, 'click', closeSidebar);

    // Sidebar nav item clicks on mobile: close after nav
    const navItems = sidebar.querySelectorAll('.nav-item[data-page]');
    navItems.forEach(item => {
      _on(item, 'click', function () {
        if (_isMobileMode() && _state.sidebarOpen) {
          // Small delay so the nav animation fires first
          setTimeout(closeSidebar, 150);
        }
      });
    });
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 17 — INITIAL SIDEBAR STATE
// ─────────────────────────────────────────────────────────────

function _initSidebarState() {
  const sidebar = _el(_config.sidebarId);
  if (!sidebar) return;

  if (_isMobileMode()) {
    // Mobile: hidden off-canvas, aria-hidden
    sidebar.setAttribute('aria-hidden', 'true');
    _setHamburgerAria(false);
  } else {
    // Desktop: visible, remove aria-hidden
    sidebar.removeAttribute('aria-hidden');
    _setHamburgerAria(false);

    // Ensure no stale open class
    sidebar.classList.remove('sidebar--open');
  }

  // Always hide overlay on init
  const overlay = _el(_config.overlayId);
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active');
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 18 — GLOBAL FUNCTIONS
// Expose openSidebar / closeSidebar to HTML onclick attrs
// ─────────────────────────────────────────────────────────────

/**
 * Attach to window so HTML onclick="openSidebar()" works.
 * These are replaced by MobileLayout.openSidebar() etc.
 */
function _exposeGlobals() {
  window.openSidebar   = openSidebar;
  window.closeSidebar  = closeSidebar;
  window.toggleSidebar = toggleSidebar;
}


// ─────────────────────────────────────────────────────────────
// SECTION 19 — RESIZE OBSERVER FOR CHART CONTAINERS
// More accurate than window resize for panel size changes
// (e.g., sidebar open/close affecting chart width)
// ─────────────────────────────────────────────────────────────

function _initChartResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return;

  const chartContainers = document.querySelectorAll(
    '.panel__chart-area, .chart-wrap, .chart-container'
  );
  if (!chartContainers.length) return;

  const ro = new ResizeObserver(_debounce(function (entries) {
    entries.forEach(entry => {
      const canvas = entry.target.querySelector('canvas');
      if (!canvas) return;

      // Chart.js: get and resize the instance
      if (window.Chart && window.Chart.getChart) {
        const chart = window.Chart.getChart(canvas);
        if (chart) chart.resize();
      }
    });
  }, TIMING.chartResizeDelay));

  chartContainers.forEach(el => ro.observe(el));
  _state.observers.push({ disconnect: () => ro.disconnect() });
}


// ─────────────────────────────────────────────────────────────
// SECTION 20 — PUBLIC INIT / DESTROY
// ─────────────────────────────────────────────────────────────

/**
 * Initialize MobileLayout.
 * @param {Object} [options] — overrides _config defaults
 */
function init(options = {}) {
  Object.assign(_config, options);

  // Snapshot initial state
  _state.lastWidth      = window.innerWidth;
  _state.lastBreakpoint = _getBreakpoint();

  // 1. Inject safe-area vars
  _injectSafeAreaVars();

  // 2. Sidebar initial state
  _initSidebarState();

  // 3. Wire hamburger / overlay / sidebar buttons
  _initHamburgerListeners();

  // 4. Touch swipe (passive: false on touchmove for preventDefault)
  _on(document, 'touchstart', _handleTouchStart, { passive: true });
  _on(document, 'touchmove',  _handleTouchMove,  { passive: false });
  _on(document, 'touchend',   _handleTouchEnd,   { passive: true });

  // 5. Keyboard trap
  _on(document, 'keydown', _handleSidebarKeydown);

  // 6. Viewport resize
  _on(window, 'resize', _handleResize, { passive: true });

  // 7. Orientation change
  _on(window, 'orientationchange', _handleOrientationChange, { passive: true });

  // 8. Page visibility
  _on(document, 'visibilitychange', _handleVisibilityChange);

  // 9. Topbar scroll shadow
  _initTopbarScrollShadow();

  // 10. Table scroll detection
  _checkTableScroll();
  _initTableScrollListeners();

  // 11. Filter toggle
  _initFilterToggle();
  _updateFilterCollapseState();

  // 12. KPI intersection observer
  _initKPIObserver();

  // 13. Chart lazy-load observer
  _initChartObserver();

  // 14. Chart ResizeObserver (precise resize)
  _initChartResizeObserver();

  // 15. Update topbar height var
  _updateTopbarHeight();

  // 16. Global function exposure
  _exposeGlobals();

  // Initial chart resize signal
  _signalChartResize();
}

/**
 * Tear down all event listeners and observers.
 * Call before SPA page transitions or testing teardown.
 */
function destroy() {
  // Close sidebar if open
  if (_state.sidebarOpen) closeSidebar();

  // Remove all event listeners
  _offAll();

  // Disconnect all observers
  _state.observers.forEach(obs => {
    if (obs && typeof obs.disconnect === 'function') obs.disconnect();
  });
  _state.observers.length = 0;

  // Clean up globals
  delete window.openSidebar;
  delete window.closeSidebar;
  delete window.toggleSidebar;

  // Reset state
  _state.sidebarOpen    = false;
  _state.lastWidth      = 0;
  _state.lastBreakpoint = '';
}


// ─────────────────────────────────────────────────────────────
// SECTION 21 — PUBLIC API OBJECT
// ─────────────────────────────────────────────────────────────

const MobileLayout = Object.freeze({
  init,
  destroy,
  openSidebar,
  closeSidebar,
  toggleSidebar,
  scrollTo,
  getBreakpoint: () => _getBreakpoint(),
  isMobile:      () => _isMobileMode(),
  isOpen:        () => _state.sidebarOpen,
  signalChartResize: _signalChartResize,
});


// ─────────────────────────────────────────────────────────────
// SECTION 22 — AUTO-INIT (IIFE)
// Runs when DOM is ready; can be disabled by setting
// window.MOBILE_LAYOUT_NO_AUTO_INIT = true before this script.
// ─────────────────────────────────────────────────────────────

(function autoInit() {
  if (typeof window === 'undefined') return;           // SSR guard
  if (window.MOBILE_LAYOUT_NO_AUTO_INIT) return;       // opt-out flag

  function boot() {
    MobileLayout.init();

    // Expose to global scope
    window.MobileLayout = MobileLayout;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();


// ─────────────────────────────────────────────────────────────
// SECTION 23 — MODULE EXPORTS
// ─────────────────────────────────────────────────────────────

// ESM
export { MobileLayout };
export default MobileLayout;

// CJS / GAS-compatible fallback
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MobileLayout };
}
