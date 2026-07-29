/* ==========================================================================
   OpenBrainAI — content.js
   Injected into every page. Renders the floating bubble, the option panel,
   handles voice input + region selection, and shows answers from Claude.
   Talks to background.js for anything that needs extension privileges
   (screenshots, the Claude API call) since content scripts can't do those
   directly.
   ========================================================================== */

(function () {
  "use strict";

  // Guard against double-injection (defensive; shouldn't normally happen).
  if (window.__obaiInjected) return;
  window.__obaiInjected = true;

  const BUBBLE_SIZE = 48;
  const EDGE_MARGIN = 20;
  const DRAG_THRESHOLD = 4; // px of movement before a pointerdown counts as a drag, not a click
  const STORAGE_POSITION_KEY = "obaiBubblePosition";
  const DEFAULT_REGION_PROMPT = "Describe what's shown in this image in plain terms.";

  // ---- DOM refs, created lazily in init() ----
  let bubbleEl = null;
  let panelEl = null;
  let answerEl = null;
  let regionOverlayEl = null;
  let regionPromptEl = null;

  // ---- Drag state ----
  let dragState = null; // { pointerId, startX, startY, startLeft, startTop, moved }

  /* ------------------------------------------------------------------
     Icons — small inline SVGs, no external assets needed.
     ------------------------------------------------------------------ */

  const ICON_BUBBLE = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3a6 6 0 0 0-6 6c0 2 .9 3.3 1.8 4.3.6.7 1.2 1.3 1.2 2.2V17a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1.5c0-.9.6-1.5 1.2-2.2C17.1 12.3 18 11 18 9a6 6 0 0 0-6-6Z"
        stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M10 21h4M11 19h2" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

  const ICON_MIC = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.6"/>
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

  const ICON_REGION = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3"/>
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" opacity="0.8"/>
    </svg>`;

  /* ------------------------------------------------------------------
     Messaging helpers — wrap chrome.runtime.sendMessage in a promise and
     surface chrome.runtime.lastError instead of letting it go silent.
     ------------------------------------------------------------------ */

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from the extension." });
      });
    });
  }

  function requestScreenshot() {
    return sendMessage({ type: "OBAI_CAPTURE_SCREENSHOT" });
  }

  function requestClaude(dataUrl, prompt) {
    return sendMessage({ type: "OBAI_CALL_CLAUDE", dataUrl, prompt });
  }

  /* ------------------------------------------------------------------
     Step 1: the bubble — draggable, position persisted across reloads.
     ------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function defaultPosition() {
    return {
      left: window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN,
      top: window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN,
    };
  }

  function clampPosition(pos) {
    return {
      left: clamp(pos.left, 0, Math.max(0, window.innerWidth - BUBBLE_SIZE)),
      top: clamp(pos.top, 0, Math.max(0, window.innerHeight - BUBBLE_SIZE)),
    };
  }

  function loadPosition() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_POSITION_KEY, (result) => {
        const stored = result && result[STORAGE_POSITION_KEY];
        resolve(stored ? clampPosition(stored) : defaultPosition());
      });
    });
  }

  function savePosition(pos) {
    chrome.storage.local.set({ [STORAGE_POSITION_KEY]: pos });
  }

  function createBubble(initialPos) {
    const bubble = document.createElement("div");
    bubble.id = "obai-bubble";
    bubble.setAttribute("role", "button");
    bubble.setAttribute("tabindex", "0");
    bubble.setAttribute("aria-label", "Open OpenBrainAI");
    bubble.style.left = `${initialPos.left}px`;
    bubble.style.top = `${initialPos.top}px`;
    bubble.innerHTML = ICON_BUBBLE;

    bubble.addEventListener("pointerdown", onBubblePointerDown);
    bubble.addEventListener("keydown", (e) => {
      // Keyboard users: Enter/Space opens the panel, same as a click.
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePanel();
      }
    });

    document.documentElement.appendChild(bubble);
    // Reveal on the next frame so the fade-in transition actually runs
    // (the position above is already correct, so there's no visible jump).
    requestAnimationFrame(() => bubble.classList.add("obai-ready"));
    return bubble;
  }

  function onBubblePointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // left click / primary touch only
    const rect = bubbleEl.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
    };
    bubbleEl.setPointerCapture(e.pointerId);
    bubbleEl.classList.add("obai-dragging");
    bubbleEl.addEventListener("pointermove", onBubblePointerMove);
    bubbleEl.addEventListener("pointerup", onBubblePointerUp);
    bubbleEl.addEventListener("pointercancel", onBubblePointerUp);
  }

  function onBubblePointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      dragState.moved = true;
      closePanel(); // dragging while a panel is open would look broken — close it
    }
    if (!dragState.moved) return;
    const next = clampPosition({
      left: dragState.startLeft + dx,
      top: dragState.startTop + dy,
    });
    bubbleEl.style.left = `${next.left}px`;
    bubbleEl.style.top = `${next.top}px`;
  }

  function onBubblePointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    bubbleEl.releasePointerCapture(e.pointerId);
    bubbleEl.classList.remove("obai-dragging");
    bubbleEl.removeEventListener("pointermove", onBubblePointerMove);
    bubbleEl.removeEventListener("pointerup", onBubblePointerUp);
    bubbleEl.removeEventListener("pointercancel", onBubblePointerUp);

    const wasDrag = dragState.moved;
    if (wasDrag) {
      const rect = bubbleEl.getBoundingClientRect();
      savePosition({ left: rect.left, top: rect.top });
    }
    dragState = null;

    if (!wasDrag) {
      togglePanel();
    }
  }

  // Keep the bubble on-screen if the window is resized smaller.
  window.addEventListener("resize", () => {
    if (!bubbleEl) return;
    const rect = bubbleEl.getBoundingClientRect();
    const next = clampPosition({ left: rect.left, top: rect.top });
    bubbleEl.style.left = `${next.left}px`;
    bubbleEl.style.top = `${next.top}px`;
  });

  /* ------------------------------------------------------------------
     Positioning helper shared by the option panel, answer card, and
     region prompt: anchor near the bubble without running off-screen.
     ------------------------------------------------------------------ */

  function positionNearBubble(el, opts) {
    const gap = 10;
    const bubbleRect = bubbleEl.getBoundingClientRect();
    const elWidth = el.offsetWidth || (opts && opts.fallbackWidth) || 280;
    const elHeight = el.offsetHeight || 160;

    const bubbleCenterX = bubbleRect.left + bubbleRect.width / 2;
    const opensAbove = bubbleRect.top > window.innerHeight / 2;
    const alignRight = bubbleCenterX > window.innerWidth / 2;

    let top = opensAbove ? bubbleRect.top - elHeight - gap : bubbleRect.bottom + gap;
    let left = alignRight ? bubbleRect.right - elWidth : bubbleRect.left;

    top = clamp(top, EDGE_MARGIN, window.innerHeight - elHeight - EDGE_MARGIN);
    left = clamp(left, EDGE_MARGIN, window.innerWidth - elWidth - EDGE_MARGIN);

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  /* ------------------------------------------------------------------
     Step 2 (option panel) — mic + region-select buttons.
     ------------------------------------------------------------------ */

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "obai-panel";
    panel.innerHTML = `
      <button type="button" class="obai-option-btn" id="obai-mic-btn" aria-label="Ask about what's on my screen with voice">
        ${ICON_MIC}<span>What's on my screen</span>
      </button>
      <button type="button" class="obai-option-btn" id="obai-region-btn" aria-label="Select a region of the page">
        ${ICON_REGION}<span>Select region</span>
      </button>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector("#obai-mic-btn").addEventListener("click", () => {
      closePanel();
      startVoiceCapture();
    });
    panel.querySelector("#obai-region-btn").addEventListener("click", () => {
      closePanel();
      startRegionSelect();
    });

    return panel;
  }

  function togglePanel() {
    if (panelEl.classList.contains("obai-open")) {
      closePanel();
    } else {
      closeAnswer();
      positionNearBubble(panelEl);
      panelEl.classList.add("obai-open");
      document.addEventListener("pointerdown", onOutsideClick, true);
    }
  }

  function closePanel() {
    panelEl.classList.remove("obai-open");
    document.removeEventListener("pointerdown", onOutsideClick, true);
  }

  function onOutsideClick(e) {
    if (panelEl.contains(e.target) || bubbleEl.contains(e.target)) return;
    closePanel();
  }

  /* ------------------------------------------------------------------
     Answer card — loading / result / error states.
     ------------------------------------------------------------------ */

  function createAnswerCard() {
    const el = document.createElement("div");
    el.id = "obai-answer-panel";
    document.documentElement.appendChild(el);
    return el;
  }

  function renderAnswerState(state) {
    let bodyHtml = "";
    if (state.kind === "listening") {
      bodyHtml = `<div class="obai-state-row"><span class="obai-spinner"></span><span>Listening…</span></div>`;
    } else if (state.kind === "loading") {
      bodyHtml = `<div class="obai-state-row"><span class="obai-spinner"></span><span>Asking Claude…</span></div>`;
    } else if (state.kind === "error") {
      bodyHtml = `<div class="obai-error-text"></div>`;
    } else if (state.kind === "result") {
      bodyHtml = `<div class="obai-answer-body"></div>`;
    }

    answerEl.innerHTML = `
      <div class="obai-answer-header">
        <span class="obai-answer-title">OpenBrainAI</span>
        <button type="button" class="obai-close-btn" aria-label="Close">×</button>
      </div>
      ${bodyHtml}
    `;

    // Set text via textContent (not innerHTML) so the model's response can
    // never be interpreted as markup on the page.
    if (state.kind === "error") {
      answerEl.querySelector(".obai-error-text").textContent = state.message;
    } else if (state.kind === "result") {
      answerEl.querySelector(".obai-answer-body").textContent = state.text;
    }

    answerEl.querySelector(".obai-close-btn").addEventListener("click", closeAnswer);

    positionNearBubble(answerEl, { fallbackWidth: 320 });
    answerEl.classList.add("obai-open");
  }

  function closeAnswer() {
    answerEl.classList.remove("obai-open");
  }

  /* ------------------------------------------------------------------
     Step 4: voice input ("What's on my screen").
     ------------------------------------------------------------------ */

  function startVoiceCapture() {
    const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!SpeechRecognition) {
      renderAnswerState({ kind: "error", message: "Voice input isn't supported in this browser." });
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";

    renderAnswerState({ kind: "listening" });

    recognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      renderAnswerState({ kind: "loading" });
      const shot = await requestScreenshot();
      if (!shot.ok) {
        renderAnswerState({ kind: "error", message: shot.error });
        return;
      }
      const result = await requestClaude(shot.dataUrl, transcript);
      if (!result.ok) {
        renderAnswerState({ kind: "error", message: result.error });
      } else {
        renderAnswerState({ kind: "result", text: result.text });
      }
    };

    recognition.onerror = (event) => {
      let message = "Voice input failed. Please try again.";
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        message = "Microphone access was denied. Allow it in the site's permissions and try again.";
      } else if (event.error === "no-speech") {
        message = "No speech detected — try again.";
      }
      renderAnswerState({ kind: "error", message });
    };

    try {
      recognition.start();
    } catch (err) {
      renderAnswerState({ kind: "error", message: "Could not start voice input." });
    }
  }

  /* ------------------------------------------------------------------
     Step 3: region select + client-side crop.
     ------------------------------------------------------------------ */

  function startRegionSelect() {
    const overlay = document.createElement("div");
    overlay.id = "obai-region-overlay";
    document.documentElement.appendChild(overlay);
    regionOverlayEl = overlay;

    const box = document.createElement("div");
    box.className = "obai-selection-box";
    box.style.display = "none";
    overlay.appendChild(box);

    let start = null;

    function onKeyDown(e) {
      if (e.key === "Escape") cancelRegionSelect();
    }
    document.addEventListener("keydown", onKeyDown, true);

    overlay.addEventListener("pointerdown", (e) => {
      start = { x: e.clientX, y: e.clientY };
      box.style.display = "block";
      updateBox(box, start, start);
      overlay.setPointerCapture(e.pointerId);
    });

    overlay.addEventListener("pointermove", (e) => {
      if (!start) return;
      updateBox(box, start, { x: e.clientX, y: e.clientY });
    });

    overlay.addEventListener("pointerup", (e) => {
      if (!start) return;
      const rect = boxRect(start, { x: e.clientX, y: e.clientY });
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      regionOverlayEl = null;

      // Ignore accidental clicks/tiny drags.
      if (rect.width < 6 || rect.height < 6) return;

      showRegionPrompt(rect);
    });

    function cancelRegionSelect() {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      regionOverlayEl = null;
    }
  }

  function boxRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x);
    const height = Math.abs(a.y - b.y);
    return { x, y, width, height };
  }

  function updateBox(box, a, b) {
    const rect = boxRect(a, b);
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function showRegionPrompt(rect) {
    const prompt = document.createElement("div");
    prompt.id = "obai-region-prompt";
    prompt.innerHTML = `
      <div class="obai-region-input-row">
        <input type="text" id="obai-region-input" placeholder="Ask something, or leave blank to just describe" />
        <button type="button" class="obai-ask-btn">Ask</button>
      </div>
      <span class="obai-region-hint">Press Esc to cancel</span>
    `;
    document.documentElement.appendChild(prompt);
    regionPromptEl = prompt;

    // Anchor just below the selected region, clamped to the viewport.
    const gap = 10;
    let top = rect.y + rect.height + gap;
    let left = rect.x;
    const promptWidth = 300;
    if (top + 110 > window.innerHeight) top = Math.max(EDGE_MARGIN, rect.y - 110 - gap);
    left = clamp(left, EDGE_MARGIN, window.innerWidth - promptWidth - EDGE_MARGIN);
    prompt.style.top = `${top}px`;
    prompt.style.left = `${left}px`;

    const input = prompt.querySelector("#obai-region-input");
    const askBtn = prompt.querySelector(".obai-ask-btn");
    input.focus();

    function submit() {
      const typed = input.value.trim();
      dismissRegionPrompt();
      captureAndCropRegion(rect, typed || DEFAULT_REGION_PROMPT);
    }

    askBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") dismissRegionPrompt();
    });
  }

  function dismissRegionPrompt() {
    if (regionPromptEl) {
      regionPromptEl.remove();
      regionPromptEl = null;
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load the captured screenshot."));
      img.src = src;
    });
  }

  async function captureAndCropRegion(rect, prompt) {
    renderAnswerState({ kind: "loading" });

    const shot = await requestScreenshot();
    if (!shot.ok) {
      renderAnswerState({ kind: "error", message: shot.error });
      return;
    }

    let croppedDataUrl;
    try {
      const img = await loadImage(shot.dataUrl);
      // Screenshots are captured at CSS pixel size, but on high-DPI
      // screens the actual bitmap has more physical pixels per CSS
      // pixel. Multiplying by devicePixelRatio is required so the crop
      // lines up with what the user actually dragged over.
      const dpr = window.devicePixelRatio || 1;
      const sx = rect.x * dpr;
      const sy = rect.y * dpr;
      const sw = rect.width * dpr;
      const sh = rect.height * dpr;

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      croppedDataUrl = canvas.toDataURL("image/png");
    } catch (err) {
      renderAnswerState({ kind: "error", message: "Could not process the selected region." });
      return;
    }

    const result = await requestClaude(croppedDataUrl, prompt);
    if (!result.ok) {
      renderAnswerState({ kind: "error", message: result.error });
    } else {
      renderAnswerState({ kind: "result", text: result.text });
    }
  }

  /* ------------------------------------------------------------------
     Init
     ------------------------------------------------------------------ */

  async function init() {
    const pos = await loadPosition();
    bubbleEl = createBubble(pos);
    panelEl = createPanel();
    answerEl = createAnswerCard();
  }

  init();
})();
