/**
 * background.js — CloudLabs v4 (Manual Step Navigation)
 *
 * NEW ARCHITECTURE — no continuous scanning:
 *  1. User types goal → AI generates an ordered step list ONCE
 *  2. Step 1 is shown: extension finds the element, draws highlight
 *  3. User reads guidance, performs the action themselves
 *  4. User clicks NEXT → extension scans for step 2 element → highlight
 *  5. User clicks PREV → go back to step 1
 *
 * AI is called TWICE per step:
 *  a) When generating steps (one-time, on Start)
 *  b) When navigating to a step (targeted: "find THIS element on THIS page")
 *
 * This is reliable because:
 *  - No polling / race conditions
 *  - User controls the pace
 *  - Each element search is fresh and targeted
 *  - Fluent UI dropdown values don't need to be read — user already did the action
 */

// ── State ─────────────────────────────────────────────────
let steps = [];
let stepIndex = 0;
let isActive = false;
let labGoal = '';
const prefetch = {};
const prefetching = new Set();
let prefetchCache = {};  // index → resolved targetInfo (pre-fetched in background)
let prefetchInProgress = new Set();
let dom_snapshot_cache = '';
let dom_snapshot_url = '';
const recoveryHints = {};
let navSeq = 0;
const activeNavByTab = {};

function clearPrefetch() {
  Object.keys(prefetch).forEach(k => delete prefetch[k]);
  Object.keys(recoveryHints).forEach(k => delete recoveryHints[k]);
  prefetching.clear();
  dom_snapshot_cache = '';
  dom_snapshot_url = '';
}

// ── Side panel open ───────────────────────────────────────
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
});

// ── Message router ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = {
    GENERATE_STEPS: () => handleGenerateSteps(msg.payload, sendResponse),
    NAVIGATE_STEP: () => handleNavigateStep(msg.payload, sendResponse),
    RETRY_STEP: () => handleNavigateStep({ index: stepIndex, force: true }, sendResponse),
    CLEAR_LAB: () => handleClearLab(sendResponse),
    GET_STATE: () => handleGetState(sendResponse),
    SAVE_CONFIG: () => handleSaveConfig(msg.payload, sendResponse),
    GET_CONFIG: () => handleGetConfig(sendResponse),
    TEST_CONNECTION: () => handleTestConnection(msg.payload, sendResponse),
    ASK_AI: () => handleAskAI(msg.payload, sendResponse),
  };
  if (h[msg.type]) { h[msg.type](); return true; }
});

// ════════════════════════════════════════════════════════════
// STEP 1: Generate steps from goal (called once on Start)
// ════════════════════════════════════════════════════════════
async function handleGenerateSteps({ goal }, sendResponse) {
  try {
    const cfg = await loadConfig();
    assertConfig(cfg);

    labGoal = goal.trim();
    steps = [];
    stepIndex = 0;
    isActive = true;
    clearPrefetch();
    prefetchCache = {};
    prefetchInProgress.clear();

    // Call AI to generate ordered steps
    const prompt =
      'Goal: ' + labGoal + '\n\n' +
      'Create step-by-step guide (JSON array). Each step:\n' +
      '{\n' +
      '  "title": "3-5 word action",\n' +
      '  "description": "clear instruction",\n' +
      '  "action": "click|type|select|navigate",\n' +
      '  "what_to_find": "exact element text"\n' +
      '}\n\n' +
      'Rules: Include EVERY step, no skips. Include page navigations. One action per step. Return JSON array only.';

    // For large lab guides, truncate to avoid hitting output token limit
    // which causes truncated/invalid JSON. 3000 chars ≈ ~750 tokens input.
    const guideInput = labGoal.length > 3000
      ? labGoal.slice(0, 3000) + '\n[Guide truncated — focusing on first section]'
      : labGoal;
    const finalPrompt = prompt.replace('Goal: ' + labGoal, 'Goal: ' + guideInput);

    const raw = await callAI([{ role: 'user', content: finalPrompt }], cfg, 1500, 60);  // Reduced from 3000 tokens
    const parsed = repairAndParseJSON(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AI returned no steps. Try rephrasing your goal or use a shorter guide.');
    }

    steps = parsed;
    await store('cl_lab', { goal: labGoal, steps, stepIndex: 0 });
    sendResponse({ ok: true, steps, count: steps.length });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => { }); }

