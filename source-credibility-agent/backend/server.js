/**
 * Agent 4: Source Credibility Agent — Backend
 * GNN-simulated trust graph analysis via Google Gemini.
 * Pure Node.js, zero npm dependencies.
 */

const http      = require('http');
const https     = require('https');
const url       = require('url');
const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');

// ── Load .env ──────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  });
}

const PORT    = 8004;
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL   = process.env.GEMINI_MODEL   || 'gemini-flash-latest';
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
    const parsed  = new URL(targetUrl);
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
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

function detectProxy() {
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
                   process.env.https_proxy || process.env.http_proxy;
  if (envProxy) return envProxy;
  try {
    const { execSync } = require('child_process');
    const out  = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
    const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = out.match(/HTTPSPort\s*:\s*(\S+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
    const host2 = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port2 = out.match(/HTTPPort\s*:\s*(\S+)/)?.[1];
    if (host2 && port2) return `http://${host2}:${port2}`;
  } catch (_) {}
  return 'http://proxy-intlho.wal-mart.com:8080';
}

function fetchWithCurl(targetUrl) {
  return new Promise((resolve, reject) => {
    const safeUrl  = targetUrl.replace(/'/g, "'\\''");
    const proxy    = detectProxy();
    const proxyFlag = proxy ? `-x '${proxy}'` : '';
    const cmd      = `/usr/bin/curl -sL --max-time 15 -A 'CredibilityAgent/1.0' ${proxyFlag} '${safeUrl}'`;
    console.log(`[fetch] proxy=${proxy || 'none'} url=${targetUrl}`);
    const child  = spawn('/bin/sh', ['-c', cmd]);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`curl exited ${code}: ${stderr.slice(0, 200)}`));
      resolve(stdout);
    });
    child.on('error', err => reject(err));
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
    .slice(0, 6000);
}

// ── GNN System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Agent 4: Source Credibility Agent, implementing a Dynamic Trust Graph using Graph Neural Network (GNN) principles.

Your task is to analyze a source (website, author, domain, social media presence, and historical output) and construct a trust graph with credibility scores.

Graph Node Types:
1. WEBSITE     — Overall website/publication credibility signals
2. AUTHOR      — Author identity, expertise, history signals
3. DOMAIN      — Domain age, registration, DNS reputation signals
4. SOCIAL_MEDIA — Social media presence, follower authenticity, engagement signals
5. HISTORICAL  — Historical article accuracy, correction frequency, bias signals

Graph Edge Types:
- TRUST      — Positive relationship reinforcing credibility
- DISTRUST   — Negative relationship undermining credibility
- NEUTRAL    — Weak or unknown relationship

GNN Propagation Logic:
- Trust scores propagate through edges: high-trust neighbors boost low-certainty nodes
- Distrust edges penalize connected node scores
- Isolated nodes (no known connections) get a low-confidence uncertainty penalty

Scoring rules:
- Each node trust_score: 0.0 (fully untrustworthy) to 1.0 (fully trustworthy)
- trust_score = weighted average of own signals + propagated neighbor scores
- Overall trust_score = GNN aggregate of all node scores (0–100 integer)
- Be precise and evidence-based. Acknowledge unknowns honestly.

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "source": "<canonical name of the source analyzed>",
  "nodes": [
    {
      "id": "website",
      "label": "Website",
      "trust_score": <0.0–1.0>,
      "confidence": <0.0–1.0>,
      "signals": ["<key observation 1>", "<key observation 2>"],
      "icon": "🌐"
    },
    {
      "id": "author",
      "label": "Author",
      "trust_score": <0.0–1.0>,
      "confidence": <0.0–1.0>,
      "signals": ["<key observation>"],
      "icon": "✍️"
    },
    {
      "id": "domain",
      "label": "Domain",
      "trust_score": <0.0–1.0>,
      "confidence": <0.0–1.0>,
      "signals": ["<key observation>"],
      "icon": "🔗"
    },
    {
      "id": "social_media",
      "label": "Social Media",
      "trust_score": <0.0–1.0>,
      "confidence": <0.0–1.0>,
      "signals": ["<key observation>"],
      "icon": "📱"
    },
    {
      "id": "historical",
      "label": "Historical Articles",
      "trust_score": <0.0–1.0>,
      "confidence": <0.0–1.0>,
      "signals": ["<key observation>"],
      "icon": "📚"
    }
  ],
  "edges": [
    { "source": "<node_id>", "target": "<node_id>", "type": "trust|distrust|neutral", "weight": <0.0–1.0>, "label": "<brief reason>" }
  ],
  "trust_score": <0–100 integer>,
  "trust_label": "High Trust|Moderate Trust|Low Trust|Very Low Trust|Unverifiable",
  "trust_color": "green|yellow|orange|red|gray",
  "summary": "<2–3 sentence GNN analysis summary>",
  "red_flags": ["<specific concern>"],
  "positive_signals": ["<specific positive>"],
  "methodology": "Dynamic Trust Graph GNN simulation — scores represent propagated credibility across the source graph."
}`;

// ── LLM call ───────────────────────────────────────────────────────────────────

async function analyzeSourceWithLLM(sourceName, context) {
  const userPrompt = context
    ? `Analyze the credibility of this source: "${sourceName}"\n\nContext/content from the source:\n${context}`
    : `Analyze the credibility of this source: "${sourceName}"\n\nNo additional content provided — use your knowledge of this source to build the trust graph.`;

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  };

  const { status, body } = await httpsPost(API_URL, { 'X-goog-api-key': API_KEY }, requestBody);

  if (status !== 200) {
    throw new Error(`Gemini API error ${status}: ${JSON.stringify(body)}`);
  }

  let raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    console.error('[gemini] full response:', JSON.stringify(body).slice(0, 500));
    throw new Error('Empty response from Gemini');
  }

  raw = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) raw = jsonMatch[0];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[gemini] raw text that failed to parse:', raw.slice(0, 500));
    throw new Error(`Gemini returned invalid JSON: ${e.message}`);
  }

  return parsed;
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // Health
  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      status: 'ok', agent: 'source-credibility', version: '1.0.0',
      model: MODEL, provider: 'gemini',
    });
  }

  // Fetch-URL proxy
  if (req.method === 'POST' && pathname === '/fetch-url') {
    try {
      const body = await readBody(req);
      if (!body.url) return sendJSON(res, 400, { detail: "Provide 'url'." });
      const html = await fetchWithCurl(body.url);
      const text = stripHtml(html);
      if (!text) return sendJSON(res, 502, { detail: 'Page returned empty content.' });
      return sendJSON(res, 200, { text, char_count: text.length });
    } catch (e) {
      return sendJSON(res, 502, { detail: `Failed to fetch URL: ${e.message}` });
    }
  }

  // Analyze source — main endpoint
  if (req.method === 'POST' && pathname === '/analyze-source') {
    try {
      const body = await readBody(req);

      // Accept: { source_name, url?, context? }
      let sourceName = (body.source_name || '').trim();
      let context    = (body.context || '').trim();

      if (!sourceName && !body.url) {
        return sendJSON(res, 400, { detail: "Provide 'source_name' or 'url'." });
      }

      // If URL given: fetch & strip, derive source_name from hostname
      if (body.url && body.url.trim()) {
        const targetUrl = body.url.trim();
        if (!sourceName) {
          try { sourceName = new URL(targetUrl).hostname; } catch (_) { sourceName = targetUrl; }
        }
        if (!context) {
          try {
            const html = await fetchWithCurl(targetUrl);
            context = stripHtml(html).slice(0, 4000);
          } catch (e) {
            console.warn('[fetch] could not fetch URL, continuing without context:', e.message);
          }
        }
      }

      if (!sourceName) sourceName = 'Unknown Source';

      console.log(`[analyze] source="${sourceName}" context_len=${context.length}`);

      const result = await analyzeSourceWithLLM(sourceName, context || null);

      // Validate & ensure all required fields
      const safeResult = {
        source:           result.source || sourceName,
        nodes:            Array.isArray(result.nodes) ? result.nodes : [],
        edges:            Array.isArray(result.edges) ? result.edges : [],
        trust_score:      typeof result.trust_score === 'number' ? result.trust_score : 50,
        trust_label:      result.trust_label || 'Unverifiable',
        trust_color:      result.trust_color || 'gray',
        summary:          result.summary || '',
        red_flags:        Array.isArray(result.red_flags) ? result.red_flags : [],
        positive_signals: Array.isArray(result.positive_signals) ? result.positive_signals : [],
        methodology:      result.methodology || 'Dynamic Trust Graph GNN simulation',
        model_used:       MODEL,
      };

      return sendJSON(res, 200, safeResult);

    } catch (e) {
      console.error('[analyze-source] error:', e.message);
      return sendJSON(res, 500, { detail: `Analysis failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n🕸️  Agent 4: Source Credibility Agent`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini (GNN simulation)`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}\n`);
  console.log(`   Open frontend/index.html in your browser.\n`);
});
