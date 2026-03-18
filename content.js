/**
 * content.js — CloudLabs v4.2
 * Receives SHOW_STEP. Finds element. Draws glass overlay.
 * Shows step card INSTANTLY, then updates when element found.
 * Keyboard shortcuts: ← → for prev/next, Esc to hide.
 *
 * v4.2: Scored element finder, selector cache, batched DOM queries,
 *       MutationObserver-based watch, optimized isVis.
 */

var targetEl  = null;
var rafId     = null;
var watchTmr  = null;
var watchObs  = null;   // MutationObserver for watchForEl
var PAD       = 8;
var DEBUG_LOGS = false;
var _latestNavId = 0;

function dlog() {
  if (!DEBUG_LOGS) return;
  console.log.apply(console, arguments);
}

// ═══════════════════════════════════════════════════════════
// SELECTOR CACHE — remembers which selectors worked recently
// Auto-invalidated when DOM mutates significantly.
// ═══════════════════════════════════════════════════════════
var _selectorCache   = {};  // key: cacheKey(selector,text) → { el, selector, ts, score }
var _cacheGeneration = 0;   // bumped on significant DOM changes
var _domObserver     = null;
var _domQueryCache   = null;
var _domQueryTs      = 0;
var _CACHE_MAX       = 1000;  // Increased from 80 — aggressive caching for speed
var _CACHE_TTL       = 120000; // Increased from 30s to 2 min — keep matches longer

function cacheKey(selector, text) { return (selector || '') + '||' + (text || ''); }

function cacheGet(selector, text) {
  var key = cacheKey(selector, text);
  var entry = _selectorCache[key];
  if (!entry) return null;
  // Expired or stale generation
  if (Date.now() - entry.ts > _CACHE_TTL) { delete _selectorCache[key]; return null; }
  // Verify the element is still in-DOM and visible
  if (!entry.el || !document.body.contains(entry.el)) {
    delete _selectorCache[key]; return null;
  }
  // Fast visibility check (skip expensive getComputedStyle)
  if (!isVisFast(entry.el)) {
    delete _selectorCache[key]; return null;
  }
  return entry.el;
}

function cacheSet(selector, text, el) {
  if (!el) return;
  var key = cacheKey(selector, text);
  // Evict oldest if at capacity
  var keys = Object.keys(_selectorCache);
  if (keys.length >= _CACHE_MAX) {
    var oldest = keys[0]; var oldestTs = Infinity;
    for (var i = 0; i < keys.length; i++) {
      if (_selectorCache[keys[i]].ts < oldestTs) { oldest = keys[i]; oldestTs = _selectorCache[keys[i]].ts; }
    }
    delete _selectorCache[oldest];
  }
  _selectorCache[key] = { el: el, ts: Date.now() };
}

function cacheClear() {
  _selectorCache = {};
  _domQueryCache = null;
  _domQueryTs = 0;
}

// Observe DOM changes to invalidate cache on large mutations
(function initDomObserver() {
  if (_domObserver) return;
  _domObserver = new MutationObserver(function(mutations) {
    var dominated = 0;
    for (var i = 0; i < mutations.length; i++) {
      dominated += mutations[i].addedNodes.length + mutations[i].removedNodes.length;
    }
    // Only clear cache on significant changes (e.g. Azure blade navigation)
    if (dominated > 10) { cacheClear(); _cacheGeneration++; }
  });
  _domObserver.observe(document.body, { childList: true, subtree: true });
})();

chrome.runtime.onMessage.addListener(function(msg, _s, sendResponse) {
  if      (msg.type === 'SHOW_STEP')      { showStep(msg.payload); sendResponse({ ok: true }); }
  else if (msg.type === 'HIDE_OVERLAY')   { destroyAll(); sendResponse({ ok: true }); }
  else if (msg.type === 'GET_DOM_SNAPSHOT'){ sendResponse({ ok: true, snapshot: buildSnapshot() }); }
  else if (msg.type === 'CHECK_STEP_BLOCKERS') {
    sendResponse({ ok: true, blockers: checkStepBlockers(msg.payload || {}) });
  }
  else if (msg.type === 'PING')           { sendResponse({ ok: true, alive: true }); }
  return true;
});

// Keyboard shortcuts — ← → Esc
document.addEventListener('keydown', function(e) {
  if (!document.getElementById('cl-root')) return;
  if (e.key === 'ArrowRight' && !e.target.matches('input,textarea'))
    chrome.runtime.sendMessage({ type: 'NAVIGATE_STEP', payload: { index: (window._clStepIndex||0)+1 } });
  if (e.key === 'ArrowLeft'  && !e.target.matches('input,textarea'))
    chrome.runtime.sendMessage({ type: 'NAVIGATE_STEP', payload: { index: (window._clStepIndex||0)-1 } });
  if (e.key === 'Escape') destroyAll();
});

