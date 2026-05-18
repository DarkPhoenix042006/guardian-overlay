"use strict";

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function msg(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function toast(text, isError = false) {
  const el = document.getElementById("toast");
  el.style.display = "block";
  el.style.color = isError ? "#fca5a5" : "#86efac";
  el.style.background = isError ? "#1a0a0a" : "#052e16";
  el.textContent = text;
  setTimeout(() => { el.style.display = "none"; }, 2500);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

const RISK_EMOJI = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" };

// ─── TABS ─────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "history") loadHistory();
  });
});

// ─── LOAD STATS ───────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const stats = await msg("GET_STATS");
    document.getElementById("stat-urls").textContent    = stats.urlCount  ?? "0";
    document.getElementById("stat-history").textContent = stats.history   ?? "0";
  } catch {
    document.getElementById("stat-urls").textContent    = "?";
    document.getElementById("stat-history").textContent = "?";
  }
}

// ─── LOAD HISTORY ─────────────────────────────────────────────────────────────

async function loadHistory() {
  const container = document.getElementById("history-list");
  try {
    const { history } = await msg("GET_HISTORY");
    if (!history || history.length === 0) {
      container.innerHTML = `<div class="history-empty">No history yet.<br>Visit a T&C page to get started.</div>`;
      return;
    }
    container.innerHTML = history.map(h => `
      <div class="history-item">
        <div class="history-badge">${RISK_EMOJI[h.risk_level] || "⚪"}</div>
        <div style="flex:1;min-width:0">
          <div class="history-title">${escHtml(h.title || h.url)}</div>
          <div class="history-url">${escHtml(h.url)}</div>
        </div>
        <div class="history-time">${timeAgo(h.timestamp)}</div>
      </div>
    `).join("");
  } catch {
    container.innerHTML = `<div class="history-empty" style="color:#fca5a5">Failed to load history</div>`;
  }
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ─── TOGGLE AUTO-SCAN ─────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const settings = await msg("GET_SETTINGS");
    document.getElementById("toggle-autoscan").checked = settings?.autoScan ?? true;
  } catch { /* default checked */ }
}

document.getElementById("toggle-autoscan").addEventListener("change", async (e) => {
  const autoScan = e.target.checked;
  await msg("SAVE_SETTINGS", { autoScan });
  toast(autoScan ? "✅ Auto-scan enabled" : "⏸️ Auto-scan paused — use right-click or popup to analyze manually");
});

// ─── BUTTONS ──────────────────────────────────────────────────────────────────

document.getElementById("btn-analyze").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Clear session flag so it runs again
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      sessionStorage.removeItem("guardian_ran");
      window.__GUARDIAN_LOADED__ = false;
    },
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files:  ["content_script.js"],
  });

  toast("🔍 Analysis triggered!");
  setTimeout(() => window.close(), 800);
});

document.getElementById("btn-clear-cache").addEventListener("click", async () => {
  const res = await msg("CLEAR_CACHE");
  toast(`🗑️ Cleared ${res.cleared} cached entries`);
  loadStats();
});

document.getElementById("btn-clear-history").addEventListener("click", async () => {
  await msg("CLEAR_HISTORY");
  toast("🗑️ History cleared");
  loadHistory();
  loadStats();
});

// ─── INIT ─────────────────────────────────────────────────────────────────────

loadStats();
loadSettings();
