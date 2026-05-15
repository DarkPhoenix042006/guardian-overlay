/**
 * GUARDIAN OVERLAY — backend/server.js
 *
 * Self-contained Node.js/Express backend.
 * Implements the full 3-stage preprocessing pipeline before any LLM call.
 *
 * Deploy to: Vercel, Railway, Render, Fly.io, or run locally.
 * Set env: GEMINI_API_KEY  (free at https://aistudio.google.com/apikey)
 *
 * Free tier: 500 requests/day, 1M tokens/min — plenty for personal use.
 *
 * POST /analyze
 *   Body: { text: string }  ← compressed text from extension
 *   Returns: GuardianResult JSON
 */

import express from "express";
import crypto  from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app    = express();
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model  = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

app.use(express.json({ limit: "50kb" }));

// ─── CORS (allow extension origin) ────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── IN-MEMORY CACHE (upgrade to Redis for production) ────────────────────────
// Key: SHA-256 of compressed text → GuardianResult
const resultCache = new Map();
const CACHE_MAX   = 1000; // evict oldest when full

function cacheGet(hash) {
  return resultCache.get(hash) ?? null;
}

function cacheSet(hash, result) {
  if (resultCache.size >= CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order)
    resultCache.delete(resultCache.keys().next().value);
  }
  resultCache.set(hash, result);
}

// ─── PIPELINE CONSTANTS ───────────────────────────────────────────────────────

const KEYWORDS = [
  "arbitration","binding arbitration","class action","waiver","dispute resolution",
  "subscription","auto-renew","auto-renewal","recurring","cancellation","cancel",
  "billing","fees","payment","refund","charge","invoice","price increase",
  "termination","suspend","account closure",
  "data sharing","third-party","third party","sell your data","data broker",
  "tracking","cookies","analytics","behavioral","fingerprint",
  "location","gps","geolocation","camera","microphone","contacts","photo library",
  "collect","store","retain","process","transfer","license","sublicense",
  "indemnif","liability","warranty disclaimer","limitation of liability",
  "governing law","jurisdiction","choice of law","force majeure",
];

const REDUNDANT_RX = [
  /please read (this|these|the following) (agreement|terms|policy|document) carefully\.?/gi,
  /by (clicking|using|accessing|continuing|proceeding)[^.]{0,120}\./gi,
  /last updated?:?\s*\w+\s*\d{1,2},?\s*\d{4}/gi,
  /table of contents/gi,
  /print this page/gi,
  /back to top/gi,
  /copyright\s*©?\s*\d{4}[^.]{0,60}/gi,
  /all rights reserved\.?/gi,
  /skip to (main )?content/gi,
];

const CITATION_RX = /\b(section|clause|article|paragraph|exhibit|schedule|appendix|§)\s+[\d.()a-z]+/gi;

const AI_TRIGGERS = [
  "billing","arbitration","permission","data sharing","sell","license",
  "collect","tracking","auto-renew","subscription","indemnif","liability",
  "waive","refund","fee","charge","third-party","camera","microphone",
  "location","termination",
];

// ─── STAGE 0: RULE-BASED EXTRACTION ──────────────────────────────────────────

