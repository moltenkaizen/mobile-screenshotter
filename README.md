# Mobile Screenshotter for Figma

Figma plugin with local Express server to capture screenshots from Android and iOS devices and insert them directly into your Figma file.

## iOS Requirements

iOS support requires several steps to enable developer features:

### Prerequisites:
- ⚠️ **Xcode** (~12-15GB download) - Required for DeveloperDiskImage mounting
- **pymobiledevice3** - Python tool for iOS device communication
- **Developer Mode** enabled on iOS device (iOS 16+)

### Setup Steps:

1. **Install Xcode** from the Mac App Store

2. **Enable Developer Mode on iPhone/iPad:**
   - Settings → Privacy & Security → Developer Mode → Enable
   - Device will restart

3. **Mount DeveloperDiskImage via Xcode:**
   - Connect your iPhone/iPad via USB
   - Open Xcode → Window → Devices and Simulators
   - Select your device and wait for "Preparing device for development..." to complete
   - Trust the computer when prompted
   - *Note: This mounts the DeveloperDiskImage which enables developer features like screenshot capture*

4. **Install pymobiledevice3:**
   ```bash
   pipx install pymobiledevice3
   # or: pip3 install pymobiledevice3
   ```

5. **Start the iOS tunnel** (required for iOS 17+):
   ```bash
   sudo pymobiledevice3 remote start-tunnel
   ```
   Copy the `RSD Address` and `RSD Port` from the output - you'll need these when starting the server.

## Prerequisites

1. **Node.js** - Install from [nodejs.org](https://nodejs.org/)
2. **ADB (Android Debug Bridge)** - Usually comes with Android Studio, or install standalone:
   ```bash
   # macOS
   brew install android-platform-tools

   # Or download from: https://developer.android.com/tools/releases/platform-tools
   ```
3. **Android Device** with USB debugging enabled:
   - Go to Settings → About Phone → Tap "Build Number" 7 times
   - Go to Settings → Developer Options → Enable "USB Debugging"

## Setup

### 1. Install Plugin Dependencies
```bash
npm install
npm run build
```

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

## Usage

### 1. Start the Server

**For iOS users:** Make sure the pymobiledevice3 tunnel is running first (see iOS Requirements above).

```bash
cd server
npm start
```

**If using iOS**, the server will prompt you to enter the RSD Address and Port from your tunnel.

You should see:
```
🚀 Mobile Screenshot Server running on http://localhost:3000
📱 Connect your Android (via ADB) or iOS (via USB) device
💡 Test connection: http://localhost:3000/health
✓ Detected: [Your Device Name]
```

### 2. Connect Your Device

**For Android:**
1. Plug in your Android device via USB
2. Unlock your device
3. Allow USB debugging when prompted
4. Verify connection:
   ```bash
   adb devices
   ```
   Should show your device listed

**For iOS:**
1. Complete the iOS Requirements steps above (Xcode, pymobiledevice3, Developer Mode, DeveloperDiskImage mounting)
2. Start the tunnel: `sudo pymobiledevice3 remote start-tunnel`
3. Start the server and enter the RSD connection info when prompted
4. Verify connection:
   ```bash
   pymobiledevice3 usbmux list
   ```
   Should show your device details in JSON format

### 3. Use the Plugin
1. Open any Figma file
2. Run the plugin: Menu → Plugins → Development → Mobile Screenshotter
3. The plugin will show connection status
4. Click "Take Screenshot"
5. Screenshot appears on your canvas!

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
- Verify DeveloperDiskImage is mounted (open Xcode → Devices and Simulators)
- Check tunnel is running: `sudo pymobiledevice3 remote start-tunnel`
- Verify device shows up: `pymobiledevice3 usbmux list`
- Restart the server and re-enter RSD connection info

### "Failed to capture screenshot" (iOS)
- Make sure your device is unlocked
- Verify tunnel is running (you'll see "Tunnel not running" error if it stopped)
- Check RSD connection info is correct
- Some apps block screenshots (e.g., banking apps)

### ADB not found
- Install Android Platform Tools (see Prerequisites)
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
│   └── package.json   # Server dependencies (includes sharp for image optimization)
└── README.md          # This file
```

## How It Works

1. **Local Server**: Express server listens on `localhost:3000` and executes device commands
2. **Device Detection**: Server detects Android (via ADB) or iOS (via pymobiledevice3) at startup
3. **Figma Plugin UI**: Makes HTTP requests to the local server to trigger screenshots
4. **Screenshot Capture**:
   - Android: Uses ADB to capture and pull screenshot
   - iOS: Uses pymobiledevice3 with tunnel connection
5. **Optimization**: Server converts PNG to JPEG (85% quality) for 93% file size reduction
6. **Transfer**: Returns screenshot as base64-encoded JPEG
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
