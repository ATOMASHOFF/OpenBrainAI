/* ============================================================================
   OpenBrainAI — popup.js
   Settings UI state machine for empty/saved key flows.
   ============================================================================ */

const emptyStateEl = document.getElementById("emptyState");
const savedStateEl = document.getElementById("savedState");

const input = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");

const maskedKeyEl = document.getElementById("maskedKey");
const changeBtn = document.getElementById("changeBtn");
const savedStatus = document.getElementById("savedStatus");

const CHECK_ICON =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function maskKey(key) {
  if (!key) return "";
  const trimmed = key.trim();
  const prefix = trimmed.slice(0, Math.min(7, trimmed.length));
  const suffix = trimmed.length > 4 ? trimmed.slice(-4) : "";
  const dots = "•".repeat(Math.max(8, trimmed.length - prefix.length - suffix.length));
  return suffix ? `${prefix}${dots}${suffix}` : `${prefix}${dots}`;
}

function showEmptyState() {
  savedStateEl.hidden = true;
  emptyStateEl.hidden = false;
  input.focus();
}

function showSavedState(key, savedLabel) {
  emptyStateEl.hidden = true;
  savedStateEl.hidden = false;
  maskedKeyEl.textContent = maskKey(key);
  if (savedLabel) {
    savedStatus.classList.remove("error");
    savedStatus.innerHTML = `${CHECK_ICON}<span>${savedLabel}</span>`;
    setTimeout(() => {
      savedStatus.textContent = "";
    }, 2000);
  }
}

function setError(targetEl, message) {
  targetEl.classList.add("error");
  targetEl.textContent = message;
}

function clearStatus(targetEl) {
  targetEl.classList.remove("error");
  targetEl.textContent = "";
}

function save() {
  const key = input.value.trim();
  if (!key) {
    setError(status, "Enter a key before saving.");
    return;
  }

  chrome.storage.local.set({ anthropicApiKey: key }, () => {
    if (chrome.runtime.lastError) {
      setError(status, "Couldn't save key — try again.");
      return;
    }

    clearStatus(status);
    showSavedState(key, "Saved");
  });
}

chrome.storage.local.get("anthropicApiKey", ({ anthropicApiKey }) => {
  if (anthropicApiKey && anthropicApiKey.trim()) {
    showSavedState(anthropicApiKey);
  } else {
    showEmptyState();
  }
});

saveBtn.addEventListener("click", save);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") save();
});

changeBtn.addEventListener("click", () => {
  clearStatus(savedStatus);
  input.value = "";
  showEmptyState();
});