// ════════════════════════════════════════════════════════════
// SHOW STEP
// ════════════════════════════════════════════════════════════
function showStep(p) {
  var navId = Number(p.navId || 0);
  if (navId && navId < _latestNavId) {
    return;
  }
  if (navId) _latestNavId = navId;

  destroyAll();

  var selector   = p.selector   || '';
  var text       = p.text       || '';
  var fallbackText = p.fallbackText || text;
  var action     = p.action     || 'click';
  var guidance   = p.guidance   || p.description || '';
  var title      = p.title      || '';
  var stepIndex  = p.stepIndex  || 0;
  var totalSteps = p.totalSteps || 1;
  var hint       = p.hint       || '';
  var resolving   = p.resolving   || false;
  var notFound    = p.notFound    || false;
  var wrongPage   = p.wrongPage   || false;
  var navigateTo  = p.navigateTo  || '';
  var needsScroll = p.needsScroll || false;
  var errorFix    = p.errorFix    || '';
  var blocked     = !!p.blocked;
  var blockedReason = p.blockedReason || '';
  var targetCandidates = buildTargetCandidates(text, fallbackText, title, guidance, action, hint);
  var primaryTargetLabel = (targetCandidates && targetCandidates[0]) || text || title || 'the required button';

  window._clStepIndex = stepIndex;

  // ── Resolving state: show step info immediately with spinner ──
  if (resolving) {
    dlog('[showStep] Resolving step', stepIndex, 'title:', title);
    buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'resolving', '', { errorFix: '' });
    return;
  }

  // ── Wrong page ────────────────────────────────────────────────
  if (wrongPage) {
    dlog('[showStep] Wrong page detected');
    buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'wrongpage', navigateTo, { errorFix });
    return;
  }

  // If AI says not found, still attempt local detection first.
  // This avoids false negatives when element is visible but AI resolution is stale.
  if (notFound) {
    dlog('[showStep] AI flagged notFound, running local retry first');
  }

  dlog('[showStep] Finding element: selector="' + selector + '" text="' + text + '"');
  
  // ── Try to find element ────────────────────────────────────────
  var foundNow = findElementWithCandidates(selector, targetCandidates, action);
  var el = foundNow ? foundNow.el : null;
  if (el) {
    dlog('[showStep] Found element');
    mountHighlight(el, title, guidance, action, hint, stepIndex, totalSteps, { errorFix, needsScroll, blocked, blockedReason });
  } else if (needsScroll) {
    // AI says to scroll — show hint card and try after scroll
    dlog('[showStep] Element not found, trying scroll');
    buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'scroll', '', { errorFix });
    // Scroll down and retry after 600ms
    window.scrollBy({ top: window.innerHeight * 0.6, behavior: 'smooth' });
    setTimeout(function() {
      var foundAfterScroll = findElementWithCandidates(selector, targetCandidates, action);
      var el2 = foundAfterScroll ? foundAfterScroll.el : null;
      if (el2) { destroyAll(); mountHighlight(el2, title, guidance, action, hint, stepIndex, totalSteps, { errorFix }); }
      else      { buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'notfound', navigateTo, { errorFix, needsScroll: true, targetLabel: primaryTargetLabel }); }
    }, 700);
  } else if (notFound) {
    // Fast optimistic retries before honoring AI not_found response.
    buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'searching', '', { errorFix });
    watchForEl(selector, targetCandidates, action, title, guidance, hint, stepIndex, totalSteps, errorFix, navigateTo, primaryTargetLabel);
  } else {
    dlog('[showStep] Element not found, watching for it');
    buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'searching', '', { errorFix });
    watchForEl(selector, targetCandidates, action, title, guidance, hint, stepIndex, totalSteps, errorFix, navigateTo, primaryTargetLabel);
  }
}

function mountHighlight(el, title, guidance, action, hint, stepIndex, totalSteps, opts) {
  targetEl = el;
  var r = el.getBoundingClientRect();
  var inView = r.top >= 0 && r.bottom <= window.innerHeight;
  if (!inView) {
    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    setTimeout(function() {
      buildCard(el, title, guidance, action, hint, stepIndex, totalSteps, 'found', '', opts || {});
      startRaf();
    }, 100);
    return;
  }
  buildCard(el, title, guidance, action, hint, stepIndex, totalSteps, 'found', '', opts || {});
  startRaf();
}

// ════════════════════════════════════════════════════════════
// ELEMENT FINDER — 9 scored strategies + cache + fuzzy match
// Each strategy pushes { el, score } into candidates[].
// Highest score wins. Ties broken by DOM order (first match).
// Score bands: 100=perfect, 80-99=strong, 50-79=good, <50=weak
// ════════════════════════════════════════════════════════════

// Fuzzy string match: returns 0-100 score
function fuzzySimilarity(target, candidate) {
  if (!target || !candidate) return 0;
  target = target.toLowerCase().trim();
  candidate = candidate.toLowerCase().trim();
  if (target === candidate) return 100;
  if (candidate.includes(target) || target.includes(candidate)) return 85;
  // Levenshtein distance simplified: check character overlap
  var matches = 0, len = Math.min(target.length, candidate.length);
  for (var i = 0; i < len; i++) {
    if (target[i] === candidate[i]) matches++;
  }
  return Math.round((matches / Math.max(target.length, candidate.length)) * 60);
}

