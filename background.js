/**
 * background.js — v3 Service Worker
 * ════════════════════════════════════════════════════════════
 *
 * NEW ARCHITECTURE: Continuous AI scan loop.
 *
 * Every SCAN_INTERVAL ms:
 *  1. Capture a screenshot of the active tab (captureVisibleTab)
 *  2. Request a DOM snapshot from the content script
 *  3. Send both to Azure OpenAI Vision (GPT-4o)
 *  4. Parse the AI response — what to highlight, any errors
 *  5. Send the highlight instruction to the content script
 *  6. Update the side panel with current status + guidance
 *
 * The AI sees the LIVE page and decides what action to take.
 * It detects errors, grayed-out elements, wrong pages, etc.
 * Static pre-parsed steps are gone.
 */

import { analyzePage } from './src/ai/pageAnalyzer.js';

// ════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════
const SCAN_INTERVAL    = 3000;  // ms between AI scans
const MAX_HISTORY      = 20;    // max completed actions to remember
const SCREENSHOT_QUALITY = 70;  // JPEG quality for screenshots (lower = faster/cheaper)

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════
let scanTimer       = null;
let isScanning      = false;
let scanActive      = false;   // true while the scan loop is running
let lastAnalysis    = null;    // most recent AI analysis result
let actionHistory   = [];      // completed actions log
let currentGoal     = '';
let manualStepIndex = 0;       // for manual prev/next override
let manualSteps     = [];      // history snapshots for prev/next
let scanErrors      = 0;       // consecutive scan errors (circuit breaker)

// ════════════════════════════════════════════════════════════
// SIDE PANEL OPEN
// ════════════════════════════════════════════════════════════
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ════════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const routes = {
    START_SCAN:       () => handleStartScan(msg.payload, sendResponse),
    STOP_SCAN:        () => handleStopScan(sendResponse),
    MARK_DONE:        () => handleMarkDone(msg.payload, sendResponse),
    MANUAL_PREV:      () => handleManualPrev(sendResponse),
    MANUAL_NEXT:      () => handleManualNext(sendResponse),
    GET_STATE:        () => handleGetState(sendResponse),
    SAVE_CONFIG:      () => handleSaveConfig(msg.payload, sendResponse),
    GET_CONFIG:       () => handleGetConfig(sendResponse),
    TEST_CONNECTION:  () => handleTestConnection(msg.payload, sendResponse),
    CLEAR_HISTORY:    () => handleClearHistory(sendResponse),
    ASK_AI:           () => handleAskAI(msg.payload, sendResponse),
    FORCE_SCAN:       () => handleForceScan(sendResponse),
  };
  if (routes[msg.type]) { routes[msg.type](); return true; }
});

// ════════════════════════════════════════════════════════════
// START SCAN LOOP
// ════════════════════════════════════════════════════════════
async function handleStartScan({ goal }, sendResponse) {
  if (!goal?.trim()) { sendResponse({ ok: false, error: 'Please enter a goal first.' }); return; }

  const config = await loadConfig();
  if (!config?.openaiEndpoint || !config?.openaiKey) {
    sendResponse({ ok: false, error: 'Configure Azure OpenAI endpoint and key in the Config tab first.' });
    return;
  }

  currentGoal     = goal.trim();
  scanActive      = true;
  scanErrors      = 0;
  actionHistory   = [];
  manualSteps     = [];
  manualStepIndex = 0;

  await store('cloudlabs_state', { goal: currentGoal, history: [], active: true });

  log(`Scan loop started. Goal: "${currentGoal}"`);
  sendResponse({ ok: true });

  // Run first scan immediately
  runScanCycle();

  // Schedule recurring scans
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    if (scanActive && !isScanning) runScanCycle();
  }, SCAN_INTERVAL);
}

// ════════════════════════════════════════════════════════════
// STOP SCAN LOOP
// ════════════════════════════════════════════════════════════
async function handleStopScan(sendResponse) {
  stopLoop();
  await notifyContentScript({ type: 'HIDE_OVERLAY' });
  sendResponse({ ok: true });
}

