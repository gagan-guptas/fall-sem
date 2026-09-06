/**
 * Agent 6: Evidence Retrieval Agent — Backend
 * Pure Node.js, zero npm dependencies.
 * Uses Google Gemini API (with built-in Search grounding) via built-in https module.
 *
 * For each claim it receives, it asks Gemini to search the live web and return
 * real evidence from reputable sources, ranked by trust and relevance, and
 * labeled as supporting, contradicting, or neutral toward the claim.
 */

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

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

const PORT    = 8005;
const API_KEY = process.env.GEMINI_API_KEY || '';
// Search grounding requires a model that supports the "google_search" tool
// (Gemini 2.0+ models) AND a Google Cloud project with billing linked — on a
// pure free-tier key it typically 429s immediately, every time, regardless
// of the plain-text quota. Off by default so this agent works the same way
// Agent 1/2 do out of the box. Flip ENABLE_SEARCH_GROUNDING=true once your
// project has grounding quota available.
const MODEL   = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const USE_GROUNDING = process.env.ENABLE_SEARCH_GROUNDING === 'true';
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries on 429 with exponential backoff, and logs the FULL error body
// (not truncated) so the exact quotaId/quotaMetric is visible in the console
// when Google's response says which specific quota was exhausted.
async function httpsPostWithRetry(targetUrl, headers, body, maxRetries = 3) {
  let lastResult;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await httpsPost(targetUrl, headers, body);
    if (result.status !== 429) return result;

    lastResult = result;
    console.error(`[gemini] 429 on attempt ${attempt + 1}/${maxRetries + 1} — full error:`,
      JSON.stringify(result.body, null, 2));

    if (attempt < maxRetries) {
      const waitMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s...
      console.log(`[gemini] backing off ${waitMs}ms before retry...`);
      await sleep(waitMs);
    }
  }
  return lastResult;
}

// ── LLM call (Gemini + Search grounding) ────────────────────────────────────────

const SYSTEM_PROMPT_GROUNDED = `You are Agent 6: Evidence Retrieval Agent — part of a Data Deception Detection Pipeline.

Your task: given a single factual claim, search the live web for real evidence from
reputable sources (wire agencies, established news outlets, fact-checking organizations,
government bodies, peer-reviewed or scientific sources) that either supports or contradicts
the claim. Do not invent sources, URLs, or quotes — only report what your search actually finds.

For each distinct piece of evidence you find, report:
- source: the name of the publication or organization
- url: the real, exact source URL you found it at
- stance: one of "supporting" | "contradicting" | "neutral"
- trust_score: 0.0-1.0, based on the general reliability/reputation of the source
- relevance_score: 0.0-1.0, based on how directly the source addresses this specific claim
- snippet: a 1-2 sentence paraphrase of the relevant content (do not quote more than a
  short phrase verbatim)

Find at most 5 pieces of evidence, ordered by relevance_score descending. If your search
finds no relevant evidence at all, return an empty evidence array.

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "evidence": [
    {
      "source": "<publication or organization name>",
      "url": "<exact source URL>",
      "stance": "<supporting|contradicting|neutral>",
      "trust_score": <0.0-1.0 float>,
      "relevance_score": <0.0-1.0 float>,
      "snippet": "<short paraphrase>"
    }
  ]
}`;

// Fallback used when live search grounding isn't available (e.g. free-tier
// key without billing linked). Relies on the model's training knowledge
// instead of a live search, so it's explicit about not fabricating exact
// URLs it can't be confident about — reducing hallucination risk at the
// cost of not being able to cite very recent events.
const SYSTEM_PROMPT_KNOWLEDGE_ONLY = `You are Agent 6: Evidence Retrieval Agent — part of a Data Deception Detection Pipeline.

You do NOT have live web search in this mode. Using only your general training knowledge,
identify well-known, reputable sources (wire agencies, established news outlets,
fact-checking organizations such as Reuters Fact Check/AP/PolitiFact/Snopes, government
bodies, or scientific organizations) that are likely to support or contradict the given
claim, based on what is generally known about this topic.

Be honest about the limits of this mode:
- Only include a specific "url" if you are highly confident it is the exact, correct
  address. If you are not certain of the exact URL, set "url" to null rather than
  guessing — a wrong URL is worse than none.
- Do not fabricate specific article titles, dates, or direct quotes you are not sure of.
- If this claim describes a very recent or obscure event you have no reliable knowledge
  of, return an empty evidence array rather than guessing.

For each distinct piece of evidence, report:
- source: the name of the publication or organization
- url: the exact source URL, or null if not confident
- stance: one of "supporting" | "contradicting" | "neutral"
- trust_score: 0.0-1.0, based on the general reliability/reputation of the source
- relevance_score: 0.0-1.0, based on how directly it addresses this specific claim
- snippet: a 1-2 sentence paraphrase of the relevant content

Find at most 5 pieces of evidence, ordered by relevance_score descending.

Return ONLY valid JSON — no markdown fences, no explanation — in this exact schema:
{
  "evidence": [
    {
      "source": "<publication or organization name>",
      "url": "<exact source URL, or null>",
      "stance": "<supporting|contradicting|neutral>",
      "trust_score": <0.0-1.0 float>,
      "relevance_score": <0.0-1.0 float>,
      "snippet": "<short paraphrase>"
    }
  ]
}`;

