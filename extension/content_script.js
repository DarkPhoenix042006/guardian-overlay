/**
 * GUARDIAN OVERLAY — content_script.js v2.0
 *
 * Features:
 *   1. Blocked domain skip (search engines, social media, etc.)
 *   2. Auto-scan toggle (respects user setting)
 *   3. Warning banner on signup pages with linked T&C
 *   4. History — shows cached result if same page visited again
 *   5. Full 3-stage pipeline
 *   6. Right-click analyze support via message listener
 */

"use strict";

// ─── DOUBLE INJECTION GUARD ───────────────────────────────────────────────────
if (window.__GUARDIAN_LOADED__) {
  throw new Error("[Guardian] Already loaded.");
}
window.__GUARDIAN_LOADED__ = true;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
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

// Patterns that suggest a signup/checkout page with linked T&C
const SIGNUP_PATTERNS = [
  /sign.?up/i, /register/i, /create.?account/i,
  /get.?started/i, /join.?now/i, /checkout/i,
  /subscribe/i, /start.?free/i,
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
  "location","termination","governing law",
];

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function normalizeUrl(href) {
  try {
    const u = new URL(href);
    return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch { return href.trim().toLowerCase(); }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escHtml(str) {
  return String(str || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function sendToSW(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (res?.error)          reject(new Error(res.error));
      else                          resolve(res);
    });
  });
}

// ─── PAGE ANALYSIS HELPERS ────────────────────────────────────────────────────

function isTCPage() {
  const url   = window.location.href;
  const title = document.title;
  const h1    = document.querySelector("h1")?.textContent || "";
  if (TC_URL_PATTERNS.some(rx  => rx.test(url)))   return true;
  if (TC_TITLE_PATTERNS.some(rx => rx.test(title))) return true;
  if (TC_TITLE_PATTERNS.some(rx => rx.test(h1)))    return true;
  const bodyText = (document.body?.innerText || "").toLowerCase();
  const hits = KEYWORDS.filter(kw => bodyText.includes(kw.toLowerCase()));
  return hits.length >= 8;
}

function isSignupPage() {
  const text = (document.body?.innerText || "") + document.title;
  return SIGNUP_PATTERNS.some(rx => rx.test(text));
}

function findLinkedTC() {
  // Find <a> tags that look like T&C links
  const links = [...document.querySelectorAll("a[href]")];
  return links.find(a => {
    const txt  = (a.textContent || "").toLowerCase().trim();
    const href = (a.getAttribute("href") || "").toLowerCase();
    return (
      TC_TITLE_PATTERNS.some(rx => rx.test(txt)) ||
      TC_URL_PATTERNS.some(rx   => rx.test(href))
    );
  });
}

function findAcceptButton() {
  const rx = /^(i\s+)?(accept|agree|i understand|got it|ok|continue)/i;
  return [...document.querySelectorAll("button,input[type=button],input[type=submit],a[role=button]")]
    .find(el => rx.test((el.textContent || el.value || "").trim()));
}

function scrapePageText() {
  const noise = ["script","style","nav","header","footer","noscript","iframe","svg"];
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(noise.join(",")).forEach(n => n.remove());
  return clone.innerText || clone.textContent || "";
}

// ─── PIPELINE ─────────────────────────────────────────────────────────────────

function stage0_extract(rawText) {
  const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const matchedIdx = new Set();
  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    if (KEYWORDS.some(kw => low.includes(kw.toLowerCase()))) {
      if (i > 0)               matchedIdx.add(i - 1);
      matchedIdx.add(i);
      if (i < lines.length-1)  matchedIdx.add(i + 1);
    }
  });
  const seen = new Set();
  return [...matchedIdx].sort((a,b) => a-b).map(i => lines[i])
    .filter(l => {
      const k = l.toLowerCase().replace(/\s+/g," ").slice(0,80);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).join("\n");
}

function stage1_compress(filtered) {
  let text = filtered;
  REDUNDANT_RX.forEach(rx => { text = text.replace(rx, ""); });
  text = text.replace(CITATION_RX, "");
  text = text.split(/\n+/).map(l => l.trim()).filter(l => l.length >= 40).join("\n");
  return text.replace(/[ \t]{2,}/g," ").replace(/\n{3,}/g,"\n\n").slice(0,8000);
}

function stage2_needsAI(compressed) {
  const low = compressed.toLowerCase();
  return AI_TRIGGERS.some(t => low.includes(t));
}

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────