function stopLoop() {
  scanActive = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

// ════════════════════════════════════════════════════════════
// CORE SCAN CYCLE
// ════════════════════════════════════════════════════════════
async function runScanCycle() {
  if (!scanActive || isScanning) return;
  isScanning = true;

  try {
    const config = await loadConfig();
    if (!config?.openaiEndpoint) { isScanning = false; return; }

    // 1. Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
      isScanning = false;
      return;
    }

    // 2. Ensure content script is alive
    const alive = await pingTab(tab.id);
    if (!alive) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/overlay/overlay.css'] });
        await sleep(300);
      } catch { isScanning = false; return; }
    }

    // 3. Show "scanning" state in side panel
    broadcastToPanel({ type: 'SCAN_STATUS', payload: { scanning: true } });

    // 4. Take screenshot
    let screenshot = null;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: SCREENSHOT_QUALITY });
      screenshot = dataUrl.split(',')[1]; // strip data:image/jpeg;base64,
    } catch (e) { log('Screenshot failed: ' + e.message); }

    // 5. Get DOM snapshot from content script
    let domSnapshot = '';
    try {
      const snap = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });
      domSnapshot = snap?.snapshot || '';
    } catch { domSnapshot = 'Could not read page DOM.'; }

    // 6. Call Azure OpenAI
    const analysis = await analyzePage({
      goal: currentGoal,
      domSnapshot,
      screenshot,
      history: actionHistory,
      pageUrl: tab.url,
      pageTitle: tab.title,
    }, config);

    lastAnalysis    = analysis;
    scanErrors      = 0;

    // 7. Send highlight + guidance to content script
    if (analysis.action?.target && analysis.status !== 'goal_complete') {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'HIGHLIGHT_TARGET',
        payload: {
          target:     analysis.action.target,
          guidance:   analysis.action.guidance,
          issues:     analysis.issues,
          fix:        analysis.fix_suggestion,
          status:     analysis.status,
          actionType: analysis.action.type,
          progress:   analysis.progress,
          history:    actionHistory,
        },
      });
    } else if (analysis.status === 'goal_complete') {
      await notifyContentScript({ type: 'SHOW_COMPLETE', payload: { goal: currentGoal } });
      stopLoop();
    } else if (analysis.status === 'wrong_page') {
      await notifyContentScript({
        type: 'SHOW_WRONG_PAGE',
        payload: { guidance: analysis.action?.guidance, fix: analysis.fix_suggestion },
      });
    }

    // 8. Update side panel
    broadcastToPanel({
      type: 'ANALYSIS_UPDATE',
      payload: {
        guidance:   analysis.action?.guidance || '',
        issues:     analysis.issues || [],
        fix:        analysis.fix_suggestion || '',
        progress:   analysis.progress || '',
        status:     analysis.status,
        history:    actionHistory,
        actionType: analysis.action?.type || '',
        scanning:   false,
        goalComplete: analysis.goal_complete,
      },
    });

    // Save snapshot for prev/next navigation
    manualSteps.push({ analysis, timestamp: Date.now() });
    if (manualSteps.length > 50) manualSteps.shift();
    manualStepIndex = manualSteps.length - 1;

  } catch (err) {
    scanErrors++;
    logError('runScanCycle', err);
    broadcastToPanel({
      type: 'SCAN_ERROR',
      payload: { error: err.message, consecutive: scanErrors },
    });
    // Circuit breaker: stop after 5 consecutive errors
    if (scanErrors >= 5) {
      stopLoop();
      broadcastToPanel({
        type: 'ANALYSIS_UPDATE',
        payload: { guidance: '', issues: [`Scan stopped after errors: ${err.message}`], fix: 'Check your Azure OpenAI config and try again.', status: 'error', scanning: false },
      });
    }
  }

  isScanning = false;
}

// ════════════════════════════════════════════════════════════
// MARK DONE — user completed the current action
// ════════════════════════════════════════════════════════════
async function handleMarkDone({ actionDescription }, sendResponse) {
  if (actionDescription) {
    actionHistory.push(actionDescription);
    if (actionHistory.length > MAX_HISTORY) actionHistory.shift();
    await store('cloudlabs_state', { goal: currentGoal, history: actionHistory, active: scanActive });
  }
  // Force an immediate rescan
  if (scanActive && !isScanning) runScanCycle();
  sendResponse({ ok: true });
}

// ════════════════════════════════════════════════════════════
// MANUAL PREV / NEXT (navigate through saved snapshots)
// ════════════════════════════════════════════════════════════
async function handleManualPrev(sendResponse) {
  if (manualStepIndex > 0) {
    manualStepIndex--;
    const snap = manualSteps[manualStepIndex];
    if (snap) {
      broadcastToPanel({ type: 'ANALYSIS_UPDATE', payload: { ...snap.analysis, scanning: false } });
      // Re-highlight
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && snap.analysis.action?.target) {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'HIGHLIGHT_TARGET',
          payload: {
            target: snap.analysis.action.target,
            guidance: snap.analysis.action.guidance,
            issues: snap.analysis.issues,
            fix: snap.analysis.fix_suggestion,
            status: snap.analysis.status,
            actionType: snap.analysis.action.type,
          },
        }).catch(() => {});
      }
    }
  }
  sendResponse({ ok: true });
}

