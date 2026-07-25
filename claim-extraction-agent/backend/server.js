/**
 * Agent 1: Claim Extraction Agent — Backend
 * Pure Node.js, zero npm dependencies.
 * Uses Google Gemini API via built-in https module.
 */

const http           = require('http');
const https          = require('https');
const url            = require('url');
const fs             = require('fs');
const path           = require('path');

// ── Load .env if present ───────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  });
}

const PORT    = 8000;
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL   = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY not set. Add it to backend/.env or export it.');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function httpsPost(targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`Bad JSON from Gemini: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(targetUrl, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: { 'User-Agent': 'ClaimExtractionAgent/1.0' },
    };
    const req = client.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        return httpsGet(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

// ── LLM call (Gemini) ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Agent 1: Claim Extraction Agent.
Your task is to decompose any piece of text into atomic, independently verifiable claims.

Rules:
1. Each claim must be a single, self-contained factual assertion.
2. Decompose compound sentences into multiple atomic claims.
3. Make implicit subjects/objects explicit (no pronouns).
4. Categorize each claim with one of these types:
   - entity_claim   → about a person, org, or named entity
   - event_claim    → about an action or event that occurred
   - location_claim → about a place or geographic context
   - temporal_claim → about a time, date, or duration
   - quantity_claim → about a number, amount, or measurement
   - attribute_claim → about a property or characteristic
   - source_claim   → about who said/reported something

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "claims": [
    {
      "id": 1,
      "text": "<atomic claim as a full declarative sentence>",
      "type": "<claim type>",
      "confidence": <0.0–1.0 float>
    }
  ]
}`;

async function extractClaimsWithLLM(text) {
  const requestBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Extract all atomic claims from this text:\n\n${text}` }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  };

  const { status, body } = await httpsPost(API_URL, { 'X-goog-api-key': API_KEY }, requestBody);

  if (status !== 200) {
    throw new Error(`Gemini API error ${status}: ${JSON.stringify(body)}`);
  }

  let raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    // Log the full body to help diagnose
    console.error('[gemini] full response:', JSON.stringify(body).slice(0, 500));
    throw new Error('Empty response from Gemini');
  }

  // Strip markdown fences (all variants)
  raw = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Extract JSON object if surrounded by prose
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) raw = jsonMatch[0];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[gemini] raw text that failed to parse:', raw.slice(0, 500));
    throw new Error(`Gemini returned invalid JSON: ${e.message}`);
  }

  return parsed.claims || [];
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // Fetch URL (pure Node https/http — no shell, no curl, no proxy)
  if (req.method === 'POST' && pathname === '/fetch-url') {
    try {
      const body = await readBody(req);
      if (!body.url) return sendJSON(res, 400, { detail: "Provide 'url'." });
      const html = await httpsGet(body.url);
      const text = stripHtml(html);
      if (!text) return sendJSON(res, 502, { detail: 'Page returned empty content.' });
      return sendJSON(res, 200, { text, char_count: text.length });
    } catch (e) {
      return sendJSON(res, 502, { detail: `Failed to fetch URL: ${e.message}` });
    }
  }

  // Health
  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      agent: 'claim-extraction',
      version: '1.0.0',
      model: MODEL,
      provider: 'gemini',
    });
  }

  // Extract claims
  if (req.method === 'POST' && pathname === '/extract-claims') {
    try {
      const body = await readBody(req);
      let sourceText = '';

      if (body.text && body.text.trim()) {
        sourceText = body.text.trim();
      } else if (body.url && body.url.trim()) {
        try {
          const html = await httpsGet(body.url.trim());
          sourceText = stripHtml(html);
        } catch (e) {
          return sendJSON(res, 502, { detail: `Failed to fetch URL: ${e.message}` });
        }
      } else {
        return sendJSON(res, 400, { detail: "Provide either 'text' or 'url'." });
      }

      if (!sourceText) {
        return sendJSON(res, 400, { detail: 'Input text is empty after processing.' });
      }

      const rawClaims = await extractClaimsWithLLM(sourceText);

      const claims = rawClaims.map((c, i) => ({
        id:         c.id ?? i + 1,
        text:       c.text,
        type:       c.type || 'attribute_claim',
        confidence: parseFloat((c.confidence ?? 0.8).toFixed(2)),
      }));

      return sendJSON(res, 200, {
        claims,
        source_text: sourceText,
        char_count:  sourceText.length,
        model_used:  MODEL,
      });

    } catch (e) {
      console.error('[extract-claims] error:', e.message);
      return sendJSON(res, 500, { detail: `Extraction failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n🧩 Agent 1: Claim Extraction Agent`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}\n`);
  console.log(`   Open frontend/index.html in your browser.\n`);
});