"use strict";

function msg(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function showStatus(text, color = "#166534", bg = "#f0fdf4", border = "#bbf7d0") {
  const el = document.getElementById("status");
  el.style.display = "block";
  el.style.color = color;
  el.style.background = bg;
  el.style.borderTopColor = border;
  el.textContent = text;
  setTimeout(() => { el.style.display = "none"; }, 3000);
}

async function loadStats() {
  try {
    const stats = await msg("GET_STATS");
    document.getElementById("url-count").textContent  = stats.urlCount;
    document.getElementById("hash-count").textContent = stats.hashCount;
  } catch {
    document.getElementById("url-count").textContent  = "?";
    document.getElementById("hash-count").textContent = "?";
  }
}

document.getElementById("btn-clear").addEventListener("click", async () => {
  const res = await msg("CLEAR_CACHE");
  showStatus(`✅ Cleared ${res.cleared} cached entries`, "#166534", "#f0fdf4", "#bbf7d0");
  loadStats();
});

document.getElementById("btn-analyze").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Clear session flag then re-inject
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => sessionStorage.removeItem("guardian_ran"),
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content_script.js"],
  });

  showStatus("🔄 Re-analysis triggered…");
  window.close();
});

loadStats();
