
/**
 * CloudLabs AI — Backend Proxy Server
 * Routes extension requests to Azure OpenAI, keeping API keys server-side.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

/* ── Config from .env ─────────────────────────────────────── */
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT;      // https://xxx.openai.azure.com/…
const OPENAI_KEY = process.env.OPENAI_KEY;
const OPENAI_AUTH_HEADER = process.env.OPENAI_AUTH_HEADER || 'api-key';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function normalizeAnyToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(normalizeAnyToText).filter(Boolean).join('\n').trim();
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return '';
  }
  return String(value);
}

function extractResponsesText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  if (typeof data.result === 'string') return data.result;

  // Typical Responses API shape: output: [{ type:'message', content:[{type:'output_text', text:'...'}] }]
  if (Array.isArray(data.output)) {
    const texts = [];
    for (const item of data.output) {
      if (!item) continue;
      if (typeof item.text === 'string') {
        texts.push(item.text);
        continue;
      }
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (!c) continue;
          if (typeof c.text === 'string') texts.push(c.text);
        }
      }
    }
    if (texts.length) return texts.join('\n').trim();
  }

  return normalizeAnyToText(data.output || data.result || '');
}

function buildHeaders(authHeader, key) {
  const h = { 'Content-Type': 'application/json' };
  if (String(authHeader || '').toLowerCase() === 'authorization') {
    h.Authorization = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
  } else {
    h['api-key'] = key;
  }
  return h;
}

async function safeJson(resp) {
  try { return await resp.json(); } catch (_) { return {}; }
}

async function fetchWithAuthFallback(url, body, timeoutMs) {
  const primaryHeader = OPENAI_AUTH_HEADER;
  const fallbackHeader = String(primaryHeader).toLowerCase() === 'authorization' ? 'api-key' : 'Authorization';

  const firstResp = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(primaryHeader, OPENAI_KEY),
    body: JSON.stringify(body),
    timeout: timeoutMs,
  });
  const firstData = await safeJson(firstResp);
  if (firstResp.status !== 401) {
    return { resp: firstResp, data: firstData, usedAuthHeader: primaryHeader };
  }

  // Retry once with alternate auth style; this fixes many misconfigured header cases.
  const secondResp = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(fallbackHeader, OPENAI_KEY),
    body: JSON.stringify(body),
    timeout: timeoutMs,
  });
  const secondData = await safeJson(secondResp);
  return { resp: secondResp, data: secondData, usedAuthHeader: fallbackHeader };
}

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors());                       // Allow extension origin
app.use(express.json({ limit: '1mb' }));

app.get("/", (req, res) => {
  res.send("Backend is working ✅");
});
require("dotenv").config();