const RISK_CFG = {
  GREEN:  { emoji:"🟢", label:"Low Risk",    bg:"#f0fdf4", border:"#86efac", heading:"#166534", light:"#dcfce7" },
  YELLOW: { emoji:"🟡", label:"Medium Risk", bg:"#fffbeb", border:"#fcd34d", heading:"#92400e", light:"#fef9c3" },
  RED:    { emoji:"🔴", label:"High Risk",   bg:"#fef2f2", border:"#fca5a5", heading:"#991b1b", light:"#fee2e2" },
};

function removeOverlay() {
  document.getElementById("guardian-overlay")?.remove();
  document.getElementById("guardian-banner")?.remove();
}

function renderLoading() {
  removeOverlay();
  const div = document.createElement("div");
  div.id = "guardian-overlay";
  div.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:2147483647;
    background:#1e1e2e;border:1.5px solid #333355;border-radius:14px;
    padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:13px;color:#e2e8f0;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    display:flex;align-items:center;gap:12px;
  `;
  div.innerHTML = `
    <div style="width:18px;height:18px;border:2px solid #333355;border-top-color:#6366f1;
      border-radius:50%;animation:guardian-spin 0.8s linear infinite;flex-shrink:0"></div>
    <div>
      <div style="font-weight:600;font-size:13px">Guardian is analyzing…</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:2px">Reading the fine print for you 🚦</div>
    </div>
    <style>@keyframes guardian-spin{to{transform:rotate(360deg)}}</style>
  `;
  document.body.appendChild(div);
}

function renderOverlay(data, cached) {
  removeOverlay();
  const cfg = RISK_CFG[data.risk_level] || RISK_CFG.GREEN;

  const listItems = (arr, icon) =>
    arr?.length
      ? arr.map(item => `
          <li style="display:flex;gap:8px;align-items:flex-start;
            background:#ffffff18;border-radius:8px;padding:7px 10px;margin-bottom:5px">
            <span style="flex-shrink:0;margin-top:1px">${icon}</span>
            <span style="line-height:1.45;font-size:12.5px">${escHtml(item)}</span>
          </li>`).join("")
      : `<li style="font-size:12px;color:#94a3b8;font-style:italic;padding:4px 0">None detected</li>`;

  const overlay = document.createElement("div");
  overlay.id = "guardian-overlay";

  const acceptBtn = findAcceptButton();
  let posStyle = "bottom:24px;right:24px;";
  if (acceptBtn) {
    const rect = acceptBtn.getBoundingClientRect();
    if (rect.top > 300) posStyle = `top:${Math.max(rect.top - 10, 80)}px;right:24px;`;
  }

  overlay.style.cssText = `
    position:fixed;${posStyle}
    width:320px;max-height:82vh;overflow-y:auto;
    z-index:2147483647;
    background:#1e1e2e;
    border:1.5px solid ${cfg.border};
    border-radius:16px;
    box-shadow:0 8px 40px rgba(0,0,0,0.45),0 0 0 1px rgba(255,255,255,0.05);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:13px;color:#e2e8f0;
    opacity:0;transition:opacity 0.3s ease,transform 0.3s ease;
    transform:translateY(10px);
  `;

  overlay.innerHTML = `
    <!-- Header -->
    <div style="padding:13px 15px 11px;border-bottom:1px solid #ffffff12;
      display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div style="display:flex;align-items:center;gap:9px;">
        <span style="font-size:24px;line-height:1" aria-hidden="true">${cfg.emoji}</span>
        <div>
          <div style="font-weight:700;font-size:14px;color:${cfg.border}">
            ${escHtml(cfg.label)}
            ${cached ? '<span style="font-size:10px;background:#1d4ed8;color:#bfdbfe;padding:2px 7px;border-radius:5px;margin-left:5px;font-weight:500">CACHED</span>' : ""}
          </div>
          <div style="font-size:11px;color:#64748b;margin-top:1px">🚦 Guardian T&amp;C Analysis</div>
        </div>
      </div>
      <button id="guardian-close" aria-label="Close" style="
        background:#ffffff12;border:none;cursor:pointer;
        width:26px;height:26px;border-radius:8px;
        color:#94a3b8;font-size:15px;display:flex;
        align-items:center;justify-content:center;flex-shrink:0;
        transition:background 0.15s;">✕</button>
    </div>

    <!-- Summary -->
    ${data.summary ? `
    <div style="padding:10px 15px 0;">
      <p style="font-size:12.5px;color:#cbd5e1;line-height:1.55;margin:0;
        background:#ffffff08;border-radius:8px;padding:8px 10px;border-left:3px solid ${cfg.border}">
        ${escHtml(data.summary)}
      </p>
    </div>` : ""}

    <!-- Arbitration badge -->
    <div style="padding:10px 15px 0;display:flex;gap:8px;flex-wrap:wrap;">
      <span style="font-size:11.5px;padding:4px 10px;border-radius:20px;font-weight:500;
        background:${data.arbitration === "present" ? "#450a0a" : "#052e16"};
        color:${data.arbitration === "present" ? "#fca5a5" : "#86efac"};
        border:1px solid ${data.arbitration === "present" ? "#991b1b" : "#166534"}">
        ${data.arbitration === "present" ? "⚖️ Arbitration: PRESENT" : "✅ No Arbitration Found"}
      </span>
    </div>

    <!-- Traps -->
    <div style="padding:12px 15px 0;">
      <div style="font-size:11px;font-weight:600;color:#94a3b8;
        text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px">
        ⚠️ Top Traps
      </div>
      <ul style="margin:0;padding:0;list-style:none;color:#fca5a5">
        ${listItems(data.traps, "🪤")}
      </ul>
    </div>

    <!-- Permissions -->
    <div style="padding:10px 15px 0;">
      <div style="font-size:11px;font-weight:600;color:#94a3b8;
        text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px">
        📡 Permissions Taken
      </div>
      <ul style="margin:0;padding:0;list-style:none;color:#fcd34d">
        ${listItems(data.permissions, "•")}
      </ul>
    </div>

    <!-- Hidden Fees -->
    <div style="padding:10px 15px 12px;">
      <div style="font-size:11px;font-weight:600;color:#94a3b8;
        text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px">
        💰 Hidden Fees
      </div>
      <ul style="margin:0;padding:0;list-style:none;color:#fcd34d">
        ${listItems(data.hidden_fees, "•")}
      </ul>
    </div>

    <!-- Footer -->
    <div style="padding:9px 15px;border-top:1px solid #ffffff10;
      display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:10.5px;color:#475569">Powered by Guardian 🚦</span>
      <span style="font-size:10.5px;color:#475569">${new Date().toLocaleTimeString()}</span>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById("guardian-close").addEventListener("click", () => {
    overlay.style.opacity = "0";
    overlay.style.transform = "translateY(10px)";
    setTimeout(() => overlay.remove(), 300);
  });

  requestAnimationFrame(() => {
    overlay.style.opacity = "1";
    overlay.style.transform = "translateY(0)";
  });
}