function stage0_extract(rawText) {
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const matchedIdx = new Set();

  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    if (KEYWORDS.some(kw => low.includes(kw.toLowerCase()))) {
      if (i > 0)              matchedIdx.add(i - 1);
      matchedIdx.add(i);
      if (i < lines.length-1) matchedIdx.add(i + 1);
    }
  });

  const seen = new Set();
  return [...matchedIdx]
    .sort((a, b) => a - b)
    .map(i => lines[i])
    .filter(l => {
      const key = l.toLowerCase().replace(/\s+/g," ").slice(0,80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

// ─── STAGE 1: HEURISTIC COMPRESSION ──────────────────────────────────────────

function stage1_compress(filtered) {
  let text = filtered;
  REDUNDANT_RX.forEach(rx => { text = text.replace(rx, ""); });
  text = text.replace(CITATION_RX, "");
  text = text
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l.length >= 40)
    .join("\n");
  text = text.replace(/[ \t]{2,}/g," ").replace(/\n{3,}/g,"\n\n");
  return text.slice(0, 8000);
}

// ─── STAGE 2: AI GATE ─────────────────────────────────────────────────────────

function stage2_needsAI(compressed) {
  const low = compressed.toLowerCase();
  return AI_TRIGGERS.some(t => low.includes(t));
}

// ─── STAGE 3: LLM CALL ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a consumer rights attorney AI assistant.
Analyze ONLY the provided Terms & Conditions clauses.
Return STRICT valid JSON — no markdown, no preamble, no trailing text.

Required schema:
{
  "risk_level": "GREEN" | "YELLOW" | "RED",
  "traps": [string, string, string],
  "permissions": [string],
  "hidden_fees": [string],
  "arbitration": "present" | "not_present",
  "summary": string
}

Field rules:
- risk_level: GREEN = consumer-friendly, YELLOW = some concerning clauses, RED = predatory/harmful
- traps: exactly 3 most dangerous clauses (be specific, quote key phrases)
- permissions: list each data type or device permission explicitly granted
- hidden_fees: list each non-obvious financial obligation
- arbitration: "present" only if binding arbitration or class action waiver is found
- summary: 1-2 sentence plain-language verdict (max 40 words)

Critical: Do NOT hallucinate. Only use information present in the input. Be concise.`;

async function stage3_callLLM(compressed) {
  // Gemini 2.5 Flash — free tier: 500 req/day, no credit card needed
  const fullPrompt = `${SYSTEM_PROMPT}\n\nAnalyze these distilled T&C clauses:\n\n${compressed}`;

  const result = await model.generateContent(fullPrompt);
  const raw    = result.response.text();

  // Strip any accidental markdown fences Gemini sometimes adds
  const clean = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const parsed = JSON.parse(clean);

  if (!["GREEN", "YELLOW", "RED"].includes(parsed.risk_level)) {
    throw new Error("Invalid risk_level in LLM response");
  }
  return {
    risk_level:  parsed.risk_level,
    traps:       Array.isArray(parsed.traps)        ? parsed.traps.slice(0, 3) : [],
    permissions: Array.isArray(parsed.permissions)  ? parsed.permissions        : [],
    hidden_fees: Array.isArray(parsed.hidden_fees)  ? parsed.hidden_fees        : [],
    arbitration: parsed.arbitration === "present"   ? "present" : "not_present",
    summary:     typeof parsed.summary === "string" ? parsed.summary.slice(0, 300) : "",
  };
}

// ─── METRICS HELPER ───────────────────────────────────────────────────────────

function computeMetrics(rawLen, compLen) {
  const rawTokens  = Math.round(rawLen  / 4);
  const compTokens = Math.round(compLen / 4);
  const saved      = Math.round((1 - compLen / Math.max(rawLen, 1)) * 100);
  return { rawChars: rawLen, compressedChars: compLen, rawTokens, compressedTokens: compTokens, reductionPct: saved };
}

// ─── ROUTE: POST /analyze ─────────────────────────────────────────────────────

app.post("/analyze", async (req, res) => {
  const start = Date.now();

  try {
    let { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Body must include { text: string }" });
    }

    // The extension sends already-compressed text.
    // If you want the server to also accept raw full documents (e.g. CLI use),
    // run the full pipeline here too.
    const rawLen = text.length;

    // Server-side pipeline (defensive — catches cases where extension sends raw text)
    let compressed = text;
    if (text.length > 10000) {
      const filtered = stage0_extract(text);
      compressed     = stage1_compress(filtered);
    } else if (text.length > 8000) {
      compressed = stage1_compress(text);
    }

    const compLen = compressed.length;
    const hash    = crypto.createHash("sha256").update(compressed).digest("hex");

    // Cache check
    const cached = cacheGet(hash);
    if (cached) {
      return res.json({
        ...cached,
        cached:  true,
        metrics: computeMetrics(rawLen, compLen),
        ms:      Date.now() - start,
      });
    }

    // AI gate
    if (!stage2_needsAI(compressed)) {
      const result = {
        risk_level:  "GREEN",
        traps:       [],
        permissions: [],
        hidden_fees: [],
        arbitration: "not_present",
        summary:     "No high-risk clauses detected by rule-based analysis.",
      };
      cacheSet(hash, result);
      return res.json({ ...result, cached: false, metrics: computeMetrics(rawLen, compLen), ms: Date.now() - start });
    }

    // LLM call
    const result = await stage3_callLLM(compressed);
    cacheSet(hash, result);

    return res.json({
      ...result,
      cached:  false,
      metrics: computeMetrics(rawLen, compLen),
      ms:      Date.now() - start,
    });

  } catch (err) {
    console.error("[Guardian backend error]", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: GET /health ───────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", cacheSize: resultCache.size });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Guardian backend] Running on http://localhost:${PORT}`);
});
