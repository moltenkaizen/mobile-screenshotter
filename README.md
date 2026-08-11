# Mobile Screenshotter for Figma

Figma plugin with local Express server to capture screenshots from Android and iOS devices and insert them directly into your Figma file.

Runs on macOS (the iOS path is macOS-only in practice; Android capture may work elsewhere but these instructions assume macOS). You only need to complete **one** platform section below — Android or iOS. Android is a two-minute setup; iOS takes noticeably longer.

## Prerequisites (everyone)

1. **Node.js** (v18 or newer) - Install from [nodejs.org](https://nodejs.org/)
2. **Figma Desktop App** - required to load a development plugin

## Setup

### 1. Build the Plugin
```bash
npm install
npm run build
```
This generates `code.js`, which is not checked in — the plugin won't load without this step.

### 2. Install Server Dependencies
```bash
cd server
npm install
```

### 3. Load Plugin in Figma
1. Open Figma Desktop App
2. Go to Menu → Plugins → Development → Import plugin from manifest
3. Select the `manifest.json` file from this folder
4. Plugin will appear in: Menu → Plugins → Development → Mobile Screenshotter

## Android Setup (the quick path)

1. **Install ADB (Android Debug Bridge)** - Usually comes with Android Studio, or install standalone:
   ```bash
   # macOS
   brew install android-platform-tools

   # Or download from: https://developer.android.com/tools/releases/platform-tools
   ```
2. **Enable USB debugging** on your device:
   - Go to Settings → About Phone → Tap "Build Number" 7 times
   - Go to Settings → Developer Options → Enable "USB Debugging"
3. **Plug in via USB**, unlock the device, and allow USB debugging when prompted
4. **Verify connection:**
   ```bash
   adb devices
   ```
   Should show your device listed

> With multiple Android devices attached, the server uses the first one `adb devices` lists.

## iOS Setup (the longer path)

iOS screenshots go through Apple's developer tooling, so there are more steps.

1. **Install pymobiledevice3** (Python tool for iOS device communication):
   ```bash
   pipx install pymobiledevice3
   # or: pip3 install pymobiledevice3
   ```

2. **Enable Developer Mode on iPhone/iPad** (iOS 16+):
   - Settings → Privacy & Security → Developer Mode → Enable
   - Device will restart

3. **Mount the DeveloperDiskImage** (enables developer features like screenshot capture):
   - Connect your iPhone/iPad via USB and trust the computer when prompted
   - Try the lightweight route first:
     ```bash
     pymobiledevice3 mounter auto-mount
     ```
     On iOS 17+ this downloads and mounts a personalized image without needing Xcode.
   - If that fails, use Xcode (~12-15GB download from the Mac App Store):
     Open Xcode → Window → Devices and Simulators, select your device, and wait for "Preparing device for development..." to complete

4. **Start the tunnel daemon** — required for iOS screenshots; the server will not capture without it:
   ```bash
   sudo pymobiledevice3 remote tunneld
   ```
   Run this in its own terminal and leave it running. The server finds it automatically — nothing to copy or paste, and it keeps working across device replugs and server restarts.

   <details>
   <summary>Alternative: one-shot tunnel with manual RSD paste</summary>

   ```bash
   sudo pymobiledevice3 remote start-tunnel
   ```
   This prints an `--rsd <addr> <port>` line you paste at the server's `RSD:` prompt. The port changes every time the tunnel restarts, so tunneld above is the easier option.
   </details>

5. **Verify connection:**
   ```bash
   pymobiledevice3 usbmux list
   ```
   Should show your device details in JSON format

## Usage

### 1. Start the Server

```bash
cd server
npm start
```

**If an iOS device is connected** and tunneld is running (iOS Setup step 4), there's nothing to configure:

```
🔍 Detecting connected devices...

✓ Detected: iPhone 15 Pro (iOS 26.x)
  Device ID: ...

✓ tunneld detected — iOS tunnels are managed automatically

🚀 Server running on http://127.0.0.1:3000
```

Without tunneld, the server prompts instead: press Enter after starting tunneld and it proceeds, or paste an `--rsd <addr> <port>` line from a manually-run `start-tunnel`. RSD values can also be passed up front to skip the prompt:
```bash
npm start -- --rsd "fd17:e13c:9ab0::1 56673"
# or
IOS_RSD_ADDRESS=fd17:e13c:9ab0::1 IOS_RSD_PORT=56673 npm start
```

### 2. Use the Plugin
1. Open any Figma file
2. Run the plugin: Menu → Plugins → Development → Mobile Screenshotter
3. The plugin shows connection status — it's fine to plug your device in after starting the server; just click "Check Connection"
4. Click "Take Screenshot"
5. Screenshot appears on your canvas!

### Physical vs Logical resolution

The plugin's toggle controls the size of the frame created in Figma — the image itself is identical either way:

- **Logical** (default): frame sized in points/dp, e.g. 393×852 for an iPhone 15 Pro. Matches the sizes you design at, so screenshots drop in at the same scale as your mockups.
- **Physical**: frame sized in raw pixels, e.g. 1179×2556 for the same phone. Use this when you want the screenshot at native capture resolution.

## Troubleshooting

### "Server not running"
- Make sure you ran `cd server && npm start`
- Check that port 3000 is not in use

### "No device connected" (Android)
- Run `adb devices` to verify your device is connected
- Try `adb kill-server && adb start-server` to restart ADB
- Make sure USB debugging is enabled on your Android device
- Try a different USB cable (some cables are power-only)

### "No device connected" (iOS)
- Make sure Developer Mode is enabled on your iPhone/iPad
- Verify DeveloperDiskImage is mounted: `pymobiledevice3 mounter auto-mount` (or Xcode → Devices and Simulators)
- Verify device shows up: `pymobiledevice3 usbmux list`
- Click "Check Connection" in the plugin after plugging in your device

### "Invalid RSD values" at the server prompt
- The RSD address must be an IPv4/IPv6 literal (e.g. `fd17:e13c:9ab0::1`); the port is 1–65535
- Paste the `--rsd` line verbatim from `sudo pymobiledevice3 remote start-tunnel` — the server strips the leading `--rsd` automatically
- The prompt loops on bad input, so you can retry without restarting the server

### "Failed to capture screenshot" (iOS)
- Make sure your device is unlocked
- Verify tunneld is still running; if it died, restart it and just retry — no server restart needed
- If using the manual `start-tunnel` fallback instead: restart the tunnel first (it prints a **new** `--rsd` port each time), then restart the server and paste the new values
- Some apps block screenshots (e.g., banking apps)

### ADB not found
- Install Android Platform Tools (see Android Setup)
- Add ADB to your PATH:
  ```bash
  # macOS/Linux - Add to ~/.zshrc or ~/.bashrc
  export PATH="$PATH:/path/to/platform-tools"
  ```

## Project Structure

```
mobile-screenshotter/
├── manifest.json       # Figma plugin manifest
├── code.ts            # Plugin main code (TypeScript)
├── code.js            # Plugin main code (compiled)
├── ui.html            # Plugin UI
├── package.json       # Plugin dependencies
├── server/            # Local server
│   ├── server.js      # Express server with ADB + pymobiledevice3 integration
│   └── package.json   # Server dependencies (cors, express, image-size)
└── README.md          # This file
```

## How It Works

1. **Local Server**: Express server listens on `localhost:3000` and executes device commands
2. **Device Detection**: Server detects Android (via ADB) or iOS (via pymobiledevice3) at startup and on every Check Connection click. Screenshots trust the cached device for speed and self-heal if it's stale: a failed capture triggers one automatic re-detect + retry, so unplugging or swapping devices never requires a restart
3. **iOS Tunnel**: `sudo pymobiledevice3 remote tunneld` runs as a daemon that creates and manages tunnels automatically; the server detects it (checked per capture, so starting it late is fine) and passes `--tunnel <udid>` to capture commands. Fallback: run `start-tunnel` manually and paste its `--rsd` line at the server prompt. An earlier version spawned the tunnel itself, but that turned out to be buggy — keeping the sudo process separate is cleaner.
4. **Figma Plugin UI**: Makes HTTP requests to the local server to trigger screenshots
5. **Screenshot Capture**:
   - Android: Uses ADB to capture and pull screenshot
   - iOS: Uses pymobiledevice3 with tunnel connection
6. **Transfer**: Returns the PNG as raw binary data to the plugin, with resolution info in an `X-Resolution` header
7. **Plugin**: Creates frame in Figma with the screenshot at logical or physical resolution

## Future Enhancements

- Screenshot history
- Multiple device support (both Android and iOS simultaneously)
- Custom image naming

## Notes

- This is a personal use tool, not published to Figma Community
- Server runs locally on your machine only
- No data is sent to external servers
- Screenshots are temporarily stored during transfer, then deleted