// ════════════════════════════════════════════════════════════
// STEP 2: Navigate to a specific step
// Called when user clicks Next or Prev
// ════════════════════════════════════════════════════════════
async function handleNavigateStep({ index, force }, sendResponse) {
  try {
    await ensureStepsLoaded();

    // Check if steps are loaded
    if (!steps || steps.length === 0) {
      sendResponse({ ok: false, error: 'No steps loaded. Generate steps first.' });
      return;
    }

    if (index < 0 || index >= steps.length) {
      sendResponse({ ok: false, error: 'No more steps.' });
      return;
    }

    stepIndex = index;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab. Make sure Azure Portal is open.');
    const navId = ++navSeq;
    activeNavByTab[tab.id] = navId;

    const step = steps[index];

    const alive = await ping(tab.id);
    if (!alive) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
      await sleep(300);
    }

    // ── INSTANT: send step with local text first so content.js can highlight immediately ──
    const base = {
      stepIndex: index, totalSteps: steps.length, title: step.title,
      description: step.description, action: step.action || 'click', guidance: step.description,
      text: step.what_to_find || '',
      fallbackText: step.what_to_find || '',
      navId
    };
    try { await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_STEP', payload: { ...base, resolving: false } }); } catch (_) { }
    sendResponse({ ok: true, step, resolving: false });

    // Adaptive planning is expensive: run asynchronously and less frequently.
    if (!force && index % 2 === 0) {
      setTimeout(async () => {
        try {
          const cfgForPlan = await loadConfig();
          const replanned = await adjustPlanOnNavigation(index, tab, cfgForPlan);
          if (replanned) {
            broadcast({ type: 'STEPS_UPDATED', payload: { steps, stepIndex } });
            await store('cl_lab', { goal: labGoal, steps, stepIndex });
          }
        } catch (e) {
          console.warn('[plan] adaptive replanning skipped:', e.message);
        }
      }, 0);
    }

    // ── RESOLVE: use cache or call AI ──
    if (dom_snapshot_url && dom_snapshot_url !== tab.url) {
      dom_snapshot_cache = '';
    }

    const cacheKey = index + ':' + tab.url;
    let t = (!force && prefetch[cacheKey]) ? prefetch[cacheKey] : null;
    if (!t) {
      const cfg = await loadConfig();
      let dom = '';
      try { 
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' }); 
        dom = r?.snapshot || ''; 
        if (!dom) console.warn('[nav] No DOM snapshot received');
        if (dom) {
          dom_snapshot_cache = dom;
          dom_snapshot_url = tab.url;
        }
      } catch (e) { 
        console.warn('[nav] Failed to get DOM:', e.message); 
      }
      if (dom && dom.length > 50) {
        t = await resolveStepTarget(step, dom, tab.url, cfg);
        console.log('[nav] Resolved target:', t ? 'found' : 'not found');
        if (t) prefetch[cacheKey] = t;
      } else {
        console.warn('[nav] DOM snapshot too small or empty, using text fallback');
        // Fallback: use what_to_find text for element matching
        t = { found: false, selector: '', text: step.what_to_find, not_found: false };
      }
    }

    // Ignore stale in-flight navigation results.
    if (activeNavByTab[tab.id] !== navId) return;

    // ── CHECK blockers on live page (only used when issues are present) ──
    let blockers = null;
    let warning = '';
    try {
      const check = await chrome.tabs.sendMessage(tab.id, {
        type: 'CHECK_STEP_BLOCKERS',
        payload: {
          selector: t?.selector || '',
          text: t?.text || step.what_to_find || '',
          action: step.action || 'click'
        }
      });
      blockers = check?.blockers || null;
    } catch (_) { }

    if (blockers?.blocked || blockers?.hasErrors) {
      warning = blockers?.reason || (blockers?.hasErrors ? 'Page shows validation errors.' : 'Step is currently blocked.');
      const errors = Array.isArray(blockers.errors) ? blockers.errors.join(' | ') : '';
      const signature = (step.title || '') + '|' + warning + '|' + errors;
      const hintKey = index + ':' + tab.url + ':' + signature;

      if (!recoveryHints[hintKey]) {
        const heuristic = getHeuristicRecoveryHint(step, blockers);
        if (heuristic) {
          recoveryHints[hintKey] = heuristic;
        } else {
          const cfg = await loadConfig();
          const hint = await generateRecoveryHint(step, blockers, cfg);
          if (hint) recoveryHints[hintKey] = hint;
        }
      }

      if (recoveryHints[hintKey]) {
        t = { ...(t || {}), error_fix: mergeRecoveryFix(t?.error_fix || '', recoveryHints[hintKey]) };
      }
    }

    // If submit/create is blocked by validation errors, redirect user to the failing tab instead of pushing "Create".
    if (blockers?.hasErrors && isSubmitLikeStep(step)) {
      const failingTab = extractAzureValidationTab(blockers.errors || []);
      if (failingTab) {
        t = {
          ...(t || {}),
          found: false,
          selector: '',
          text: failingTab,
          hint: 'Open this tab to fix validation errors first',
          not_found: false,
          needs_scroll: false,
          error_fix: mergeRecoveryFix(
            t?.error_fix || '',
            'Validation failed in ' + failingTab + '. Click ' + failingTab + ' tab and fix highlighted fields before creating.'
          )
        };
      }
    }

    if (t?.not_found) {
      const targetLabel = t?.text || step?.what_to_find || step?.title || 'the required button';
      t = {
        ...(t || {}),
        needs_scroll: true,
        error_fix: mergeRecoveryFix(
          t?.error_fix || '',
          'Scroll down and look for "' + targetLabel + '". If still not visible, retry this step.'
        )
      };
    }

    if (activeNavByTab[tab.id] !== navId) return;

    // ── UPDATE overlay with refined AI-resolved target ──
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_STEP', payload: {
          ...base, resolving: false,
          selector: t?.selector || '',
          text: t?.text || step.what_to_find || '',
          fallbackText: step.what_to_find || '',
          hint: t?.hint || '',
          notFound: t?.not_found || false,
          needsScroll: t?.needs_scroll || false,
          errorFix: t?.error_fix || '',
          blocked: !!blockers?.blocked,
          blockedReason: warning,
          wrongPage: t?.wrong_page || false,
          navigateTo: t?.navigate_to || '',
          navId,
        }
      });
    } catch (_) { }

    broadcast({
      type: 'STEP_RESOLVED',
      payload: {
        index,
        target: t,
        errorFix: t?.error_fix || '',
        needsScroll: t?.needs_scroll || false,
        warning,
        navId
      }
    });

    // Pre-fetch upcoming steps silently
    bgPrefetch(index, tab);
    await store('cl_lab', { goal: labGoal, steps, stepIndex });
  } catch (err) {
    broadcast({ type: 'STEP_RESOLVED', payload: { index, target: null, error: err.message } });
  }
}

