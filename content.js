/**
 * content.js — v3
 * ════════════════════════════════════════════════════════════
 *
 * Receives HIGHLIGHT_TARGET from background.js (which got it from AI).
 * Finds the element using 8 strategies, renders the overlay.
 *
 * Key messages:
 *   HIGHLIGHT_TARGET  → find element + show overlay with guidance
 *   HIDE_OVERLAY      → remove everything
 *   GET_DOM_SNAPSHOT  → return structured DOM for AI
 *   SHOW_COMPLETE     → show goal complete screen
 *   SHOW_WRONG_PAGE   → show navigation hint
 *   PING              → alive check
 */

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════
let targetEl   = null;
let rafId      = null;
let lastUrl    = location.href;
const PAD      = 8;

// ════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  switch (msg.type) {
    case 'HIGHLIGHT_TARGET':
      renderHighlight(msg.payload);
      sendResponse({ ok: true });
      break;
    case 'HIDE_OVERLAY':
      destroyAll();
      sendResponse({ ok: true });
      break;
    case 'GET_DOM_SNAPSHOT':
      sendResponse({ ok: true, snapshot: buildSnapshot() });
      break;
    case 'SHOW_COMPLETE':
      showCompleteScreen(msg.payload);
      sendResponse({ ok: true });
      break;
    case 'SHOW_WRONG_PAGE':
      showWrongPage(msg.payload);
      sendResponse({ ok: true });
      break;
    case 'PING':
      sendResponse({ ok: true, alive: true });
      break;
  }
  return true;
});

// ════════════════════════════════════════════════════════════
// RENDER HIGHLIGHT — called every scan cycle
// ════════════════════════════════════════════════════════════
function renderHighlight(payload) {
  const { target, guidance, issues, fix, status, actionType, progress } = payload;

  // Find the element using all available strategies
  const el = findElement(target);

  destroyAll(); // clean previous overlay

  if (el) {
    targetEl = el;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    setTimeout(() => {
      buildOverlay({ guidance, issues, fix, status, actionType, progress, found: true });
      startRaf();
    }, 300);
  } else {
    // Element not found — show floating guidance card (no highlight ring)
    buildOverlay({ guidance, issues, fix, status, actionType, progress, found: false });
  }
}

// ════════════════════════════════════════════════════════════
// ELEMENT FINDER — 8 strategies
// ════════════════════════════════════════════════════════════

