/**
 * GUARDIAN OVERLAY — service_worker.js
 *
 * All external API calls live here, not in the content script.
 * This bypasses host-page CSP restrictions completely.
 *
 * Storage layout (chrome.storage.local):
 *   guardian_url:<normalizedUrl>  → { result, timestamp }
 *   guardian_hash:<sha256>        → { result, timestamp }
 *
 * Message types handled:
 *   CHECK_URL   → checks if URL was previously analyzed
 *   CHECK_HASH  → checks hash cache
 *   SAVE_URL    → persists URL → result
 *   SAVE_HASH   → persists hash → result
 *   ANALYZE     → calls backend API, returns result
 *   GET_STATS   → returns storage stats for popup
 */

"use strict";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

// Replace with your deployed backend URL.
// For local dev: "http://localhost:3000/analyze"
const BACKEND_URL = "https://your-guardian-backend.vercel.app/analyze";

// Cache TTL: 7 days. After this, re-analyze even for known URLs.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── STORAGE HELPERS ──────────────────────────────────────────────────────────

function urlKey(url)   { return `guardian_url:${url}`; }
function hashKey(hash) { return `guardian_hash:${hash}`; }

async function storageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, data => resolve(data[key] ?? null));
  });
}

async function storageSet(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

async function storageGetAll() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, data => resolve(data));
  });
}

function isExpired(entry) {
  if (!entry?.timestamp) return true;
  return Date.now() - entry.timestamp > CACHE_TTL_MS;
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

  // Validate expected shape
  if (!data.risk_level || !["GREEN", "YELLOW", "RED"].includes(data.risk_level)) {
    throw new Error("Invalid response from backend: missing or invalid risk_level");
  }

  return data;
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Must return true to keep channel open for async responses
  handleMessage(message, sender)
    .then(result => sendResponse(result))
    .catch(err   => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {

    case "CHECK_URL": {
      const entry = await storageGet(urlKey(payload.url));
      if (!entry || isExpired(entry)) return { found: false };
      return { found: true, result: entry.result };
    }

    case "CHECK_HASH": {
      const entry = await storageGet(hashKey(payload.hash));
      if (!entry || isExpired(entry)) return { result: null };
      return { result: entry.result };
    }

    case "SAVE_URL": {
      await storageSet(urlKey(payload.url), {
        result: payload.result,
        timestamp: Date.now(),
      });
      return { ok: true };
    }

    case "SAVE_HASH": {
      await storageSet(hashKey(payload.hash), {
        result: payload.result,
        timestamp: Date.now(),
      });
      return { ok: true };
    }

    case "ANALYZE": {
      const { compressed, hash } = payload;

      // Double-check hash cache before making API call
      // (race condition guard: two tabs open the same page simultaneously)
      const existing = await storageGet(hashKey(hash));
      if (existing && !isExpired(existing)) {
        return { result: existing.result, cached: true };
      }

      const result = await callBackend(compressed);
      return { result, cached: false };
    }

    case "GET_STATS": {
      const all = await storageGetAll();
      const keys = Object.keys(all);
      const urlEntries  = keys.filter(k => k.startsWith("guardian_url:"));
      const hashEntries = keys.filter(k => k.startsWith("guardian_hash:"));
      return {
        urlCount:  urlEntries.length,
        hashCount: hashEntries.length,
        totalKeys: keys.length,
      };
    }

    case "CLEAR_CACHE": {
      const all = await storageGetAll();
      const guardianKeys = Object.keys(all).filter(k => k.startsWith("guardian_"));
      await new Promise(resolve => chrome.storage.local.remove(guardianKeys, resolve));
      return { cleared: guardianKeys.length };
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ─── INSTALL HOOK ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[Guardian] Installed successfully.");
  }
});
