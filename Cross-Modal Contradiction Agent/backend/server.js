/**
 * Agent 2: Cross-Modal Contradiction Agent — Backend
 * Pure Node.js, zero npm dependencies.
 * Uses Google Gemini (vision) API via built-in https/http modules.
 *
 * Research Architecture (CMSAN):
 *   Text Encoder  : DeBERTa-v3
 *   Image Encoder : CLIP ViT-Large
 *   Fusion        : Cross-Attention Transformer
 * Demo Implementation: powered by Gemini multimodal API
 */

const http      = require('http');
const https     = require('https');
const url       = require('url');
const fs        = require('fs');
const path      = require('path');
const { spawn, execSync } = require('child_process');

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

const PORT    = 8001;
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

// ── Proxy detection (same as Agent 1) ─────────────────────────────────────────

function detectProxy() {
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
                   process.env.https_proxy || process.env.http_proxy;
  if (envProxy) return envProxy;

  try {
    const out = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
    const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = out.match(/HTTPSPort\s*:\s*(\S+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
    const host2 = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port2 = out.match(/HTTPPort\s*:\s*(\S+)/)?.[1];
    if (host2 && port2) return `http://${host2}:${port2}`;
  } catch (_) {}

  return 'http://proxy-intlho.wal-mart.com:8080';
}

// ── Fetch image bytes via curl, return {data: base64, mimeType} ────────────────

function fetchImageAsBase64(imageUrl) {
  return new Promise((resolve, reject) => {
    const safeUrl = imageUrl.replace(/'/g, "'\\''");
    const proxy   = detectProxy();
    const proxyFlag = proxy ? `-x '${proxy}'` : '';

    // -o - streams bytes to stdout; --max-filesize 10MB guard
    const cmd = `/usr/bin/curl -sL --max-time 20 --max-filesize 10485760 -A 'CMSAN-Agent/1.0' ${proxyFlag} '${safeUrl}'`;

    console.log(`[image-fetch] proxy=${proxy || 'none'} url=${imageUrl}`);

    const child = spawn('/bin/sh', ['-c', cmd]);
    const chunks = [];
    let stderr = '';

    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => (stderr += d));

    child.on('close', code => {
      if (code !== 0) return reject(new Error(`curl exited ${code}: ${stderr.slice(0, 200)}`));
      if (!chunks.length) return reject(new Error('Image URL returned empty content'));

      const buf      = Buffer.concat(chunks);
      const data     = buf.toString('base64');
      const mimeType = guessMimeType(imageUrl, buf);
      resolve({ data, mimeType });
    });

    child.on('error', err => reject(err));
  });
}

function guessMimeType(imageUrl, buf) {
  // Check magic bytes first
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';

  // Fallback: extension
  const ext = imageUrl.split('?')[0].split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                gif: 'image/gif',  webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] || 'image/jpeg';
}

// ── LLM call (Gemini) ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Agent 2: Cross-Modal Contradiction Agent — part of a Data Deception Detection Pipeline.

Your task: analyze whether a news image and a news headline/text semantically align or contradict each other.

This implements a Cross-Modal Semantic Alignment Network (CMSAN):
- Semantic Alignment Score: how closely the image content matches the text (0.0 = completely unrelated, 1.0 = perfect match)
- Contradiction Score: how strongly the image contradicts or conflicts with the text (0.0 = no contradiction, 1.0 = direct contradiction)

Note: Both scores are independent. Low alignment does not imply high contradiction — an image can simply be irrelevant (low alignment, moderate contradiction) or actively misleading (low alignment, high contradiction).

Analyze:
1. What does the image show? (location, event, people, objects)
2. What does the text claim?
3. Do they match the same event, location, and context?
4. Are there geographic, temporal, or contextual mismatches?

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "alignment_score": <0.0–1.0 float, 2 decimal places>,
  "contradiction_score": <0.0–1.0 float, 2 decimal places>,
  "image_description": "<1-2 sentences describing the image content>",
  "text_summary": "<1 sentence summarizing what the text claims>",
  "mismatch_reason": "<specific reason for low alignment or high contradiction, or 'None' if aligned>",
  "verdict": "<one of: ALIGNED | MISMATCHED | CONTRADICTED | UNRELATED>",
  "confidence": <0.0–1.0 float overall model confidence>
}`;

async function analyzeContradiction({ imageBase64, mimeType, imageDescription, text }) {
  const parts = [];

  // Image part (if available)
  if (imageBase64) {
    parts.push({ inlineData: { mimeType, data: imageBase64 } });
  } else if (imageDescription) {
    parts.push({ text: `[Image Description]: ${imageDescription}` });
  }

  parts.push({ text: `[News Text / Headline]: ${text}` });
  parts.push({ text: 'Analyze the cross-modal semantic alignment and contradiction between the image and the news text.' });

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };

  const { status, body } = await httpsPost(API_URL, { 'X-goog-api-key': API_KEY }, requestBody);

  if (status !== 200) {
    throw new Error(`Gemini API error ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }

  let raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    console.error('[gemini] full response:', JSON.stringify(body).slice(0, 500));
    throw new Error('Empty response from Gemini');
  }

  // Strip markdown fences
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

// ── HTTP Server ────────────────────────────────────────────────────────────────

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

  // Health
  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      status:   'ok',
      agent:    'cross-modal-contradiction',
      version:  '1.0.0',
      model:    MODEL,
      provider: 'gemini',
    });
  }

  // Analyze
  if (req.method === 'POST' && pathname === '/analyze') {
    try {
      const body = await readBody(req);
      const { image_url, image_description, text } = body;

      if (!text || !text.trim()) {
        return sendJSON(res, 400, { detail: "Provide 'text' (news headline or article snippet)." });
      }
      if (!image_url && !image_description) {
        return sendJSON(res, 400, { detail: "Provide either 'image_url' or 'image_description'." });
      }

      let imageBase64 = null;
      let mimeType    = 'image/jpeg';
      let imageMode   = 'description';

      // Attempt to fetch image bytes if URL provided
      if (image_url && image_url.trim()) {
        try {
          const result = await fetchImageAsBase64(image_url.trim());
          imageBase64  = result.data;
          mimeType     = result.mimeType;
          imageMode    = 'vision';
          console.log(`[analyze] image fetched — ${imageBase64.length} base64 chars, mime=${mimeType}`);
        } catch (fetchErr) {
          console.warn(`[analyze] image fetch failed (${fetchErr.message}), falling back to description mode`);
          imageMode = 'description_fallback';
          // Use the URL as a hint if no description given
          if (!image_description) {
            return sendJSON(res, 502, {
              detail: `Could not fetch image: ${fetchErr.message}. Provide 'image_description' as fallback.`,
            });
          }
        }
      }

      const result = await analyzeContradiction({
        imageBase64,
        mimeType,
        imageDescription: image_description || null,
        text: text.trim(),
      });

      return sendJSON(res, 200, {
        ...result,
        image_mode: imageMode,
        model_used: MODEL,
        input: {
          image_url:         image_url         || null,
          image_description: image_description || null,
          text:              text.trim(),
        },
      });

    } catch (e) {
      console.error('[analyze] error:', e.message);
      return sendJSON(res, 500, { detail: `Analysis failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n🔍 Agent 2: Cross-Modal Contradiction Agent`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini (vision)`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}\n`);
  console.log(`   Open frontend/index.html in your browser.\n`);
});