function renderError(msg) {
  removeOverlay();
  const div = document.createElement("div");
  div.id = "guardian-overlay";
  div.style.cssText = `
    position:fixed;bottom:24px;right:24px;width:290px;z-index:2147483647;
    background:#1e1e2e;border:1.5px solid #991b1b;border-radius:14px;
    padding:13px 15px;font-family:-apple-system,sans-serif;font-size:13px;
    color:#fca5a5;box-shadow:0 8px 32px rgba(0,0,0,0.4);
    display:flex;gap:10px;align-items:flex-start;
  `;
  div.innerHTML = `
    <span style="font-size:18px;flex-shrink:0">⚠️</span>
    <div style="flex:1">
      <div style="font-weight:600;margin-bottom:3px">Guardian Error</div>
      <div style="font-size:12px;color:#94a3b8">${escHtml(msg)}</div>
    </div>
    <button onclick="this.closest('#guardian-overlay').remove()" style="
      background:none;border:none;cursor:pointer;color:#64748b;
      font-size:16px;flex-shrink:0;padding:0;line-height:1">✕</button>
  `;
  document.body.appendChild(div);
}

// ─── WARNING BANNER (signup pages with linked T&C) ────────────────────────────

function renderWarningBanner(tcLink) {
  if (document.getElementById("guardian-banner")) return;

  const banner = document.createElement("div");
  banner.id = "guardian-banner";
  banner.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:2147483646;
    background:#1e1e2e;border-top:2px solid #f59e0b;
    padding:12px 20px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:13px;color:#e2e8f0;
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    box-shadow:0 -4px 20px rgba(0,0,0,0.4);
  `;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex:1">
      <span style="font-size:20px;flex-shrink:0">⚠️</span>
      <div>
        <div style="font-weight:600;color:#fcd34d;font-size:13px">
          T&amp;C linked but not read
        </div>
        <div style="font-size:12px;color:#94a3b8;margin-top:2px">
          You're about to accept terms you haven't reviewed. Guardian can analyze them for you.
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button id="guardian-banner-analyze" style="
        background:#6366f1;color:white;border:none;
        padding:7px 14px;border-radius:8px;font-size:12.5px;
        font-weight:600;cursor:pointer;white-space:nowrap;
        transition:background 0.15s;">
        🔍 Analyze T&amp;C
      </button>
      <button id="guardian-banner-close" style="
        background:#ffffff12;color:#94a3b8;border:none;
        padding:7px 10px;border-radius:8px;font-size:12px;
        cursor:pointer;transition:background 0.15s;">
        Dismiss
      </button>
    </div>
  `;

  document.body.appendChild(banner);

  document.getElementById("guardian-banner-close").addEventListener("click", () => {
    banner.remove();
  });

  document.getElementById("guardian-banner-analyze").addEventListener("click", async () => {
    banner.remove();
    const href = tcLink.getAttribute("href");
    const fullUrl = href.startsWith("http") ? href : new URL(href, window.location.origin).href;
    await analyzeExternalUrl(fullUrl);
  });
}

