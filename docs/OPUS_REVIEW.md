# Mobile Screenshotter — Code Review

Opus-level code review of a Figma plugin that captures mobile device screenshots (Android via ADB, iOS via pymobiledevice3) and places them on the Figma canvas. The project works well and has been through several optimization rounds. This review identifies bugs, security concerns, and quality improvements.

> **Historical — resolved.** The high-priority findings here (RSD command injection, temp file race, rotation parsing) were fixed in commits `2dfeb5a`, `b80d38d`, and `892bbea`. This document describes the pre-hardening code; see `docs/ultrareview04-22-26.md` for the current review.

> **Note:** This document is findings-only. No fixes have been implemented.

---

## High Priority (Bugs / Security)

### 1. Command injection risk in iOS RSD params
**File:** `server.js:199`

`buildPymobiledevice3Command()` interpolates `rsd.address` and `rsd.port` directly into a shell command string. These values come from user input (interactive prompt or env vars). A malicious or malformed value like `; rm -rf /` would execute arbitrary shell commands.

**Fix:** Validate address/port format (regex for IP/hostname and numeric port), or use `execFile` with argument arrays instead of `exec` with string interpolation.

---

### 2. Race condition on temp screenshot file
**File:** `server.js:295`

All screenshot requests write to the same `temp_screenshot.png` path. Concurrent requests would clobber each other.

**Fix:** Use a unique temp file per request (e.g., `temp_screenshot_${Date.now()}_${Math.random()}.png`).

---

### 3. Android rotation parsing may be fragile
**File:** `server.js:88-91`

The code parses `ROTATION_(\d+)` and divides by 90, assuming values like `ROTATION_0`, `ROTATION_90`, `ROTATION_270`. Some Android versions/devices output `ROTATION_0` meaning enum value 0 (not degrees), which would give `0/90 = 0` (coincidentally correct for portrait) but `1/90 = 0.011` for landscape — breaking landscape detection entirely.

**Fix:** Handle both formats: if the captured value is < 4, treat it as an enum (0-3); if >= 90, divide by 90.

---

## Medium Priority (Correctness / Performance)

### 4. iOS landscape orientation not handled
**File:** `server.js:271-280`

iOS resolution always returns `rotation: 0, isLandscape: false`. If an iOS device is in landscape, the screenshot dimensions won't match the reported resolution, and the frame in Figma will be wrong.

**Fix:** Use `image-size` (already a dependency!) to detect actual screenshot dimensions and compare against known specs to infer orientation.

---

### 5. iPhone 16 series missing from iPhoneSpecs
**File:** `server.js:30-45`

The spec map stops at iPhone 15. iPhone 16, 16 Pro, 16 Pro Max, and iPhone 16e are missing. Users with these devices will get fallback resolution (iPhone 15 Pro specs), which may be wrong.

**Fix:** Add iPhone 16 family entries (iPhone17,1 through iPhone17,5).

---

### 6. `Array.from(bytes)` is expensive and likely unnecessary
**File:** `ui.html:326`

Converting a multi-MB Uint8Array to a regular JS Array for `postMessage` is very slow and doubles memory usage. Figma's plugin postMessage now supports Uint8Array via structured clone — this conversion may no longer be needed.

**Fix:** Try sending `bytes` (Uint8Array) directly. On the code.ts side, receive it as Uint8Array instead of `number[]`. Test to confirm Figma supports it.

---

### 7. Device detection is startup-only — no reconnection support
**Files:** `server.js`, `ui.html`

If a device is disconnected and reconnected, the server must be restarted. The "Check Connection" button in the UI calls `/device` but that only reads the cached state.

**Fix:** Add a `/reconnect` endpoint that re-runs `detectAndStoreDevice()`, or automatically re-detect on `/device` calls when `connectedDevice.connected` is false.

---

### 8. No timeouts on device commands
**File:** `server.js`

`execAsync` calls to ADB and pymobiledevice3 have no timeout. A hung device could block the server indefinitely.

**Fix:** Add `{ timeout: 15000 }` to `execAsync` calls for device commands, and a longer timeout (30s) for screenshot capture.

---

## Low Priority (Cleanup)

### 9. `sharp` imported but unused
**File:** `server.js:8`

The JPEG conversion code is commented out (lines 327-335), but `sharp` is still imported and listed as a dependency. It's a heavy native module (~30MB) that slows `npm install` for no benefit.

**Fix:** Remove the import and dependency, or move to an optional/commented pattern.

---

### 10. `image-size` dependency unused
**File:** `server/package.json:13`

Listed as a dependency but never imported or used anywhere.

**Fix:** Remove it, or use it to solve issue #4 above.

---

### 11. `manifest.json` `allowedDomains: ["none"]` is misleading
**File:** `manifest.json:15`

The string `"none"` doesn't have special meaning in Figma's manifest schema — it's treated as a literal domain name. An empty array `[]` is the correct way to express "no production domains."

**Fix:** Change to `"allowedDomains": []`.

---

### 12. No null check on `connectedDevice.info` in iOS paths
**File:** `server.js:251-253`

If `connectedDevice.connected` is true but `info` is null (edge case), accessing `.Identifier`, `.ProductType` etc. will throw an unhandled exception.

**Fix:** Add a guard: `if (!connectedDevice.info)` return an error response.

---

### 13. No `X-Resolution` header parse error handling
**File:** `ui.html:303`

`JSON.parse(resolutionHeader)` will throw on malformed data, causing the entire screenshot flow to fail with an unclear error.

**Fix:** Wrap in try/catch and fall back to the `/resolution` endpoint.

---

### 14. Excessive performance logging in code.ts
**File:** `code.ts`

Nearly every operation has timing instrumentation. This is useful for development but clutters the code and will spam the console in normal use.

**Fix:** Gate behind a `DEBUG` flag, or remove now that performance has been optimized. Alternatively, wrap in a simple `time(label, fn)` helper to reduce boilerplate.

---

## Summary by Priority

| Priority | # | Finding | File |
|----------|---|---------|------|
| **High** | 1 | Command injection in RSD params | server.js:199 |
| **High** | 2 | Race condition on temp file | server.js:295 |
| **High** | 3 | Android rotation parsing fragile | server.js:88-91 |
| **Medium** | 4 | iOS landscape not handled | server.js:271-280 |
| **Medium** | 5 | iPhone 16 specs missing | server.js:30-45 |
| **Medium** | 6 | `Array.from(bytes)` performance | ui.html:326 |
| **Medium** | 7 | No device reconnection support | server.js |
| **Medium** | 8 | No command timeouts | server.js |
| **Low** | 9 | Unused `sharp` import/dependency | server.js:8 |
| **Low** | 10 | Unused `image-size` dependency | package.json:13 |
| **Low** | 11 | `allowedDomains: ["none"]` misleading | manifest.json:15 |
| **Low** | 12 | No null check on iOS device info | server.js:251-253 |
| **Low** | 13 | No JSON.parse error handling | ui.html:303 |
| **Low** | 14 | Excessive performance logging | code.ts |