const SYSTEM_PROMPT = USE_GROUNDING ? SYSTEM_PROMPT_GROUNDED : SYSTEM_PROMPT_KNOWLEDGE_ONLY;

async function retrieveEvidenceForClaim(claimText) {
  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: USE_GROUNDING
          ? `Claim to check: "${claimText}"\n\nSearch for real evidence and return the JSON described in your instructions.`
          : `Claim to check: "${claimText}"\n\nUsing your general knowledge, return the JSON described in your instructions.` }],
      },
    ],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };

  // Only attach the search tool when grounding is explicitly enabled — this
  // is the piece that requires a project with search-grounding quota.
  if (USE_GROUNDING) {
    requestBody.tools = [{ google_search: {} }];
  }

  const { status, body } = await httpsPostWithRetry(API_URL, { 'X-goog-api-key': API_KEY }, requestBody);

  if (status !== 200) {
    throw new Error(`Gemini API error ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }

  const candidate = body.candidates?.[0];
  let raw = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!raw.trim()) {
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

  let evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];

  // Clamp/normalize scores and drop malformed entries defensively.
  evidence = evidence
    .filter(e => e && typeof e.source === 'string')
    .map(e => ({
      source: e.source,
      url: typeof e.url === 'string' ? e.url : null,
      stance: ['supporting', 'contradicting', 'neutral'].includes(e.stance) ? e.stance : 'neutral',
      trust_score: clamp01(e.trust_score),
      relevance_score: clamp01(e.relevance_score),
      snippet: typeof e.snippet === 'string' ? e.snippet : '',
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score);

  // Real grounding sources Gemini's search tool actually cited, if present —
  // useful for cross-checking that URLs above are genuine, not hallucinated.
  const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
  const groundingSources = groundingChunks
    .map(c => c.web && { title: c.web.title, url: c.web.uri })
    .filter(Boolean);

  return { evidence, groundingSources };
}

function clamp01(n) {
  const v = typeof n === 'number' ? n : parseFloat(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
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
      agent:    'evidence-retrieval',
      version:  '1.0.0',
      model:    MODEL,
      provider: 'gemini',
      grounded: USE_GROUNDING,
    });
  }

  // Retrieve evidence for one or more claims
  if (req.method === 'POST' && pathname === '/retrieve-evidence') {
    try {
      const body = await readBody(req);
      const claims = body.claims;

      if (!Array.isArray(claims) || !claims.length) {
        return sendJSON(res, 400, { detail: "Provide 'claims' as a non-empty array of { id, text, type }." });
      }

      const results = [];

      // Sequential, not parallel — keeps this simple and avoids hitting
      // per-second/per-minute rate limits on the Gemini API when checking
      // many claims. A short gap between claims further protects against
      // the RPM ceiling on search-grounding requests specifically.
      const DELAY_BETWEEN_CLAIMS_MS = 1200;

      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        const claimId = claim.id ?? i + 1;
        const claimText = (claim.text || '').trim();

        if (!claimText) {
          results.push({ claim_id: claimId, claim_text: '', claim_type: claim.type || null, evidence: [], error: 'Empty claim text' });
          continue;
        }

        try {
          const { evidence, groundingSources } = await retrieveEvidenceForClaim(claimText);
          results.push({
            claim_id: claimId,
            claim_text: claimText,
            claim_type: claim.type || null,
            evidence,
            grounding_sources: groundingSources,
          });
        } catch (err) {
          console.error(`[retrieve-evidence] claim #${claimId} failed:`, err.message);
          results.push({ claim_id: claimId, claim_text: claimText, claim_type: claim.type || null, evidence: [], error: err.message });
        }

        if (i < claims.length - 1) await sleep(DELAY_BETWEEN_CLAIMS_MS);
      }

      return sendJSON(res, 200, { results, model_used: MODEL, grounded: USE_GROUNDING });

    } catch (e) {
      console.error('[retrieve-evidence] error:', e.message);
      return sendJSON(res, 500, { detail: `Evidence retrieval failed: ${e.message}` });
    }
  }

  sendJSON(res, 404, { detail: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n🔎 Agent 6: Evidence Retrieval Agent`);
  console.log(`   Backend  → http://localhost:${PORT}`);
  console.log(`   Provider → Google Gemini${USE_GROUNDING ? ' (search grounding ON)' : ' (knowledge-only mode — no live search)'}`);
  console.log(`   Model    → ${MODEL}`);
  console.log(`   Key set  → ${API_KEY ? 'yes ✓' : 'NO ✗ — set GEMINI_API_KEY'}`);
  console.log(`\n   Open frontend/index.html in your browser.\n`);
});