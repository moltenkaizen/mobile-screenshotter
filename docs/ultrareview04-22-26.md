# Ultrareview — 2026-04-22

> **Status (2026-08-11): all findings addressed.** 1 (`/resolution` orientation cache), 2 (`X-Figma-Plugin` header gate), 3 (unconditional re-detect), and 4 (single-flight + parallel 8s probes, client timeout 15s/35s) are fixed in `server/server.js` and `ui.html`; 5 (README cleanup) is fixed in `README.md`.

Scope: 10 files changed, 789 insertions(+), 686 deletions(-) on `main`.

## Context for whoever picks this up

This is a **personal tool**: one user, running on their own laptop, connecting to their own phone. There is no multi-user concurrency and no LAN/internet exposure beyond what the user's own browser can reach on loopback. Treat findings below through that lens — some attack models that would be critical in a shared service are minor or moot here, and some concurrency findings only matter if a single user can realistically trigger overlapping requests from the same browser.

Re-ranked for this context:

1. **Bug 3 — stale device cache after unplug/replug.** Single-user, happens daily. Top priority.
2. **Bug 1 — `/resolution` iOS ignores landscape.** Produces silently-wrong Figma frames; one user will definitely hit this.
3. **Bug 5 — README "How It Works" stale.** Nit. Cleanup.
4. **Bug 2 — CORS drive-by.** Real (malicious website in the user's own browser while server is running), but niche. Worth fixing with a one-header gate.
5. **Bug 4 — detection race.** Mostly moot at one user; the **timeout-asymmetry half** still matters (fresh-boot first click looks broken). Fix just that half.

## How to orient in the codebase

- `server/server.js` is the Express server (~500 lines). Hot areas: `detectAndStoreDevice()` ~line 201, `/device` handler ~line 287, `/resolution` handler ~line 330 with iOS branch ~361, `/screenshot` handler ~line 385 with capture at ~411 and response serialization ~441.
- `ui.html` is the Figma plugin UI. Hot areas: `checkConnection()` at ~line 210, `takeScreenshot()` at ~line 280, `X-Resolution` header parse at ~line 305 with fallback to `/resolution` at ~line 315.
- `code.ts` receives dims from `ui.html` and builds the framed Figma node (`createFramedScreenshot`).
- Recent commits that matter: `4311a5e` (manual RSD), `2dfeb5a` (loopback + CORS), `b80d38d` (timeouts, guards, reconnect), `892bbea` (iPhone 16 specs + landscape), `32b8ed8` (Uint8Array direct).

Before making changes: `git log --oneline -20`, then read `server/server.js` top-to-bottom once. The file is small enough to hold in head.

---

## 1. `/resolution` iOS branch hardcodes portrait — inconsistent with `/screenshot`

**Severity:** normal
**File:** `server/server.js:361-373`

### What's wrong

`/screenshot` was updated in this PR to infer landscape from the captured PNG's dimensions (`server.js:441-458`). `/resolution` still hardcodes `rotation: 0, isLandscape: false` in the iOS branch. Both endpoints pull from the same `connectedDevice.info.ProductType` and same `iPhoneSpecs` map, so the divergence is accidental.

### Two concrete failures

**A. Check Connection panel always shows portrait.** `ui.html:216-223` fetches `/resolution` and renders `${resData.physical.width}x${resData.physical.height}` / `${resData.logical.width}x${resData.logical.height}` into the device info panel. With the phone rotated, the panel contradicts the actual screen.

**B. Screenshot fallback stretches landscape PNGs.** `ui.html:315-321` falls back to `/resolution` when the `X-Resolution` header is absent or malformed. This PR explicitly added the try/catch at `ui.html:311-313` (`/* malformed header — fall through to /resolution fetch */`) to make that fallback live. For a landscape iOS capture, `resolutionData.logical` is portrait-shaped, Figma builds a 393×852 portrait frame, the 2556×1179 landscape PNG is stuffed into it with `scaleMode: 'FILL'` — stretched output.

### Full repro (fallback path)

1. User rotates iPhone to landscape, takes a screenshot.
2. `/screenshot` captures a 2556×1179 PNG.
3. `server.js:443-448`: `imageSize` correctly swaps dims, sets `isLandscape: true`, serializes to `X-Resolution` header.
4. Header is lost or malformed for any reason. Per the new try/catch, `resolutionData` stays `null`.
5. `ui.html:316` falls back to `fetch('/resolution')`.
6. Server returns hardcoded portrait: `physical: {1179, 2556}, logical: {393, 852}`.
7. `code.ts` / `createFramedScreenshot` builds a 393×852 portrait frame; landscape PNG gets stretched in.

### Fix (pick one)

**Preferred: shared helper + cache last-observed orientation.**

1. In `server.js`, add a module-level `lastOrientation = { isLandscape: false, rotation: 0 }` (or store on `connectedDevice.orientation`).
2. In `/screenshot`, after the `imageSize` block at ~line 443, write the inferred orientation to that cache before responding.
3. In `/resolution` iOS branch (lines 361-373), read from the cache instead of hardcoding.
4. If the cache has never been populated (no screenshot taken yet), return `rotation: null, isLandscape: null` and update `ui.html:216-223` to render "orientation unknown — take a screenshot first" instead of a dimension string.

**Minimum viable: stop lying.**

Change `server.js:371` to return `rotation: null, isLandscape: null`, and update the Check Connection panel renderer in `ui.html:216-223` to handle nulls by showing a single baseline string like "portrait baseline specs (rotate-aware)".

### Files to touch

- `server/server.js:361-373` (and ~443 if adopting the helper).
- `ui.html:216-223` (Check Connection panel render).
- `ui.html:315-321` (fallback: consider having it capture-and-retry instead of trusting stale portrait dims).

### Verification

1. With phone portrait: Check Connection shows portrait dims; screenshot flow produces a portrait frame — unchanged.
2. With phone landscape: Check Connection shows landscape dims (or neutral string under minimum fix); screenshot flow produces a landscape frame.
3. Force the fallback path: in `ui.html:305`, temporarily comment out the `X-Resolution` header read so `resolutionData` is `null`. Verify the landscape screenshot still produces a correctly-sized frame.

---

## 2. CORS allowlist permits drive-by screenshots from any website the user visits

**Severity:** normal (niche, but real)
**File:** `server/server.js:178-186`

### What's wrong

```js
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null') return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  },
  exposedHeaders: ['X-Resolution']
}));
```

The intent comment above this block promises "drive-by web pages can't fetch /screenshot." The gate accepts both missing `Origin` and the literal string `'null'`, both of which an attacker webpage can trigger.

### Threat model for a personal tool

User is browsing the web while the server is running on their own machine. A malicious site (or a compromised ad on a site they trust) loads a sandboxed iframe that fetches `http://127.0.0.1:3000/screenshot`:

```html
<iframe sandbox="allow-scripts" srcdoc='
  <script>
    fetch("http://127.0.0.1:3000/screenshot")
      .then(r => r.arrayBuffer())
      .then(buf => parent.postMessage([...new Uint8Array(buf)], "*"));
  </script>'></iframe>
```

The sandboxed document has null origin → browser sends `Origin: null` → server returns `Access-Control-Allow-Origin: null` → browser's CORS check passes → attacker reads PNG bytes and exfiltrates. The paired phone will capture and send its current screen.

Loopback binding doesn't help: browsers reach `127.0.0.1` from any origin.

### Why this matters even for a personal tool

- User's phone may show login prompts, 2FA codes, messages at the moment of capture.
- Each exploit wakes the phone and runs the full screenshot pipeline.
- No rate limiting, no user confirmation.

### Fix

Require a custom header that only the plugin sends. Any custom header forces a CORS preflight, which `<img>`, `<script>`, `<link>`, and sandboxed-iframe no-cors requests cannot satisfy.

**In `server/server.js` just after the existing `cors()` block (~line 186):**

```js
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next(); // let cors handle preflight
  if (req.get('X-Figma-Plugin') !== '1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});
```

**In the `cors()` config, add `allowedHeaders`:**

```js
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null') return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  },
  allowedHeaders: ['X-Figma-Plugin', 'Content-Type'],
  exposedHeaders: ['X-Resolution']
}));
```

**In `ui.html`, update all three `fetch` calls** (`/device`, `/resolution`, `/screenshot` — grep for `fetch(\`` in `ui.html`) to include the header:

```js
fetch(`${SERVER_URL}/screenshot`, {
  headers: { 'X-Figma-Plugin': '1' },
  signal: AbortSignal.timeout(FETCH_TIMEOUT)
})
```

### Verification

1. With the plugin: screenshots, check connection, resolution fetch all still work.
2. Attacker test: save the sandboxed-iframe HTML above to a file, open it in the user's browser while the server runs. Before fix: the iframe logs PNG bytes to console. After fix: 403 Forbidden, no bytes returned.
3. `<img src="http://127.0.0.1:3000/screenshot">` test: before fix, phone captures. After fix, the img load fails (no preflight possible).

---

## 3. Inline re-detection only handles never-connected → connected; unplug/replug/device-swap leaves stale cache

**Severity:** normal (top priority for this tool — happens in daily use)
**File:** `server/server.js:290-294` and duplicate at `:385-387`

### What's wrong

The guard added in commit `b80d38d`:

```js
if (!connectedDevice.connected) {
  await detectAndStoreDevice();
}
```

only fires when the cache says "not connected." Once connected, the cache is never refreshed until server restart. README:160 now tells the user "Click 'Check Connection' in the plugin after plugging in your device," but clicking it is a no-op if the server thinks it's still connected to the previous device.

### Three concrete failures

**A. Unplug → 30s hang.** `/screenshot` skips re-detect, goes straight to `adb exec-out screencap -p` or `pymobiledevice3 developer dvt screenshot` against a disconnected device, hits the 30-second `SCREENSHOT_TIMEOUT`, returns generic 500.

**B. Replug same device.** Works by coincidence if the device kept the same adb serial / iOS ID. If it didn't (common with iOS after a reboot), you get A.

**C. Device swap (worst).** Swap iPhone 15 Pro (`iPhone16,1`, 1179×2556) for iPhone 16 Pro Max (`iPhone17,2`, 1320×2868):

1. `/screenshot` skips re-detect, captures from the actually-plugged Pro Max → 1320×2868 PNG.
2. `server.js:436` calls `getIOSResolution(connectedDevice.info.ProductType)` — still the stale `iPhone16,1` → returns 1179×2556.
3. `X-Resolution` header reports 1179×2556; Figma frame is sized 393×852.
4. The actual PNG is 1320×2868, stuffed into a portrait frame sized for a smaller phone. Silently wrong, no error.

### Fix

Simplest: drop the guard entirely and always re-detect on `/device` and `/screenshot`.

**In `server.js`, change:**

```js
// /device at ~line 290
if (!connectedDevice.connected) {
  await detectAndStoreDevice();
}
```

**to:**

```js
await detectAndStoreDevice();
```

Same change at `server.js:385-387` for `/screenshot`.

Cost: one `adb devices` + one `pymobiledevice3 usbmux list` per request. On a warm daemon both are <100ms. The screenshot itself takes 500-2000ms, so this is noise.

Coordinate with Bug 4's fix (single-flight) so the unconditional re-detect on `/device` doesn't race with a concurrent `/screenshot`'s re-detect.

### Files to touch

- `server/server.js:290-294` (`/device` guard).
- `server/server.js:385-387` (`/screenshot` guard).

### Verification

1. Plug phone A, start server, take screenshot — works.
2. Unplug A without stopping server. Click Check Connection → reports "no device" (not stale).
3. Plug phone B. Take screenshot → correct dimensions for B, not A.
4. Plug A again. Take screenshot → correct dimensions for A.

---

## 4. Detection timeout can exceed client's fetch timeout on fresh-boot first click

**Severity:** normal (the race half is mostly moot for one user; timeout half still bites)
**File:** `server/server.js:287-295`, `ui.html:149`

### Context trim

The full finding flagged two issues: (1) a race on `connectedDevice` when two requests overlap, (2) a sequential-timeout sum that can exceed the client's `FETCH_TIMEOUT`.

For a single-user tool on a local machine, the race (1) is very hard to trigger: the user can't click "Check Connection" and "Take Screenshot" simultaneously from the same browser tab. Still worth a cheap fix because it's a one-liner that also helps (2).

The timeout asymmetry (2) is live: first click after laptop wake / adb-daemon restart can time out on the client while the server is fine.

### What's wrong

`detectAndStoreDevice()` (server.js:201-249) runs `adb devices` (`QUICK_TIMEOUT` = 15000ms) then `pymobiledevice3 usbmux list` (15000ms) sequentially. Worst case 30s. Client `FETCH_TIMEOUT` in `ui.html:149` is 10000ms. When `adb devices` triggers a cold daemon spawn (2-8s) and pymd3 is slow too, client aborts with `checkConnection`'s catch-all `'✗ Server not running'` — user sees a false error while the server is quietly completing the probe.

### Fix

Two small changes, do both:

**A. Single-flight (also helps if the race ever happens):**

Add to `server/server.js` near `connectedDevice`:

```js
let detectInFlight = null;
function runDetectOnce() {
  if (!detectInFlight) {
    detectInFlight = detectAndStoreDevice().finally(() => { detectInFlight = null; });
  }
  return detectInFlight;
}
```

Replace the inline `await detectAndStoreDevice()` (after Bug 3's change makes it unconditional) with `await runDetectOnce()` in both `/device` and `/screenshot`.

**B. Shrink per-probe timeouts for the detection path and run in parallel:**

Inside `detectAndStoreDevice()`, use a 3-5s timeout for the detection-only probes (keep the 15s+ timeouts for actual capture calls). Run them with `Promise.any` so whichever daemon answers first wins:

```js
const DETECT_TIMEOUT = 5000;
try {
  const result = await Promise.any([
    execAsync('adb devices', { timeout: DETECT_TIMEOUT }).then(r => ({ kind: 'android', r })),
    execAsync('pymobiledevice3 usbmux list', { timeout: DETECT_TIMEOUT }).then(r => ({ kind: 'ios', r }))
  ]);
  // ...branch on result.kind and parse r like today
} catch (e) {
  // Promise.any AggregateError — neither daemon found anything
  connectedDevice = { type: null, connected: false, id: null, info: null };
}
```

Total worst-case detection now 5s, comfortably under the client's 10s.

### Files to touch

- `server/server.js`: add `runDetectOnce`, update both handler guards, refactor `detectAndStoreDevice` to `Promise.any`.
- Optionally `ui.html:149`: bump `FETCH_TIMEOUT` to 15000ms as a belt-and-suspenders — harmless even after the server fix.

### Verification

1. Cold boot (restart laptop), plug phone, first Check Connection click → works within 10s.
2. Kill adb (`adb kill-server`), then click Check Connection. First click triggers fresh daemon spawn but still completes under 10s because pymd3 path short-circuits on no-iOS and adb-parallel runs concurrently.
3. With nothing plugged, Check Connection responds quickly (~5s max) with "no device" rather than waiting 30s.

---

## 5. README "How It Works" has stale claims from earlier architecture

**Severity:** nit
**File:** `README.md:200-207` (and ~192 for the Project Structure tree)

Three lines contradict the code as of this PR. The author already edited the adjacent step 7 (JPEG → binary PNG) in the same hunk, so this was a missed cleanup.

### Fixes

**Line ~192 (Project Structure tree):** delete the `(includes sharp for image optimization)` parenthetical. `sharp` is no longer in `server/package.json`. Current `dependencies`: `cors`, `express`, `image-size`.

**Line 200 ("iOS Tunnel"):** This line was added in this same PR but commit `4311a5e` removed auto-spawn. Replace with:

> **iOS Tunnel:** user runs `sudo pymobiledevice3 remote start-tunnel` in another terminal and pastes the `--rsd <addr> <port>` line at the server's `RSD:` prompt. The server does not manage tunnel lifecycle.

**Line 205 ("Optimization"):** Delete entirely, or replace with:

> **Response format:** server returns the captured PNG as-is (`Content-Type: image/png`). No re-encoding.

### Verification

Grep the README for `sharp`, `JPEG`, `jpeg`, `automatically starts`, `manages the tunnel`, `85%`, `93%` — should return zero hits after the fix.

---

## Order to tackle

1. **Bug 3** — drop the re-detection guard. Smallest diff, biggest daily-use win.
2. **Bug 4B** — shrink detection timeouts and `Promise.any`. Makes Bug 3's fix cheap.
3. **Bug 4A** — single-flight wrapper. Keeps Bug 3's unconditional re-detect from running twice on overlapping clicks.
4. **Bug 1** — `/resolution` landscape fix (pick the minimum-viable variant if short on time).
5. **Bug 2** — CORS header gate. Self-contained.
6. **Bug 5** — README cleanup.
