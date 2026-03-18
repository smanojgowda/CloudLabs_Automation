/**
 * sidepanel.js — CloudLabs v4
 * Manual step-by-step navigation. No continuous scanning.
 */

var $ = function(id) { return document.getElementById(id); };
var $$ = function(sel) { return document.querySelectorAll(sel); };

var totalSteps  = 0;
var currentStep = 0;
var stepsData   = [];

document.addEventListener('DOMContentLoaded', function() {
  wireTabs();
  wireGuideTab();
  wireUploadTab();
  wireChatTab();
  wireConfigTab();
  loadConfig();
  restoreState();
  wireTabChangeStop();
});

// FIX 3: Hide overlay when user switches to a different website
function wireTabChangeStop() {
  if (!chrome.tabs) return;
  chrome.tabs.onActivated.addListener(function(info) {
    // When user switches tabs, hide overlay on the previous tab
    chrome.tabs.query({ active: false }, function(tabs) {
      tabs.forEach(function(tab) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'HIDE_OVERLAY' }).catch(function(){});
        }
      });
    });
  });
  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo) {
    // When URL changes (navigation), clear overlay and prefetch cache
    if (changeInfo.url) {
      chrome.tabs.sendMessage(tabId, { type: 'HIDE_OVERLAY' }).catch(function(){});
    }
  });
}

// Receive background broadcast when element is resolved
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'STEPS_UPDATED') {
    var incoming = msg.payload?.steps;
    if (Array.isArray(incoming) && incoming.length) {
      stepsData = incoming;
      totalSteps = incoming.length;
      if (typeof msg.payload?.stepIndex === 'number') {
        currentStep = Math.max(0, Math.min(msg.payload.stepIndex, totalSteps - 1));
      }
      $('stepsBadge').textContent = totalSteps;
      renderStepCard(currentStep);
      renderStepList();
    }
    return;
  }

  if (msg.type === 'STEP_RESOLVED') {
    if (typeof msg.payload?.index === 'number' && msg.payload.index !== currentStep) {
      return;
    }
    var t = msg.payload.target;
    var errorFix   = msg.payload.errorFix   || (t && t.error_fix)   || '';
    var needsScroll= msg.payload.needsScroll || (t && t.needs_scroll)|| false;
    var warning    = msg.payload.warning || '';
    if (t && (t.not_found || t.wrong_page)) {
      var targetText = (t && (t.text || t.selector)) || stepsData[currentStep]?.what_to_find || stepsData[currentStep]?.title || 'the required button';
      var issueMsg = t.wrong_page ? 'Wrong page — navigate first.' : 'Element not found on this page.';
      var fixMsg   = '';
      if (t.navigate_to) fixMsg += '👉 Go to: ' + t.navigate_to + '\n';
      if (!t.wrong_page || needsScroll) {
        fixMsg += '📜 Scroll down and look for "' + targetText + '".\n';
      }
      if (errorFix)      fixMsg += '🔧 ' + errorFix;
      if (!fixMsg)       fixMsg = 'Check you are on the correct Azure page, then click Retry.';
      showIssue(issueMsg, fixMsg.trim());
      setStatus('error', 'Not found');
    } else if (warning) {
      showIssue('Step needs attention', (errorFix || warning).trim());
      setStatus('active', 'Step ' + (msg.payload.index + 1) + ' / ' + totalSteps);
    } else if (msg.payload.error) {
      showIssue(msg.payload.error, errorFix || '');
      setStatus('error', 'Error');
    } else {
      $('issueArea')?.classList.add('hidden');
      setStatus('active', 'Step ' + (msg.payload.index + 1) + ' / ' + totalSteps);
    }
  }
});

// ── Tabs ─────────────────────────────────────────────────
function wireTabs() {
  $$('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      $$('.tab').forEach(function(b){ b.classList.remove('active'); });
      $$('.panel').forEach(function(p){ p.classList.remove('active'); });
      btn.classList.add('active');
      var p = $('tab-' + btn.dataset.tab);
      if (p) p.classList.add('active');
    });
  });
}

function switchTab(name) {
  $$('.tab').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === name); });
  $$('.panel').forEach(function(p){ p.classList.toggle('active', p.id === 'tab-' + name); });
}

