/**
 * Agent 5: Scam Detection Agent — Backend
 * Fine-tuned Transformer simulation via Google Gemini.
 * Behavioral embeddings: detects persuasion strategies, not just keywords.
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

const PORT    = 8005;
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

// ── System Prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Agent 5: Scam Detection Agent, implementing a fine-tuned Transformer model that detects scam patterns through behavioral embeddings.

Your novel approach: instead of matching keywords, you identify and score PERSUASION STRATEGIES — the underlying behavioral patterns that form scam-behavior vectors.

The four behavioral embedding dimensions you measure:

1. URGENCY — Time pressure, deadlines, "act now" patterns
   Examples: "Limited time offer", "Expires in 24 hours", "Last chance", "Don't wait"

2. PSYCHOLOGICAL_MANIPULATION — Cognitive biases, social proof, authority abuse, fear tactics
   Examples: "Everyone is doing this", "As approved by [authority]", "You've been specially selected", "Your account is at risk"

3. FINANCIAL_LURE — Unrealistic reward promises, get-rich-quick, prize claims
   Examples: "Claim reward immediately", "You've won $1,000,000", "Double your investment", "Free money"

4. EMOTIONAL_EXPLOITATION — Empathy manipulation, sympathy bait, guilt, love bombing
   Examples: "I need your help urgently", "A dying relative left you money", "Please help me transfer funds"

Each dimension is scored 0.0–1.0 forming a behavioral embedding vector [urgency, manipulation, financial_lure, emotional_exploitation].
Scam probability = weighted combination of these four dimensions.

Also extract:
- Specific trigger phrases found in the text (the actual words/phrases that fired each dimension)
- Pattern classification (e.g., "Advance Fee Fraud", "Phishing", "Prize Scam", "Romance Scam", "Tech Support Scam", "Investment Fraud", "Lottery Scam", "Impersonation Scam")
- Risk tier: CRITICAL (>=0.8), HIGH (>=0.6), MEDIUM (>=0.4), LOW (>=0.2), SAFE (<0.2)

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "scam_probability": <0.0–1.0 float>,
  "risk_tier": "CRITICAL|HIGH|MEDIUM|LOW|SAFE",
  "risk_color": "red|orange|yellow|blue|green",
  "pattern_type": "<scam classification>",
  "behavioral_vector": {
    "urgency":                  <0.0–1.0>,
    "psychological_manipulation": <0.0–1.0>,
    "financial_lure":           <0.0–1.0>,
    "emotional_exploitation":   <0.0–1.0>
  },
  "trigger_phrases": [
    {
      "phrase": "<exact text from input>",
      "dimension": "urgency|psychological_manipulation|financial_lure|emotional_exploitation",
      "score": <0.0–1.0>,
      "explanation": "<why this fires the dimension>"
    }
  ],
  "summary": "<2–3 sentence behavioral analysis>",
  "recommendation": "<what the recipient should do>",
  "methodology": "Behavioral embedding vector analysis — scores represent persuasion strategy intensity, not keyword frequency."
}`;

// ── LLM call ───────────────────────────────────────────────────────────────────

async function analyzeWithLLM(text) {
  const userPrompt = `Analyze the following text for scam behavioral patterns. Score each persuasion dimension and extract trigger phrases:\n\n---\n${text}\n---`;

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.15, maxOutputTokens: 4096 },
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

// ── HTTP Server ────────────────────────────────────────────────────────────────

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

  // Health
  if (req.method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      status: 'ok', agent: 'scam-detection', version: '1.0.0',
      model: MODEL, provider: 'gemini',
    });
  }

  // Analyze — main endpoint
  if (req.method === 'POST' && pathname === '/analyze') {
    try {
      const body = await readBody(req);
      const text = (body.text || '').trim();

      if (!text) {
        return sendJSON(res, 400, { detail: "Provide 'text' field." });
      }

      console.log(`[analyze] text_len=${text.length}`);

      const result = await analyzeWithLLM(text.slice(0, 8000));

      const bv = result.behavioral_vector || {};
      const safeResult = {
        scam_probability:       typeof result.scam_probability === 'number' ? result.scam_probability : 0.5,
        risk_tier:              result.risk_tier  || 'MEDIUM',
        risk_color:             result.risk_color || 'yellow',
        pattern_type:           result.pattern_type || 'Unknown',
        behavioral_vector: {
          urgency:                    typeof bv.urgency === 'number' ? bv.urgency : 0,
          psychological_manipulation: typeof bv.psychological_manipulation === 'number' ? bv.psychological_manipulation : 0,
          financial_lure:             typeof bv.financial_lure === 'number' ? bv.financial_lure : 0,
          emotional_exploitation:     typeof bv.emotional_exploitation === 'number' ? bv.emotional_exploitation : 0,
        },
        trigger_phrases:  Array.isArray(result.trigger_phrases) ? result.trigger_phrases : [],
        summary:          result.summary || '',
        recommendation:   result.recommendation || '',
        methodology:      result.methodology || 'Behavioral embedding vector analysis',
        model_used:       MODEL,
      };

      return sendJSON(res, 200, safeResult);

    } catch (e) {
      console.error('[analyze] error:', e.message);
      return sendJSON(res, 500, { detail: `Analysis failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n🕵️  Agent 5: Scam Detection Agent`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini (Transformer simulation)`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}\n`);
  console.log(`   Open frontend/index.html in your browser.\n`);
});