function findElement(target) {
  if (!target) return null;
  const { selector, text } = target;
  let el;

  // S1: CSS selector from AI
  if (selector) {
    el = trySelector(selector);
    if (el) return el;
  }

  // S2: Exact text on buttons/links
  if (text) {
    el = textScan(text, ['button','a','[role="button"]','[role="menuitem"]','[role="tab"]']);
    if (el) return el;
  }

  // S3: Azure Fluent UI label spans
  if (text) {
    el = fluentScan(text);
    if (el) return el;
  }

  // S4: aria-label fuzzy match
  if (text || selector) {
    el = ariaFuzzy(text || selector);
    if (el) return el;
  }

  // S5: Input placeholder / label
  if (text) {
    el = inputScan(text);
    if (el) return el;
  }

  // S6: role=button deep scan
  if (text) {
    el = roleScan(text);
    if (el) return el;
  }

  // S7: Full page text walk
  if (text) {
    el = pageWalk(text);
    if (el) return el;
  }

  // S8: Partial selector from text (build selector on the fly)
  if (text) {
    const phrase = text.replace(/['"]/g, '').trim();
    const built = [`button:contains("${phrase}")`, `[aria-label*="${phrase}"]`];
    for (const s of built) {
      el = trySelector(s);
      if (el) return el;
    }
  }

  return null;
}

function trySelector(sel) {
  if (!sel) return null;
  // Custom :text("…") syntax
  const tm = sel.match(/:text\("(.+?)"\)/);
  if (tm) return textScan(tm[1], null);
  // Custom :contains("…") syntax
  const cm = sel.match(/:contains\("(.+?)"\)/);
  if (cm) {
    const base = sel.replace(/:contains\(".*?"\)/, '').trim() || '*';
    return textScan(cm[1], [base]);
  }
  try { return document.querySelector(sel) || null; } catch { return null; }
}

function textScan(phrase, tagList) {
  const lower = phrase.toLowerCase().trim();
  const tags = tagList || ['button','a','[role="button"]','[role="menuitem"]','[role="option"]','[role="tab"]','label','span','div','li'];
  for (const tag of tags) {
    let nodes;
    try { nodes = document.querySelectorAll(tag); } catch { continue; }
    // Exact
    for (const n of nodes) {
      if (!vis(n)) continue;
      if (deepText(n).toLowerCase().trim() === lower) return nearest(n);
    }
    // Starts with
    for (const n of nodes) {
      if (!vis(n)) continue;
      if (deepText(n).toLowerCase().trim().startsWith(lower)) return nearest(n);
    }
    // Contains
    for (const n of nodes) {
      if (!vis(n)) continue;
      if (deepText(n).toLowerCase().includes(lower)) return nearest(n);
    }
  }
  return null;
}

function fluentScan(phrase) {
  const lower = phrase.toLowerCase().trim();
  const lsels = ['.ms-Button-label','.ms-Button-textContainer','[class*="label"]','[class*="Label"]','[class*="text-"]','[class*="-text"]','.fxs-commandBar-button > span','[class*="buttonText"]','[class*="ButtonText"]'];
  for (const ls of lsels) {
    for (const span of document.querySelectorAll(ls)) {
      if (!vis(span)) continue;
      const t = deepText(span).toLowerCase();
      if (t.includes(lower)) return nearest(span) || span;
    }
  }
  return null;
}

function ariaFuzzy(phrase) {
  const lower = phrase.toLowerCase().trim();
  // Exact aria-label
  for (const el of document.querySelectorAll('[aria-label]')) {
    if (!vis(el)) continue;
    if ((el.getAttribute('aria-label') || '').toLowerCase() === lower) return el;
  }
  // Contains aria-label
  for (const el of document.querySelectorAll('[aria-label]')) {
    if (!vis(el)) continue;
    if ((el.getAttribute('aria-label') || '').toLowerCase().includes(lower)) return el;
  }
  return null;
}

function inputScan(phrase) {
  const lower = phrase.toLowerCase().trim();
  const inputs = document.querySelectorAll('input,textarea,select,[role="combobox"],[role="textbox"],[role="spinbutton"]');
  for (const el of inputs) {
    if (!vis(el)) continue;
    const ph = (el.getAttribute('placeholder') || '').toLowerCase();
    const ar = (el.getAttribute('aria-label')  || '').toLowerCase();
    const ti = (el.getAttribute('title')        || '').toLowerCase();
    if ([ph,ar,ti].some(s => s.includes(lower))) return el;
  }
  // label for= association
  for (const lbl of document.querySelectorAll('label')) {
    if (!vis(lbl)) continue;
    if (deepText(lbl).toLowerCase().includes(lower)) {
      const forId = lbl.getAttribute('for');
      const inp = (forId && document.getElementById(forId)) || lbl.querySelector('input,select,textarea');
      if (inp && vis(inp)) return inp;
    }
  }
  return null;
}

function roleScan(phrase) {
  const lower = phrase.toLowerCase().trim();
  for (const el of document.querySelectorAll('[role="button"],[role="menuitem"],[role="option"],[role="tab"],[role="radio"],[role="checkbox"],[role="switch"],[role="link"]')) {
    if (!vis(el) || deepText(el).toLowerCase().includes(lower)) return el;
  }
  return null;
}

function pageWalk(phrase) {
  if (!phrase || phrase.length < 3) return null;
  const lower = phrase.toLowerCase().trim();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => {
      if (!vis(n)) return NodeFilter.FILTER_SKIP;
      const t = (n.innerText || n.textContent || '').trim();
      if (!t || t.length > 150) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let best = null;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const t = deepText(n).toLowerCase();
    if (t === lower) return nearest(n);
    if (t.includes(lower) && !best) best = n;
  }
  return best ? nearest(best) : null;
}

// Walk up to nearest interactive ancestor
function nearest(el) {
  let cur = el;
  for (let i = 0; i < 6; i++) {
    if (!cur || cur === document.body) break;
    const tag  = cur.tagName?.toLowerCase();
    const role = cur.getAttribute?.('role');
    if (['button','a','select','input','textarea'].includes(tag) || ['button','link','menuitem','option','tab','checkbox','radio','switch'].includes(role)) return cur;
    cur = cur.parentElement;
  }
  return el;
}

function deepText(el) { return (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim(); }
function vis(el) {
  if (!el || !(el instanceof Element)) return false;
  try {
    const s = window.getComputedStyle(el);
    if (s.display==='none' || s.visibility==='hidden' || s.opacity==='0' || s.pointerEvents==='none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
  } catch { return false; }
}

// ════════════════════════════════════════════════════════════
// OVERLAY BUILDER
// ════════════════════════════════════════════════════════════

function buildOverlay({ guidance, issues, fix, status, actionType, progress, found }) {
  const container = el('div', '', { id: 'cl-root' });

  // Backdrop (only if element found — no backdrop when floating)
  if (found) {
    const backdrop = el('div', 'cl-backdrop', { id: 'cl-backdrop' });
    container.appendChild(backdrop);
    const ring = el('div', 'cl-ring', { id: 'cl-ring' });
    container.appendChild(ring);
  }

  // Tooltip card
  const card = el('div', `cl-card${found ? '' : ' cl-card--float'}${issues?.length ? ' cl-card--issue' : ''}`, { id: 'cl-card' });
  card.innerHTML = buildCardHTML({ guidance, issues, fix, status, actionType, progress });
  container.appendChild(card);

  document.body.appendChild(container);

  requestAnimationFrame(() => {
    document.getElementById('cl-backdrop')?.classList.add('cl-on');
    document.getElementById('cl-ring')?.classList.add('cl-on');
    document.getElementById('cl-card')?.classList.add('cl-on');
  });
}

function buildCardHTML({ guidance, issues, fix, status, actionType, progress }) {
  const ACTION_ICONS = { click:'👆', type:'⌨️', select:'☑️', navigate:'🔗', wait:'⏳', verify:'✅', scroll:'📜' };
  const icon  = ACTION_ICONS[actionType] || '➡️';
  const hasIssues = issues?.length > 0;

  return `
<div class="cl-bar ${hasIssues ? 'cl-bar--warn' : ''}"></div>
<div class="cl-inner">
  <div class="cl-row">
    <div class="cl-chip ${hasIssues ? 'cl-chip--warn' : ''}">${hasIssues ? '⚠️ Action needed' : `${icon} ${cap(actionType || 'action')}`}</div>
    ${progress ? `<div class="cl-progress-txt">${esc(progress)}</div>` : ''}
  </div>

  ${hasIssues ? `
  <div class="cl-issues">
    ${issues.map(i => `<div class="cl-issue-row">⚠️ ${esc(i)}</div>`).join('')}
  </div>
  ${fix ? `<div class="cl-fix">🔧 <strong>Fix:</strong> ${esc(fix)}</div>` : ''}
  ` : ''}

  <p class="cl-guidance">${esc(guidance || 'Analysing page…')}</p>
</div>`.trim();
}

// ════════════════════════════════════════════════════════════
// RAF LOOP — keeps ring + card pinned to element every frame
// ════════════════════════════════════════════════════════════
function startRaf() {
  stopRaf();
  function frame() {
    const ring = document.getElementById('cl-ring');
    const card = document.getElementById('cl-card');
    if (!ring || !targetEl) { stopRaf(); return; }

    if (!document.body.contains(targetEl)) {
      // Element disappeared — will be re-found on next scan
      destroyAll();
      return;
    }

    const r = targetEl.getBoundingClientRect();
    ring.style.left   = `${r.left   - PAD}px`;
    ring.style.top    = `${r.top    - PAD}px`;
    ring.style.width  = `${r.width  + PAD*2}px`;
    ring.style.height = `${r.height + PAD*2}px`;

    if (card) placeCard(card, r);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

function stopRaf() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

function placeCard(card, r) {
  const CW = 295, CM = 12;
  const vw = window.innerWidth, vh = window.innerHeight;
  const ch = card.offsetHeight || 150;
  let left, top;

  if (r.right + PAD + CM + CW <= vw) {       // right
    left = r.right + PAD + CM;  top = Math.max(CM, r.top + PAD);
  } else if (r.left - PAD - CM - CW >= 0) {  // left
    left = r.left  - PAD - CM - CW; top = Math.max(CM, r.top + PAD);
  } else if (r.bottom + PAD + CM + ch <= vh) { // below
    left = Math.max(CM, r.left - PAD); top = r.bottom + PAD + CM;
  } else {                                    // above
    left = Math.max(CM, r.left - PAD); top = r.top - PAD - CM - ch;
  }

  left = Math.max(CM, Math.min(left, vw - CW - CM));
  top  = Math.max(CM, Math.min(top,  vh - ch - CM));
  card.style.left = `${left}px`;
  card.style.top  = `${top}px`;
}

// ════════════════════════════════════════════════════════════
// SPECIAL SCREENS
// ════════════════════════════════════════════════════════════
function showCompleteScreen({ goal }) {
  destroyAll();
  const root = el('div', '', { id: 'cl-root' });
  root.innerHTML = `
<div id="cl-backdrop" class="cl-backdrop cl-on"></div>
<div class="cl-complete cl-on">
  <div class="cl-complete-inner">
    <div class="cl-complete-icon">🎉</div>
    <h2>Goal Complete!</h2>
    <p>${esc(goal)}</p>
    <p class="cl-complete-sub">The CloudLabs guide has finished. Great work!</p>
  </div>
</div>`.trim();
  document.body.appendChild(root);
}

function showWrongPage({ guidance, fix }) {
  destroyAll();
  const root = el('div', '', { id: 'cl-root' });
  const card = el('div', 'cl-card cl-card--float cl-card--issue cl-on', { id: 'cl-card' });
  card.innerHTML = `
<div class="cl-bar cl-bar--warn"></div>
<div class="cl-inner">
  <div class="cl-chip cl-chip--warn">🗺️ Wrong page</div>
  <p class="cl-guidance">${esc(guidance || 'Navigate to the correct page first.')}</p>
  ${fix ? `<div class="cl-fix">🔧 ${esc(fix)}</div>` : ''}
</div>`.trim();
  root.appendChild(card);
  document.body.appendChild(root);
}

// ════════════════════════════════════════════════════════════
// DOM SNAPSHOT for AI
// ════════════════════════════════════════════════════════════
function buildSnapshot() {
  const SEL = 'button,a[href],input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="textbox"],[aria-label],[data-testid]';
  const rows = [];

  document.querySelectorAll(SEL).forEach((n, idx) => {
    if (!vis(n)) return;
    const tag  = n.tagName.toLowerCase();
    const text = deepText(n).slice(0, 80);
    const aria = n.getAttribute('aria-label') || '';
    const role = n.getAttribute('role') || tag;
    const ph   = n.getAttribute('placeholder') || '';
    const id   = n.id ? `#${n.id}` : '';
    const tid  = n.getAttribute('data-testid') || n.getAttribute('data-automationid') || '';
    const dis  = n.disabled || n.getAttribute('aria-disabled') === 'true' ? ' [DISABLED]' : '';
    const desc = [text, aria, ph].filter(Boolean).join(' | ').slice(0, 100);

    // Build best selector
    let sel = tag;
    if (n.id)             sel = `#${CSS.escape(n.id)}`;
    else if (aria)         sel = `${tag}[aria-label="${aria}"]`;
    else if (tid)          sel = `[data-testid="${tid}"]`;
    else if (ph)           sel = `${tag}[placeholder="${ph}"]`;

    if (desc) rows.push(`[${idx}] ${role}${dis} | sel:"${sel}" | "${desc}"`);
  });

  // Also include visible error/warning messages
  const alerts = [];
  document.querySelectorAll('[role="alert"],[role="status"],.ms-MessageBar,.notification-container,[class*="error"],[class*="warning"],[class*="Error"],[class*="Warning"]').forEach(n => {
    if (!vis(n)) return;
    const t = deepText(n).slice(0, 120);
    if (t) alerts.push(`ALERT: "${t}"`);
  });

  return [
    `URL: ${location.href}`,
    `TITLE: ${document.title}`,
    alerts.length ? `\nPAGE ALERTS:\n${alerts.slice(0,5).join('\n')}` : '',
    `\nINTERACTIVE ELEMENTS (${rows.length}):\n${rows.slice(0,100).join('\n')}`,
  ].join('\n').trim();
}

// ════════════════════════════════════════════════════════════
// TEARDOWN
// ════════════════════════════════════════════════════════════
function destroyAll() {
  stopRaf();
  targetEl = null;
  document.getElementById('cl-root')?.remove();
}

// ════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════
function el(tag, cls, attrs={}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k,v));
  return e;
}
function esc(s='') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cap(s)    { return String(s).charAt(0).toUpperCase()+String(s).slice(1); }

console.log('[CloudLabs] v3 content script ready ✅');
