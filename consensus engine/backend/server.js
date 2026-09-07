/**
 * Agent 6: Consensus Engine — Backend
 * Pure Node.js, zero npm dependencies.
 * Uses Google Gemini API via built-in https module.
 *
 * Research Architecture (simulated via Gemini):
 *   Bayesian Evidence Fusion Network (BEFN)
 *     - Per-agent belief nodes, weighted by each agent's own reported
 *       confidence/score fields (not just raw presence/absence)
 *     - Conflict-detection layer: flags when two agents' evidence pulls
 *       in opposite directions, rather than quietly averaging over it
 *     - Abstention handling: an agent that did not run contributes no
 *       belief in either direction — it is not treated as a bad signal
 *
 * This agent does not re-derive raw signals (deepfake artifacts, scam
 * language, source trust graphs, etc.) — that is the job of Agents 1-5.
 * It only reconciles their already-scored outputs into one verdict.
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

const PORT    = 8006;
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

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Agent 6: the Consensus Engine, implementing a Bayesian Evidence Fusion Network (BEFN) over a Data Deception Detection Pipeline.

You do NOT re-analyze raw content. You receive the already-computed JSON outputs of up to six upstream agents and reconcile them into a single fused verdict:
  - claim_extraction        : atomic claims pulled from the text (informational — not itself evidence of truth or deception)
  - cross_modal_contradiction: does the image semantically match the text?
  - deepfake_video          : video/audio manipulation evidence
  - image_deepfake          : still-image manipulation evidence
  - source_credibility      : trust-graph analysis of the publisher/source
  - scam_detection          : behavioral persuasion-pattern analysis

Some agents may be missing (null) because that evidence type was not submitted, or because the agent failed to respond (listed separately as "unavailable"). Treat a missing agent as an ABSTENTION — it contributes no belief in either direction and must not be scored as suspicious by its mere absence. Do not penalize a piece of content just because, say, no video was submitted.

Fusion rules:
1. Convert every agent's own score into a "trust direction" between -1.0 (strongly undermines trust) and +1.0 (strongly supports trust), using that agent's own reported confidence/score fields as your basis — do not invent numbers it did not report.
2. Weight each agent's contribution by how directly it bears on deception (a high-confidence scam-pattern or deepfake finding should weigh more heavily than a merely low-confidence one).
3. CONFLICT DETECTION: explicitly identify when two or more agents point in opposite directions (e.g. source looks credible but scam-pattern language is present; image looks authentic but cross-modal contradiction is high). Name the specific agents involved and what the disagreement is — do not smooth conflicts over into a bland average.
4. If fewer than two agents produced evidence, say so plainly and lower your confidence accordingly rather than manufacturing a precise-looking score from thin evidence.
5. claim_extraction contributes no trust direction on its own — use it only for context in your explanation, never as a scored input.

Return ONLY valid JSON — no markdown fences, no explanation outside the JSON — in this exact schema:
{
  "trust_score": <0-100 integer, 50 = no evidence either way>,
  "verdict": "TRUSTED | UNCERTAIN | SUSPICIOUS | DECEPTIVE | INSUFFICIENT_EVIDENCE",
  "confidence": <0.0-1.0 float — your confidence in this verdict, lower when evidence is sparse or agents disagree>,
  "contributing_factors": [
    {
      "agent": "<one of: claim_extraction|cross_modal_contradiction|deepfake_video|image_deepfake|source_credibility|scam_detection>",
      "direction": "supports_trust | undermines_trust | neutral",
      "weight": <0.0-1.0, how much this factored into the final score>,
      "reason": "<one sentence citing the specific finding>"
    }
  ],
  "conflicts": ["<one sentence per detected disagreement between named agents, empty array if none>"],
  "explanation": "<3-5 sentence synthesis a human reviewer can act on>",
  "recommendation": "<one sentence: what should the reviewer do next>",
  "methodology": "Bayesian Evidence Fusion Network — weighted belief aggregation with explicit conflict detection across independently-scored agents."
}`;

async function runConsensus(evidence, unavailable) {
  const userPrompt =
    `Upstream agent outputs (null = not submitted for this item):\n` +
    JSON.stringify(evidence, null, 2) +
    `\n\nAgents that were unavailable / failed to respond (treat as abstentions, but mention if relevant): ` +
    JSON.stringify(unavailable || []) +
    `\n\nFuse this evidence into a single consensus verdict per your instructions.`;

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
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

const VALID_KEYS = ['claim_extraction','cross_modal_contradiction','deepfake_video','image_deepfake','source_credibility','scam_detection'];

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
    return sendJSON(res, 200, {
      status: 'ok', agent: 'consensus-engine', version: '1.0.0',
      model: MODEL, provider: 'gemini',
    });
  }

  if (req.method === 'POST' && pathname === '/consensus') {
    try {
      const body = await readBody(req);
      const evidenceIn = body.evidence || {};
      const unavailable = Array.isArray(body.unavailable) ? body.unavailable : [];

      // Normalise to the six known keys; anything else is dropped.
      const evidence = {};
      VALID_KEYS.forEach(k => { evidence[k] = evidenceIn[k] ?? null; });

      const submittedCount = VALID_KEYS.filter(k => evidence[k] !== null && k !== 'claim_extraction').length;
      if (submittedCount === 0) {
        return sendJSON(res, 200, {
          trust_score: 50,
          verdict: 'INSUFFICIENT_EVIDENCE',
          confidence: 0.0,
          contributing_factors: [],
          conflicts: [],
          explanation: 'No scoring evidence was submitted — only claim extraction (if present) carries no trust signal on its own.',
          recommendation: 'Submit at least one of: source info, image, video, or text for scam-pattern analysis.',
          methodology: 'Bayesian Evidence Fusion Network — weighted belief aggregation with explicit conflict detection across independently-scored agents.',
          model_used: MODEL,
        });
      }

      const result = await runConsensus(evidence, unavailable);

      const clamp01 = v => Math.min(1, Math.max(0, parseFloat(v) || 0));
      const clampScore = v => Math.min(100, Math.max(0, Math.round(parseFloat(v))));

      return sendJSON(res, 200, {
        trust_score:          isNaN(clampScore(result.trust_score)) ? 50 : clampScore(result.trust_score),
        verdict:               result.verdict     || 'UNCERTAIN',
        confidence:            clamp01(result.confidence),
        contributing_factors: Array.isArray(result.contributing_factors) ? result.contributing_factors : [],
        conflicts:             Array.isArray(result.conflicts) ? result.conflicts : [],
        explanation:           result.explanation  || '',
        recommendation:        result.recommendation || '',
        methodology:           result.methodology || 'Bayesian Evidence Fusion Network',
        model_used:            MODEL,
      });

    } catch (e) {
      console.error('[consensus] error:', e.message);
      return sendJSON(res, 500, { detail: `Consensus failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n⚖️  Agent 6: Consensus Engine`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini (Bayesian fusion)`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}\n`);
  console.log(`   Awaits POST /consensus { evidence: {...}, unavailable: [...] }\n`);
});
