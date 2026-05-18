/**
 * GUARDIAN OVERLAY — service_worker.js v2.0
 *
 * Handles:
 *   - All external API fetch (CSP bypass)
 *   - chrome.storage.local (URL cache, hash cache, history, settings)
 *   - Context menu "Analyze with Guardian"
 *   - Auto-scan toggle state
 *
 * Storage keys:
 *   guardian_url:<url>       → { result, timestamp, title }
 *   guardian_hash:<sha256>   → { result, timestamp }
 *   guardian_history         → [ { url, title, risk_level, timestamp } ]
 *   guardian_settings        → { autoScan: bool }
 */

"use strict";

const BACKEND_URL  = "http://localhost:3000/analyze";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_HISTORY  = 50;

// ─── BLOCKED DOMAINS (skip these entirely) ────────────────────────────────────
const BLOCKED_DOMAINS = [
  "google.com","google.co.in","google.co.uk","google.com.au",
  "bing.com","duckduckgo.com","yahoo.com","baidu.com","yandex.com",
  "youtube.com","youtu.be",
  "github.com","stackoverflow.com","reddit.com",
  "twitter.com","x.com","instagram.com","facebook.com","linkedin.com",
  "wikipedia.org","wikimedia.org",
  "amazon.com","ebay.com","etsy.com",
  "netflix.com","twitch.tv","spotify.com",
  "maps.google.com","translate.google.com",
  "chrome://","chrome-extension://","about:","moz-extension://"
];

// ─── STORAGE HELPERS ──────────────────────────────────────────────────────────

function storageGet(key) {
  return new Promise(resolve =>
    chrome.storage.local.get(key, d => resolve(d[key] ?? null))
  );
}

function storageSet(key, value) {
  return new Promise(resolve =>
    chrome.storage.local.set({ [key]: value }, resolve)
  );
}

function storageGetAll() {
  return new Promise(resolve =>
    chrome.storage.local.get(null, resolve)
  );
}

function isExpired(entry) {
  if (!entry?.timestamp) return true;
  return Date.now() - entry.timestamp > CACHE_TTL_MS;
}

function urlKey(url)   { return `guardian_url:${url}`;  }
function hashKey(hash) { return `guardian_hash:${hash}`; }

// ─── HISTORY HELPERS ──────────────────────────────────────────────────────────

async function addToHistory(url, title, risk_level) {
  let history = (await storageGet("guardian_history")) || [];
  // Remove existing entry for same URL
  history = history.filter(h => h.url !== url);
  // Add to front
  history.unshift({ url, title: title || url, risk_level, timestamp: Date.now() });
  // Cap at MAX_HISTORY
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  await storageSet("guardian_history", history);
}

// ─── SETTINGS HELPERS ─────────────────────────────────────────────────────────

async function getSettings() {
  const s = await storageGet("guardian_settings");
  return s || { autoScan: true };
}

// ─── API CALL ─────────────────────────────────────────────────────────────────

async function callBackend(compressed) {
  const response = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: compressed }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Backend ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  if (!data.risk_level || !["GREEN","YELLOW","RED"].includes(data.risk_level)) {
    throw new Error("Invalid response from backend");
  }
  return data;
}

// ─── CONTEXT MENU SETUP ───────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       "guardian-analyze-link",
      title:    "🛡️ Analyze with Guardian",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id:       "guardian-analyze-page",
      title:    "🛡️ Analyze this page with Guardian",
      contexts: ["page"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl;
  if (!url || !tab?.id) return;

  // Tell content script to fetch + analyze this URL
  chrome.tabs.sendMessage(tab.id, {
    type:    "GUARDIAN_ANALYZE_URL",
    payload: { url },
  }).catch(() => {
    // Content script may not be loaded yet — inject it
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["content_script.js"],
    });
  });
});

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(r  => sendResponse(r))
    .catch(e => sendResponse({ error: e.message }));
  return true;
});

async function handleMessage(message) {
  const { type, payload } = message;

  switch (type) {

    case "CHECK_BLOCKED": {
      try {
        const host = new URL(payload.url).hostname.replace(/^www\./, "");
        const blocked = BLOCKED_DOMAINS.some(d => host === d || host.endsWith("." + d));
        return { blocked };
      } catch { return { blocked: false }; }
    }

    case "GET_SETTINGS": {
      return getSettings();
    }

    case "SAVE_SETTINGS": {
      await storageSet("guardian_settings", payload);
      return { ok: true };
    }

    case "CHECK_URL": {
      const entry = await storageGet(urlKey(payload.url));
      if (!entry || isExpired(entry)) return { found: false };
      return { found: true, result: entry.result, title: entry.title };
    }

    case "CHECK_HASH": {
      const entry = await storageGet(hashKey(payload.hash));
      if (!entry || isExpired(entry)) return { result: null };
      return { result: entry.result };
    }

    case "SAVE_URL": {
      await storageSet(urlKey(payload.url), {
        result:    payload.result,
        title:     payload.title || payload.url,
        timestamp: Date.now(),
      });
      await addToHistory(payload.url, payload.title, payload.result.risk_level);
      return { ok: true };
    }

    case "SAVE_HASH": {
      await storageSet(hashKey(payload.hash), {
        result:    payload.result,
        timestamp: Date.now(),
      });
      return { ok: true };
    }

    case "ANALYZE": {
      const { compressed, hash } = payload;
      const existing = await storageGet(hashKey(hash));
      if (existing && !isExpired(existing)) return { result: existing.result, cached: true };
      const result = await callBackend(compressed);
      return { result, cached: false };
    }

    case "GET_HISTORY": {
      const history = (await storageGet("guardian_history")) || [];
      return { history };
    }

    case "CLEAR_HISTORY": {
      await storageSet("guardian_history", []);
      return { ok: true };
    }

    case "GET_STATS": {
      const all      = await storageGetAll();
      const keys     = Object.keys(all);
      const history  = (await storageGet("guardian_history")) || [];
      return {
        urlCount:  keys.filter(k => k.startsWith("guardian_url:")).length,
        hashCount: keys.filter(k => k.startsWith("guardian_hash:")).length,
        history:   history.length,
      };
    }

    case "CLEAR_CACHE": {
      const all  = await storageGetAll();
      const keys = Object.keys(all).filter(k => k.startsWith("guardian_"));
      await new Promise(resolve => chrome.storage.local.remove(keys, resolve));
      return { cleared: keys.length };
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ─── INSTALL / STARTUP ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
  // Set default settings on first install
  storageGet("guardian_settings").then(s => {
    if (!s) storageSet("guardian_settings", { autoScan: true });
  });
});

chrome.runtime.onStartup.addListener(setupContextMenu);