// ─── ANALYZE EXTERNAL URL (for banner + context menu) ────────────────────────

async function analyzeExternalUrl(url) {
  renderLoading();
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`Could not fetch linked page (${res.status})`);
    const html = await res.text();
    // Strip HTML tags
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    ["script","style","nav","header","footer"].forEach(t =>
      tmp.querySelectorAll(t).forEach(n => n.remove())
    );
    const rawText = tmp.innerText || tmp.textContent || "";
    if (rawText.length < 200) throw new Error("Page content too short to analyze");
    await runPipeline(rawText, url, url);
  } catch (err) {
    renderError(`Could not fetch that page: ${err.message}. Try visiting it directly.`);
  }
}

// ─── CORE PIPELINE ────────────────────────────────────────────────────────────

async function runPipeline(rawText, normUrl, pageTitle) {
  const filtered   = stage0_extract(rawText);
  if (!filtered || filtered.length < 100) {
    renderError("Not enough T&C content found on this page.");
    return;
  }
  const compressed = stage1_compress(filtered);
  const hash       = await sha256(compressed);

  // Hash cache check
  const cachedHash = await sendToSW("CHECK_HASH", { hash });
  if (cachedHash?.result) {
    renderOverlay(cachedHash.result, true);
    await sendToSW("SAVE_URL", { url: normUrl, result: cachedHash.result, title: pageTitle });
    return;
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
    renderOverlay(result, false);
    await sendToSW("SAVE_URL",  { url: normUrl, result, title: pageTitle });
    await sendToSW("SAVE_HASH", { hash, result });
    return;
  }

  // LLM call
  const res = await sendToSW("ANALYZE", { compressed, hash });
  renderOverlay(res.result, res.cached || false);
  await sendToSW("SAVE_URL",  { url: normUrl, result: res.result, title: pageTitle });
  await sendToSW("SAVE_HASH", { hash, result: res.result });
}

// ─── CONTEXT MENU LISTENER ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "GUARDIAN_ANALYZE_URL") {
    analyzeExternalUrl(message.payload.url);
  }
});

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  // Session guard
  if (sessionStorage.getItem(GUARDIAN_SESSION_KEY)) return;

  // Check if domain is blocked
  const blockCheck = await sendToSW("CHECK_BLOCKED", { url: window.location.href });
  if (blockCheck?.blocked) return;

  // Check auto-scan setting
  const settings = await sendToSW("GET_SETTINGS", {});
  if (!settings?.autoScan) return; // User turned off auto-scan

  // Startup delay
  await sleep(STARTUP_DELAY_MS);

  const normUrl   = normalizeUrl(window.location.href);
  const pageTitle = document.title || normUrl;

  // URL cache check — show history result instantly
  const urlCache = await sendToSW("CHECK_URL", { url: normUrl });
  if (urlCache?.found) {
    renderOverlay(urlCache.result, true);
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // Is this a T&C page?
  if (isTCPage()) {
    const rawText = scrapePageText();
    if (!rawText || rawText.length < 500) {
      sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
      return;
    }
    renderLoading();
    try {
      await runPipeline(rawText, normUrl, pageTitle);
    } catch (err) {
      renderError(`Analysis failed: ${err.message}`);
    }
    sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
    return;
  }

  // Is this a signup page with a linked T&C?
  if (isSignupPage()) {
    const tcLink = findLinkedTC();
    if (tcLink) {
      // Small extra delay so page fully renders
      await sleep(1000);
      renderWarningBanner(tcLink);
    }
  }

  sessionStorage.setItem(GUARDIAN_SESSION_KEY, "1");
}

main().catch(err => {
  if (!err.message?.includes("Already loaded")) {
    console.warn("[Guardian]", err.message);
  }
});