// ── Guide Tab ─────────────────────────────────────────────
function wireGuideTab() {
  $('btnGenerate')?.addEventListener('click', generateSteps);
  $('btnReset')?.addEventListener('click', resetLab);
  $('btnPrev')?.addEventListener('click', function() { navigateTo(currentStep - 1); });
  $('btnNext')?.addEventListener('click', function() { navigateTo(currentStep + 1); });
  $('btnRetry')?.addEventListener('click', function() {
    setStatus('loading','Retrying…');
    bg('RETRY_STEP').then(function(){ setStatus('active','Scanning…'); });
  });

  // Keyboard shortcuts (← →) mirror in panel too
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' && !e.target.matches('input,textarea')) navigateTo(currentStep + 1);
    if (e.key === 'ArrowLeft'  && !e.target.matches('input,textarea')) navigateTo(currentStep - 1);
  });
}

async function generateSteps() {
  var goal = $('goalInput')?.value?.trim();
  if (!goal) { $('goalInput')?.focus(); return; }

  setBtnLoad('btnGenerate', true, 'Generating steps…');
  setStatus('loading', 'Generating…');

  var r = await bg('GENERATE_STEPS', { goal });
  setBtnLoad('btnGenerate', false, '✨ Generate Steps');

  if (!r.ok) {
    showAlert('btnGenerate', 'error', r.error);
    if (r.error && r.error.includes('Config')) switchTab('config');
    setStatus('', 'Idle');
    return;
  }

  stepsData   = r.steps;
  totalSteps  = r.count;
  currentStep = 0;

  $('goalText').textContent = goal;
  $('guideIdle').classList.add('hidden');
  $('guideActive').classList.remove('hidden');
  $('stepsBadge').textContent = totalSteps;
  renderStepList();
  setStatus('active', 'Ready');

  // Show step 0 immediately
  navigateTo(0);
}

async function navigateTo(index) {
  if (index < 0 || index >= totalSteps) return;

  currentStep = index;
  renderStepCard(index);
  renderStepList();
  $('issueArea')?.classList.add('hidden');
  setStatus('loading', 'Finding element…');

  // Send message and handle errors
  const r = await bg('NAVIGATE_STEP', { index });
  if (!r.ok) {
    console.error('Navigation failed:', r.error);
    setStatus('error', r.error || 'Navigation failed');
  }
}

function renderStepCard(index) {
  if (!stepsData[index]) return;
  var step = stepsData[index];
  var pct  = totalSteps > 1 ? Math.round((index / (totalSteps - 1)) * 100) : 0;

  var ICONS = { click:'👆', type:'⌨️', select:'☑️', navigate:'🔗', wait:'⏳' };
  $('stepBadge').textContent   = index + 1;
  $('stepAction').textContent  = (ICONS[step.action] || '➡️') + ' ' + cap(step.action || 'action');
  $('stepCounter').textContent = 'Step ' + (index + 1) + ' / ' + totalSteps;
  $('stepTitle').textContent   = step.title || ('Step ' + (index + 1));
  $('stepDesc').textContent    = step.description || step.what_to_find || '';
  $('stepFill').style.width    = pct + '%';

  $('btnPrev').disabled = index === 0;
  $('btnNext').disabled = index === totalSteps - 1;
  $('btnNext').textContent = index === totalSteps - 1 ? '✅ Finish' : 'Next →';
}

function renderStepList() {
  var list = $('stepsList');
  if (!list || !stepsData.length) return;
  list.innerHTML = stepsData.map(function(step, i) {
    var cls = 'step-row' + (i === currentStep ? ' current' : '');
    return '<div class="' + cls + '" data-i="' + i + '">' +
      '<div class="sr-n">' + (i + 1) + '</div>' +
      '<div class="sr-info"><div class="sr-title">' + esc(step.title || 'Step ' + (i+1)) + '</div>' +
      '<div class="sr-desc">' + esc((step.what_to_find || step.description || '').slice(0, 60)) + '</div></div>' +
      '</div>';
  }).join('');
  list.querySelectorAll('.step-row').forEach(function(row) {
    row.addEventListener('click', function() { navigateTo(parseInt(row.dataset.i, 10)); });
  });
}

