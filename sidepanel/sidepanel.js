/**
 * sidepanel.js — v3
 * Drives the side panel UI.
 * Communicates with background.js via chrome.runtime.sendMessage.
 * Receives live updates from background via chrome.runtime.onMessage.
 */

const $ = id => document.getElementById(id);

// ── Refs ─────────────────────────────────────────────────
const statusPill    = $('statusPill');
const statusTxt     = $('statusTxt');
const goalInput     = $('goalInput');
const goalSection   = $('goalSection');
const liveSection   = $('liveSection');
const goalDisplay   = $('goalDisplay');
const goalBanner    = $('goalBanner');
const scanDot       = $('scanDot');
const scanBarTxt    = $('scanBarTxt');
const issueBanner   = $('issueBanner');
const issueBody     = $('issueBody');
const issueFix      = $('issueFix');
const guidanceChip  = $('guidanceChip');
const guidanceTxt   = $('guidanceTxt');
const guidanceHint  = $('guidanceHint');
const histCount     = $('histCount');
const historyList   = $('historyList');
const chatHist      = $('chatHist');
const chatInp       = $('chatInp');
const cfgMsg        = $('cfgMsg');

// ════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  wireTabs();
  wireGuideTab();
  wireChatTab();
  wireConfigTab();
  await loadConfig();
  await restoreState();
  listenToBackground();
});

// ════════════════════════════════════════════════════════════
// BACKGROUND MESSAGE LISTENER
// Background broadcasts live AI updates here
// ════════════════════════════════════════════════════════════
function listenToBackground() {
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'ANALYSIS_UPDATE': applyAnalysis(msg.payload); break;
      case 'SCAN_STATUS':     applyScanStatus(msg.payload); break;
      case 'SCAN_ERROR':      applyScanError(msg.payload); break;
    }
  });
}

// ════════════════════════════════════════════════════════════
// APPLY AI ANALYSIS TO UI
// ════════════════════════════════════════════════════════════
function applyAnalysis(p) {
  const { guidance, issues, fix, progress, status, actionType, history, scanning, goalComplete } = p;

  // Scan dot
  scanDot.className = 'scan-dot active';
  scanBarTxt.textContent = scanning ? 'Scanning…' : `Last scan: ${timeAgo()}`;

  // Status pill
  if (goalComplete) {
    setStatus('active', '🎉 Complete!');
  } else if (status === 'error_detected') {
    setStatus('error', 'Issue detected');
  } else if (status === 'wrong_page') {
    setStatus('error', 'Wrong page');
  } else {
    setStatus('active', 'Guiding');
  }

  // Issues banner
  if (issues?.length) {
    issueBody.textContent = issues.join('\n');
    if (fix) {
      issueFix.textContent = fix;
      issueFix.classList.remove('hidden');
    } else {
      issueFix.classList.add('hidden');
    }
    issueBanner.classList.remove('hidden');
  } else {
    issueBanner.classList.add('hidden');
  }

  // Guidance card
  const ACTION_ICONS = { click:'👆', type:'⌨️', select:'☑️', navigate:'🔗', wait:'⏳', verify:'✅', scroll:'📜' };
  const icon  = ACTION_ICONS[actionType] || '➡️';
  guidanceChip.textContent = issues?.length ? '⚠️ Issue — action needed' : `${icon} ${cap(actionType || 'action')}`;
  guidanceChip.style.color = issues?.length ? '#fde68a' : '';
  guidanceTxt.textContent  = guidance || 'Analysing page…';
  guidanceHint.textContent = progress || '';

  // History
  if (history?.length) updateHistory(history);
}

function applyScanStatus({ scanning }) {
  if (scanning) {
    scanDot.className = 'scan-dot loading';
    scanBarTxt.textContent = 'Scanning…';
    setStatus('loading', 'Scanning…');
  }
}

function applyScanError({ error, consecutive }) {
  guidanceTxt.textContent = `Scan error: ${error}`;
  scanDot.className = 'scan-dot';
  scanBarTxt.textContent = 'Scan failed';
  if (consecutive >= 5) {
    setStatus('error', 'Stopped');
    showStopped();
  }
}