function findElement(selector, text, action) {
  // ── 0. Check cache first (O(1) fast path) ──
  var cached = cacheGet(selector, text);
  if (cached) {
    dlog('[findElement] Cache hit for: "' + text + '"');
    return cached;
  }

  var lowerRaw = (text || '').toLowerCase().trim();
  var lower = normalizeNeedle(lowerRaw) || lowerRaw;
  var candidates = [];  // { el, score, strategy }

  // ── Batch DOM queries once (saves 6+ querySelectorAll calls) ──
  var dom = batchQueryDOM();
  dlog('[findElement] Searching for: "' + text + '" | Action: ' + action + ' | Buttons: ' + dom.buttons.length + ' | Inputs: ' + dom.inputs.length);

  // ── 1. Exact CSS selector (highest confidence) ──
  if (selector) {
    try {
      var el = document.querySelector(selector);
      if (el && isVis(el)) {
        dlog('[findElement] Found by selector: ' + selector);
        cacheSet(selector, text, el);
        return el;  // Fast exit for perfect match
      }
    } catch (_) {}
  }

  if (lower) {
    // Prefer real tab controls early when needle looks like an Azure tab label.
    if (looksLikeTabNeedle(lowerRaw) || looksLikeTabNeedle(lower)) {
      scoredTabText(lower, dom.buttons, candidates);
      var tabHit = pickBestCandidate(candidates, 96);
      if (tabHit) {
        cacheSet(selector, text, tabHit.el);
        return tabHit.el;
      }
    }

    // ── 2. Input-specific search for type/select actions ──
    if (action === 'type' || action === 'select') {
      scoredInputSearch(lower, dom.inputs, dom.labels, candidates, 95);
    }

    // ── 3. Exact button text (highest priority for quick match) ──
    scoredButtonText(lower, dom.buttons, candidates);
    var perfect = pickBestCandidate(candidates, 100);
    if (perfect) {
      dlog('[findElement] Perfect match after button scan');
      cacheSet(selector, text, perfect.el);
      return perfect.el;
    }

    // ── 4. Aria-label exact match ──
    scoredAriaLabel(lower, dom.ariaEls, candidates, true);
    perfect = pickBestCandidate(candidates, 100);
    if (perfect) {
      dlog('[findElement] Perfect match after aria scan');
      cacheSet(selector, text, perfect.el);
      return perfect.el;
    }

    // ── 5. Azure Fluent UI span scan ──
    scoredFluentScan(lower, dom.fluentLabels, candidates);

    // ── 6. Aria-label contains ──
    scoredAriaLabel(lower, dom.ariaEls, candidates, false);

    // ── 7. Input by label/placeholder (fallback for non-type actions) ──
    if (action !== 'type' && action !== 'select') {
      scoredInputSearch(lower, dom.inputs, dom.labels, candidates, 55);
    }

    // ── 8. title attribute match ──
    scoredTitleAttr(lower, dom.buttons, candidates);

    // ── 9. Expensive text walk only when nothing else matched ──
    if (candidates.length === 0 && lower.length > 2) {
      scoredTextWalk(lower, candidates);
    }
  }

  var bestHit = pickBestCandidate(candidates, 45);
  if (!bestHit) {
    dlog('[findElement] No candidates found for: "' + text + '"');
    return null;
  }

  var best = bestHit.el;
  dlog('[findElement] Found by strategy: ' + bestHit.strategy + ' (score: ' + bestHit.score + ')');

  // ── Cache the winner ──
  cacheSet(selector, text, best);
  return best;
}

function findElementWithCandidates(selector, candidates, action) {
  if (!candidates || !candidates.length) return null;
  for (var i = 0; i < candidates.length; i++) {
    var needle = candidates[i];
    if (!needle) continue;
    var sel = i === 0 ? selector : '';
    var el = findElement(sel, needle, action);
    if (el) return { el: el, needle: needle };
  }
  return null;
}

function buildTargetCandidates(text, fallbackText, title, guidance, action, hint) {
  var out = [];
  function push(v) {
    v = String(v || '').trim();
    if (!v) return;
    if (v.length > 80) return;
    if (out.indexOf(v) >= 0) return;
    out.push(v);
  }

  push(text);
  push(fallbackText);

  extractUiTargets(text).forEach(push);
  extractUiTargets(fallbackText).forEach(push);

  var cleanedTitle = normalizeNeedle(title || '');
  if (cleanedTitle && cleanedTitle.length <= 40) push(cleanedTitle);
  extractUiTargets(title).forEach(push);
  extractUiTargets(hint).forEach(push);

  // For field steps, guidance often includes the real label phrase.
  if (action === 'type' || action === 'select') {
    var cleanedGuide = normalizeNeedle((guidance || '').split(/[.!?]/)[0] || '');
    if (cleanedGuide && cleanedGuide.length <= 60) push(cleanedGuide);
    extractUiTargets(guidance).forEach(push);
  } else {
    extractUiTargets(guidance).forEach(push);
  }

  return out.slice(0, 8);
}