function showIssue(msg, fix) {
  var area = $('issueArea');
  if (!area) return;
  $('issueMsg').textContent = msg || '';
  var fixEl = $('issueFix');
  if (fix) { fixEl.textContent = fix; fixEl.style.display = 'block'; }
  else { fixEl.style.display = 'none'; }
  area.classList.remove('hidden');
}

async function resetLab() {
  if (!confirm('Reset the lab? All progress will be lost.')) return;
  await bg('CLEAR_LAB');
  stepsData = []; totalSteps = 0; currentStep = 0;
  $('guideActive')?.classList.add('hidden');
  $('guideIdle')?.classList.remove('hidden');
  $('goalInput').value = '';
  setStatus('', 'Idle');
}

// ── Upload Tab ────────────────────────────────────────────
function wireUploadTab() {
  $$('.src-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      $$('.src-tab').forEach(function(b){ b.classList.remove('active'); });
      $$('.src-zone').forEach(function(z){ z.classList.remove('active'); });
      btn.classList.add('active');
      var z = $('zone-' + btn.dataset.src);
      if (z) z.classList.add('active');
      checkUploadReady();
    });
  });

  $('guideText')?.addEventListener('input', checkUploadReady);

  $('fileInput')?.addEventListener('change', function(e) {
    var file = e.target.files[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      $('guideText').value = ev.target.result;
      $('dropTitle').textContent = '✅ ' + file.name;
      $('dropZone')?.classList.add('has-file');
      checkUploadReady();
    };
    reader.readAsText(file);
  });

  $('btnParseGuide')?.addEventListener('click', parseGuide);
}

function checkUploadReady() {
  var hasPaste = $('zone-paste')?.classList.contains('active') && ($('guideText')?.value?.trim().length > 20);
  var hasFile  = $('fileInput')?.files?.length > 0;
  var btn = $('btnParseGuide');
  if (btn) btn.disabled = !(hasPaste || hasFile);
}

async function parseGuide() {
  var text = $('guideText')?.value?.trim();
  if (!text) return;

  setBtnLoad('btnParseGuide', true, 'Parsing…');
  showMsg('uploadMsg', 'info', '🤖 Parsing guide…');

  var r = await bg('GENERATE_STEPS', { goal: text });
  setBtnLoad('btnParseGuide', false, '✨ Parse Guide');

  if (!r.ok) { showMsg('uploadMsg', 'error', '❌ ' + r.error); return; }

  stepsData   = r.steps;
  totalSteps  = r.count;
  currentStep = 0;

  showMsg('uploadMsg', 'success', '✅ ' + r.count + ' steps loaded! Go to Guide tab.');
  $('guideActive')?.classList.remove('hidden');
  $('guideIdle')?.classList.add('hidden');
  $('goalText').textContent = 'From uploaded guide';
  $('stepsBadge').textContent = totalSteps;
  renderStepList();
  setTimeout(function() { switchTab('guide'); navigateTo(0); }, 1200);
}

