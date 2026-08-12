/* ==========================================================================
   OpenBrainAI — content.js
   Injected into every page. Renders the floating bubble, option panel,
   region selection, voice capture, and answer panel UI.
   ========================================================================== */

(function () {
  "use strict";

  if (window.__obaiInjected) return;
  window.__obaiInjected = true;

  const BUBBLE_SIZE = 48;
  const EDGE_MARGIN = 20;
  const DRAG_THRESHOLD = 4;
  const STORAGE_POSITION_KEY = "obaiBubblePosition";
  const DEFAULT_REGION_PROMPT = "Describe what's shown in this image in plain terms.";

  let bubbleEl = null;
  let panelEl = null;
  let answerEl = null;
  let regionOverlayEl = null;
  let regionPromptEl = null;

  let dragState = null;
  let outsideClickHandlerAttached = false;

  let lastCaptureDataUrl = null;
  let lastQuestionText = "";

  let bubbleMode = "idle"; // idle | active | listening | thinking
  let stopListeningFeedback = null;

  const ICON_BUBBLE = `
    <svg class="obai-mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path class="obai-mark-base" d="M7.5 8.5l4.5 3.5 4.5-3.5"/>
      <path class="obai-mark-base" d="M6.5 16l5.5-4 5.5 4"/>
      <circle class="obai-mark-base" cx="7" cy="8" r="2"/>
      <circle class="obai-mark-base" cx="17" cy="8" r="2"/>
      <circle class="obai-mark-base" cx="12" cy="12" r="2"/>
      <circle class="obai-mark-base" cx="6.5" cy="16" r="1.8"/>
      <circle class="obai-mark-base" cx="17.5" cy="16" r="1.8"/>
      <circle class="obai-mark-core" cx="12" cy="12" r="1"/>
      <circle class="obai-mark-ring" cx="12" cy="12" r="9"/>
    </svg>`;

  const ICON_MIC = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor"/>
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor"/>
    </svg>`;

  const ICON_REGION = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke="currentColor"/>
      <rect x="8" y="8" width="8" height="8" rx="1.5" stroke="currentColor"/>
    </svg>`;

  const ICON_SETTINGS = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 4.8a7.5 7.5 0 0 1 5 0l1.1-1.2 2 2-1.1 1.1a7.5 7.5 0 0 1 1.6 4.3l1.5.6v2.8l-1.5.6a7.5 7.5 0 0 1-1.6 4.3l1.1 1.1-2 2-1.1-1.2a7.5 7.5 0 0 1-5 0l-1.1 1.2-2-2 1.1-1.1A7.5 7.5 0 0 1 5.9 15L4.4 14.4v-2.8l1.5-.6a7.5 7.5 0 0 1 1.6-4.3L6.4 5.6l2-2 1.1 1.2Z" stroke="currentColor"/>
      <circle cx="12" cy="12" r="2.6" stroke="currentColor"/>
    </svg>`;

  const ICON_CLOSE = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

  const ICON_SEND = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 11.5 20 4l-6.5 16-2.3-6.2L4 11.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>`;

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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function defaultPosition() {
    return {
      left: window.innerWidth - BUBBLE_SIZE - EDGE_MARGIN,
      top: clamp(window.innerHeight * 0.52, EDGE_MARGIN, window.innerHeight - BUBBLE_SIZE - EDGE_MARGIN),
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

  function setBubbleMode(mode) {
    bubbleMode = mode;
    if (!bubbleEl) return;
    bubbleEl.classList.toggle("obai-active", mode === "active");
    bubbleEl.classList.toggle("obai-listening", mode === "listening");
    bubbleEl.classList.toggle("obai-thinking", mode === "thinking");
  }

  function setBubblePulse(value) {
    if (!bubbleEl) return;
    bubbleEl.style.setProperty("--obai-pulse", String(clamp(value, 0.08, 0.28)));
  }

  function refreshBubbleMode() {
    if (bubbleMode === "listening" || bubbleMode === "thinking") {
      setBubbleMode(bubbleMode);
      return;
    }
    if (panelEl.classList.contains("obai-open") || answerEl.classList.contains("obai-open")) {
      setBubbleMode("active");
    } else {
      setBubbleMode("idle");
    }
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
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePanel();
      }
    });

    document.documentElement.appendChild(bubble);
    requestAnimationFrame(() => bubble.classList.add("obai-ready"));
    return bubble;
  }

  function onBubblePointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
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
      closePanel();
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

    if (!wasDrag) togglePanel();
  }

  window.addEventListener("resize", () => {
    if (!bubbleEl) return;
    const rect = bubbleEl.getBoundingClientRect();
    const next = clampPosition({ left: rect.left, top: rect.top });
    bubbleEl.style.left = `${next.left}px`;
    bubbleEl.style.top = `${next.top}px`;
  });

  function positionNearBubble(el, opts) {
    const gap = 10;
    const bubbleRect = bubbleEl.getBoundingClientRect();
    const elWidth = el.offsetWidth || (opts && opts.fallbackWidth) || 280;
    const elHeight = el.offsetHeight || 170;

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
      <button type="button" class="obai-option-btn" id="obai-settings-btn" aria-label="Open OpenBrainAI settings">
        ${ICON_SETTINGS}<span>Settings</span>
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
    panel.querySelector("#obai-settings-btn").addEventListener("click", () => {
      closePanel();
      window.open(chrome.runtime.getURL("popup.html"), "_blank", "noopener");
    });

    return panel;
  }

  function togglePanel() {
    if (panelEl.classList.contains("obai-open")) {
      closePanel();
      return;
    }
    closeAnswer();
    positionNearBubble(panelEl);
    panelEl.classList.add("obai-open");
    if (!outsideClickHandlerAttached) {
      document.addEventListener("pointerdown", onOutsideClick, true);
      outsideClickHandlerAttached = true;
    }
    refreshBubbleMode();
  }

  function closePanel() {
    panelEl.classList.remove("obai-open");
    if (outsideClickHandlerAttached) {
      document.removeEventListener("pointerdown", onOutsideClick, true);
      outsideClickHandlerAttached = false;
    }
    refreshBubbleMode();
  }

  function onOutsideClick(e) {
    if (panelEl.contains(e.target) || bubbleEl.contains(e.target)) return;
    closePanel();
  }

  function createAnswerCard() {
    const el = document.createElement("div");
    el.id = "obai-answer-panel";
    document.documentElement.appendChild(el);
    return el;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatInlineMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  function renderMarkdownLite(text) {
    const escaped = escapeHtml((text || "").trim());
    if (!escaped) return "<p>(No answer returned.)</p>";

    const lines = escaped.split(/\r?\n/);
    const chunks = [];
    let listItems = [];
    let paragraph = [];

    const flushList = () => {
      if (!listItems.length) return;
      chunks.push(`<ul>${listItems.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join("")}</ul>`);
      listItems = [];
    };

    const flushParagraph = () => {
      if (!paragraph.length) return;
      chunks.push(`<p>${formatInlineMarkdown(paragraph.join("\n"))}</p>`);
      paragraph = [];
    };

    lines.forEach((line) => {
      const listMatch = /^\s*[-*]\s+(.*)$/.exec(line);
      if (listMatch) {
        flushParagraph();
        listItems.push(listMatch[1]);
        return;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        return;
      }
      flushList();
      paragraph.push(line);
    });

    flushParagraph();
    flushList();

    return chunks.join("") || `<p>${formatInlineMarkdown(escaped)}</p>`;
  }

  function toProductError(rawMessage, source) {
    const message = String(rawMessage || "");
    const m = message.toLowerCase();

    if (source === "voice" && m.includes("no speech")) {
      return "Didn't catch that — try again.";
    }

    if (
      m.includes("api key") ||
      m.includes("unauthorized") ||
      m.includes("invalid") ||
      m.includes("status 401") ||
      m.includes("forbidden")
    ) {
      return "Couldn't reach the AI — check your API key in settings.";
    }

    if (m.includes("network") || m.includes("failed to fetch") || m.includes("connection")) {
      return "Couldn't reach the AI — check your connection and try again.";
    }

    if (m.includes("microphone") || m.includes("not-allowed") || m.includes("service-not-allowed")) {
      return "Microphone access is blocked — allow it and try again.";
    }

    if (m.includes("support") && m.includes("browser")) {
      return "Voice input isn't available in this browser.";
    }

    return "Something went wrong — please try again.";
  }

  function renderAnswerState(state) {
    const question = state.question || lastQuestionText || "";
    const questionBlock = question
      ? `<div class="obai-question-block"><span class="obai-question-label">Question</span><span class="obai-question-text">${escapeHtml(
          question
        )}</span></div>`
      : "";

    let bodyHtml = "";
    if (state.kind === "listening") {
      bodyHtml = `<div class="obai-state-row"><span class="obai-state-icon"></span><span>Listening…</span></div>`;
    } else if (state.kind === "loading") {
      bodyHtml = `
        <div class="obai-state-row"><span class="obai-state-icon"></span><span>Thinking…</span></div>
        <div class="obai-skeleton" aria-hidden="true">
          <span class="obai-skeleton-line"></span>
          <span class="obai-skeleton-line"></span>
          <span class="obai-skeleton-line"></span>
        </div>`;
    } else if (state.kind === "error") {
      bodyHtml = `<div class="obai-error-text">${escapeHtml(state.message || "Something went wrong — please try again.")}</div>`;
    } else {
      bodyHtml = `<div class="obai-answer-body">${renderMarkdownLite(state.text || "")}</div>`;
    }

    const canFollowUp = Boolean(lastCaptureDataUrl);

    answerEl.innerHTML = `
      <div class="obai-answer-header">
        <span class="obai-answer-title">OpenBrainAI</span>
        <button type="button" class="obai-close-btn" aria-label="Dismiss answer panel">${ICON_CLOSE}</button>
      </div>
      ${questionBlock}
      <div class="obai-answer-scroll">${bodyHtml}</div>
      <div class="obai-followup">
        <input type="text" class="obai-followup-input" aria-label="Ask follow-up question" placeholder="Ask a follow-up" ${
          canFollowUp ? "" : "disabled"
        } />
        <button type="button" class="obai-followup-send" aria-label="Send follow-up" ${canFollowUp ? "" : "disabled"}>${ICON_SEND}</button>
      </div>
    `;

    answerEl.querySelector(".obai-close-btn").addEventListener("click", closeAnswer);

    const followupInput = answerEl.querySelector(".obai-followup-input");
    const followupBtn = answerEl.querySelector(".obai-followup-send");
    const submitFollowUp = () => {
      const typed = followupInput.value.trim();
      if (!typed || !lastCaptureDataUrl) return;
      followupInput.value = "";
      askWithImage(lastCaptureDataUrl, typed);
    };
    followupBtn.addEventListener("click", submitFollowUp);
    followupInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitFollowUp();
    });

    positionNearBubble(answerEl, { fallbackWidth: 360 });
    answerEl.classList.add("obai-open");
    refreshBubbleMode();
  }

  function closeAnswer() {
    answerEl.classList.remove("obai-open");
    refreshBubbleMode();
  }

  async function askWithImage(dataUrl, prompt) {
    const trimmed = (prompt || "").trim();
    if (!dataUrl || !trimmed) return;

    lastCaptureDataUrl = dataUrl;
    lastQuestionText = trimmed;
    setBubbleMode("thinking");
    renderAnswerState({ kind: "loading", question: trimmed });

    const result = await requestClaude(dataUrl, trimmed);
    if (!result.ok) {
      setBubbleMode("active");
      renderAnswerState({ kind: "error", message: toProductError(result.error, "api"), question: trimmed });
      return;
    }

    setBubbleMode("active");
    renderAnswerState({ kind: "result", text: result.text, question: trimmed });
  }

  async function startListeningFeedback() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setBubblePulse(0.14);
      return () => setBubblePulse(0.14);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        stream.getTracks().forEach((track) => track.stop());
        setBubblePulse(0.14);
        return () => setBubblePulse(0.14);
      }

      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let rafId = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        setBubblePulse(0.11 + rms * 0.7);
        rafId = window.requestAnimationFrame(tick);
      };
      tick();

      return async () => {
        if (rafId) window.cancelAnimationFrame(rafId);
        setBubblePulse(0.14);
        source.disconnect();
        analyser.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
      };
    } catch (_err) {
      setBubblePulse(0.14);
      return () => setBubblePulse(0.14);
    }
  }

  async function stopListeningVisualizer() {
    if (!stopListeningFeedback) return;
    try {
      await stopListeningFeedback();
    } catch (_err) {
      // Ignore cleanup failures.
    }
    stopListeningFeedback = null;
  }

  async function startVoiceCapture() {
    const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!SpeechRecognition) {
      renderAnswerState({ kind: "error", message: toProductError("unsupported browser", "voice") });
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";

    setBubbleMode("listening");
    renderAnswerState({ kind: "listening", question: "Listening for your question" });

    let finalized = false;
    startListeningFeedback().then((cleanup) => {
      stopListeningFeedback = cleanup;
    });

    recognition.onresult = async (event) => {
      if (finalized) return;
      finalized = true;
      await stopListeningVisualizer();

      const transcript = event.results && event.results[0] && event.results[0][0] ? event.results[0][0].transcript : "";
      const prompt = (transcript || "").trim();
      if (!prompt) {
        setBubbleMode("active");
        renderAnswerState({ kind: "error", message: "Didn't catch that — try again." });
        return;
      }

      const shot = await requestScreenshot();
      if (!shot.ok) {
        setBubbleMode("active");
        renderAnswerState({ kind: "error", message: toProductError(shot.error, "api"), question: prompt });
        return;
      }

      await askWithImage(shot.dataUrl, prompt);
    };

    recognition.onerror = async (event) => {
      if (finalized) return;
      finalized = true;
      await stopListeningVisualizer();
      setBubbleMode("active");
      renderAnswerState({ kind: "error", message: toProductError(event.error || "voice error", "voice") });
    };

    recognition.onend = async () => {
      await stopListeningVisualizer();
      if (!finalized) {
        setBubbleMode("active");
        renderAnswerState({ kind: "error", message: "Didn't catch that — try again." });
      }
    };

    try {
      recognition.start();
    } catch (_err) {
      await stopListeningVisualizer();
      setBubbleMode("active");
      renderAnswerState({ kind: "error", message: "Could not start voice input — try again." });
    }
  }

  function startRegionSelect() {
    const overlay = document.createElement("div");
    overlay.id = "obai-region-overlay";
    document.documentElement.appendChild(overlay);
    regionOverlayEl = overlay;

    const box = document.createElement("div");
    box.className = "obai-selection-box";
    box.style.display = "none";
    overlay.appendChild(box);

    const sizeTag = document.createElement("div");
    sizeTag.className = "obai-selection-size";
    sizeTag.style.display = "none";
    overlay.appendChild(sizeTag);

    let start = null;

    function onKeyDown(e) {
      if (e.key === "Escape") cancelRegionSelect();
    }
    document.addEventListener("keydown", onKeyDown, true);

    overlay.addEventListener("pointerdown", (e) => {
      start = { x: e.clientX, y: e.clientY };
      box.style.display = "block";
      sizeTag.style.display = "block";
      updateBox(box, sizeTag, start, start, e.clientX, e.clientY);
      overlay.setPointerCapture(e.pointerId);
    });

    overlay.addEventListener("pointermove", (e) => {
      if (!start) return;
      updateBox(box, sizeTag, start, { x: e.clientX, y: e.clientY }, e.clientX, e.clientY);
    });

    overlay.addEventListener("pointerup", (e) => {
      if (!start) return;
      const rect = boxRect(start, { x: e.clientX, y: e.clientY });
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      regionOverlayEl = null;

      if (rect.width < 6 || rect.height < 6) return;

      flashSelection(rect, () => showRegionPrompt(rect));
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

  function updateBox(box, sizeTag, a, b, cursorX, cursorY) {
    const rect = boxRect(a, b);
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    sizeTag.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    sizeTag.style.left = `${clamp(cursorX + 12, EDGE_MARGIN, window.innerWidth - 84)}px`;
    sizeTag.style.top = `${clamp(cursorY + 14, EDGE_MARGIN, window.innerHeight - 30)}px`;
  }

  function flashSelection(rect, cb) {
    const flash = document.createElement("div");
    flash.className = "obai-selection-flash";
    flash.style.left = `${rect.x}px`;
    flash.style.top = `${rect.y}px`;
    flash.style.width = `${rect.width}px`;
    flash.style.height = `${rect.height}px`;
    document.documentElement.appendChild(flash);

    setTimeout(() => {
      flash.remove();
      cb();
    }, 150);
  }

  function showRegionPrompt(rect) {
    const prompt = document.createElement("div");
    prompt.id = "obai-region-prompt";
    prompt.innerHTML = `
      <div class="obai-region-input-row">
        <input type="text" id="obai-region-input" placeholder="Ask something, or leave blank to describe" aria-label="Question about selected region" />
        <button type="button" class="obai-ask-btn" aria-label="Ask with selected region">Ask</button>
      </div>
      <span class="obai-region-hint">Press Esc to cancel</span>
    `;
    document.documentElement.appendChild(prompt);
    prompt.classList.add("obai-open");
    regionPromptEl = prompt;

    const gap = 10;
    let top = rect.y + rect.height + gap;
    let left = rect.x;
    const promptWidth = 320;
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
      img.onerror = () => reject(new Error("Could not load screenshot."));
      img.src = src;
    });
  }

  async function captureAndCropRegion(rect, prompt) {
    setBubbleMode("thinking");
    renderAnswerState({ kind: "loading", question: prompt });

    const shot = await requestScreenshot();
    if (!shot.ok) {
      setBubbleMode("active");
      renderAnswerState({ kind: "error", message: toProductError(shot.error, "api"), question: prompt });
      return;
    }

    let croppedDataUrl;
    try {
      const img = await loadImage(shot.dataUrl);
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
    } catch (_err) {
      setBubbleMode("active");
      renderAnswerState({ kind: "error", message: "Couldn't process that selection — try again.", question: prompt });
      return;
    }

    await askWithImage(croppedDataUrl, prompt);
  }

  async function init() {
    const pos = await loadPosition();
    bubbleEl = createBubble(pos);
    panelEl = createPanel();
    answerEl = createAnswerCard();
    setBubblePulse(0.14);
    setBubbleMode("idle");
  }

  init();
})();