// ════════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════════
function wireTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`)?.classList.add('active');
    });
  });
  $('btnConfig')?.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'config'));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-config'));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}

// ════════════════════════════════════════════════════════════
// GUIDE TAB
// ════════════════════════════════════════════════════════════
function wireGuideTab() {
  $('btnStart')?.addEventListener('click', startScan);
  $('btnStop')?.addEventListener('click',  stopScan);
  $('btnRescan')?.addEventListener('click', forceScan);
  $('btnDone')?.addEventListener('click',   markDone);
  $('btnPrev')?.addEventListener('click',   () => bg('MANUAL_PREV'));
  $('btnNext')?.addEventListener('click',   () => bg('MANUAL_NEXT'));
  $('btnClearHistory')?.addEventListener('click', async () => {
    await bg('CLEAR_HISTORY');
    historyList.innerHTML = '';
    histCount.textContent = '0 actions';
  });
}

async function startScan() {
  const goal = goalInput?.value?.trim();
  if (!goal) { goalInput?.focus(); return; }

  setBtnLoad('btnStart', true, 'Starting…');

  const r = await bg('START_SCAN', { goal });
  setBtnLoad('btnStart', false, '🚀 Start AI Guide');

  if (!r.ok) {
    showCfgMsg('error', r.error);
    switchTab('config');
    return;
  }

  goalDisplay.textContent = goal;
  goalSection.classList.add('hidden');
  liveSection.classList.remove('hidden');
  setStatus('loading', 'Starting…');
  scanDot.className = 'scan-dot loading';
  scanBarTxt.textContent = 'Starting…';
}

async function stopScan() {
  await bg('STOP_SCAN');
  showStopped();
}

function showStopped() {
  liveSection.classList.add('hidden');
  goalSection.classList.remove('hidden');
  setStatus('', 'Idle');
  scanDot.className = 'scan-dot';
}

function forceScan() {
  scanDot.className = 'scan-dot loading';
  scanBarTxt.textContent = 'Scanning…';
  bg('FORCE_SCAN');
}

async function markDone() {
  const action = guidanceTxt?.textContent || 'Action completed';
  await bg('MARK_DONE', { actionDescription: action.slice(0, 120) });
  // Visual feedback
  $('btnDone').textContent = '✓ Done!';
  setTimeout(() => { if ($('btnDone')) $('btnDone').textContent = '✅ Done, next'; }, 1200);
}

function updateHistory(history) {
  histCount.textContent = `${history.length} action${history.length !== 1 ? 's' : ''}`;
  historyList.innerHTML = history.map((item, i) => `
    <div class="hist-item">
      <span class="hist-num">${i + 1}</span>
      <span class="hist-txt">${esc(item)}</span>
    </div>
  `).join('');
  historyList.scrollTop = historyList.scrollHeight;
}

// ════════════════════════════════════════════════════════════
// CHAT TAB
// ════════════════════════════════════════════════════════════
function wireChatTab() {
  $('chatSend')?.addEventListener('click', sendChat);
  chatInp?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

async function sendChat() {
  const q = chatInp?.value?.trim();
  if (!q) return;

  appendBubble(q, 'user');
  chatInp.value = '';

  const thinking = appendBubble('Thinking…', 'assistant thinking');
  $('chatSend').disabled = true;

  const r = await bg('ASK_AI', { question: q });
  thinking.remove();
  appendBubble(r.ok ? r.answer : `Error: ${r.error}`, 'assistant');
  $('chatSend').disabled = false;
}

function appendBubble(text, cls) {
  const d = document.createElement('div');
  d.className = `bubble ${cls}`;
  d.innerHTML = `<div class="bubble-body">${esc(text)}</div>`;
  chatHist.appendChild(d);
  chatHist.scrollTop = chatHist.scrollHeight;
  return d;
}

// ════════════════════════════════════════════════════════════
// CONFIG TAB
// ════════════════════════════════════════════════════════════
function wireConfigTab() {
  $('btnSave')?.addEventListener('click', saveConfig);
  $('btnTest')?.addEventListener('click', testConn);
  $('cfgKey')?.addEventListener('focus', function() {
    if (this.value.match(/^•+$/)) this.value = '';
  });
}

async function loadConfig() {
  const r = await bg('GET_CONFIG');
  if (!r.ok || !r.config) return;
  const c = r.config;
  if ($('cfgEndpoint'))  $('cfgEndpoint').value  = c.openaiEndpoint   || '';
  if ($('cfgAuth'))      $('cfgAuth').value       = c.openaiAuthHeader || 'api-key';
  if ($('cfgModel'))     $('cfgModel').value      = c.model            || 'gpt-4o';
  if ($('cfgInterval'))  $('cfgInterval').value   = c.scanInterval     || '3000';
  if (c.openaiKey && $('cfgKey')) $('cfgKey').value = '•'.repeat(24);
}

async function saveConfig() {
  const endpoint = $('cfgEndpoint')?.value?.trim();
  const key      = $('cfgKey')?.value?.trim();
  const auth     = $('cfgAuth')?.value?.trim()     || 'api-key';
  const model    = $('cfgModel')?.value?.trim()    || 'gpt-4o';
  const interval = $('cfgInterval')?.value        || '3000';

  if (!endpoint) { showCfgMsg('error', '⚠️ Endpoint URL is required.'); return; }
  if (!endpoint.startsWith('http')) { showCfgMsg('error', '⚠️ Endpoint must start with https://'); return; }

  const current = (await bg('GET_CONFIG'))?.config || {};
  const saving  = { openaiEndpoint: endpoint, openaiAuthHeader: auth, model, scanInterval: interval };
  saving.openaiKey = (key && !key.match(/^•+$/)) ? key : (current.openaiKey || '');

  await bg('SAVE_CONFIG', saving);
  if (key && !key.match(/^•+$/)) $('cfgKey').value = '•'.repeat(24);
  showCfgMsg('success', '✅ Saved!');
}

async function testConn() {
  const cfg = (await bg('GET_CONFIG'))?.config;
  if (!cfg?.openaiEndpoint) { showCfgMsg('error', '⚠️ Save config first.'); return; }

  setBtnLoad('btnTest', true, 'Testing…');
  clearMsg('cfgMsg');

  const r = await bg('TEST_CONNECTION', { config: cfg });
  setBtnLoad('btnTest', false, '🔌 Test');

  if (r.ok) showCfgMsg('success', '✅ Connected successfully!');
  else      showCfgMsg('error', `❌ ${r.error}`);
}

// ════════════════════════════════════════════════════════════
// STATE RESTORE
// ════════════════════════════════════════════════════════════
async function restoreState() {
  const r = await bg('GET_STATE');
  if (r.ok && r.scanActive && r.state?.goal) {
    goalDisplay.textContent = r.state.goal;
    if (goalInput) goalInput.value = r.state.goal;
    goalSection.classList.add('hidden');
    liveSection.classList.remove('hidden');
    setStatus('loading', 'Resuming…');
    if (r.lastAnalysis) applyAnalysis({ ...r.lastAnalysis, scanning: false });
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function bg(type, payload = {}) {
  return new Promise(res => {
    chrome.runtime.sendMessage({ type, payload }, r => {
      if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
      else res(r || { ok: false });
    });
  });
}

function setStatus(state, label) {
  if (!statusPill) return;
  statusPill.className = 'status-pill' + (state ? ` ${state}` : '');
  if (statusTxt) statusTxt.textContent = label;
}

function showCfgMsg(type, text) {
  const el = $('cfgMsg');
  if (!el) return;
  const cls = { success:'alert-success', error:'alert-error', info:'alert-info' }[type] || 'alert-info';
  el.innerHTML = `<div class="alert ${cls}" style="margin-top:8px">${esc(text)}</div>`;
}

function clearMsg(id) { const e=$(id); if(e) e.innerHTML=''; }

function setBtnLoad(id, loading, label) {
  const btn = $(id); if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? `<div class="spin"></div> ${label}` : label;
}

function esc(s='') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

function timeAgo() {
  return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