async function handleGetState(sendResponse) {
  try {
    await ensureStepsLoaded();
    sendResponse({ ok: true, steps, stepIndex, isActive, labGoal });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function ensureStepsLoaded() {
  if (steps && steps.length > 0) return;
  const saved = await load('cl_lab');
  if (!saved || !Array.isArray(saved.steps) || saved.steps.length === 0) return;

  steps = saved.steps;
  stepIndex = Math.max(0, Math.min(saved.stepIndex || 0, steps.length - 1));
  labGoal = saved.goal || '';
  isActive = true;
}

async function bgPrefetch(idx, tab) {
  // Prefetch next 2-3 steps in parallel for instant navigation
  const prefetchCount = 1;
  const promises = [];
  
  for (let i = 1; i <= prefetchCount; i++) {
    const nextIdx = idx + i;
    if (nextIdx >= steps.length) break;
    
    const key = nextIdx + ':' + tab.url;
    if (prefetch[key] || prefetching.has(key)) continue;
    
    prefetching.add(key);
    const promise = (async () => {
      try {
        const cfg = await loadConfig();
        if (!dom_snapshot_cache || dom_snapshot_url !== tab.url) {
          // Get fresh DOM if needed
          try {
            const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });
            if (r?.snapshot) {
              dom_snapshot_cache = r.snapshot;
              dom_snapshot_url = tab.url;
            }
          } catch (_) {}
        }
        const dom = dom_snapshot_cache || '';
        if (steps[nextIdx] && dom) {
          const info = await resolveStepTarget(steps[nextIdx], dom, tab.url, cfg);
          if (info) { prefetch[key] = info; }
        }
      } catch (_) { }
      prefetching.delete(key);
    })();
    promises.push(promise);
  }
  
  // Fire and forget — don't await
  Promise.all(promises).catch(() => {});
}


