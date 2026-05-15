/**
 * GUARDIAN OVERLAY — content_script.js
 * Runs in isolated world on every page.
 * All external fetch calls are routed through the service worker
 * to bypass host-page CSP restrictions.
 *
 * Pipeline:
 *   sessionStorage guard → 6s delay → chrome.storage.local URL check
 *   → T&C detection → rule-based extraction → compression
 *   → hash → cache check → service worker fetch → render UI → persist
 */

"use strict";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const GUARDIAN_SESSION_KEY = "guardian_ran";
const STARTUP_DELAY_MS     = 6000;

const TC_URL_PATTERNS = [
  /\/(terms|tos|terms-of-service|terms-of-use|user-agreement|eula)/i,
  /\/(privacy|privacy-policy|data-policy|cookie-policy)/i,
  /\/(legal|conditions|agreement|disclaimer)/i,
];

const TC_TITLE_PATTERNS = [
  /terms (of|and) (service|use|conditions)/i,
  /privacy policy/i,
  /user agreement/i,
  /cookie policy/i,
  /end user license/i,
  /legal notice/i,
];

const KEYWORDS = [
  "arbitration","binding arbitration","class action","waiver","dispute resolution",
  "subscription","auto-renew","auto-renewal","recurring","cancellation","cancel",
  "billing","fees","payment","refund","charge","invoice","price increase",
  "termination","suspend","ban","account closure",
  "data sharing","third-party","third party","sell your data","data broker",
  "tracking","cookies","analytics","behavioral","fingerprint","profile",
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
  /jump to section/gi,
  /print this page/gi,
  /back to top/gi,
  /copyright\s*©?\s*\d{4}/gi,
  /all rights reserved\.?/gi,
  /©\s*\d{4}[^.]{0,60}/gi,
  /skip to (main )?content/gi,
  /cookie (banner|notice|consent)[^.]{0,80}/gi,
];

const CITATION_RX = /\b(section|clause|article|paragraph|exhibit|schedule|appendix|§)\s+[\d.()a-z]+/gi;

const AI_TRIGGERS = [
  "billing","arbitration","permission","data sharing","sell","license",
  "collect","tracking","auto-renew","subscription","indemnif","liability",
  "waive","refund","fee","charge","third-party","camera","microphone",
  "location","termination","governing law",
];

// ─── GUARD: sessionStorage (per browser session, cleared on tab close) ────────