console.log("ENDPOINT:", process.env.OPENAI_ENDPOINT);
console.log("KEY:", process.env.OPENAI_KEY ? "Loaded ✅" : "Missing ❌");
/* ── Health check ─────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    configured: !!(OPENAI_ENDPOINT && OPENAI_KEY),
    model: MODEL
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: !!(OPENAI_ENDPOINT && OPENAI_KEY),
    model: MODEL
  });
});

/* ── Chat completion proxy ────────────────────────────────── */
app.post('/api/chat', async (req, res) => {
  if (!OPENAI_ENDPOINT || !OPENAI_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured — set OPENAI_ENDPOINT and OPENAI_KEY in .env' });
  }

  const { messages, temperature, max_tokens, max_completion_tokens, response_format } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ ok: false, error: 'messages[] required' });
  }

  try {
    // Detect API type based on endpoint
    const isResponsesAPI = OPENAI_ENDPOINT.includes('/openai/responses');
    const isProjectsAPI = OPENAI_ENDPOINT.includes('/api/projects/');
    const isAzureCognitiveServices = OPENAI_ENDPOINT.includes('.cognitiveservices.azure.com');
    
    let requestBody;
    if (isResponsesAPI) {
      // Azure Responses API format - convert messages to input text
      const inputText = messages
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');
      
      requestBody = {
        model: MODEL,
        input: inputText,
      };
    } else {
      // Standard OpenAI Chat Completions format (used by Projects API and Cognitive Services)
      requestBody = {
        model: MODEL,
        messages,
        max_completion_tokens: max_completion_tokens ?? max_tokens ?? 1000,  // Safe default (was 4096 — too high!)
      };
      // Only include temperature if explicitly provided (gpt-5.3-chat only supports default value of 1)
      if (temperature !== undefined && temperature !== null) {
        requestBody.temperature = temperature;
      }
      if (response_format) requestBody.response_format = response_format;
    }

    // Construct the full endpoint URL
    let fullEndpoint = OPENAI_ENDPOINT;
    if (isResponsesAPI) {
      fullEndpoint = OPENAI_ENDPOINT;
    } else if (isAzureCognitiveServices) {
      // Azure Cognitive Services endpoint format
      const baseUrl = OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, ''); // Remove query and trailing slash
      fullEndpoint = `${baseUrl}/openai/deployments/${MODEL}/chat/completions?api-version=2024-12-01-preview`;
    } else if (isProjectsAPI) {
      if (!OPENAI_ENDPOINT.endsWith('/chat/completions')) {
        fullEndpoint = OPENAI_ENDPOINT + '/chat/completions';
      }
      // Add api-version query parameter if not already present
      if (!fullEndpoint.includes('api-version')) {
        fullEndpoint += '?api-version=2024-12-01-preview';
      }
    }

    const { resp, data, usedAuthHeader } = await fetchWithAuthFallback(fullEndpoint, requestBody, 25000);

    if (!resp.ok) {
      console.error('[proxy] upstream error', resp.status, data);
      return res.status(resp.status).json({
        ok: false,
        error: data?.error?.message || `Azure returned ${resp.status}`,
        debug: {
          endpointHost: (() => { try { return new URL(fullEndpoint).host; } catch (_) { return 'invalid-url'; } })(),
          usedAuthHeader,
          apiType: isResponsesAPI ? 'responses' : (isProjectsAPI ? 'projects' : (isAzureCognitiveServices ? 'cognitive-chat' : 'chat')),
        }
      });
    }

    // Extract content based on API type
    let choice;
    if (isResponsesAPI) {
      // Responses API may return structured output; normalize to plain text.
      choice = extractResponsesText(data);
    } else {
      // Standard OpenAI and Cognitive Services return choices array
      choice = normalizeAnyToText(data.choices?.[0]?.message?.content ?? '');
    }
    
    res.json({ ok: true, content: choice, usage: data.usage });
  } catch (err) {
    console.error('[proxy] exception', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ── Test connection ──────────────────────────────────────── */
app.post('/api/test', async (_req, res) => {
  if (!OPENAI_ENDPOINT || !OPENAI_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }
  try {
    const isResponsesAPI = OPENAI_ENDPOINT.includes('/openai/responses');
    const isProjectsAPI = OPENAI_ENDPOINT.includes('/api/projects/');
    const isAzureCognitiveServices = OPENAI_ENDPOINT.includes('.cognitiveservices.azure.com');
    
    let requestBody;
    if (isResponsesAPI) {
      requestBody = { model: MODEL, input: 'Reply with OK' };
    } else {
      // Standard OpenAI format
      requestBody = {
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_completion_tokens: 300,  // Reduced from 500 — we ask simpler questions now
      };
    }

    // Construct the full endpoint URL
    let fullEndpoint = OPENAI_ENDPOINT;
    if (isResponsesAPI) {
      fullEndpoint = OPENAI_ENDPOINT;
    } else if (isAzureCognitiveServices) {
      // Azure Cognitive Services endpoint format
      const baseUrl = OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, ''); // Remove query and trailing slash
      fullEndpoint = `${baseUrl}/openai/deployments/${MODEL}/chat/completions?api-version=2024-12-01-preview`;
    } else if (isProjectsAPI) {
      if (!OPENAI_ENDPOINT.endsWith('/chat/completions')) {
        fullEndpoint = OPENAI_ENDPOINT + '/chat/completions';
      }
      // Add api-version query parameter if not already present
      if (!fullEndpoint.includes('api-version')) {
        fullEndpoint += '?api-version=2024-12-01-preview';
      }
    }

    const { resp, data, usedAuthHeader } = await fetchWithAuthFallback(fullEndpoint, requestBody, 20000);
    if (!resp.ok) {
      return res.json({
        ok: false,
        error: data?.error?.message || `Status ${resp.status}`,
        debug: {
          endpointHost: (() => { try { return new URL(fullEndpoint).host; } catch (_) { return 'invalid-url'; } })(),
          usedAuthHeader,
          apiType: isResponsesAPI ? 'responses' : (isProjectsAPI ? 'projects' : (isAzureCognitiveServices ? 'cognitive-chat' : 'chat')),
        }
      });
    }
    
    let reply;
    if (isResponsesAPI) {
      reply = extractResponsesText(data);
    } else {
      reply = normalizeAnyToText(data.choices?.[0]?.message?.content || '');
    }
    res.json({ ok: true, reply });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/* ── Resolve element target (find and return selector) ────── */
app.post('/api/resolve-target', async (req, res) => {
  if (!OPENAI_ENDPOINT || !OPENAI_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  const { step, domSnapshot, pageUrl } = req.body;
  if (!step || !domSnapshot || !pageUrl) {
    return res.status(400).json({ ok: false, error: 'step, domSnapshot, pageUrl required' });
  }

  const prompt =
    'Find UI element for: ' + step.what_to_find + '\n' +
    'Action: ' + (step.action || 'click') + '\n' +
    'URL: ' + pageUrl + '\n\n' +
    'DOM (visible elements only):\n' +
    domSnapshot.slice(0, 8000) + '\n\n' +
    'RULES:\n' +
    '1. Return ONLY JSON\n' +
    '2. Match exact text or best fuzzy match\n' +
    '3. Prefer visible elements [VISIBLE] over [OFF-SCREEN]\n' +
    '4. Copy selector exactly from "sel:" field\n' +
    '5. If not found, return not_found: true\n\n' +
    'Response: {\n' +
    '  "found": boolean,\n' +
    '  "selector": "sel: value here",\n' +
    '  "text": "visible text",\n' +
    '  "hint": "brief location",\n' +
    '  "not_found": boolean,\n' +
    '  "needs_scroll": boolean,\n' +
    '  "wrong_page": boolean,\n' +
    '  "navigate_to": "",\n' +
    '  "error_fix": ""\n' +
    '}';

  try {
    // Call AI with the prompt
    const isResponsesAPI = OPENAI_ENDPOINT.includes('/openai/responses');
    const isProjectsAPI = OPENAI_ENDPOINT.includes('/api/projects/');
    const isAzureCognitiveServices = OPENAI_ENDPOINT.includes('.cognitiveservices.azure.com');
    
    let requestBody;
    if (isResponsesAPI) {
      requestBody = { model: MODEL, input: prompt };
    } else {
      requestBody = {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 300,  // Keep this low — simpler task
      };
    }

    let fullEndpoint = OPENAI_ENDPOINT;
    if (isResponsesAPI) {
      fullEndpoint = OPENAI_ENDPOINT;
    } else if (isAzureCognitiveServices) {
      const baseUrl = OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, '');
      fullEndpoint = `${baseUrl}/openai/deployments/${MODEL}/chat/completions?api-version=2024-12-01-preview`;
    } else if (isProjectsAPI) {
      if (!OPENAI_ENDPOINT.endsWith('/chat/completions')) {
        fullEndpoint = OPENAI_ENDPOINT + '/chat/completions';
      }
      if (!fullEndpoint.includes('api-version')) {
        fullEndpoint += '?api-version=2024-12-01-preview';
      }
    }

    const { resp, data } = await fetchWithAuthFallback(fullEndpoint, requestBody, 25000);

    if (!resp.ok) {
      console.error('[resolve-target] upstream error', resp.status, data);
      return res.status(resp.status).json({
        ok: false,
        error: data?.error?.message || `Azure returned ${resp.status}`,
      });
    }

    let content;
    if (isResponsesAPI) {
      content = extractResponsesText(data);
    } else {
      content = normalizeAnyToText(data.choices?.[0]?.message?.content ?? '');
    }

    // Parse JSON response
    let parsed = null;
    try {
      const clean = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (_) {
      // Try to repair truncated JSON
      if (content.startsWith('{')) {
        const lastComplete = content.lastIndexOf('},');
        if (lastComplete > 0) {
          try {
            parsed = JSON.parse(content.slice(0, lastComplete + 1) + '}');
          } catch (_) {
            parsed = { found: false, selector: '', not_found: true };
          }
        }
      }
    }

    if (!parsed) {
      parsed = { found: false, selector: '', not_found: true };
    }

    res.json({ ok: true, target: parsed });
  } catch (err) {
    console.error('[resolve-target] exception', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

/* ── Start ────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`✅ CloudLabs proxy listening on http://localhost:${PORT}`);
  if (!OPENAI_ENDPOINT || !OPENAI_KEY) {
    console.warn('⚠️  OPENAI_ENDPOINT or OPENAI_KEY missing — set them in backend/.env');
  }
});
