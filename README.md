<a href="https://github.com/user-attachments/assets/3d398bc1-d26e-448e-ac92-c929d8348eb4">
  <img src="https://github.com/user-attachments/assets/3d398bc1-d26e-448e-ac92-c929d8348eb4" alt="Screenshot" width="400">
</a>
<a href="https://github.com/user-attachments/assets/9ef3cb07-ac24-499d-b798-cf2e7321391c">
  <img src="https://github.com/user-attachments/assets/9ef3cb07-ac24-499d-b798-cf2e7321391c" alt="Screenshot" width="400">
</a>
<a href="https://github.com/user-attachments/assets/454500b9-f01d-4fd6-ad5f-fbec1b6d638e">
  <img src="https://github.com/user-attachments/assets/454500b9-f01d-4fd6-ad5f-fbec1b6d638e" alt="Screenshot" width="300">
</a>
<a href="https://github.com/user-attachments/assets/65474ad1-d1ff-4308-909f-bff054e61279">
  <img src="https://github.com/user-attachments/assets/65474ad1-d1ff-4308-909f-bff054e61279" alt="Screenshot" width="300">
</a>

# 🛡️ Guardian Overlay

### AI-powered Terms & Conditions Risk Analyzer

**Reads the fine print so you don't have to.**

Guardian is a Chrome Extension that silently analyzes Terms & Conditions and Privacy Policy pages, then surfaces a color-coded risk report — right next to the Accept button — before you blindly click it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Gemini 2.5 Flash](https://img.shields.io/badge/AI-Gemini%202.5%20Flash-4285F4?logo=google)](https://aistudio.google.com)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-yellow?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3)
[![Free Tier](https://img.shields.io/badge/Cost-Free%20Tier-brightgreen)](https://aistudio.google.com/apikey)
[![Node.js](https://img.shields.io/badge/Backend-Node.js-339933?logo=nodedotjs)](https://nodejs.org)

</div>

---

## 📋 Table of Contents

- [The Problem](#-the-problem)
- [What It Does](#-what-it-does)
- [How It Works](#-how-it-works)
- [Architecture](#-architecture)
- [Token Cost Savings](#-token-cost-savings)
- [Project Structure](#-project-structure)
- [Prerequisites](#-prerequisites)
- [Setup: Backend](#-setup-backend)
- [Setup: Chrome Extension](#-setup-chrome-extension)
- [Deploy to Production](#-deploy-to-production)
- [Tech Stack](#-tech-stack)
- [Roadmap](#-planned)
- [Contributing](#-contributing)
- [License](#-license)

---

## 😤 The Problem

Every day you click **"I Accept"** without reading a word.

Hidden inside those walls of legal text:
- 🔴 Your data being **sold to third parties**
- 🔴 **Binding arbitration** clauses that strip your right to sue
- 🔴 **Auto-renewing subscriptions** with buried cancellation terms
- 🔴 Permission to access your **camera, microphone, and location**
- 🔴 **Hidden fees** that appear months later

Nobody reads Terms & Conditions. Guardian does it for you.

---

## 🎯 What It Does

When you land on any Terms & Conditions or Privacy Policy page, Guardian automatically detects it, analyzes it, and shows you this:

| Output | Description |
|---|---|
| 🟢🟡🔴 **Risk Level** | GREEN / YELLOW / RED verdict at a glance |
| 🪤 **Top 3 Traps** | The most dangerous clauses, in plain English |
| 📡 **Permissions Taken** | Every data type and device access being granted |
| 💰 **Hidden Fees** | Auto-renewals, late fees, billing surprises |
| ⚖️ **Arbitration Status** | Whether you're waiving your right to sue |

All of this appears in a **floating overlay before you click Accept** — with zero effort on your part.

---

## 🧠 How It Works

Guardian uses a **3-stage preprocessing pipeline** that reduces LLM token usage by **80–95%** before any AI call is made. Most work happens locally, for free, in milliseconds.

```
Page Load
    │
    ▼
sessionStorage guard ──► Already ran this session? EXIT
    │
    ▼
Wait 6 seconds (let dynamic content render)
    │
    ▼
chrome.storage.local check (normalized URL)
    ├── Found + not expired ──► Show cached result instantly, EXIT
    │
    ▼
Is this a T&C page? (URL pattern + title + keyword density)
    ├── No ──► EXIT silently
    │
    ▼
Scrape visible text (strip nav, footer, scripts)
    │
    ▼
┌─────────────────────────────────────────────┐
│  STAGE 0 — Rule-based extraction  FREE 0ms  │
│  40+ legal keywords → extract paragraphs    │
│  ± context lines → deduplicate              │
│  200k chars ──► ~15k chars                  │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STAGE 1 — Heuristic compression  FREE ~1ms │
│  Strip boilerplate, citations, short lines  │
│  Hard cap at 8,000 characters               │
│  15k chars ──► ~3k–6k chars                 │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
SHA-256 hash ──► Local cache hit? ──► Return instantly, EXIT
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STAGE 2 — AI Gate check          FREE ~1ms │
│  No risk trigger words found?               │
│  ──► Return GREEN immediately, no API call  │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  STAGE 3 — Gemini 2.5 Flash        ~2–5s    │
│  Send ONLY compressed text                  │
│  Strict JSON prompt → structured result     │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
Render overlay UI (near Accept button if detected)
    │
    ▼
Save to chrome.storage.local (7-day TTL)
    │
    ▼
Mark sessionStorage = done
```

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────┐
│                        Chrome Browser                      │
│                                                            │
│  ┌──────────────────────┐      ┌────────────────────────┐  │
│  │  content_script.js   │      │   service_worker.js    │  │
│  │   (isolated world)   │◄────►│   (extension origin)   │  │
│  │                      │      │                        │  │
│  │ • T&C page detection │      │ • ALL fetch() calls    │  │
│  │ • DOM text scraping  │      │ • chrome.storage.local │  │
│  │ • Stage 0, 1, 2      │      │ • Hash cache manager   │  │
│  │ • Overlay UI render  │      │ • Backend API proxy    │  │
│  └──────────────────────┘      └───────────┬────────────┘  │
│                                            │               │
└────────────────────────────────────────────│───────────────┘
                                             │ POST /analyze
                                             ▼
                             ┌────────────────────────────┐
                             │      Node.js Backend       │
                             │                            │
                             │  • Server-side pipeline    │
                             │  • In-memory hash cache    │
                             │  • Gemini 2.5 Flash API    │
                             │  • GET /health             │
                             └────────────────────────────┘
```

### Why route all `fetch()` through the service worker?

Content scripts share the host page's network stack. Banks, healthcare, and legal sites — exactly the targets — have strict Content Security Policies that **silently block** external requests from content scripts. The service worker runs under the extension origin and is completely exempt.

### Why two cache layers?

| Layer | Key | Scope | TTL |
|---|---|---|---|
| URL cache | `guardian_url:<normalizedUrl>` | chrome.storage.local | 7 days |
| Hash cache | `guardian_hash:<sha256>` | chrome.storage.local | 7 days |
| Server cache | SHA-256 of compressed text | In-memory Map | Process lifetime |

URL normalization strips query params and session tokens so `example.com/tos?ref=google&sid=abc` and `example.com/tos` map to the same key.

---

## 💰 Token Cost Savings

| Scenario | Input Tokens | Cost (Gemini Flash) |
|---|---|---|
| Naive — raw doc to LLM | ~40,000 | ~$0.04 |
| Guardian pipeline | ~1,500–2,000 | ~$0.001 |
| Cache hit (URL or hash) | 0 | **$0.00** |
| AI gate skip (GREEN page) | 0 | **$0.00** |

**Typical reduction: 92–96% fewer tokens per analysis.**

On the free tier (500 req/day), Guardian can analyze hundreds of unique documents daily at zero cost.

---

## 📁 Project Structure

```
guardian-overlay/
│
├── extension/                  ← Load this folder in Chrome
│   ├── manifest.json           ← MV3 config, permissions
│   ├── content_script.js       ← 13-step pipeline orchestrator
│   ├── service_worker.js       ← All fetch + storage operations
│   ├── popup/
│   │   ├── popup.html          ← Extension action button UI
│   │   └── popup.js            ← Cache stats + re-analyze
│   └── icons/
│       ├── icon16.png          ← 16×16 toolbar icon
│       ├── icon48.png          ← 48×48 extensions page icon
│       └── icon128.png         ← 128×128 Chrome Web Store icon
│
├── backend/
│   ├── server.js               ← Express API + pipeline + Gemini
│   ├── package.json
│   ├── package-lock.json
│   └── .env.example            ← Copy to .env and add your key
│
├── .gitignore
├── vercel.json                 ← Zero-config Vercel deployment
└── README.md
```

---

## ✅ Prerequisites

Before you begin, make sure you have:

- [Node.js](https://nodejs.org/) **v18 or higher** — [Download](https://nodejs.org/en/download)
- [Google Chrome](https://www.google.com/chrome/) browser
- A free **Gemini API key** — get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  - No credit card required
  - Free tier: **500 requests/day**
- [Git](https://git-scm.com/downloads) (to clone the repo)

---

## 🔧 Setup: Backend

### 1. Clone the repository

```bash
git clone https://github.com/DarkPhoenix042006/guardian-overlay.git
cd guardian-overlay
```

### 2. Install dependencies

```bash
cd backend
npm install
```

### 3. Get your free Gemini API key

1. Go to **[https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)**
2. Sign in with any Google account
3. Click **"Create API Key"**
4. Copy the key — it starts with `AIza...(example)`

### 4. Configure environment variables

```bash
# Copy the example file
cp .env.example .env
```

Open `.env` and paste your key:

```env
GEMINI_API_KEY=AIza...your-key-here
PORT=3000
```


### 5. Start the server

**Windows (Command Prompt):**
```cmd
npm start
```

**Windows (PowerShell):**
```powershell
npm start
```

**Mac / Linux:**
```bash
npm start
```

You should see:
```
[Guardian backend] Running on http://localhost:3000
```

### 6. Verify it's working

Open a **second terminal** and run:

**Health check:**
```bash
curl http://localhost:3000/health
```
```json
{ "status": "ok", "cacheSize": 0 }
```

**Full pipeline test:**

Windows CMD:
```cmd
curl -X POST http://localhost:3000/analyze -H "Content-Type: application/json" -d "{\"text\":\"Your subscription will automatically renew monthly. We use binding arbitration and waive class action rights. We collect your location, camera, and microphone data and may sell it to third parties. Late payment fees of $35 apply.\"}"
```

Mac / Linux / PowerShell:
```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"text":"Your subscription will automatically renew monthly. We use binding arbitration and waive class action rights. We collect your location, camera, and microphone data and may sell it to third parties. Late payment fees of $35 apply."}'
```

**Expected response:**
```json
{
  "risk_level": "RED",
  "traps": [
    "Binding arbitration waives your right to a jury trial",
    "Personal data including location and biometrics sold to third parties",
    "Subscription auto-renews monthly with no clear cancellation process"
  ],
  "permissions": ["location data", "camera data", "microphone data"],
  "hidden_fees": ["$35 late payment fee"],
  "arbitration": "present",
  "summary": "This service uses binding arbitration, sells personal data, and has auto-renewing subscriptions with hidden fees.",
  "cached": false,
  "metrics": {
    "rawChars": 312,
    "compressedChars": 312,
    "reductionPct": 0
  },
  "ms": 3241
}
```

If you see `risk_level: RED` — your backend is fully working. ✅

---

## 🔌 Setup: Chrome Extension

### 1. Point the extension at your backend

Open `extension/service_worker.js` and update line 20:

```js
// Local development:
const BACKEND_URL = "http://localhost:3000/analyze";

// Production (after deploying — see below):
// const BACKEND_URL = "https://your-app.vercel.app/analyze";
```

### 2. Add extension icons

Add three PNG icon files to `extension/icons/`:

| File | Size | Purpose |
|---|---|---|
| `icon16.png` | 16×16 px | Toolbar icon |
| `icon48.png` | 48×48 px | Extensions management page |
| `icon128.png` | 128×128 px | Chrome Web Store |

> Free icons: [Icons8](https://icons8.com/icons/set/shield) · [Flaticon](https://www.flaticon.com/search?word=shield) · Any shield/security PNG works.

### 3. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** — toggle in the top-right corner
3. Click **"Load unpacked"**
4. Select the `extension/` folder from this project
5. The Guardian shield icon appears in your Chrome toolbar ✅

### 4. Test on a real T&C page

Navigate to any of these — Guardian activates automatically after 6 seconds:

- https://www.spotify.com/legal/end-user-agreement/
- https://discord.com/terms
- https://www.tiktok.com/legal/page/us/terms-of-service/en
- https://twitter.com/en/tos

A risk overlay appears in the **bottom-right corner** of the page.

---

## 🚀 Deploy to Production

### Option A — Vercel (recommended, free)

```bash
# Install Vercel CLI
npm install -g vercel

# From the project root
vercel

# Add your API key securely — never in code
vercel env add GEMINI_API_KEY

# Deploy
vercel --prod
```

Your backend is live at `https://your-project.vercel.app`.

Update `service_worker.js`:
```js
const BACKEND_URL = "https://your-project.vercel.app/analyze";
```

### Option B — Local + ngrok (quick sharing)

```bash
# Terminal 1 — server running
npm start

# Terminal 2 — expose to internet
npx ngrok http 3000
```

Use the ngrok HTTPS URL as your `BACKEND_URL`.

---

## 🛠️ Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Extension | Chrome Manifest V3 | Modern, secure, CSP-safe architecture |
| Content Pipeline | Vanilla JS | Zero deps, runs in isolated world |
| Service Worker | Chrome Service Worker | Bypasses host-page CSP for all fetches |
| Backend | Node.js + Express | Lightweight, deploys anywhere |
| AI Model | Gemini 2.5 Flash | Best free tier — 500 req/day, no card |
| Preprocessing | Rule-based + Regex | 92–96% token reduction before AI |
| Caching | SHA-256 + chrome.storage | Prevents redundant API calls |
| Deployment | Vercel | Zero-config, free tier |

---
## Planned

 - PDF Terms & Conditions support — upload a PDF, get the same analysis
 - History popup — see every T&C you've had analyzed with their risk scores
 - Multi-language support — not everyone's T&Cs are in English
 - Export risk report as PDF — useful for sharing or keeping records
 - Chrome Web Store publish — so anyone can install it in one click
 - Crowdsourced results — if 1000 people analyzed "for example:Spotify's T&C", share that cached result instantly with no API call 

---

## 🤝 Contributing

Contributions are welcome and i would love to know ur thoughts!

```bash
# 1. Fork the repo on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/guardian-overlay.git

# 3. Create a feature branch
git checkout -b feature/your-feature-name

# 4. Make changes and commit
git add .
git commit -m "feat: describe your change"

# 5. Push and open a Pull Request
git push origin feature/your-feature-name
```

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built for hackathon &nbsp;·&nbsp; Powered by Gemini 2.5 Flash &nbsp;·&nbsp; Free tier friendly

**If this helped you, drop a ⭐ — it means a lot!**

</div>
