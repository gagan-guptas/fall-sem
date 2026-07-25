/**
 * Image Deepfake Detector — Backend
 * Pure Node.js, zero npm dependencies.
 * Uses Google Gemini Vision API via built-in https/http modules.
 *
 * 5 Detection Features:
 *   1. Facial Geometry    — asymmetry, proportion anomalies
 *   2. Frequency Artifacts — GAN/diffusion checkerboard noise (FFT-style)
 *   3. Skin Texture       — unnatural smoothness, blending zones
 *   4. Eye & Reflection   — corneal inconsistency, pupil anomalies
 *   5. Edge & Boundary    — hair/face boundary blending seams
 */

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

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

const PORT    = 8003;
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL   = process.env.GEMINI_MODEL   || 'gemini-2.0-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Max inline image size: 10 MB
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

if (!API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY not set. Add it to backend/.env');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendJSON(res, status, body) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
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
    const opts = {
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
    const req = https.request(opts, res => {
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

// ── System prompt — exactly 5 features ────────────────────────────────────────

const SYSTEM_PROMPT = `You are an Image Deepfake Detector.
Analyze the given image and judge it on EXACTLY these 5 features to determine if it is AI-generated or manipulated.

FEATURE 1 — FACIAL GEOMETRY
Examine facial symmetry, proportions, and structural coherence.
Look for: unnatural symmetry, warped ear/nose/chin shapes, distorted teeth, impossible proportions.

FEATURE 2 — FREQUENCY ARTIFACTS
Examine pixel-level patterns typical of GAN/diffusion generation.
Look for: checkerboard patterns, spectral anomalies, unnatural noise distribution, repetitive micro-textures.

FEATURE 3 — SKIN TEXTURE
Examine skin surface realism.
Look for: over-smoothed regions (loss of pores), inconsistent texture zones, airbrushed blends, unnatural glossiness.

FEATURE 4 — EYE & REFLECTION
Examine eyes closely.
Look for: asymmetric catchlights, missing/duplicated reflections, unnatural iris patterns, incorrect pupil shape, blurred cornea edges.

FEATURE 5 — EDGE & BOUNDARY
Examine borders between face/hair/background.
Look for: blending seams, halo artifacts, floating hair strands that vanish, color fringing, abrupt background transitions.

Return ONLY valid JSON — no markdown fences, no extra text — in this exact schema:
{
  "fake_confidence_score": <0.0–1.0 float>,
  "verdict": "<AUTHENTIC | LIKELY AUTHENTIC | UNCERTAIN | LIKELY FAKE | FAKE>",
  "features": {
    "facial_geometry": {
      "score": <0.0–1.0, higher = more suspicious>,
      "label": "<Clean | Minor Issues | Suspicious | Strong Indicator>",
      "finding": "<one precise observation>"
    },
    "frequency_artifacts": {
      "score": <0.0–1.0>,
      "label": "<Clean | Minor Issues | Suspicious | Strong Indicator>",
      "finding": "<one precise observation>"
    },
    "skin_texture": {
      "score": <0.0–1.0>,
      "label": "<Clean | Minor Issues | Suspicious | Strong Indicator>",
      "finding": "<one precise observation>"
    },
    "eye_reflection": {
      "score": <0.0–1.0>,
      "label": "<Clean | Minor Issues | Suspicious | Strong Indicator>",
      "finding": "<one precise observation>"
    },
    "edge_boundary": {
      "score": <0.0–1.0>,
      "label": "<Clean | Minor Issues | Suspicious | Strong Indicator>",
      "finding": "<one precise observation>"
    }
  },
  "summary": "<2 sentence overall assessment>",
  "note": "<any caveats about image quality or analysis confidence>"
}`;

async function analyzeImageWithGemini(imageBase64, mimeType) {
  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: 'Analyze this image for deepfake indicators across the 5 features. Return the JSON result.' },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };

  const { status, body } = await httpsPost(API_URL, { 'X-goog-api-key': API_KEY }, requestBody);

  if (status !== 200) {
    throw new Error(`Gemini API error ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }

  let raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Empty response from Gemini');

  raw = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) raw = match[0];

  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`Gemini returned invalid JSON: ${e.message}`); }
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, { status: 'ok', agent: 'image-deepfake', version: '1.0.0', model: MODEL, provider: 'gemini' });
  }

  if (req.method === 'POST' && pathname === '/analyze-image') {
    try {
      const body = await readBody(req);
      const { image_base64, mime_type } = body;

      if (!image_base64 || !mime_type) {
        return sendJSON(res, 400, { detail: "Provide 'image_base64' and 'mime_type' (e.g. 'image/jpeg')." });
      }

      const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!SUPPORTED.includes(mime_type)) {
        return sendJSON(res, 415, { detail: `Unsupported type '${mime_type}'. Supported: ${SUPPORTED.join(', ')}.` });
      }

      const sizeBytes = Buffer.byteLength(image_base64, 'base64');
      if (sizeBytes > MAX_IMAGE_BYTES) {
        return sendJSON(res, 413, { detail: `Image too large (${(sizeBytes/1048576).toFixed(1)} MB). Limit is 10 MB.` });
      }

      console.log(`[analyze] mime=${mime_type} size=${(sizeBytes/1048576).toFixed(2)}MB`);

      const result = await analyzeImageWithGemini(image_base64, mime_type);

      const clamp = v => Math.min(1, Math.max(0, parseFloat(v) || 0));
      const FEATURES = ['facial_geometry', 'frequency_artifacts', 'skin_texture', 'eye_reflection', 'edge_boundary'];
      const features = {};
      FEATURES.forEach(key => {
        const raw = result.features?.[key] || {};
        features[key] = {
          score:   clamp(raw.score),
          label:   raw.label   || 'Unknown',
          finding: raw.finding || 'No finding.',
        };
      });

      const score = clamp(result.fake_confidence_score);

      return sendJSON(res, 200, {
        fake_confidence_score: score,
        verdict:  result.verdict  || deriveVerdict(score),
        features,
        summary:  result.summary  || '',
        note:     result.note     || '',
        model_used:    MODEL,
        image_size_mb: parseFloat((sizeBytes/1048576).toFixed(2)),
      });

    } catch (e) {
      console.error('[analyze-image] error:', e.message);
      return sendJSON(res, 500, { detail: `Analysis failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

function deriveVerdict(score) {
  if (score >= 0.80) return 'FAKE';
  if (score >= 0.60) return 'LIKELY FAKE';
  if (score >= 0.40) return 'UNCERTAIN';
  if (score >= 0.20) return 'LIKELY AUTHENTIC';
  return 'AUTHENTIC';
}

server.listen(PORT, () => {
  console.log(`\n🖼️  Image Deepfake Detector`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}`);
  console.log(`   Features → Facial Geometry · Frequency · Skin · Eyes · Edges`);
  console.log(`\n   Open frontend/index.html in your browser.\n`);
});