function extractUiTargets(text) {
  text = String(text || '');
  if (!text) return [];
  var found = [];
  function add(v) {
    v = String(v || '').trim();
    if (!v || v.length > 40) return;
    if (found.indexOf(v) >= 0) return;
    found.push(v);
  }

  // Pull explicit quoted labels: "Basics", 'Subscription', `Review + create`.
  var quoted = text.match(/["'`][^"'`]{2,40}["'`]/g) || [];
  for (var i = 0; i < quoted.length; i++) {
    add(quoted[i].slice(1, -1));
  }

  // Common Azure create-wizard tabs.
  var tabs = ['Basics', 'Disks', 'Networking', 'Management', 'Monitoring', 'Advanced', 'Tags', 'Review + create'];
  var low = text.toLowerCase();
  for (var t = 0; t < tabs.length; t++) {
    if (low.indexOf(tabs[t].toLowerCase()) >= 0) add(tabs[t]);
  }

  // Frequent field labels that show up in Azure forms.
  var fields = ['Subscription', 'Resource group', 'Region', 'Name', 'Storage account name', 'Virtual machine size', 'Size'];
  for (var f = 0; f < fields.length; f++) {
    if (low.indexOf(fields[f].toLowerCase()) >= 0) add(fields[f]);
  }

  return found;
}

function looksLikeTabNeedle(lower) {
  lower = String(lower || '').toLowerCase();
  return /\bbasics\b|\bdisks\b|\bnetworking\b|\bmanagement\b|\bmonitoring\b|\badvanced\b|\btags\b|review\s*\+\s*create/.test(lower);
}

// ════════════════════════════════════════════════════════════
// BATCHED DOM QUERIES — single pass, shared across strategies
// ════════════════════════════════════════════════════════════
function batchQueryDOM() {
  // Reuse DOM query results for a very short window during retry loops.
  var now = Date.now();
  if (_domQueryCache && (now - _domQueryTs) < 120) {
    return _domQueryCache;
  }

  _domQueryCache = {
    buttons:     document.querySelectorAll('button,a[href],[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="link"]'),
    inputs:      document.querySelectorAll('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"]'),
    labels:      document.querySelectorAll('label'),
    ariaEls:     document.querySelectorAll('[aria-label]'),
    fluentLabels:document.querySelectorAll('.ms-Button-label,[class*="label"],[class*="Label"],[class*="buttonText"]'),
  };
  _domQueryTs = now;
  return _domQueryCache;
}

function pickBestCandidate(candidates, minScore) {
  if (!candidates || candidates.length === 0) return null;

  // Deduplicate by element keeping the highest score per element.
  var byEl = new Map();
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!c || !c.el || !isVisFast(c.el)) continue;
    var cur = byEl.get(c.el);
    if (!cur || c.score > cur.score) byEl.set(c.el, c);
  }

  var list = Array.from(byEl.values());
  if (list.length === 0) return null;

  list.sort(function(a, b) { return b.score - a.score; });
  var top = list[0];
  if (typeof minScore === 'number' && top.score < minScore) return null;
  return top;
}

// ════════════════════════════════════════════════════════════
// SCORED STRATEGY HELPERS
// Each pushes { el, score, strategy } into candidates array.
// ════════════════════════════════════════════════════════════

// Strategy 3: Exact button text + fuzzy matching
function scoredButtonText(lower, buttons, candidates) {
  for (var i = 0; i < buttons.length; i++) {
    var n = buttons[i]; if (!isVis(n)) continue;
    var txt = getText(n).toLowerCase().trim();
    if (!txt) continue;
    if (txt === lower) {
      candidates.push({ el: nearBtn(n), score: 100, strategy: 'btnExact' });
    } else if (txt === '+ ' + lower || txt === '+' + lower) {
      candidates.push({ el: nearBtn(n), score: 98, strategy: 'btnPlus' });
    } else {
      // Fuzzy match for close matches and partial matches
      var fuzzyScore = fuzzySimilarity(lower, txt);
      if (fuzzyScore > 70) {  // Only include decent matches
        candidates.push({ el: nearBtn(n), score: fuzzyScore, strategy: 'btnFuzzy' });
      } else if (txt.length < 60 && txt.includes(lower) && lower.length > 3) {
        // Fallback to substring match with lower score
        var ratio = lower.length / txt.length;
        candidates.push({ el: nearBtn(n), score: Math.round(40 + ratio * 25), strategy: 'btnPartial' });
      }
    }
  }
}

// Strategy: explicit tab matching for Azure wizard tabs.
function scoredTabText(lower, buttons, candidates) {
  var normalizedNeedle = normalizeNeedle(lower);
  for (var i = 0; i < buttons.length; i++) {
    var n = buttons[i]; if (!isVis(n)) continue;
    var role = (n.getAttribute('role') || '').toLowerCase();
    var txt = normalizeNeedle(getText(n));
    if (!txt) continue;
    if (role === 'tab' && txt === normalizedNeedle) {
      candidates.push({ el: n, score: 100, strategy: 'tabExact' });
    } else if (role === 'tab' && txt.includes(normalizedNeedle) && normalizedNeedle.length > 2) {
      candidates.push({ el: n, score: 96, strategy: 'tabContains' });
    }
  }
}

// Strategy 4 & 6: Aria-label (exact flag controls score)
function scoredAriaLabel(lower, ariaEls, candidates, exactOnly) {
  for (var i = 0; i < ariaEls.length; i++) {
    var e = ariaEls[i]; if (!isVis(e)) continue;
    var label = (e.getAttribute('aria-label') || '').toLowerCase();
    if (!label) continue;
    if (label === lower) {
      candidates.push({ el: e, score: 85, strategy: 'ariaExact' });
    } else if (!exactOnly && label.includes(lower) && lower.length > 2) {
      var ratio = lower.length / label.length;
      candidates.push({ el: e, score: Math.round(40 + ratio * 30), strategy: 'ariaContains' });
    }
  }
}

// Strategy 5: Azure Fluent UI span scan
function scoredFluentScan(lower, fluentLabels, candidates) {
  for (var i = 0; i < fluentLabels.length; i++) {
    var sp = fluentLabels[i]; if (!isVis(sp)) continue;
    var txt = getText(sp).toLowerCase();
    if (!txt) continue;
    if (txt === lower) {
      candidates.push({ el: nearBtn(sp) || sp, score: 82, strategy: 'fluentExact' });
    } else if (txt.includes(lower) && lower.length > 2) {
      var ratio = lower.length / txt.length;
      candidates.push({ el: nearBtn(sp) || sp, score: Math.round(45 + ratio * 30), strategy: 'fluentPartial' });
    }
  }
}

// Strategy 2 & 7: Input search (by aria-label, placeholder, or <label>)
function scoredInputSearch(lower, inputs, labels, candidates, baseScore) {
  var normalized = normalizeNeedle(lower);
  var needleTokens = tokenizeNeedle(normalized || lower);
  for (var i = 0; i < inputs.length; i++) {
    var n = inputs[i]; if (!isVis(n)) continue;
    var aria = (n.getAttribute('aria-label') || '').toLowerCase();
    var ph   = (n.getAttribute('placeholder') || '').toLowerCase();
    var idv  = (n.getAttribute('id') || '').toLowerCase();
    var name = (n.getAttribute('name') || '').toLowerCase();
    var haystack = (aria + ' ' + ph + ' ' + idv + ' ' + name).trim();
    var overlap = tokenOverlapScore(needleTokens, haystack);
    if (aria === lower || ph === lower || aria === normalized || ph === normalized) {
      candidates.push({ el: n, score: baseScore, strategy: 'inputExact' });
    } else if (
      (aria && (aria.includes(lower) || aria.includes(normalized))) ||
      (ph && (ph.includes(lower) || ph.includes(normalized))) ||
      (idv && (idv.includes(lower.replace(/\s+/g, '')) || idv.includes(normalized.replace(/\s+/g, '')))) ||
      (name && (name.includes(lower.replace(/\s+/g, '')) || name.includes(normalized.replace(/\s+/g, ''))))
    ) {
      candidates.push({ el: n, score: baseScore - 10, strategy: 'inputPartial' });
    } else if (overlap >= 70) {
      candidates.push({ el: n, score: baseScore - 12, strategy: 'inputToken' });
    }
  }
  // Also check <label for="…"> associations
  for (var i = 0; i < labels.length; i++) {
    var lbl = labels[i]; if (!isVis(lbl)) continue;
    var lblTxt = getText(lbl).toLowerCase();
    var lblOverlap = tokenOverlapScore(needleTokens, lblTxt);
    if (lblTxt.includes(lower) || lblTxt.includes(normalized) || lblOverlap >= 70) {
      var fid = lbl.getAttribute('for');
      if (fid) { var inp = document.getElementById(fid); if (inp && isVis(inp)) { candidates.push({ el: inp, score: baseScore - 5, strategy: 'inputLabel' }); continue; } }
      var inp2 = lbl.querySelector('input,select,textarea');
      if (inp2 && isVis(inp2)) candidates.push({ el: inp2, score: baseScore - 8, strategy: 'inputLabelChild' });
    }
  }
}

// Strategy 8: title attribute match (new — catches Azure tooltips)
function scoredTitleAttr(lower, buttons, candidates) {
  for (var i = 0; i < buttons.length; i++) {
    var n = buttons[i]; if (!isVis(n)) continue;
    var title = (n.getAttribute('title') || '').toLowerCase();
    if (!title) continue;
    if (title === lower) {
      candidates.push({ el: n, score: 70, strategy: 'titleExact' });
    } else if (title.includes(lower) && lower.length > 3) {
      candidates.push({ el: n, score: 55, strategy: 'titleContains' });
    }
  }
}

// Strategy 9: Broad text walk (TreeWalker — most expensive, only if no candidates yet)
function scoredTextWalk(lower, candidates) {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: function(n) {
      // Skip invisible, script, style, and our overlay
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (n.id === 'cl-root') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var bestPartial = null;
  var bestPartialLen = Infinity;
  while (walker.nextNode()) {
    var n = walker.currentNode;
    if (!isVisFast(n)) continue;  // use fast-path check here
    var t = getText(n).toLowerCase();
    if (!t || t.length > 200) continue;
    if (t === lower) {
      candidates.push({ el: nearBtn(n), score: 45, strategy: 'walkExact' });
      return; // exact walk match found, good enough
    }
    // Track best partial (shortest containing text = most specific match)
    if (t.includes(lower) && t.length < bestPartialLen) {
      bestPartial = n;
      bestPartialLen = t.length;
    }
  }
  if (bestPartial) {
    var ratio = lower.length / bestPartialLen;
    candidates.push({ el: nearBtn(bestPartial), score: Math.round(20 + ratio * 20), strategy: 'walkPartial' });
  }
}

// ── nearBtn: walk up to find nearest interactive ancestor ──
function nearBtn(el) {
  var cur = el;
  for (var i = 0; i < 6; i++) {
    if (!cur || cur === document.body) break;
    var tag = (cur.tagName || '').toLowerCase();
    var role = cur.getAttribute ? (cur.getAttribute('role') || '') : '';
    if (['button','a','select','input','textarea'].indexOf(tag) >= 0 ||
        ['button','link','menuitem','option','tab','checkbox','radio','switch'].indexOf(role) >= 0) return cur;
    cur = cur.parentElement;
  }
  return el;
}

// ════════════════════════════════════════════════════════════
// WATCH FOR ELEMENT — MutationObserver + exponential backoff
// Reacts to DOM changes instead of blind polling, with a
// fallback timer for CSS-only reveals (no DOM mutation).
// ════════════════════════════════════════════════════════════
function watchForEl(selector, candidates, action, title, guidance, hint, stepIndex, totalSteps, errorFix, navigateTo, targetLabel) {
  stopWatch();
  var tries    = 0;
  var maxTries = 8;  // Be patient with Azure blade rendering
  var delay    = 100;
  var firstNeedle = (candidates && candidates[0]) || '';

  function attempt() {
    tries++;
    dlog('[watchForEl] Attempt ' + tries + '/' + maxTries + ' for: "' + firstNeedle + '"');
    var found = findElementWithCandidates(selector, candidates || [], action);
    var el = found ? found.el : null;
    if (el) {
      dlog('[watchForEl] Found on attempt ' + tries);
      stopWatch();
      destroyAll();
      mountHighlight(el, title, guidance, action, hint, stepIndex, totalSteps, { errorFix: errorFix || '' });
      return;
    }
    if (tries === 1 || tries === 3 || tries === 5) {
      // Periodic nudges help when element is rendered below fold.
      dlog('[watchForEl] Attempt ' + tries + ' missed, scrolling...');
      window.scrollBy({ top: Math.round(window.innerHeight * 0.5), behavior: 'auto' });
    }
    if (tries >= maxTries) {
      dlog('[watchForEl] Max retries reached, giving up');
      stopWatch();
      buildCard(null, title, guidance, action, hint, stepIndex, totalSteps, 'notfound', navigateTo || '', {
        errorFix: errorFix || '',
        needsScroll: true,
        targetLabel: targetLabel || firstNeedle || ''
      });
      return;
    }
    // Exponential backoff: 100ms → 200ms → 300ms → 400ms
    delay = 100 * tries;
    watchTmr = setTimeout(attempt, delay);
  }

  // React to DOM mutations — re-attempt immediately when Azure renders new content
  watchObs = new MutationObserver(function(mutations) {
    var dominated = 0;
    for (var i = 0; i < mutations.length; i++) {
      dominated += mutations[i].addedNodes.length;
    }
    if (dominated < 1) return;
    dlog('[watchForEl] DOM mutation detected, retrying...');
    if (watchTmr) { clearTimeout(watchTmr); watchTmr = null; }
    attempt();
  });
  watchObs.observe(document.body, { childList: true, subtree: true });

  // Kick off first attempt immediately
  attempt();
}

function normalizeNeedle(s) {
  s = String(s || '').toLowerCase();
  s = s.replace(/[\"'`]/g, ' ');
  s = s.replace(/\b(click|select|choose|open|enter|type|fill|set|provide|pick)\b/g, ' ');
  s = s.replace(/\b(field|input|textbox|dropdown|option|button)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokenizeNeedle(s) {
  s = String(s || '').toLowerCase().trim();
  if (!s) return [];
  var tokens = s.split(/\s+/).filter(function(t) {
    return t && t.length > 2 && !/^(the|and|for|with|from|into|this|that|your|you)$/.test(t);
  });
  return Array.from(new Set(tokens));
}

function tokenOverlapScore(tokens, haystack) {
  if (!tokens || tokens.length === 0) return 0;
  haystack = String(haystack || '').toLowerCase();
  if (!haystack) return 0;
  var hits = 0;
  for (var i = 0; i < tokens.length; i++) {
    if (haystack.includes(tokens[i])) hits++;
  }
  return Math.round((hits / tokens.length) * 100);
}

function stopWatch() {
  if (watchTmr) { clearTimeout(watchTmr); watchTmr = null; }
  if (watchObs) { watchObs.disconnect(); watchObs = null; }
}

// ════════════════════════════════════════════════════════════
// VISIBILITY CHECKS
// isVisFast: cheap dimension check only (NO getComputedStyle)
// isVis: full check with computed style (used sparingly)
// ════════════════════════════════════════════════════════════
function isVisFast(el) {
  if (!el || !(el instanceof Element)) return false;
  var r = el.getBoundingClientRect();
  // Must have non-zero dimensions AND be in viewport range
  return r.width > 0 && r.height > 0 && r.bottom > -50 && r.top < window.innerHeight + 50;
}

function isVis(el) {
  if (!el || !(el instanceof Element)) return false;
  try {
    // Fast-path: zero dimensions ⇒ invisible
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // Viewport check (allow 50px outside viewport for partially scrolled elements)
    if (r.bottom < -50 || r.top > window.innerHeight + 50) return false;
    // Computed style check (only when needed) — use cached getComputedStyle when possible
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  } catch (_) { return false; }
}

function getText(el) {
  return (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
}

// ════════════════════════════════════════════════════════════
// OVERLAY BUILDER
// state: 'found' | 'resolving' | 'searching' | 'notfound' | 'wrongpage'
// ════════════════════════════════════════════════════════════
function buildCard(el, title, guidance, action, hint, stepIndex, totalSteps, state, extra, opts) {
  opts = opts || {};
  var root = document.createElement('div');
  root.id = 'cl-root';

  if (el) {
    var bd = document.createElement('div');
    bd.className = 'cl-backdrop'; bd.id = 'cl-backdrop';
    root.appendChild(bd);
    var ring = document.createElement('div');
    ring.className = 'cl-ring'; ring.id = 'cl-ring';
    root.appendChild(ring);
  }

  var card = document.createElement('div');
  card.id = 'cl-card';
  card.className = 'cl-card' + (el ? '' : ' cl-card--float') +
    (state === 'notfound' || state === 'wrongpage' ? ' cl-card--warn' : '');
  card.innerHTML = cardHTML(title, guidance, action, hint, stepIndex, totalSteps, state, extra, opts);
  root.appendChild(card);

  document.body.appendChild(root);

  requestAnimationFrame(function() {
    var b = document.getElementById('cl-backdrop');
    var r = document.getElementById('cl-ring');
    var c = document.getElementById('cl-card');
    if (b) b.classList.add('cl-on');
    if (r) r.classList.add('cl-on');
    if (c) c.classList.add('cl-on');
  });
}

function cardHTML(title, guidance, action, hint, stepIndex, totalSteps, state, extra, opts) {
  opts = opts || {};
  var ICONS = { click:'👆', type:'⌨️', select:'☑️', navigate:'🔗', wait:'⏳', verify:'✅', scroll:'📜' };
  var icon = ICONS[action] || '➡️';
  var pct  = totalSteps > 1 ? Math.round((stepIndex / (totalSteps - 1)) * 100) : 0;

  // Status strip below description
  var strip = '';
  if (state === 'resolving') {
    strip = '<div class="cl-strip cl-strip--spin"><div class="cl-spinner"></div>Finding element on page…</div>';
  } else if (state === 'searching') {
    strip = '<div class="cl-strip cl-strip--spin"><div class="cl-spinner"></div>Searching for element…</div>';
  } else if (state === 'notfound') {
    var targetLabel = opts.targetLabel ? ' Look for <strong>' + esc(opts.targetLabel) + '</strong>.' : '';
    strip = '<div class="cl-strip cl-strip--warn">⚠️ Element not found. ' +
      (extra ? 'Navigate to: <strong>' + esc(extra) + '</strong>' : 'Make sure you are on the correct page.') +
      targetLabel +
      '</div>';
  } else if (state === 'wrongpage') {
    strip = '<div class="cl-strip cl-strip--warn">🗺️ Wrong page. ' +
      (extra ? 'Go to: <strong>' + esc(extra) + '</strong>' : 'Navigate to the correct Azure page.') +
      '</div>';
  } else if (opts.blocked) {
    strip = '<div class="cl-strip cl-strip--warn">⛔ Action blocked. ' + esc(opts.blockedReason || 'Resolve page errors first.') + '</div>';
  }

  var hintRow = hint ? '<div class="cl-hint">📍 ' + esc(hint) + '</div>' : '';

  // Error fix suggestion
  var fixRow = opts.errorFix
    ? '<div class="cl-fix-row">🔧 ' + esc(opts.errorFix) + '</div>'
    : '';

  // Scroll suggestion
  var scrollRow = opts.needsScroll && state === 'notfound'
    ? '<div class="cl-scroll-row">📜 Try scrolling down — the element may be below the visible area.</div>'
    : '';

  return (
    '<div class="cl-bar' + (state==='notfound'||state==='wrongpage' ? ' cl-bar--warn' : '') + '"></div>' +
    '<div class="cl-inner">' +
      '<div class="cl-row">' +
        '<div class="cl-badge"><span class="cl-n">' + (stepIndex+1) + '</span><span class="cl-of">/' + totalSteps + '</span></div>' +
        '<div class="cl-chip">' + icon + ' ' + cap(action) + '</div>' +
        '<button class="cl-stop-btn" onclick="document.getElementById(&quot;cl-root&quot;).remove()" title="Hide overlay">&#x2715;</button>' +
      '</div>' +
      '<p class="cl-title">' + esc(title) + '</p>' +
      '<p class="cl-desc">'  + esc(guidance) + '</p>' +
      hintRow +
      strip +
      fixRow +
      scrollRow +
      '<div class="cl-prog"><div class="cl-track"><div class="cl-fill" style="width:' + pct + '%"></div></div></div>' +
      '<p class="cl-foot">← → navigate · Esc hide · ✕ close</p>' +
    '</div>'
  );
}

// ── rAF loop — keeps ring pinned to element ───────────────
function startRaf() {
  stopRaf();
  function frame() {
    var ring = document.getElementById('cl-ring');
    var card = document.getElementById('cl-card');
    if (!ring || !targetEl) { stopRaf(); return; }
    if (!document.body.contains(targetEl)) { destroyAll(); return; }
    var r = targetEl.getBoundingClientRect();
    ring.style.left   = (r.left   - PAD) + 'px';
    ring.style.top    = (r.top    - PAD) + 'px';
    ring.style.width  = (r.width  + PAD*2) + 'px';
    ring.style.height = (r.height + PAD*2) + 'px';
    if (card) placeCard(card, r);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

function stopRaf() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

function placeCard(card, r) {
  var CW = 285, CM = 12, vw = window.innerWidth, vh = window.innerHeight;
  var ch = card.offsetHeight || 160;
  var left, top;
  if      (r.right  + PAD + CM + CW <= vw) { left = r.right  + PAD + CM;       top = Math.max(CM, r.top + PAD); }
  else if (r.left   - PAD - CM - CW >= 0)  { left = r.left   - PAD - CM - CW;  top = Math.max(CM, r.top + PAD); }
  else if (r.bottom + PAD + CM + ch <= vh) { left = Math.max(CM, r.left-PAD);   top = r.bottom + PAD + CM; }
  else                                      { left = Math.max(CM, r.left-PAD);   top = r.top - PAD - CM - ch; }
  left = Math.max(CM, Math.min(left, vw - CW - CM));
  top  = Math.max(CM, Math.min(top,  vh - ch - CM));
  card.style.left = left + 'px';
  card.style.top  = top  + 'px';
}

function destroyAll() {
  stopRaf();
  stopWatch();
  targetEl = null;
  var r = document.getElementById('cl-root');
  if (r) r.remove();
}

// ════════════════════════════════════════════════════════════
// DOM SNAPSHOT
// ════════════════════════════════════════════════════════════
function buildSnapshot() {
  var url = location.href.toLowerCase();
  var pageType =
    url.includes('microsoft.virtualmachine-arm') ? 'AZURE_CREATE_VM_FORM' :
    url.includes('virtualmachinesbrowse') || url.includes('computehub') ? 'AZURE_VM_LIST' :
    url.includes('resourcegroups') && url.includes('create') ? 'AZURE_CREATE_RG_FORM' :
    url.includes('resourcegroups') ? 'AZURE_RG_LIST' :
    url.includes('portal.azure.com') && (url.includes('/home') || url.endsWith('portal.azure.com/') || url.endsWith('portal.azure.com')) ? 'AZURE_HOME' :
    url.includes('portal.azure.com') ? 'AZURE_PORTAL_GENERIC' : 'OTHER';

  var alerts = [], fields = [], buttons = [];

  document.querySelectorAll('[role="alert"],[role="alertdialog"],.ms-MessageBar,[class*="errorMessage"]').forEach(function(n) {
    if (!isVis(n)) return; var t = getText(n).slice(0,200).trim(); if (t && t.length > 3) alerts.push(t);
  });

  document.querySelectorAll('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"]').forEach(function(n, idx) {
    if (!isVis(n)) return;
    var tag  = n.tagName.toLowerCase();
    var aria = n.getAttribute('aria-label') || '';
    var ph   = n.getAttribute('placeholder') || '';
    var val  = (n.value || '').trim();
    var role = n.getAttribute('role') || tag;
    var dis  = n.disabled ? '[DISABLED]' : '[ENABLED]';
    var r = n.getBoundingClientRect();
    var pos = r.top < window.innerHeight ? '[VISIBLE]' : '[OFF-SCREEN]';
    if (!val) {
      var wrap = n.closest('[class*="Dropdown"]') || n.closest('[class*="ComboBox"]') || n.parentElement;
      if (wrap) { var sp = wrap.querySelector('[class*="title"],[class*="selected"]'); if (sp) val = getText(sp).trim(); }
    }
    var filled = val ? '[FILLED:"' + val.slice(0,50) + '"]' : '[EMPTY]';
    var sel = n.id ? '#' + n.id : (aria ? tag + '[aria-label="' + aria + '"]' : (ph ? tag + '[placeholder="' + ph + '"]' : tag));
    fields.push('[' + role + '] ' + dis + ' ' + filled + ' ' + pos + ' | label:"' + (aria || ph || 'field_' + idx) + '" | sel:"' + sel + '"');
  });

  document.querySelectorAll('button,a[href],[role="button"],[role="menuitem"],[role="tab"],[role="option"]').forEach(function(n) {
    if (!isVis(n)) return;
    var tag  = n.tagName.toLowerCase();
    var text = getText(n).slice(0, 80);
    var aria = n.getAttribute('aria-label') || '';
    var role = n.getAttribute('role') || tag;
    var dis  = n.disabled ? '[DISABLED]' : '[ENABLED]';
    var r = n.getBoundingClientRect();
    var pos = r.top < window.innerHeight ? '[VISIBLE]' : '[OFF-SCREEN]';
    var sel  = n.id ? '#' + n.id : (aria ? tag + '[aria-label="' + aria + '"]' : tag);
    var d = (aria || text).slice(0, 80);
    if (d) buttons.push('[' + role + '] ' + dis + ' "' + d + '" ' + pos + ' | sel:"' + sel + '"');
  });

  var lines = ['PAGE_TYPE: '+pageType, 'URL: '+location.href, 'TITLE: '+document.title, ''];
  if (alerts.length) { lines.push('ERRORS:'); alerts.forEach(function(a){ lines.push('  !!'+a); }); lines.push(''); }
  lines.push('FORM FIELDS ('+fields.length+'):');
  fields.forEach(function(f){ lines.push('  '+f); });
  lines.push(''); lines.push('BUTTONS ('+buttons.length+'):');
  buttons.slice(0,100).forEach(function(b){ lines.push('  '+b); });
  return lines.join('\n');
}

function checkStepBlockers(payload) {
  var selector = payload.selector || '';
  var text = payload.text || '';
  var action = payload.action || 'click';

  var alerts = [];
  document.querySelectorAll('[role="alert"],[role="alertdialog"],.ms-MessageBar,[class*="errorMessage"]').forEach(function(n) {
    if (!isVis(n)) return;
    var t = getText(n).slice(0, 180).trim();
    if (t && t.length > 3) alerts.push(t);
  });

  var el = null;
  try {
    el = findElement(selector, text, action);
  } catch (_) {}

  var targetDisabled = isElementDisabled(el);
  var submitLike = /(create|review|submit|deploy|finish|next)/i.test(text || '');
  var hasErrors = alerts.length > 0;
  var blocked = !!targetDisabled || (hasErrors && submitLike);

  var reason = '';
  if (targetDisabled) {
    reason = 'The highlighted control is disabled.';
  } else if (hasErrors && submitLike) {
    reason = 'Form validation errors must be fixed before this action.';
  }

  return {
    blocked: blocked,
    reason: reason,
    hasErrors: hasErrors,
    errors: alerts.slice(0, 3),
    targetDisabled: !!targetDisabled,
    targetFound: !!el
  };
}

function isElementDisabled(el) {
  if (!el) return false;
  try {
    if (el.disabled) return true;
    var aria = (el.getAttribute('aria-disabled') || '').toLowerCase();
    if (aria === 'true') return true;
    var cls = (el.className || '').toString().toLowerCase();
    if (cls.includes('disabled') || cls.includes('is-disabled')) return true;
    var s = window.getComputedStyle(el);
    if (s.pointerEvents === 'none' || s.opacity === '0.5') return true;
  } catch (_) { }
  return false;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cap(s) { return String(s).charAt(0).toUpperCase()+String(s).slice(1); }
dlog('[CloudLabs] content ready');