// ── Chat Tab ──────────────────────────────────────────────
function wireChatTab() {
  $('chatSend')?.addEventListener('click', sendChat);
  $('chatInp')?.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

async function sendChat() {
  var q = $('chatInp')?.value?.trim(); if (!q) return;
  appendBubble(q, 'user');
  $('chatInp').value = '';
  var thinking = appendBubble('Thinking…', 'assistant thinking');
  $('chatSend').disabled = true;
  var r = await bg('ASK_AI', { question: q });
  thinking.remove();
  appendBubble(r.ok ? r.answer : '⚠️ ' + r.error, 'assistant');
  $('chatSend').disabled = false;
}

function appendBubble(text, cls) {
  var d = document.createElement('div');
  d.className = 'bubble ' + cls;
  d.innerHTML = '<div class="bubble-body">' + esc(text) + '</div>';
  $('chatHist').appendChild(d);
  $('chatHist').scrollTop = $('chatHist').scrollHeight;
  return d;
}

// ── Config Tab ────────────────────────────────────────────
function wireConfigTab() {
  $('btnSave')?.addEventListener('click', saveConfig);
  $('btnTest')?.addEventListener('click', testConn);
  $('cfgKey')?.addEventListener('focus', function() {
    if (this.value.match(/^•+$/)) this.value = '';
  });
}

async function loadConfig() {
  var r = await bg('GET_CONFIG');
  if (!r.ok || !r.config) return;
  var c = r.config;
  if ($('cfgProxyUrl')) $('cfgProxyUrl').value = c.proxyUrl || 'http://localhost:3000';
  if ($('cfgEndpoint')) $('cfgEndpoint').value = c.openaiEndpoint   || '';
  if ($('cfgAuth'))     $('cfgAuth').value     = c.openaiAuthHeader || 'api-key';
  if ($('cfgModel'))    $('cfgModel').value    = c.model            || 'gpt-4o-mini';
  if (c.openaiKey && $('cfgKey')) $('cfgKey').value = '•'.repeat(24);
}

async function saveConfig() {
  var proxyUrl = $('cfgProxyUrl')?.value?.trim() || '';
  var endpoint = $('cfgEndpoint')?.value?.trim() || '';
  var key      = $('cfgKey')?.value?.trim()      || '';
  var auth     = $('cfgAuth')?.value?.trim()     || 'api-key';
  var model    = $('cfgModel')?.value?.trim()    || 'gpt-4o-mini';

  if (!proxyUrl)              { showMsg('cfgMsg','error','⚠️ Proxy URL required.'); return; }
  if (!proxyUrl.startsWith('http')) { showMsg('cfgMsg','error','⚠️ Proxy URL must start with http://'); return; }

  var current = (await bg('GET_CONFIG')).config || {};
  var saving  = { proxyUrl, openaiEndpoint: endpoint, openaiAuthHeader: auth, model };
  saving.openaiKey = (key && !key.match(/^•+$/)) ? key : (current.openaiKey || '');

  await bg('SAVE_CONFIG', saving);
  if (key && !key.match(/^•+$/)) $('cfgKey').value = '•'.repeat(24);
  showMsg('cfgMsg', 'success', '✅ Saved!');
}

async function testConn() {
  var cfg = (await bg('GET_CONFIG')).config;
  if (!cfg?.proxyUrl) { showMsg('cfgMsg','error','⚠️ Save config first.'); return; }
  setBtnLoad('btnTest', true, 'Testing…');
  var r = await bg('TEST_CONNECTION', { config: cfg });
  setBtnLoad('btnTest', false, '🔌 Test');
  if (r.ok) showMsg('cfgMsg','success','✅ Connected!');
  else      showMsg('cfgMsg','error','❌ ' + r.error);
}

// ── Restore ───────────────────────────────────────────────
async function restoreState() {
  var r = await bg('GET_STATE');
  if (r.ok && r.steps?.length) {
    stepsData   = r.steps;
    totalSteps  = r.steps.length;
    currentStep = r.stepIndex || 0;
    $('goalText').textContent = r.labGoal || 'Restored lab';
    $('guideIdle')?.classList.add('hidden');
    $('guideActive')?.classList.remove('hidden');
    $('stepsBadge').textContent = totalSteps;
    renderStepCard(currentStep);
    renderStepList();
    setStatus('active', 'Step ' + (currentStep + 1) + ' / ' + totalSteps);
  }
}

// ── Helpers ───────────────────────────────────────────────
function bg(type, payload) {
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage({ type, payload: payload || {} }, function(r) {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(r || { ok: false });
    });
  });
}

function setStatus(state, label) {
  var pill = $('statusPill'); if (!pill) return;
  pill.className = 'status-pill' + (state ? ' ' + state : '');
  var txt = $('statusTxt'); if (txt) txt.textContent = label;
}

function showMsg(id, type, text) {
  var el = $(id); if (!el) return;
  var cls = {success:'alert-success',error:'alert-error',info:'alert-info'}[type]||'alert-info';
  el.innerHTML = '<div class="alert ' + cls + '" style="margin-top:8px">' + esc(text) + '</div>';
}

function showAlert(nearId, type, text) {
  var near = $(nearId); if (!near) return;
  var div = document.createElement('div');
  var cls = {success:'alert-success',error:'alert-error',info:'alert-info'}[type]||'alert-info';
  div.className = 'alert ' + cls;
  div.style.marginTop = '8px';
  div.textContent = text;
  near.parentNode.insertBefore(div, near.nextSibling);
  setTimeout(function(){ div.remove(); }, 5000);
}

function setBtnLoad(id, loading, label) {
  var btn = $(id); if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? '<div class="spin"></div> ' + label : label;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