if (sessionStorage.getItem(GUARDIAN_SESSION_KEY)) {
  // Already ran this tab session — bail immediately
  throw new Error("[Guardian] Already ran this session. Exiting.");
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function normalizeUrl(href) {
  try {
    const u = new URL(href);
    // Strip query params, hash, trailing slash
    return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return href.trim().toLowerCase();
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ─── TC PAGE DETECTION ────────────────────────────────────────────────────────

function isTCPage() {
  const url   = window.location.href.toLowerCase();
  const title = document.title.toLowerCase();
  const h1    = (document.querySelector("h1")?.textContent || "").toLowerCase();

  if (TC_URL_PATTERNS.some(rx => rx.test(url))) return true;
  if (TC_TITLE_PATTERNS.some(rx => rx.test(title))) return true;
  if (TC_TITLE_PATTERNS.some(rx => rx.test(h1)))    return true;

  // Density check: if >8 of our keywords appear in visible text → likely TC
  const bodyText = (document.body?.innerText || "").toLowerCase();
  const hits = KEYWORDS.filter(kw => bodyText.includes(kw.toLowerCase()));
  return hits.length >= 8;
}

// ─── STAGE 0: RULE-BASED EXTRACTION ──────────────────────────────────────────

function stage0_extract(rawText) {
  const lines = rawText
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);

  const matchedIdx = new Set();
  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    if (KEYWORDS.some(kw => low.includes(kw.toLowerCase()))) {
      if (i > 0) matchedIdx.add(i - 1);
      matchedIdx.add(i);
      if (i < lines.length - 1) matchedIdx.add(i + 1);
    }
  });

  const seen = new Set();
  return [...matchedIdx]
    .sort((a, b) => a - b)
    .map(i => lines[i])
    .filter(l => {
      const key = l.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
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
  text = text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.slice(0, 8000);
}

// ─── STAGE 2: SHOULD WE CALL AI? ─────────────────────────────────────────────

function stage2_needsAI(compressed) {
  const low = compressed.toLowerCase();
  return AI_TRIGGERS.some(t => low.includes(t));
}

// ─── TEXT SCRAPING (handles SPA + MutationObserver) ─────────────────────────

function scrapePageText() {
  // Remove noise nodes before grabbing text
  const noise = ["script","style","nav","header","footer","noscript","iframe","svg"];
  const clone  = document.body.cloneNode(true);
  clone.querySelectorAll(noise.join(",")).forEach(n => n.remove());
  return clone.innerText || clone.textContent || "";
}

// ─── FIND ACCEPT BUTTON ───────────────────────────────────────────────────────

function findAcceptButton() {
  const rx = /^(i\s+)?(accept|agree|i understand|got it|ok|continue)/i;
  const candidates = [
    ...document.querySelectorAll("button, input[type=button], input[type=submit], a[role=button]"),
  ];
  return candidates.find(el => rx.test((el.textContent || el.value || "").trim()));
}

// ─── OVERLAY RENDERER ─────────────────────────────────────────────────────────

function renderOverlay(data, cached) {
  // Remove any existing overlay
  document.getElementById("guardian-overlay")?.remove();

  const RISK_CFG = {
    GREEN:  { emoji: "🟢", label: "Low Risk",    bg: "#f0fdf4", border: "#86efac", heading: "#166534" },
    YELLOW: { emoji: "🟡", label: "Medium Risk", bg: "#fffbeb", border: "#fcd34d", heading: "#92400e" },
    RED:    { emoji: "🔴", label: "High Risk",   bg: "#fef2f2", border: "#fca5a5", heading: "#991b1b" },
  };

  const cfg = RISK_CFG[data.risk_level] || RISK_CFG.GREEN;

  const list = (arr, icon) =>
    (arr && arr.length)
      ? arr.map(item => `<li style="margin-bottom:6px;line-height:1.45">${icon} ${escHtml(item)}</li>`).join("")
      : `<li style="color:#9ca3af;font-style:italic">None detected</li>`;

  const overlay = document.createElement("div");
  overlay.id = "guardian-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Guardian T&C Risk Analysis");
  overlay.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 340px;
    max-height: 80vh;
    overflow-y: auto;
    z-index: 2147483647;
    background: ${cfg.bg};
    border: 1.5px solid ${cfg.border};
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: #111827;
    line-height: 1.5;
    transition: opacity 0.3s ease;
  `;

  overlay.innerHTML = `
    <div style="padding:14px 16px 12px;border-bottom:1px solid ${cfg.border};display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:22px" aria-hidden="true">${cfg.emoji}</span>
        <div>
          <div style="font-weight:600;font-size:14px;color:${cfg.heading}">
            ${escHtml(cfg.label)}
            ${cached ? '<span style="font-size:10px;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:4px;margin-left:4px;font-weight:500">cached</span>' : ""}
          </div>
          <div style="font-size:11px;color:#6b7280;margin-top:1px">Guardian T&amp;C Analysis</div>
        </div>
      </div>
      <button id="guardian-close" aria-label="Close Guardian overlay" style="
        background:none;border:none;cursor:pointer;padding:4px;
        color:#9ca3af;font-size:18px;line-height:1;border-radius:6px;
      ">✕</button>
    </div>

    ${data.summary ? `
    <div style="padding:10px 16px 0;font-size:12.5px;color:#374151;line-height:1.5">
      ${escHtml(data.summary)}
    </div>` : ""}

    <div style="padding:10px 16px">
      <div style="font-weight:600;font-size:12px;color:#374151;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">
        ⚠️ Top Traps
      </div>
      <ul style="margin:0;padding-left:0;list-style:none;font-size:12.5px">
        ${list(data.traps, "🪤")}
      </ul>
    </div>

    <div style="padding:0 16px 10px;border-top:1px solid ${cfg.border}">
      <div style="font-weight:600;font-size:12px;color:#374151;margin:10px 0 6px;text-transform:uppercase;letter-spacing:.04em">
        📡 Permissions Taken
      </div>
      <ul style="margin:0;padding-left:0;list-style:none;font-size:12.5px">
        ${list(data.permissions, "•")}
      </ul>
    </div>

    <div style="padding:0 16px 10px;border-top:1px solid ${cfg.border}">
      <div style="font-weight:600;font-size:12px;color:#374151;margin:10px 0 6px;text-transform:uppercase;letter-spacing:.04em">
        💰 Hidden Fees
      </div>
      <ul style="margin:0;padding-left:0;list-style:none;font-size:12.5px">
        ${list(data.hidden_fees, "•")}
      </ul>
    </div>

    <div style="padding:8px 16px 12px;border-top:1px solid ${cfg.border};display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:11.5px;display:flex;align-items:center;gap:5px">
        <span style="font-size:13px">${data.arbitration === "present" ? "⚖️" : "✅"}</span>
        <span style="color:${data.arbitration === "present" ? "#991b1b" : "#166534"};font-weight:500">
          Arbitration: ${data.arbitration === "present" ? "PRESENT" : "Not detected"}
        </span>
      </div>
      <div style="font-size:10.5px;color:#9ca3af">Powered by Guardian</div>
    </div>
  `;

  // Position near accept button if found
  const acceptBtn = findAcceptButton();
  if (acceptBtn) {
    const rect = acceptBtn.getBoundingClientRect();
    if (rect.top > 200) {
      overlay.style.bottom = "auto";
      overlay.style.top    = `${Math.max(rect.top - 20, 60)}px`;
    }
  }

  document.body.appendChild(overlay);

  document.getElementById("guardian-close").addEventListener("click", () => {
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 300);
  });

  // Fade in
  overlay.style.opacity = "0";
  requestAnimationFrame(() => { overlay.style.opacity = "1"; });
}

function renderError(msg) {
  document.getElementById("guardian-overlay")?.remove();
  const div = document.createElement("div");
  div.id = "guardian-overlay";
  div.style.cssText = `
    position:fixed;bottom:24px;right:24px;width:300px;z-index:2147483647;
    background:#fef2f2;border:1.5px solid #fca5a5;border-radius:12px;
    padding:14px 16px;font-family:-apple-system,sans-serif;font-size:13px;
    color:#991b1b;box-shadow:0 4px 16px rgba(0,0,0,0.12);
  `;
  div.innerHTML = `<strong>Guardian Error</strong><br><span style="font-size:12px">${escHtml(msg)}</span>
    <button onclick="this.parentNode.remove()" style="float:right;background:none;border:none;cursor:pointer;color:#991b1b;font-size:16px;margin-top:-4px">✕</button>`;
  document.body.appendChild(div);
}

function renderLoading() {
  document.getElementById("guardian-overlay")?.remove();
  const div = document.createElement("div");
  div.id = "guardian-overlay";
  div.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:2147483647;
    background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;
    padding:12px 16px;font-family:-apple-system,sans-serif;font-size:13px;
    color:#374151;box-shadow:0 4px 16px rgba(0,0,0,0.10);
    display:flex;align-items:center;gap:10px;
  `;
  div.innerHTML = `
    <div style="width:16px;height:16px;border:2px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:guardian-spin 0.8s linear infinite"></div>
    <span>Guardian is analyzing this page…</span>
    <style>@keyframes guardian-spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(div);
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── MESSAGE TO SERVICE WORKER ────────────────────────────────────────────────

function sendToServiceWorker(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────

async function main() {
  // ── STEP 1: sessionStorage guard (per tab session) ──────────────────────────
  if (sessionStorage.getItem(GUARDIAN_SESSION_KEY)) return;

  // ── STEP 2: Wait for page to fully settle ───────────────────────────────────
  await sleep(STARTUP_DELAY_MS);

  // ── STEP 3: chrome.storage.local — normalized URL check ─────────────────────
  const normUrl = normalizeUrl(window.location.href);
  const storageRes = await sendToServiceWorker("CHECK_URL", { url: normUrl });
  if (storageRes?.found) {
    // Previously analyzed — re-show cached result silently if stored
    if (storageRes.result) {
      renderOverlay(storageRes.result, true);
    }
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 4: Is this a T&C page? ─────────────────────────────────────────────
  if (!isTCPage()) {
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 5: Scrape text ──────────────────────────────────────────────────────
  const rawText = scrapePageText();
  if (!rawText || rawText.length < 500) {
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 6: Rule-based extraction (Stage 0) ──────────────────────────────────
  const filtered = stage0_extract(rawText);
  if (!filtered || filtered.length < 100) {
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 7: Compression (Stage 1) ────────────────────────────────────────────
  const compressed = stage1_compress(filtered);

  // ── STEP 8: Compute hash + check local session cache ─────────────────────────
  const hash = await sha256(compressed);
  const cachedRes = await sendToServiceWorker("CHECK_HASH", { hash });
  if (cachedRes?.result) {
    renderOverlay(cachedRes.result, true);
    await sendToServiceWorker("SAVE_URL", { url: normUrl, result: cachedRes.result });
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 9: AI gate check (Stage 2) ──────────────────────────────────────────
  const needsAI = stage2_needsAI(compressed);
  if (!needsAI) {
    const safeResult = {
      risk_level: "GREEN",
      traps: [],
      permissions: [],
      hidden_fees: [],
      arbitration: "not_present",
      summary: "No high-risk clauses detected by rule-based analysis.",
    };
    renderOverlay(safeResult, false);
    await sendToServiceWorker("SAVE_URL", { url: normUrl, result: safeResult });
    await sendToServiceWorker("SAVE_HASH", { hash, result: safeResult });
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 10: Call backend via service worker (Stage 3) ───────────────────────
  renderLoading();
  let result;
  try {
    const res = await sendToServiceWorker("ANALYZE", { compressed, hash });
    result = res.result;
  } catch (err) {
    renderError(`Analysis failed: ${err.message}`);
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // ── STEP 11: Render UI ────────────────────────────────────────────────────────
  renderOverlay(result, false);

  // ── STEP 12: Persist to chrome.storage.local + hash cache ────────────────────
  await sendToServiceWorker("SAVE_URL",  { url: normUrl, result });
  await sendToServiceWorker("SAVE_HASH", { hash, result });

  // ── STEP 13: Mark session as done ────────────────────────────────────────────
  sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
}

main().catch(err => {
  // Silently swallow non-critical errors so we don't pollute the page console
  if (!err.message?.includes("Already ran")) {
    console.warn("[Guardian]", err.message);
  }
});
