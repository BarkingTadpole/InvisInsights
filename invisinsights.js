(function (window, document) {
  if (window.invisinsights) {
    return;
  }

  var defaultConfig = {
    endpoint: '/collect',
    sessionTimeoutMs: 30 * 60 * 1000,
    idleThresholdMs: 3000,
    hoverThresholdMs: 800,
    scrollReversalWindowMs: 600,
    rereadWindowMs: 15000,
    rageClickWindowMs: 800,
    rageClickRadiusPx: 24,
    jitterAngleRad: 1.7,
    jitterMoveWindowMs: 120,
    ctaProximityPx: 120,
    projectKey: null,
    devMode: false,
    enableAutoSetup: true
  };

  var config = (function () {
    var userConfig = window.invisinsightsConfig || {};
    var merged = {};
    Object.keys(defaultConfig).forEach(function (key) {
      merged[key] = defaultConfig[key];
    });
    Object.keys(userConfig).forEach(function (key) {
      merged[key] = userConfig[key];
    });
    if (!userConfig.endpoint) {
      var host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        merged.endpoint = 'http://localhost:3000/collect';
      }
    }
    return merged;
  })();

  function isOwnerMode() {
    return (
      config.devMode === true ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
    );
  }

  function getScriptProjectKey() {
    var current = document.currentScript;
    if (current && current.getAttribute) {
      var key = current.getAttribute('data-project-key');
      if (key) {
        return key;
      }
    }
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var script = scripts[i];
      if (!script || !script.getAttribute) {
        continue;
      }
      var src = script.getAttribute('src') || '';
      if (src.indexOf('invisinsights') !== -1) {
        var attr = script.getAttribute('data-project-key');
        if (attr) {
          return attr;
        }
      }
    }
    return null;
  }

  function getProjectKey() {
    return config.projectKey || window.invisinsightsProjectKey || getScriptProjectKey();
  }

  function getApiBase() {
    if (typeof config.endpoint !== 'string') {
      return '';
    }
    if (config.endpoint.indexOf('http') !== 0) {
      return '';
    }
    try {
      return new URL(config.endpoint).origin;
    } catch (e) {
      return '';
    }
  }

  function resolveApiUrl(path) {
    var base = getApiBase();
    return base ? base + path : path;
  }

  function now() {
    return Date.now();
  }

  function generateId() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return 'sess_' + Math.random().toString(36).slice(2) + '_' + now().toString(36);
  }

  function getOrCreateSessionId() {
    try {
      var existing = window.sessionStorage.getItem('ifai_sid');
      if (existing) {
        return existing;
      }
      var sid = generateId();
      window.sessionStorage.setItem('ifai_sid', sid);
      return sid;
    } catch (e) {
      return generateId();
    }
  }

  function isDisabled(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    if (el.disabled) {
      return true;
    }
    var aria = el.getAttribute('aria-disabled');
    if (aria && aria.toLowerCase() === 'true') {
      return true;
    }
    if (el.closest && el.closest('[disabled], [aria-disabled="true"]')) {
      return true;
    }
    return false;
  }

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'label') {
      return true;
    }
    var role = el.getAttribute('role');
    if (role && /button|link|tab|menuitem/.test(role.toLowerCase())) {
      return true;
    }
    if (el.tabIndex >= 0) {
      return true;
    }
    if (typeof el.onclick === 'function') {
      return true;
    }
    return false;
  }

  function isLabelOrIcon(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'label' || tag === 'svg' || tag === 'i' || tag === 'img') {
      return true;
    }
    var cls = (el.className || '').toString().toLowerCase();
    if (cls.indexOf('icon') !== -1) {
      return true;
    }
    if (el.getAttribute && el.getAttribute('aria-label')) {
      return true;
    }
    return false;
  }

  function isCTA(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') {
      return true;
    }
    if (tag === 'input') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button') {
        return true;
      }
    }
    if (tag === 'a' && el.getAttribute('href')) {
      return true;
    }
    var role = el.getAttribute('role');
    if (role && role.toLowerCase() === 'button') {
      return true;
    }
    var cls = (el.className || '').toString().toLowerCase();
    if (cls.indexOf('cta') !== -1 || cls.indexOf('primary') !== -1) {
      return true;
    }
    if (el.hasAttribute('data-cta')) {
      return true;
    }
    return false;
  }

  function summarizeElement(el) {
    if (!el || el.nodeType !== 1) {
      return null;
    }
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      type: el.getAttribute('type') || null,
      disabled: isDisabled(el),
      interactive: isInteractive(el)
    };
  }

  function loadNavState() {
    try {
      var raw = window.sessionStorage.getItem('ifai_nav');
      if (!raw) {
        return { paths: {}, order: [] };
      }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { paths: {}, order: [] };
      }
      return parsed;
    } catch (e) {
      return { paths: {}, order: [] };
    }
  }

  function saveNavState(state) {
    try {
      window.sessionStorage.setItem('ifai_nav', JSON.stringify(state));
    } catch (e) {
      return;
    }
  }

  var state = {
    sessionId: getOrCreateSessionId(),
    pageStartTs: now(),
    lastActiveTs: now(),
    idleStartTs: 0,
    idleDurations: [],
    scrollReversalCount: 0,
    rereadCount: 0,
    hoverLongCount: 0,
    ctaHesitationCount: 0,
    rageClickCount: 0,
    disabledClickCount: 0,
    nonInteractiveClickCount: 0,
    mouseMoves: 0,
    jitterEvents: 0,
    lastVector: null,
    lastMoveTs: 0,
    lastMousePos: null,
    lastInteraction: null,
    lastInteractionTs: 0,
    sendQueued: false,
    navLoopCount: 0,
    revisitPaths: [],
    lastRageTs: 0,
    lastScrollDir: null,
    lastScrollY: window.scrollY || 0,
    lastScrollDirChangeTs: 0,
    sectionVisits: new Map(),
    recentClicks: [],
    sentFinal: false,
    projectKey: getProjectKey(),
    unloading: false
  };

  function markActivity(el) {
    var ts = now();
    if (state.idleStartTs) {
      state.idleDurations.push(ts - state.idleStartTs);
      state.idleStartTs = 0;
    }
    state.lastActiveTs = ts;
    if (el) {
      state.lastInteraction = summarizeElement(el);
      state.lastInteractionTs = ts;
    }
  }

  function onIdleCheck() {
    var ts = now();
    if (!state.idleStartTs && ts - state.lastActiveTs >= config.idleThresholdMs) {
      state.idleStartTs = ts;
    }
  }

  function onScroll() {
    var y = window.scrollY || 0;
    var dir = y >= state.lastScrollY ? 'down' : 'up';
    var ts = now();
    if (state.lastScrollDir && dir !== state.lastScrollDir) {
      if (ts - state.lastScrollDirChangeTs <= config.scrollReversalWindowMs) {
        state.scrollReversalCount += 1;
      }
      state.lastScrollDirChangeTs = ts;
    }
    state.lastScrollDir = dir;
    state.lastScrollY = y;

    var sectionSize = Math.max(window.innerHeight * 0.8, 1);
    var sectionIndex = Math.floor(y / sectionSize);
    var lastVisit = state.sectionVisits.get(sectionIndex);
    if (lastVisit && ts - lastVisit <= config.rereadWindowMs) {
      state.rereadCount += 1;
    }
    state.sectionVisits.set(sectionIndex, ts);

    markActivity(null);
  }

  function onMouseMove(e) {
    var ts = now();
    var x = e.clientX;
    var y = e.clientY;
    state.lastMousePos = { x: x, y: y };

    if (state.lastMoveTs) {
      var dt = ts - state.lastMoveTs;
      if (dt > 0) {
        var dx = x - state.lastVector.x;
        var dy = y - state.lastVector.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        var prevDx = state.lastVector.dx;
        var prevDy = state.lastVector.dy;
        var prevLen = Math.sqrt(prevDx * prevDx + prevDy * prevDy) || 1;
        var dot = dx * prevDx + dy * prevDy;
        var angle = Math.acos(Math.min(1, Math.max(-1, dot / (len * prevLen || 1))));
        state.mouseMoves += 1;
        if (angle > config.jitterAngleRad && dt <= config.jitterMoveWindowMs) {
          state.jitterEvents += 1;
        }
        state.lastVector = { x: x, y: y, dx: dx, dy: dy };
      }
    } else {
      state.lastVector = { x: x, y: y, dx: 0, dy: 0 };
    }

    state.lastMoveTs = ts;
    markActivity(null);
  }

  function onClick(e) {
    var ts = now();
    var x = e.clientX;
    var y = e.clientY;
    var el = e.target;

    var isDisabledClick = isDisabled(el);
    if (isDisabledClick) {
      state.disabledClickCount += 1;
    } else if (!isInteractive(el)) {
      state.nonInteractiveClickCount += 1;
    }

    state.recentClicks.push({ x: x, y: y, ts: ts });
    state.recentClicks = state.recentClicks.filter(function (item) {
      return ts - item.ts <= config.rageClickWindowMs;
    });

    var nearbyCount = 0;
    for (var i = 0; i < state.recentClicks.length; i += 1) {
      var click = state.recentClicks[i];
      var dx = click.x - x;
      var dy = click.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= config.rageClickRadiusPx) {
        nearbyCount += 1;
      }
    }

    if (nearbyCount >= 3 && ts - state.lastRageTs > config.rageClickWindowMs) {
      state.rageClickCount += 1;
      state.lastRageTs = ts;
    }

    markActivity(el);
  }

  var hoverStarts = new WeakMap();

  function onMouseOver(e) {
    var el = e.target;
    if (isLabelOrIcon(el) || isCTA(el)) {
      hoverStarts.set(el, now());
    }
  }

  function onMouseOut(e) {
    var el = e.target;
    var start = hoverStarts.get(el);
    if (start) {
      var duration = now() - start;
      if (duration >= config.hoverThresholdMs) {
        state.hoverLongCount += 1;
        if (isCTA(el)) {
          state.ctaHesitationCount += 1;
        }
      }
      hoverStarts.delete(el);
    }
  }

  function onKeydown(e) {
    markActivity(e.target);
  }

  function onTouchStart(e) {
    markActivity(e.target);
  }

  function getNearestCtaDistance() {
    if (!state.lastMousePos) {
      return null;
    }
    var candidates = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[href], [data-cta], .cta, .primary');
    if (!candidates.length) {
      return null;
    }
    var minDist = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var rect = candidates[i].getBoundingClientRect();
      var dx = 0;
      if (state.lastMousePos.x < rect.left) {
        dx = rect.left - state.lastMousePos.x;
      } else if (state.lastMousePos.x > rect.right) {
        dx = state.lastMousePos.x - rect.right;
      }
      var dy = 0;
      if (state.lastMousePos.y < rect.top) {
        dy = rect.top - state.lastMousePos.y;
      } else if (state.lastMousePos.y > rect.bottom) {
        dy = state.lastMousePos.y - rect.bottom;
      }
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (minDist === null || dist < minDist) {
        minDist = dist;
      }
    }
    return minDist;
  }

  function computeNavigationLoops() {
    var navState = loadNavState();
    var path = window.location.pathname + window.location.search;
    var count = navState.paths[path] || 0;
    navState.paths[path] = count + 1;
    navState.order.push({ path: path, ts: now() });
    saveNavState(navState);
    if (count > 0) {
      state.navLoopCount = count;
      state.revisitPaths = [path];
    }
  }

  function average(list) {
    if (!list.length) {
      return 0;
    }
    var total = 0;
    for (var i = 0; i < list.length; i += 1) {
      total += list[i];
    }
    return Math.round(total / list.length);
  }

  function buildPayload() {
    var ts = now();
    var timeOnPage = ts - state.pageStartTs;
    var avgHesitation = average(state.idleDurations);
    var jitterScore = state.mouseMoves ? Math.min(100, Math.round((state.jitterEvents / state.mouseMoves) * 100)) : 0;
    var ctaDistance = getNearestCtaDistance();
    var nearCta = ctaDistance !== null && ctaDistance <= config.ctaProximityPx;

    return {
      project_id: state.projectKey,
      session_id: state.sessionId,
      page_path: window.location.pathname,
      page_query: window.location.search || '',
      user_agent_hint: navigator.userAgent ? navigator.userAgent.split(')')[0] + ')' : null,
      timestamp_ms: ts,
      time_on_page_ms: timeOnPage,
      avg_hesitation_time_ms: avgHesitation,
      idle_hesitation_count: state.idleDurations.length,
      rage_click_count: state.rageClickCount,
      scroll_reversal_count: state.scrollReversalCount,
      reread_section_count: state.rereadCount,
      long_hover_count: state.hoverLongCount,
      disabled_click_count: state.disabledClickCount,
      noninteractive_click_count: state.nonInteractiveClickCount,
      mouse_jitter_score: jitterScore,
      navigation_loop_count: state.navLoopCount,
      cta_hesitation: state.ctaHesitationCount,
      last_interaction: state.lastInteraction,
      inferred_abandonment_context: {
        last_interaction_ts: state.lastInteractionTs || null,
        near_cta_before_exit: nearCta,
        cta_distance_px: ctaDistance,
        time_on_page_ms: timeOnPage,
        idle_periods: state.idleDurations.length,
        disabled_clicks: state.disabledClickCount,
        noninteractive_clicks: state.nonInteractiveClickCount,
        scroll_reversals: state.scrollReversalCount,
        rage_clicks: state.rageClickCount
      }
    };
  }

  function sendPayload(reason, isFinal) {
    if (state.sentFinal && isFinal) {
      return;
    }
    if (isFinal) {
      state.sentFinal = true;
    }
    var payload = buildPayload();
    payload.session_end_reason = reason || 'unknown';

    var body = JSON.stringify(payload);
    if (!state.projectKey) {
      return;
    }
    try {
      fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Invis-Project-Key': state.projectKey
        },
        body: body,
        keepalive: true,
        credentials: 'omit'
      });
    } catch (e) {
      return;
    }
  }

  function init() {
    computeNavigationLoops();

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('click', onClick, true);
    window.addEventListener('mouseover', onMouseOver, true);
    window.addEventListener('mouseout', onMouseOut, true);
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('touchstart', onTouchStart, { passive: true });

    window.addEventListener('beforeunload', function () {
      state.unloading = true;
      sendPayload('beforeunload', true);
    });

    window.addEventListener('pagehide', function () {
      state.unloading = true;
      sendPayload('pagehide', true);
    });

    window.setInterval(onIdleCheck, 1000);
  }

  function start() {
    if (config.enableAutoSetup && isOwnerMode() && state.projectKey) {
      checkProjectStatus(function (needsSetup) {
        if (needsSetup) {
          return;
        }
        init();
      });
      return;
    }
    init();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }

  window.invisinsights = {
    getSessionId: function () {
      return state.sessionId;
    },
    getProjectKey: function () {
      return state.projectKey;
    },
    flush: function () {
      sendPayload('manual', true);
    }
  };

  var setupTriggered = false;

  function checkProjectStatus(callback) {
    if (setupTriggered || !state.projectKey) {
      if (callback) {
        callback(false);
      }
      return;
    }
    setupTriggered = true;
    var url =
      resolveApiUrl('/project-status');
    fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: { 'X-Invis-Project-Key': state.projectKey }
    })
      .then(function (res) {
        if (!res.ok) {
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) {
          if (callback) {
            callback(false);
          }
          return;
        }
        if (!data.needs_setup) {
          if (callback) {
            callback(false);
          }
          return;
        }
        var setupUrl = '/connect-surveymonkey?project_key=' + encodeURIComponent(state.projectKey);
        setupUrl = resolveApiUrl(setupUrl);
        if (callback) {
          callback(true);
        }
        var win = window.open(setupUrl, '_blank', 'noopener');
        if (!win) {
          window.location.href = setupUrl;
        }
      })
      .catch(function () {
        if (callback) {
          callback(false);
        }
        return;
      });
  }
})(window, document);
