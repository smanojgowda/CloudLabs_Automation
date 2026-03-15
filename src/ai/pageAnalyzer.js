/**
 * src/ai/pageAnalyzer.js
 * ════════════════════════════════════════════════════════════
 * CORE AI ENGINE — v3
 *
 * Every scan cycle this receives:
 *   • The user's overall goal ("Create a VM in Azure")
 *   • A structured DOM snapshot (all visible interactive elements)
 *   • A base64 screenshot of the page (for visual context)
 *   • The history of completed actions so far
 *
 * It returns a precise JSON object telling the extension:
 *   • Which element to highlight (selector + fallback text)
 *   • What guidance text to show the user
 *   • Any errors, warnings, or blocking issues detected
 *   • Whether the goal is complete
 *
 * This is what replaces static pre-parsed steps.
 * The AI sees the LIVE page every scan cycle and decides intelligently.
 */

// ════════════════════════════════════════════════════════════
// MAIN EXPORT
// ════════════════════════════════════════════════════════════

/**
 * Analyze the current page state and return what to do next.
 *
 * @param {object} params
 *   params.goal        - user's overall goal string
 *   params.domSnapshot - structured JSON of interactive elements
 *   params.screenshot  - base64 PNG screenshot (optional, used for vision)
 *   params.history     - array of recently completed actions
 *   params.pageUrl     - current URL
 *   params.pageTitle   - current page title
 * @param {object} config - { openaiEndpoint, openaiKey, openaiAuthHeader, model }
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzePage(params, config) {
  const { goal, domSnapshot, screenshot, history, pageUrl, pageTitle } = params;

  const useVision = !!(screenshot && config.model?.includes('gpt-4') || config.model?.includes('o1'));

  const messages = buildMessages({ goal, domSnapshot, screenshot: useVision ? screenshot : null, history, pageUrl, pageTitle });

  const raw = await callAzureOpenAI(messages, config);

  return parseAnalysisResult(raw);
}

// ════════════════════════════════════════════════════════════
// MESSAGE BUILDER
// ════════════════════════════════════════════════════════════

function buildMessages({ goal, domSnapshot, screenshot, history, pageUrl, pageTitle }) {
  const systemPrompt = `You are an expert Azure cloud portal assistant embedded in a browser extension.

Your job: look at the current state of an Azure portal page and tell the user EXACTLY what to do next to achieve their goal.

You can see:
1. The user's goal
2. A structured list of ALL visible interactive elements on the page (buttons, inputs, dropdowns, links)
3. A screenshot of the page (if provided)
4. What the user has already done

CRITICAL RULES:
- Only suggest actions for elements that are CURRENTLY VISIBLE and ENABLED on the page
- If you see an error, warning, or unavailable option — report it immediately and suggest how to fix it
- If a button is greyed out, disabled, or not on this page — DO NOT suggest clicking it
- Be specific about WHERE the element is (e.g. "in the top command bar", "in the left sidebar", "in the Basics tab form")
- The user CANNOT see your reasoning — only the guidance text is shown to them

Return ONLY this JSON (no markdown, no explanation):
{
  "status": "action_required" | "error_detected" | "goal_complete" | "waiting" | "wrong_page",
  "action": {
    "type": "click" | "type" | "select" | "scroll" | "navigate" | "wait",
    "guidance": "Clear 1-2 sentence instruction. Describe WHAT to do and WHERE to find it.",
    "target": {
      "selector": "best CSS selector for the element (use aria-label, id, role, or text)",
      "text":     "exact visible text of the element (button label, input label, etc.)",
      "hint":     "where to look on the page (e.g. 'top command bar', 'bottom of form', 'left sidebar')"
    }
  },
  "issues": [
    "Any error messages, warnings, or unavailable options detected — quote them exactly"
  ],
  "fix_suggestion": "If issues exist, plain-English fix (e.g. 'Change the region to East US 2 — the selected VM size is not available in East US')",
  "progress": "Brief description of progress toward goal (e.g. 'Basics tab complete, now on Networking')",
  "goal_complete": false
}`;

  const historyText = history?.length
    ? `\nActions completed so far:\n${history.slice(-5).map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`
    : '\nNo actions completed yet — this is the start.';

  const userContent = [];

  if (screenshot) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${screenshot}`, detail: 'high' },
    });
  }

  userContent.push({
    type: 'text',
    text: `GOAL: ${goal}
${historyText}

PAGE: ${pageTitle}
URL: ${pageUrl}

VISIBLE INTERACTIVE ELEMENTS ON THIS PAGE:
${domSnapshot}

Analyze the page and return JSON telling me exactly what to highlight and what the user should do next.
If there are any errors or warnings visible, report them in "issues" and provide "fix_suggestion".`,
  });

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: screenshot ? userContent : userContent[userContent.length - 1].text },
  ];
}

// ════════════════════════════════════════════════════════════
// AZURE OPENAI CALLER
// ════════════════════════════════════════════════════════════

async function callAzureOpenAI(messages, config) {
  const { openaiEndpoint: endpoint, openaiKey: key, openaiAuthHeader: authHeader = 'api-key', model = 'gpt-4o' } = config;

  if (!endpoint) throw new Error('Azure OpenAI endpoint not configured.');
  if (!key)      throw new Error('Azure OpenAI key not configured.');

  // Build auth header
  const headers = { 'Content-Type': 'application/json' };
  if (authHeader?.toLowerCase() === 'authorization') {
    headers['Authorization'] = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
  } else {
    headers[authHeader || 'api-key'] = key;
  }

  const isResponsesAPI = endpoint.includes('/responses');

  const body = isResponsesAPI ? {
    model,
    input: messages,
    max_output_tokens: 800,
    // No temperature, no response_format — not supported by Responses API
  } : {
    model,
    messages,
    max_tokens: 800,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  let resp;
  try {
    resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(`Azure OpenAI error (${resp.status}): ${e?.error?.message || resp.statusText}`);
  }

  const data = await resp.json();

  if (isResponsesAPI) {
    return data?.output?.flatMap(o => o.content || [])?.find(c => c.type === 'output_text' || c.type === 'text')?.text || '';
  }
  return data?.choices?.[0]?.message?.content || '';
}

// ════════════════════════════════════════════════════════════
// RESULT PARSER + NORMALIZER
// ════════════════════════════════════════════════════════════

function parseAnalysisResult(raw) {
  let parsed;
  try {
    // Strip markdown fences if present
    const clean = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    // Fallback — return a generic waiting state
    return {
      status: 'waiting',
      action: { type: 'wait', guidance: raw.slice(0, 200) || 'Analyzing page…', target: null },
      issues: [],
      fix_suggestion: null,
      progress: '',
      goal_complete: false,
    };
  }

  return {
    status:         parsed.status         || 'action_required',
    action:         parsed.action         || null,
    issues:         parsed.issues         || [],
    fix_suggestion: parsed.fix_suggestion || null,
    progress:       parsed.progress       || '',
    goal_complete:  parsed.goal_complete  || false,
  };
}