// ════════════════════════════════════════════════════════════
// AI RESOLVER: given a step + DOM snapshot, find the exact element
// ════════════════════════════════════════════════════════════
async function resolveStepTarget(step, domSnapshot, pageUrl, cfg) {
  const proxyUrl = cfg.proxyUrl || 'http://localhost:3000';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);  // Keep AI resolve fast; local matcher already runs immediately.
    
    const resp = await fetch(proxyUrl + '/api/resolve-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, domSnapshot, pageUrl }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error('Proxy error (' + resp.status + '): ' + (e?.error || resp.statusText));
    }

    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed to resolve target');
    
    return data.target || { found: false, selector: '', not_found: true };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[resolveStepTarget] timeout after 9s');
      return { found: false, selector: '', text: step?.what_to_find || '', not_found: false };
    }
    console.warn('[resolveStepTarget] error:', err.message);
    return { found: false, selector: '', text: step?.what_to_find || '', not_found: false };
  }
}

async function generateRecoveryHint(step, blockers, cfg) {
  try {
    const errs = (blockers?.errors || []).slice(0, 3).join(' | ');
    const prompt =
      'You are an Azure portal helper. User is blocked on a step.\n' +
      'Step title: ' + (step?.title || '') + '\n' +
      'Step action: ' + (step?.action || 'click') + '\n' +
      'Target text: ' + (step?.what_to_find || '') + '\n' +
      'Blocked reason: ' + (blockers?.reason || 'Unknown') + '\n' +
      'Visible errors: ' + (errs || 'None') + '\n\n' +
      'Return one short actionable instruction (max 20 words). No bullets.';

    const raw = await callAI([{ role: 'user', content: prompt }], cfg, 80, 10);
    return (raw || '').trim().slice(0, 220);
  } catch (_) {
    if (blockers?.targetDisabled) return 'This control is disabled. Fill required fields above and clear validation errors first.';
    if (blockers?.hasErrors) return 'Resolve visible validation errors on this page, then retry this step.';
    return '';
  }
}

async function adjustPlanOnNavigation(index, tab, cfg) {
  if (!Array.isArray(steps) || !steps.length) return false;
  if (!tab?.id) return false;

  let dom = '';
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });
    dom = r?.snapshot || '';
  } catch (_) {
    dom = '';
  }
  if (!dom || dom.length < 50) return false;

  const done = steps.slice(0, index).map((s, i) => {
    return (i + 1) + '. ' + (s?.title || '') + ' — ' + (s?.description || s?.what_to_find || '');
  }).join('\n');

  const windowSize = 6;
  const draftUpcoming = steps.slice(index, index + windowSize).map((s, i) => {
    return (index + i + 1) + '. [' + (s?.action || 'click') + '] ' + (s?.title || '') + ' | find: ' + (s?.what_to_find || '');
  }).join('\n');

  const prompt =
    'You are adjusting an Azure portal guided flow in real time.\n' +
    'Primary goal: ' + (labGoal || '') + '\n' +
    'Current URL: ' + (tab.url || '') + '\n\n' +
    'Completed steps:\n' + (done || 'None') + '\n\n' +
    'Draft upcoming steps:\n' + (draftUpcoming || 'None') + '\n\n' +
    'Live page snapshot:\n' + dom.slice(0, 6000) + '\n\n' +
    'Task:\n' +
    'Return ONLY a JSON array of 4-8 revised upcoming steps starting from the current step.\n' +
    'Each item must be: {"title":"","description":"","action":"click|type|select|navigate","what_to_find":""}.\n' +
    'Rules: one action per step, keep it practical for current page state, include validation recovery if needed.';

  const raw = await callAI([{ role: 'user', content: prompt }], cfg, 900, 20);
  const parsed = repairAndParseJSON(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return false;

  const sanitized = parsed
    .map(normalizeStep)
    .filter(Boolean)
    .slice(0, 8);
  if (!sanitized.length) return false;

  const tailRemainder = steps.slice(index + windowSize);
  steps = steps.slice(0, index).concat(sanitized, tailRemainder);
  if (stepIndex >= steps.length) stepIndex = Math.max(0, steps.length - 1);
  return true;
}

