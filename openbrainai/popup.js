/* ==========================================================================
   OpenBrainAI — popup.js
   Settings screen: save the user's Anthropic API key to chrome.storage.local
   under "anthropicApiKey", which background.js reads before every API call.
   ========================================================================== */

const input = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

// Pre-fill with the stored key, if any, so it's clear a key is already saved.
chrome.storage.local.get("anthropicApiKey", ({ anthropicApiKey }) => {
  if (anthropicApiKey) input.value = anthropicApiKey;
});

function save() {
  const key = input.value.trim();
  if (!key) {
    status.textContent = "Enter a key before saving.";
    status.classList.add("error");
    return;
  }
  chrome.storage.local.set({ anthropicApiKey: key }, () => {
    status.classList.remove("error");
    status.textContent = "Saved ✓";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
}

saveBtn.addEventListener("click", save);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") save();
});
