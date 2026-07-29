# OpenBrainAI

A floating bubble that answers questions about anything on your screen, via voice or a selected region, using the Claude API.

## Load it

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the OpenBrainAI icon in the toolbar and paste an Anthropic API key (get one at console.anthropic.com), then **Save**
5. Open any normal webpage (not a `chrome://` page — extensions can't run there) — the bubble should appear bottom-right

## One deliberate change from the original spec

The spec's `host_permissions` list only `https://api.anthropic.com/*`. I added `<all_urls>` alongside it.

Reason: `chrome.tabs.captureVisibleTab` requires either the `<all_urls>` host permission or an active grant from `activeTab`. `activeTab` only activates when the user invokes the extension directly — clicking the toolbar icon, a keyboard shortcut, a context-menu item. A click on the bubble is a click inside the page's own content script, not an invocation of the extension itself, so it does **not** trigger `activeTab`. Without `<all_urls>`, every screenshot capture from the bubble would fail with a permissions error the first time you test step 2 below. Since the content script already runs on `<all_urls>` anyway, this doesn't expand what the extension can see — it just lets the capture call that's already wired up actually succeed.

## Build/test order (as specified)

1. **Bubble only** — drag it around, reload the page, confirm it reappears where you left it. Try it on 2–3 different real sites.
2. **Pipeline smoke test** — click the bubble, click "What's on my screen," and check that a real answer comes back. To match the spec's suggested first pass (raw `alert()`, no UI polish), temporarily replace the two `renderAnswerState({kind:'result', ...})` calls in `captureAndCropRegion`/the voice `onresult` handler with `alert(result.text)` — this isolates the content→background→API→back round trip from the panel UI. Revert once it works.
3. **Region select** — drag a box, confirm the cropped image actually matches what you dragged. Test at both 100% and 150%+ browser zoom (Ctrl/Cmd + `+`) since this is exactly what the `devicePixelRatio` multiplication in `captureAndCropRegion` is for.
4. **Voice** — click "What's on my screen," speak a command, confirm the mic prompt appears and Chrome asks for microphone permission (per-site, first time on each origin).
5. **Answer panel polish** — already wired in this build (no `alert()` in the delivered code); confirm loading → result/error states render correctly and the × dismisses it.
6. **Settings popup** — already built; confirm the key saves and pre-fills on reopen.
7. **Error paths** — test with no key saved, an invalid key, mic permission denied, and offline (should show the messages defined in `background.js` / `content.js` rather than throwing).

## Known v1 limitations (inherited from the spec, not bugs)

- `captureVisibleTab` only grabs the visible viewport, not the full scrollable page.
- Voice permission is granted per-website by Chrome, not once for the extension — expect a mic prompt the first time you use it on each new site.
- The Claude model is set to `claude-sonnet-4-6` in `background.js` — change `CLAUDE_MODEL` there if you'd rather use a different one.