function mergeRecoveryFix(existing, next) {
  const a = String(existing || '').trim();
  const b = String(next || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return a + ' ' + b;
}

function getHeuristicRecoveryHint(step, blockers) {
  const combined = ((blockers?.errors || []).join(' | ') + ' | ' + (blockers?.reason || '')).toLowerCase();
  const target = (step?.what_to_find || '').toLowerCase();
  const failingTab = extractAzureValidationTab(blockers?.errors || []);

  if (/size\s+is\s+not\s+available|vm\s+size.*not\s+available|sku.*not\s+available|currently\s+unavailable/.test(combined)) {
    return 'This VM size is unavailable in this region/zone. Pick another size (for example B-series), or change region/availability zone.';
  }

  if (/quota|limit|exceed|not\s+enough\s+quota/.test(combined)) {
    return 'Quota is insufficient. Choose a smaller VM size, reduce cores, or request a quota increase for this region.';
  }

  if (/name.*already\s+exists|already\s+in\s+use|must\s+be\s+globally\s+unique/.test(combined)) {
    return 'Use a unique name value, then retry this step.';
  }

  if (/password|complexity|must\s+contain|at\s+least/.test(combined)) {
    return 'Update credentials to meet Azure password/username policy, then retry.';
  }

  if (/required|must\s+be\s+specified|cannot\s+be\s+empty/.test(combined)) {
    if (failingTab) {
      return 'Open ' + failingTab + ' tab and fill required fields marked in red, then return to Review + create.';
    }
    return 'Fill all required fields marked in red, then retry this step.';
  }

  if (/not\s+registered|subscription.*disabled|not\s+allowed/.test(combined)) {
    return 'Subscription or provider access is blocking this step. Check subscription status and resource provider registration.';
  }

  if (/validation\s+error|invalid/.test(combined) || /create|review|submit|deploy|finish|next/.test(target)) {
    return 'Resolve the visible validation message on the form, then continue with this step.';
  }

  return '';
}

function isSubmitLikeStep(step) {
  const text = ((step?.title || '') + ' ' + (step?.description || '') + ' ' + (step?.what_to_find || '')).toLowerCase();
  return /create|review|submit|deploy|finish|next/.test(text);
}

function extractAzureValidationTab(errors) {
  const joined = (errors || []).join(' | ');
  const m = joined.match(/(?:tab|following\s+tab)\s*:\s*(Basics|Disks|Networking|Management|Monitoring|Advanced|Tags|Review\s*\+\s*create)/i);
  if (m && m[1]) {
    return m[1].replace(/\s*\+\s*/g, ' + ');
  }
  return '';
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const action = ['click', 'type', 'select', 'navigate'].includes((step.action || '').toLowerCase())
    ? step.action.toLowerCase()
    : 'click';
  const title = String(step.title || '').trim();
  const description = String(step.description || '').trim();
  const what = String(step.what_to_find || '').trim();
  if (!title && !description && !what) return null;
  return {
    title: title || (what ? 'Interact with ' + what : 'Next step'),
    description: description || what || 'Continue with this step.',
    action,
    what_to_find: what || title || 'Next'
  };
}

// ════════════════════════════════════════════════════════════
// CHAT
// ════════════════════════════════════════════════════════════
async function handleAskAI({ question }, sendResponse) {
  try {
    const cfg = await loadConfig();
    assertConfig(cfg);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let ctx = '';
    if (tab?.id) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });
        if (r?.snapshot) ctx = r.snapshot.slice(0, 1500);
      } catch (_) { }
    }

    const currentStep = steps[stepIndex];
    const stepCtx = currentStep
      ? 'Current step: ' + currentStep.title + ' — ' + currentStep.description
      : '';

    const msgs = [{
      role: 'user',
      content: 'You are a helpful Azure assistant. Answer in 2-3 sentences.\n\n' +
        (stepCtx ? stepCtx + '\n\n' : '') +
        (ctx ? 'Page context:\n' + ctx + '\n\n' : '') +
        'Question: ' + question,
    }];

    const answer = await callAI(msgs, cfg, 300, 30);  // 30s timeout for chat
    const answerText = (typeof answer === 'string') ? answer : JSON.stringify(answer || '');
    sendResponse({ ok: true, answer: answerText.trim() });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════
// CLEAR
// ════════════════════════════════════════════════════════════
async function handleClearLab(sendResponse) {
  steps = []; stepIndex = 0; isActive = false; labGoal = '';
  clearPrefetch();
  await chrome.storage.local.remove('cl_lab');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'HIDE_OVERLAY' }); } catch (_) { }
  }
  sendResponse({ ok: true });
}