async function handleManualNext(sendResponse) {
  if (manualStepIndex < manualSteps.length - 1) {
    manualStepIndex++;
    const snap = manualSteps[manualStepIndex];
    if (snap) {
      broadcastToPanel({ type: 'ANALYSIS_UPDATE', payload: { ...snap.analysis, scanning: false } });
    }
  } else {
    // Force a fresh scan
    if (scanActive && !isScanning) runScanCycle();
  }
  sendResponse({ ok: true });
}

// ════════════════════════════════════════════════════════════
// FORCE SCAN — immediate rescan on demand
// ════════════════════════════════════════════════════════════
function handleForceScan(sendResponse) {
  if (scanActive && !isScanning) runScanCycle();
  sendResponse({ ok: true });
}

// ════════════════════════════════════════════════════════════
// CHATBOX — ask AI a question about the current state
// ════════════════════════════════════════════════════════════
async function handleAskAI({ question }, sendResponse) {
  try {
    const config = await loadConfig();
    if (!config?.openaiEndpoint) throw new Error('Configure Azure OpenAI first.');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let domSnapshot = '';
    if (tab) {
      try {
        const s = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });
        domSnapshot = s?.snapshot || '';
      } catch {}
    }

    const context = lastAnalysis
      ? `Current guidance: ${lastAnalysis.action?.guidance || ''}\nCurrent status: ${lastAnalysis.status}`
      : '';

    const prompt = `You are a CloudLabs Azure assistant. Answer concisely (2-3 sentences max).

${context}
${domSnapshot ? `Page elements: ${domSnapshot.slice(0, 2000)}` : ''}

User question: ${question}`;

    const headers = { 'Content-Type': 'application/json' };
    const h = config.openaiAuthHeader || 'api-key';
    headers[h.toLowerCase() === 'authorization' ? 'Authorization' : h] =
      h.toLowerCase() === 'authorization' && !config.openaiKey.startsWith('Bearer ')
        ? `Bearer ${config.openaiKey}` : config.openaiKey;

    const isResp = config.openaiEndpoint.includes('/responses');
    const body = isResp ? {
      model: config.model || 'gpt-4o',
      input: [{ role: 'user', content: prompt }],
      max_output_tokens: 300,
    } : {
      model: config.model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.3,
    };

    const resp = await fetch(config.openaiEndpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await resp.json();
    const answer = isResp
      ? data?.output?.flatMap(o => o.content || [])?.find(c => c.type === 'output_text')?.text || ''
      : data?.choices?.[0]?.message?.content || '';

    sendResponse({ ok: true, answer: answer.trim() });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════
// CONFIG + STATE
// ════════════════════════════════════════════════════════════
async function handleGetState(sendResponse) {
  const state = await load('cloudlabs_state');
  sendResponse({ ok: true, state, scanActive, lastAnalysis });
}

async function handleSaveConfig(config, sendResponse) {
  await store('cloudlabs_config', config);
  sendResponse({ ok: true });
}

async function handleGetConfig(sendResponse) {
  const config = await load('cloudlabs_config');
  sendResponse({ ok: true, config: config || null });
}

async function handleTestConnection({ config }, sendResponse) {
  try {
    const h = config.openaiAuthHeader || 'api-key';
    const headers = { 'Content-Type': 'application/json' };
    headers[h.toLowerCase() === 'authorization' ? 'Authorization' : h] =
      h.toLowerCase() === 'authorization' && !config.openaiKey.startsWith('Bearer ')
        ? `Bearer ${config.openaiKey}` : config.openaiKey;

    const isResp = config.openaiEndpoint?.includes('/responses');
    const body = isResp ? {
      model: config.model || 'gpt-4o',
      input: [{ role: 'user', content: 'Reply: CloudLabs connected.' }],
      max_output_tokens: 20,
    } : {
      model: config.model || 'gpt-4o',
      messages: [{ role: 'user', content: 'Reply: CloudLabs connected.' }],
      max_tokens: 20,
    };

    const resp = await fetch(config.openaiEndpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e?.error?.message || `HTTP ${resp.status}`);
    }
    sendResponse({ ok: true, message: 'Connection successful!' });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleClearHistory(sendResponse) {
  actionHistory   = [];
  manualSteps     = [];
  manualStepIndex = 0;
  await store('cloudlabs_state', { goal: currentGoal, history: [], active: scanActive });
  sendResponse({ ok: true });
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

async function notifyContentScript(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, msg);
  } catch {}
}

function broadcastToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function pingTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return r?.alive === true;
  } catch { return false; }
}

async function loadConfig() {
  return (await load('cloudlabs_config')) || {};
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[CloudLabs BG] ${msg}`); }
function logError(fn, e) { console.error(`[CloudLabs BG] ${fn}:`, e.message); }
