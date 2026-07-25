/**
 * Agent 3: Deepfake Evidence Agent — Backend
 * Pure Node.js, zero npm dependencies.
 * Uses Google Gemini (multimodal video+audio) API via built-in https/http modules.
 *
 * Research Architecture (simulated via Gemini):
 *   Video Encoder : X-CLIP (Cross-frame Contrastive Language-Image Pre-training)
 *   Face Encoder  : Vision Transformer + Frequency Domain Analysis (FFT artifacts)
 *   Audio Encoder : Wav2Vec2 (self-supervised speech representations)
 *
 * Novel Detection Signals:
 *   - Lip-sync inconsistency (phoneme ↔ mouth shape alignment)
 *   - Audio-video temporal mismatch
 *   - GAN/diffusion temporal artifacts (inter-frame flicker, blending boundaries)
 *
 * Note: Gemini inline video is limited to ~20 MB. Larger files require
 *       the Gemini Files API (upload → reference by URI). Videos above
 *       that threshold are rejected with a 413 and a clear error message.
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

const PORT    = 8002;
const API_KEY = process.env.GEMINI_API_KEY || '';
// gemini-2.0-flash supports inline video (audio track included)
const MODEL   = process.env.GEMINI_MODEL   || 'gemini-2.0-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Max inline video size: 20 MB
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

if (!API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY not set. Add it to backend/.env or export it.');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
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

// ── Gemini multimodal call ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Agent 3: Deepfake Evidence Agent.
You receive a video (with its audio track) and perform a comprehensive deepfake analysis
simulating the following research pipeline:
  • X-CLIP   — cross-frame video consistency (temporal coherence)
  • ViT + FFT — face analysis with frequency-domain artifact detection (GAN/diffusion noise)
  • Wav2Vec2  — audio authenticity and phoneme-level transcription

Novel analysis signals you must assess:
  1. LIP-SYNC INCONSISTENCY: Do mouth movements match the audio phonemes at each moment?
     Look for timing offsets, unnatural jaw motion, blurry lip regions, mouth boundary artifacts.
  2. AUDIO-VIDEO MISMATCH: Does the overall audio content (speech, tone, emotion, environment)
     match what the video visually shows? Are there mismatched emotions or contexts?
  3. TEMPORAL ARTIFACTS: Are there inter-frame flickering, abrupt identity shifts, blending
     seams, unnatural skin texture variations, or GAN/diffusion signature patterns across frames?
  4. FACE ANALYSIS: Are there frequency-domain anomalies (checkerboard patterns, spectral peaks
     inconsistent with natural imaging), unnatural eye blinking, asymmetry, or boundary artifacts
     around the face?

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "deepfake_confidence_score": <0.0–1.0 float, probability this is a deepfake>,
  "verdict": "<LIKELY AUTHENTIC | INCONCLUSIVE | LIKELY DEEPFAKE | HIGH CONFIDENCE DEEPFAKE>",
  "analysis": {
    "lip_sync": {
      "score": <0.0–1.0, higher = more suspicious>,
      "label": "<Synchronized | Minor Issues | Inconsistent | Severely Mismatched>",
      "findings": "<2-3 sentence specific observation>"
    },
    "audio_video_mismatch": {
      "score": <0.0–1.0>,
      "label": "<Consistent | Slight Mismatch | Mismatch Detected | Severe Mismatch>",
      "findings": "<2-3 sentence specific observation>"
    },
    "temporal_artifacts": {
      "score": <0.0–1.0>,
      "label": "<Clean | Minor Artifacts | Moderate Artifacts | Heavy Artifacts>",
      "findings": "<2-3 sentence specific observation>"
    },
    "face_analysis": {
      "score": <0.0–1.0>,
      "label": "<Natural | Slight Anomalies | Manipulation Detected | Strong Manipulation>",
      "findings": "<2-3 sentence specific observation>"
    }
  },
  "evidence_summary": "<3-4 sentence overall summary of the evidence>",
  "processing_notes": "<any caveats about video quality, length, or analysis confidence>"
}`;

async function analyzeVideoWithGemini(videoBase64, mimeType) {
  const requestBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data:      videoBase64,
            },
          },
          {
            text: 'Analyze this video for deepfake indicators. Examine lip-sync, audio-video consistency, temporal artifacts across frames, and face manipulation signatures. Provide the complete deepfake evidence analysis.',
          },
        ],
      },
    ],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 4096,
    },
  };

  const { status, body } = await httpsPost(
    API_URL,
    { 'X-goog-api-key': API_KEY },
    requestBody,
  );

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

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    });
    return res.end();
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      status:   'ok',
      agent:    'deepfake-evidence',
      version:  '1.0.0',
      model:    MODEL,
      provider: 'gemini',
    });
  }

  // ── Analyze deepfake ───────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/analyze-deepfake') {
    try {
      const body = await readBody(req);

      // Expect { video_base64: string, mime_type: string }
      const { video_base64, mime_type } = body;

      if (!video_base64 || !mime_type) {
        return sendJSON(res, 400, {
          detail: "Provide 'video_base64' (base64-encoded video) and 'mime_type' (e.g. 'video/mp4').",
        });
      }

      // Validate MIME type
      const SUPPORTED_MIME = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/avi'];
      if (!SUPPORTED_MIME.includes(mime_type)) {
        return sendJSON(res, 415, {
          detail: `Unsupported MIME type '${mime_type}'. Supported: ${SUPPORTED_MIME.join(', ')}.`,
        });
      }

      // Size guard — Gemini inline limit ~20 MB
      const sizeBytes = Buffer.byteLength(video_base64, 'base64');
      if (sizeBytes > MAX_VIDEO_BYTES) {
        return sendJSON(res, 413, {
          detail: `Video too large (${(sizeBytes / 1048576).toFixed(1)} MB). Inline upload limit is 20 MB. Please use a shorter clip.`,
        });
      }

      console.log(`[analyze] mime=${mime_type} size=${(sizeBytes / 1048576).toFixed(2)}MB`);

      const result = await analyzeVideoWithGemini(video_base64, mime_type);

      // Normalise scores to [0,1] and ensure required fields
      const clamp = v => Math.min(1, Math.max(0, parseFloat(v) || 0));
      const score = clamp(result.deepfake_confidence_score);

      const signals = ['lip_sync', 'audio_video_mismatch', 'temporal_artifacts', 'face_analysis'];
      const analysis = {};
      signals.forEach(key => {
        const raw = result.analysis?.[key] || {};
        analysis[key] = {
          score:    clamp(raw.score),
          label:    raw.label    || 'Unknown',
          findings: raw.findings || 'No findings available.',
        };
      });

      return sendJSON(res, 200, {
        deepfake_confidence_score: score,
        verdict:          result.verdict          || deriveVerdict(score),
        analysis,
        evidence_summary: result.evidence_summary || '',
        processing_notes: result.processing_notes || '',
        model_used:       MODEL,
        video_size_mb:    parseFloat((sizeBytes / 1048576).toFixed(2)),
      });

    } catch (e) {
      console.error('[analyze-deepfake] error:', e.message);
      return sendJSON(res, 500, { detail: `Analysis failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

function deriveVerdict(score) {
  if (score >= 0.85) return 'HIGH CONFIDENCE DEEPFAKE';
  if (score >= 0.60) return 'LIKELY DEEPFAKE';
  if (score >= 0.40) return 'INCONCLUSIVE';
  return 'LIKELY AUTHENTIC';
}

server.listen(PORT, () => {
  console.log(`\n🎭 Agent 3: Deepfake Evidence Agent`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}`);
  console.log(`   Max size → 20 MB inline video`);
  console.log(`\n   Open frontend/index.html in your browser.\n`);
});