// ════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════
async function handleSaveConfig(config, sendResponse) {
  await store('cl_config', config);
  sendResponse({ ok: true });
}
async function handleGetConfig(sendResponse) {
  const c = await load('cl_config');
  sendResponse({ ok: true, config: c || null });
}
async function handleTestConnection({ config }, sendResponse) {
  try {
    const proxyUrl = config?.proxyUrl || 'http://localhost:3000';
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const resp = await fetch(proxyUrl + '/api/health', { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!resp.ok) throw new Error('Proxy returned ' + resp.status);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Proxy health check failed');
    sendResponse({ ok: true, message: 'Connected to proxy!' });
  } catch (err) {
    sendResponse({ ok: false, error: err.name === 'AbortError' 
      ? 'Connection timeout — backend may be down' 
      : err.message 
    });
  }
}

// ════════════════════════════════════════════════════════════
// AI CALLER (routes through backend proxy)
// ════════════════════════════════════════════════════════════
async function callAI(messages, cfg, maxTokens, timeoutSeconds) {
  const proxyUrl = cfg.proxyUrl || 'http://localhost:3000';
  const timeout = (timeoutSeconds || 60) * 1000;  // Default 60s, can be customized per call

  const body = { messages, max_completion_tokens: maxTokens || 800 };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(proxyUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error('Proxy error (' + resp.status + '): ' + (e?.error || resp.statusText));
    }
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Unknown proxy error');
    return data.content || '';
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('AI request timed out after ' + (timeout/1000) + 's. Azure may be slow or overloaded. Try again.');
    }
    var msg = String(err && err.message || '');
    if (/Failed to fetch|ECONNREFUSED|NetworkError|fetch failed/i.test(msg)) {
      throw new Error('Backend proxy is unreachable at ' + proxyUrl + '. Start backend/server.js and verify Config -> Proxy URL.');
    }
    throw err;
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function parseJSON(raw) {
  if (!raw) return null;
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(clean);
}

// Robust JSON parser that handles truncated responses from AI
// (e.g. "Unterminated string" from lab guides that exceed output tokens)
function repairAndParseJSON(raw) {
  if (!raw) return null;

  // Strip markdown fences
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Try direct parse first
  try { return JSON.parse(text); } catch (_) { }

  // If it starts with [ (array) or { (object), try to repair truncated JSON
  if (text.startsWith('[')) {
    // Find the last complete object before the truncation
    // Strategy: find the last complete '}' followed by optional ',' and extract up to there
    const lastComplete = text.lastIndexOf('},');
    const lastEnd = text.lastIndexOf('}]');

    if (lastEnd > 0) {
      try { return JSON.parse(text.slice(0, lastEnd + 2)); } catch (_) { }
    }
    if (lastComplete > 0) {
      // Close the array after the last complete item
      const repaired = text.slice(0, lastComplete + 1) + ']';
      try { return JSON.parse(repaired); } catch (_) { }
    }

    // Last resort: extract all complete JSON objects from the array
    const objects = [];
    const regex = /\{[^{}]*"title"[^{}]*"description"[^{}]*\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      try { objects.push(JSON.parse(match[0])); } catch (_) { }
    }
    if (objects.length > 0) return objects;
  }

  if (text.startsWith('{')) {
    // Single object — find last complete key-value pair
    const repaired = text.replace(/,?\s*"[^"]*"\s*:\s*[^,}]*$/, '') + '}';
    try { return JSON.parse(repaired); } catch (_) { }
  }

  throw new Error('Could not parse AI response as JSON');
}

async function ping(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return r?.alive === true; }
  catch (_) { return false; }
}

function store(key, value) {
  return new Promise((res, rej) => {
    chrome.storage.local.set({ [key]: value }, () =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()
    );
  });
}

function load(key) {
  return new Promise((res, rej) => {
    chrome.storage.local.get(key, r =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r[key] ?? null)
    );
  });
}

async function loadConfig() {
  const c = (await load('cl_config')) || {};
  if (!c.proxyUrl) c.proxyUrl = 'http://localhost:3000';
  return c;
}
function assertConfig(c) {
  if (!c?.proxyUrl) throw new Error('Backend proxy URL not configured. Open Config tab.');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log('[CloudLabs] ' + msg); }

// ── AUTO-RESTORE STATE ON STARTUP ──────────────────────
(async () => {
  try {
    const saved = await load('cl_lab');
    if (saved && saved.steps && Array.isArray(saved.steps) && saved.steps.length > 0) {
      steps = saved.steps;
      stepIndex = saved.stepIndex || 0;
      labGoal = saved.goal || '';
      isActive = true;
      log('Restored ' + steps.length + ' steps from storage');
    }
  } catch (err) {
    log('Failed to restore state: ' + err.message);
  }
})();

console.log('[CloudLabs v4] background ready');
