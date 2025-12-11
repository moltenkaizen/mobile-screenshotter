# Mobile Screenshotter for Figma

Figma plugin with local Express server to capture screenshots from Android devices and insert them directly into your Figma file.

## iOS Support (Advanced Users)

**An `ios-support` branch is available** with experimental iPhone/iPad support, but it has significant requirements:

- ⚠️ **Requires Xcode** (~12-15GB download) for Developer disk images
- Requires `libimobiledevice` (`brew install libimobiledevice`)
- Device must be trusted and have Developer image mounted via Xcode

**To use iOS support:**
```bash
git checkout ios-support
cd server
npm install  # Installs additional dependencies
npm start
```

Due to these heavyweight requirements, **the `main` branch remains Android-only** for simplicity and accessibility.

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
```bash
cd server
npm start
```

You should see:
```
🚀 Android Screenshot Server running on http://localhost:3000
📱 Make sure your Android device is connected via ADB
💡 Test connection: http://localhost:3000/health
```

### 2. Connect Your Android Device
1. Plug in your Android device via USB
2. Unlock your device
3. Allow USB debugging when prompted
4. Verify connection:
   ```bash
   adb devices
   ```
   Should show your device listed

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

### "No device connected"
- Run `adb devices` to verify your device is connected
- Try `adb kill-server && adb start-server` to restart ADB
- Make sure USB debugging is enabled on your Android device
- Try a different USB cable (some cables are power-only)

### "Failed to capture screenshot"
- Make sure your device is unlocked
- Some apps block screenshots (e.g., banking apps)
- Try taking a screenshot manually first to verify your device allows it

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
│   ├── server.js      # Express server with ADB integration
│   └── package.json   # Server dependencies
└── README.md          # This file
```

## How It Works

1. **Local Server**: Express server listens on `localhost:3000` and executes ADB commands
2. **Figma Plugin UI**: Makes HTTP requests to the local server to trigger screenshots
3. **ADB**: Captures screenshot from connected Android device
4. **Server**: Returns screenshot as base64-encoded PNG
5. **Plugin**: Creates image node in Figma with the screenshot data

## Future Enhancements

- Screenshot history
- Multiple device support (both Android and iOS simultaneously)
- Custom image naming
- Better iOS support (without requiring Xcode installation)

## Notes

- This is a personal use tool, not published to Figma Community
- Server runs locally on your machine only
- No data is sent to external servers
- Screenshots are temporarily stored during transfer, then deleted
