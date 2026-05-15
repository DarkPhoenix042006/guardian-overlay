# 🛡️ Guardian Overlay — T&C Risk Analyzer

A Chrome Extension (MV3) + Node.js backend that analyzes Terms & Conditions pages for hidden risks using a 3-stage preprocessing pipeline that reduces LLM token usage by **80–95%**.

---

## Architecture

```
Browser Tab (T&C page)
│
├─ content_script.js  ← isolated world, no external fetch
│   │
│   ├── [0] sessionStorage guard → abort if already ran this session
│   ├── [1] Wait 6 seconds (dynamic content settles)
│   ├── [2] chrome.storage.local URL check → return cached UI if found
│   ├── [3] T&C page detection (URL pattern + title + keyword density)
│   ├── [4] DOM text scraping (noise nodes removed)
│   ├── [5] STAGE 0: Rule-based keyword extraction + deduplication
│   ├── [6] STAGE 1: Heuristic compression → max 8,000 chars
│   ├── [7] SHA-256 hash → hash cache check via service worker
│   ├── [8] STAGE 2: AI gate (skip LLM if no risk triggers)
│   ├── [9] chrome.runtime.sendMessage("ANALYZE") → service worker
│   ├── [10] Render overlay UI
│   └── [11] Persist URL + hash → chrome.storage.local
│
└─ service_worker.js  ← handles ALL external fetch (bypasses page CSP)
    │
    ├── CHECK_URL    → chrome.storage.local lookup
    ├── CHECK_HASH   → in-memory hash cache
    ├── SAVE_URL     → persist URL → result (7-day TTL)
    ├── SAVE_HASH    → persist hash → result
    ├── ANALYZE      → POST /analyze to backend
    └── GET_STATS    → popup stats

Backend (Node.js/Express)
│
├── POST /analyze
│   ├── Server-side STAGE 0+1 pipeline (if raw text received)
│   ├── SHA-256 hash → server-side in-memory cache
│   ├── STAGE 2: AI gate check
│   └── STAGE 3: Claude Sonnet API call (only if needed)
│
└── GET /health
```

---

## Token Cost Comparison

| Scenario | Input tokens | Output tokens | Cost (Sonnet) |
|---|---|---|---|
| Naive — full doc to LLM | ~40,000 | ~500 | ~$0.12 |
| Guardian pipeline | ~1,500–2,000 | ~300 | ~$0.005 |
| Cache hit (URL or hash) | 0 | 0 | $0.00 |
| AI gate skip (GREEN) | 0 | 0 | $0.00 |

**Typical reduction: 92–96% fewer tokens per analysis.**

---

## Project Structure

```
guardian-extension/
├── extension/
│   ├── manifest.json          ← MV3 config
│   ├── content_script.js      ← Pipeline orchestrator (isolated world)
│   ├── service_worker.js      ← All fetch + storage operations
│   ├── popup/
│   │   ├── popup.html         ← Extension action UI
│   │   └── popup.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── backend/
│   ├── server.js              ← Express API + 3-stage pipeline
│   └── package.json
├── vercel.json                ← One-command deploy config
└── README.md
```

---

## Setup

### 1. Backend

```bash
cd backend
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# Server runs at http://localhost:3000
```

**Deploy to Vercel (free tier):**
```bash
# From project root:
vercel
vercel env add ANTHROPIC_API_KEY
vercel --prod
```

### 2. Extension

1. Open `extension/service_worker.js`
2. Replace `BACKEND_URL` with your deployed backend URL:
   ```js
   const BACKEND_URL = "https://your-guardian-backend.vercel.app/analyze";
   ```
3. Add icons to `extension/icons/` (16x16, 48x48, 128x128 PNG)
4. Open Chrome → `chrome://extensions/`
5. Enable **Developer mode** (top right)
6. Click **Load unpacked** → select the `extension/` folder

---

## How the Pipeline Works

### Stage 0 — Rule-Based Extraction (0ms, $0)
Scans the raw page text for 40+ legal risk keywords (arbitration, billing, permissions, data sharing, etc.). Extracts matching paragraphs plus ±1 surrounding paragraphs for context. Deduplicates identical lines.

**Typical reduction:** 200k chars → 15k chars

### Stage 1 — Heuristic Compression (1ms, $0)
- Strips redundant boilerplate via regex (cookie banners, "please read carefully", copyright notices)
- Removes legal citations like "Section 4.2(a)"
- Drops lines under 40 characters (navigation fragments)
- Hard caps at 8,000 characters

**Typical reduction:** 15k chars → 3k–6k chars

### Stage 2 — AI Gate (1ms, $0)
Checks if 15 high-risk trigger words appear in compressed text. If none match → returns GREEN immediately. No API call made.

### Stage 3 — LLM Analysis (2–5s, ~$0.005)
Sends only the compressed text with a strict JSON-schema prompt. Response is validated and normalized before caching.

---

## Caching Strategy

Two independent cache layers prevent redundant API calls:

| Layer | Key | Scope | TTL |
|---|---|---|---|
| URL cache | `guardian_url:<normalizedUrl>` | chrome.storage.local | 7 days |
| Hash cache | `guardian_hash:<sha256>` | chrome.storage.local + server memory | 7 days |
| Server cache | SHA-256 of compressed text | In-memory Map (1000 entries) | Process lifetime |

URL normalization strips query params, hash fragments, and trailing slashes so `example.com/tos?ref=google` and `example.com/tos` map to the same key.

---

## Key MV3 Decisions

**Why route all fetch through the service worker?**
Content scripts run in an isolated world but share the host page's network stack. If the T&C page has a strict CSP (common on financial/healthcare sites), `fetch()` calls from the content script to external domains get blocked. The service worker runs in the extension origin and is exempt from host-page CSP.

**Why sessionStorage for the per-session guard?**
`chrome.storage.local` persists across restarts — good for the 7-day URL cache. But we also want to skip re-running if the user navigates back to the same tab in the same session. `sessionStorage` is per-tab and auto-clears when the tab closes, making it the right tool for this guard.

**Why SHA-256 both client and server side?**
The extension computes the hash before the API call to check local storage. The server computes it again as a race-condition guard (two tabs opening the same page simultaneously would otherwise both make API calls).
