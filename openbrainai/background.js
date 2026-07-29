/* ==========================================================================
   OpenBrainAI — background.js (service worker)
   The only place that touches privileged extension APIs: capturing the
   visible tab and calling the Claude API. content.js talks to this file
   via chrome.runtime.sendMessage.
   ========================================================================== */

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
// Swap this for another model id (e.g. "claude-sonnet-5") if you'd rather
// use a different model — see https://docs.claude.com for current model IDs.
const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MAX_TOKENS = 1000;
const CLAUDE_API_VERSION = "2023-06-01";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "OBAI_CAPTURE_SCREENSHOT") {
    captureVisibleTab().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message.type === "OBAI_CALL_CLAUDE") {
    callClaude(message.dataUrl, message.prompt).then(sendResponse);
    return true;
  }

  return false;
});

/**
 * Captures the currently visible tab as a PNG data URL.
 * Only grabs the visible viewport, not the full scrollable page — that's
 * a known v1 limitation, not a bug.
 */
function captureVisibleTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message || "Could not capture the screen.",
        });
        return;
      }
      resolve({ ok: true, dataUrl });
    });
  });
}

/**
 * Sends an image + prompt to the Claude API and returns the text answer.
 * @param {string} dataUrl - a "data:image/png;base64,...." string
 * @param {string} prompt - the user's question (or a default description prompt)
 */
async function callClaude(dataUrl, prompt) {
  if (!dataUrl) {
    return { ok: false, error: "No screenshot to analyze." };
  }

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return { ok: false, error: "Captured image was in an unexpected format." };
  }
  const [, mediaType, base64Data] = match;

  const stored = await chrome.storage.local.get("anthropicApiKey");
  const apiKey = stored.anthropicApiKey;
  if (!apiKey) {
    return { ok: false, error: "Add your Anthropic API key in the extension settings." };
  }

  const requestBody = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
          { type: "text", text: (prompt && prompt.trim()) || "Describe what is shown in this image." },
        ],
      },
    ],
  };

  let response;
  try {
    response = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": CLAUDE_API_VERSION,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (networkErr) {
    return { ok: false, error: "Network error reaching the Claude API. Check your connection." };
  }

  let body;
  try {
    body = await response.json();
  } catch (parseErr) {
    return { ok: false, error: "Received an unreadable response from the Claude API." };
  }

  if (!response.ok) {
    const apiMessage = body && body.error && body.error.message;
    return { ok: false, error: apiMessage || `Claude API request failed (status ${response.status}).` };
  }

  const textBlock = Array.isArray(body.content) ? body.content.find((b) => b.type === "text") : null;
  return { ok: true, text: (textBlock && textBlock.text) || "(Claude returned no text.)" };
}
