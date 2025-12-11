# iOS Support Implementation Plan

## Overview
This document outlines the plan for adding iOS device support to the Mobile Screenshotter plugin, enabling screenshots from iPhones and iPads in addition to Android devices.

---

## Tool Equivalent

Instead of ADB, we'll use **libimobiledevice** (open source iOS device communication):
- **Installation:** `brew install libimobiledevice`
- Already mentioned in README as a planned enhancement
- Provides command-line tools for iOS device interaction

---

## Key Differences Between Android & iOS

### 1. Screenshots (Actually Simpler!)

**Android (3 commands):**
```bash
adb shell screencap -p /sdcard/screenshot.png
adb pull /sdcard/screenshot.png local.png
adb shell rm /sdcard/screenshot.png
```

**iOS (1 command):**
```bash
idevicescreenshot screenshot.png  # That's it!
```

### 2. Device Detection

**Android:**
```bash
adb devices
# Output: List of devices attached
#         emulator-5554    device
```

**iOS:**
```bash
idevice_id -l
# Output: UDID like "00008030-001234567890ABCD"
```

### 3. Device Info

**Android:**
```bash
adb shell getprop ro.product.manufacturer  # "Google"
adb shell getprop ro.product.model          # "Pixel 7"
```

**iOS:**
```bash
ideviceinfo -k ProductType    # "iPhone15,2"
ideviceinfo -k DeviceName      # "John's iPhone"
ideviceinfo -k ProductName     # "iPhone 14 Pro"
ideviceinfo -k ProductVersion  # "17.0"
```

**Note:** `ProductType` returns hardware identifiers (e.g., "iPhone15,2") which need to be mapped to marketing names (e.g., "iPhone 14 Pro").

### 4. Resolution (THE CHALLENGE)

**Android:** Direct commands available
```bash
adb shell wm size      # Physical size: 1080x2400
adb shell wm density   # Physical density: 420
# Calculate logical: physical / (density / 160)
```

**iOS:** No direct command! Must use workarounds.

#### Option A - Screenshot Dimensions
```bash
idevicescreenshot temp.png
# Read image dimensions programmatically
```
- **Pros:** Always accurate, works for any device
- **Cons:** Requires taking a screenshot first, slower

#### Option B - Device Database
Maintain a lookup table:
```javascript
const iosDevices = {
  'iPhone15,2': {
    name: 'iPhone 14 Pro',
    physical: { width: 1179, height: 2556 },
    scale: 3
  },
  'iPhone15,3': {
    name: 'iPhone 14 Pro Max',
    physical: { width: 1290, height: 2796 },
    scale: 3
  },
  'iPhone14,5': {
    name: 'iPhone 13',
    physical: { width: 1170, height: 2532 },
    scale: 3
  },
  // ... etc
};
```
- **Pros:** Fast, no screenshot needed
- **Cons:** Requires maintenance for new devices, won't recognize unknown devices

#### Option C - Hybrid Approach (RECOMMENDED)
```javascript
async function getIOSResolution(productType, udid) {
  // 1. Try database lookup first
  if (iosDevices[productType]) {
    return iosDevices[productType];
  }

  // 2. Fall back to screenshot dimensions for unknown devices
  const tempFile = 'temp_detect.png';
  await execAsync(`idevicescreenshot -u ${udid} ${tempFile}`);
  const dimensions = await getImageDimensions(tempFile);
  fs.unlinkSync(tempFile);

  // 3. Estimate scale factor (usually 2 or 3)
  const scale = estimateScaleFactor(dimensions.width);

  return {
    physical: dimensions,
    scale: scale
  };
}
```
- **Pros:** Fast for known devices, works for unknown devices
- **Cons:** Slightly more complex implementation

### 5. Logical Resolution Calculation

iOS uses fixed scale factors (@2x or @3x):

**Examples:**
- iPhone 14 Pro: 1179×2556 physical → 393×852 logical (@3x scale)
- iPhone SE: 750×1334 physical → 375×667 logical (@2x scale)
- iPad Pro 12.9": 2048×2732 physical → 1024×1366 logical (@2x scale)

**Calculation:**
```javascript
const logicalWidth = Math.round(physicalWidth / scale);
const logicalHeight = Math.round(physicalHeight / scale);
```

---

## Implementation Changes Needed

### 1. Server Changes (server/server.js)

#### Add Device Type Detection
```javascript
async function detectDeviceType() {
  try {
    // Check for Android
    const { stdout: adbOutput } = await execAsync('adb devices');
    const androidDevices = adbOutput.split('\n')
      .filter(line => line.trim() && !line.includes('List of devices'))
      .filter(line => line.includes('device'));

    if (androidDevices.length > 0) {
      return { type: 'android', connected: true };
    }
  } catch (e) {
    // ADB not available or no Android devices
  }

  try {
    // Check for iOS
    const { stdout: iosOutput } = await execAsync('idevice_id -l');
    const iosDevices = iosOutput.split('\n').filter(line => line.trim());

    if (iosDevices.length > 0) {
      return { type: 'ios', connected: true, udid: iosDevices[0] };
    }
  } catch (e) {
    // libimobiledevice not available or no iOS devices
  }

  return { type: null, connected: false };
}
```

#### Update `/device` Endpoint
```javascript
app.get('/device', async (req, res) => {
  const deviceType = await detectDeviceType();

  if (!deviceType.connected) {
    return res.json({ connected: false, message: 'No device connected' });
  }

  if (deviceType.type === 'android') {
    // Existing Android logic
    // ...
  } else if (deviceType.type === 'ios') {
    try {
      const udid = deviceType.udid;

      // Get device info
      const { stdout: productType } = await execAsync(`ideviceinfo -u ${udid} -k ProductType`);
      const { stdout: deviceName } = await execAsync(`ideviceinfo -u ${udid} -k DeviceName`);

      // Map ProductType to marketing name
      const deviceInfo = iosDevices[productType.trim()] || { name: productType.trim() };

      res.json({
        connected: true,
        deviceType: 'ios',
        deviceId: udid,
        manufacturer: 'Apple',
        model: deviceInfo.name || deviceName.trim()
      });
    } catch (error) {
      res.status(500).json({
        connected: false,
        error: 'Failed to get iOS device info',
        message: error.message
      });
    }
  }
});
```

#### Update `/screenshot` Endpoint
```javascript
app.get('/screenshot', async (req, res) => {
  const tempFile = path.join(__dirname, 'temp_screenshot.png');
  const deviceType = await detectDeviceType();

  if (!deviceType.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (deviceType.type === 'android') {
      // Existing Android logic
      await execAsync('adb shell screencap -p /sdcard/screenshot.png');
      await execAsync(`adb pull /sdcard/screenshot.png "${tempFile}"`);
      await execAsync('adb shell rm /sdcard/screenshot.png');
    } else if (deviceType.type === 'ios') {
      // iOS screenshot (much simpler!)
      await execAsync(`idevicescreenshot -u ${deviceType.udid} "${tempFile}"`);
    }

    // Common code for both platforms
    const imageBuffer = fs.readFileSync(tempFile);
    const base64Image = imageBuffer.toString('base64');
    fs.unlinkSync(tempFile);

    res.json({
      success: true,
      image: base64Image,
      format: 'png'
    });
  } catch (error) {
    console.error('Screenshot error:', error);
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    res.status(500).json({
      error: 'Failed to capture screenshot',
      message: error.message
    });
  }
});
```

#### Update `/resolution` Endpoint
```javascript
app.get('/resolution', async (req, res) => {
  const deviceType = await detectDeviceType();

  if (!deviceType.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (deviceType.type === 'android') {
      // Existing Android logic
      // ...
    } else if (deviceType.type === 'ios') {
      const { stdout: productType } = await execAsync(`ideviceinfo -u ${deviceType.udid} -k ProductType`);
      const deviceInfo = iosDevices[productType.trim()];

      if (deviceInfo) {
        // Known device - use database
        const physicalWidth = deviceInfo.physical.width;
        const physicalHeight = deviceInfo.physical.height;
        const scale = deviceInfo.scale;
        const logicalWidth = Math.round(physicalWidth / scale);
        const logicalHeight = Math.round(physicalHeight / scale);

        res.json({
          success: true,
          physical: { width: physicalWidth, height: physicalHeight },
          logical: { width: logicalWidth, height: logicalHeight },
          scale: scale
        });
      } else {
        // Unknown device - use screenshot dimensions
        const tempFile = path.join(__dirname, 'temp_detect.png');
        await execAsync(`idevicescreenshot -u ${deviceType.udid} "${tempFile}"`);

        // Get image dimensions using a library like 'image-size'
        const dimensions = require('image-size')(tempFile);
        fs.unlinkSync(tempFile);

        // Estimate scale (usually 2 or 3)
        const estimatedScale = dimensions.width > 1200 ? 3 : 2;
        const logicalWidth = Math.round(dimensions.width / estimatedScale);
        const logicalHeight = Math.round(dimensions.height / estimatedScale);

        res.json({
          success: true,
          physical: { width: dimensions.width, height: dimensions.height },
          logical: { width: logicalWidth, height: logicalHeight },
          scale: estimatedScale,
          estimated: true
        });
      }
    }
  } catch (error) {
    console.error('Resolution error:', error);
    res.status(500).json({
      error: 'Failed to get screen resolution',
      message: error.message
    });
  }
});
```

#### Add iOS Device Database
```javascript
const iosDevices = {
  // iPhone 15 Series (2023)
  'iPhone16,1': { name: 'iPhone 15 Pro', physical: { width: 1179, height: 2556 }, scale: 3 },
  'iPhone16,2': { name: 'iPhone 15 Pro Max', physical: { width: 1290, height: 2796 }, scale: 3 },
  'iPhone15,4': { name: 'iPhone 15', physical: { width: 1179, height: 2556 }, scale: 3 },
  'iPhone15,5': { name: 'iPhone 15 Plus', physical: { width: 1290, height: 2796 }, scale: 3 },

  // iPhone 14 Series (2022)
  'iPhone15,2': { name: 'iPhone 14 Pro', physical: { width: 1179, height: 2556 }, scale: 3 },
  'iPhone15,3': { name: 'iPhone 14 Pro Max', physical: { width: 1290, height: 2796 }, scale: 3 },
  'iPhone14,7': { name: 'iPhone 14', physical: { width: 1170, height: 2532 }, scale: 3 },
  'iPhone14,8': { name: 'iPhone 14 Plus', physical: { width: 1284, height: 2778 }, scale: 3 },

  // iPhone 13 Series (2021)
  'iPhone14,2': { name: 'iPhone 13 Pro', physical: { width: 1170, height: 2532 }, scale: 3 },
  'iPhone14,3': { name: 'iPhone 13 Pro Max', physical: { width: 1284, height: 2778 }, scale: 3 },
  'iPhone14,5': { name: 'iPhone 13', physical: { width: 1170, height: 2532 }, scale: 3 },
  'iPhone14,4': { name: 'iPhone 13 mini', physical: { width: 1080, height: 2340 }, scale: 3 },

  // iPhone SE (2022)
  'iPhone14,6': { name: 'iPhone SE (3rd gen)', physical: { width: 750, height: 1334 }, scale: 2 },

  // iPad Pro 12.9" (2022)
  'iPad14,5': { name: 'iPad Pro 12.9" (6th gen)', physical: { width: 2048, height: 2732 }, scale: 2 },
  'iPad14,6': { name: 'iPad Pro 12.9" (6th gen)', physical: { width: 2048, height: 2732 }, scale: 2 },

  // iPad Pro 11" (2022)
  'iPad14,3': { name: 'iPad Pro 11" (4th gen)', physical: { width: 1668, height: 2388 }, scale: 2 },
  'iPad14,4': { name: 'iPad Pro 11" (4th gen)', physical: { width: 1668, height: 2388 }, scale: 2 },

  // Add more as needed...
};
```

**Note:** This database will need periodic updates as new iOS devices are released. Consider adding a comment with the last update date.

### 2. UI Changes (ui.html)

Minimal changes needed - the UI is already generic enough!

**Optional Enhancement:** Show device type indicator
```html
<div id="deviceInfo" class="device-info" style="display: none;">
  <div>
    <strong><span id="deviceModel">-</span></strong>
    <span id="deviceType" style="margin-left: 6px; font-size: 9px; opacity: 0.5;">-</span>
  </div>
  <div id="resolutionInfo" style="margin-top: 4px; display: none;">
    Physical: <span id="physicalRes">-</span> | Logical: <span id="logicalRes">-</span>
  </div>
</div>
```

```javascript
// In checkConnection()
deviceTypeEl.textContent = deviceData.deviceType === 'ios' ? '(iOS)' : '(Android)';
```

### 3. Plugin Changes (code.ts)

**No changes needed!** The plugin code is already device-agnostic. It just receives image data and resolution info, regardless of source platform.

---

## Additional Considerations

### iOS Trust/Pairing
- iOS devices must "Trust This Computer" before they can be accessed
- User must tap "Trust" dialog on iPhone the first time
- May need to run `idevicepair pair` command if trust dialog doesn't appear
- Add troubleshooting note to README

### Multiple Devices
What if both Android AND iOS devices are connected simultaneously?

**Options:**

**Option A - First Device Wins:**
```javascript
// Check Android first, then iOS
// Return whichever is found first
```
- Simple implementation
- Predictable behavior

**Option B - Device Selector Dropdown:**
```javascript
// Detect all connected devices
// Show dropdown in UI to select which to use
```
- Better UX for multi-device setups
- More complex implementation

**Option C - Last Used Device:**
```javascript
// Remember last selected device type
// Default to that platform on next connection
```
- Good middle ground
- Requires state persistence

**Recommendation:** Start with Option A for initial implementation.

### Dependencies

**User Prerequisites:**
```bash
# Android (existing)
brew install android-platform-tools

# iOS (new)
brew install libimobiledevice
```

**Node.js Dependencies:**
```bash
npm install image-size  # For reading screenshot dimensions
```

Add to server/package.json:
```json
{
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "image-size": "^1.0.2"
  }
}
```

### README Updates

Update Prerequisites section:
```markdown
## Prerequisites

1. **Node.js** - Install from [nodejs.org](https://nodejs.org/)

2. **For Android Screenshots:**
   - **ADB (Android Debug Bridge)** - Install from Android Studio or standalone:
     ```bash
     # macOS
     brew install android-platform-tools
     ```
   - **Android Device Setup:**
     - Go to Settings → About Phone → Tap "Build Number" 7 times
     - Go to Settings → Developer Options → Enable "USB Debugging"

3. **For iOS Screenshots:**
   - **libimobiledevice** - Install via Homebrew:
     ```bash
     # macOS
     brew install libimobiledevice
     ```
   - **iOS Device Setup:**
     - Connect device via USB
     - Unlock device
     - Tap "Trust" when prompted "Trust This Computer?"
     - If trust dialog doesn't appear, run: `idevicepair pair`
```

---

## Testing Strategy

### Test Matrix

| Device | OS Version | Resolution | Scale | Priority |
|--------|-----------|------------|-------|----------|
| iPhone 15 Pro | iOS 17+ | 1179×2556 | @3x | High |
| iPhone 14 | iOS 16+ | 1170×2532 | @3x | High |
| iPhone SE | iOS 15+ | 750×1334 | @2x | Medium |
| iPad Pro 12.9" | iPadOS 16+ | 2048×2732 | @2x | Medium |
| iPhone 13 mini | iOS 15+ | 1080×2340 | @3x | Low |

### Test Cases

1. **Basic Screenshot Capture**
   - [ ] Connect iOS device
   - [ ] Device appears in plugin
   - [ ] Take screenshot with logical size
   - [ ] Take screenshot with physical size
   - [ ] Verify image quality

2. **Device Detection**
   - [ ] iOS device only connected
   - [ ] Android device only connected
   - [ ] Both iOS and Android connected (test priority)
   - [ ] No devices connected

3. **Resolution Detection**
   - [ ] Known device (in database)
   - [ ] Unknown device (fallback to screenshot)
   - [ ] Verify logical calculations are correct

4. **Trust/Pairing**
   - [ ] Fresh device (never trusted)
   - [ ] Previously trusted device
   - [ ] Test `idevicepair pair` recovery

5. **Edge Cases**
   - [ ] Device locked during screenshot
   - [ ] Device disconnected mid-capture
   - [ ] Multiple iOS devices connected
   - [ ] libimobiledevice not installed

---

## Estimated Implementation Effort

| Task | Difficulty | Time Estimate |
|------|-----------|---------------|
| Screenshot capture | Easy | 1 hour |
| Device detection | Easy | 1 hour |
| Device info (make/model) | Medium | 2 hours |
| Resolution detection (hybrid) | Medium-Hard | 3 hours |
| iOS device database | Easy | 1 hour |
| Testing across devices | Medium | 2-3 hours |
| README updates | Easy | 30 min |
| **Total** | - | **~10-11 hours** |

**Note:** This assumes access to iOS devices for testing. Without devices, testing time increases significantly.

---

## Known Limitations

1. **iOS Only:** No support for other Apple platforms (watchOS, tvOS, visionOS)
2. **USB Only:** Wireless iOS debugging not supported (requires additional setup)
3. **Database Maintenance:** Device database needs updates as new iPhones/iPads release
4. **Scale Factor Estimation:** Unknown devices may have incorrect scale factor guesses
5. **Trust Requirement:** Users must manually trust computer on first connection
6. **Single Device:** No UI for selecting between multiple connected devices

---

## Future Enhancements (Post-iOS)

1. **Wireless Connection Support**
   - Android: `adb connect <ip>`
   - iOS: Network debugging (requires Xcode pairing)

2. **Multi-Device Selector**
   - Dropdown to choose between multiple connected devices
   - Remember last selected device

3. **Automatic Device Database Updates**
   - Fetch latest device specs from online source
   - Auto-update on plugin load

4. **Device-Specific Frame Templates**
   - Add device bezels/frames around screenshots
   - Support for notch/Dynamic Island overlays

5. **Rotation Detection**
   - Detect landscape vs portrait orientation
   - Auto-swap width/height in logical resolution

---

## References

- [libimobiledevice Documentation](https://libimobiledevice.org/)
- [iOS Device Model Identifiers](https://www.theiphonewiki.com/wiki/Models)
- [iOS Screen Sizes Reference](https://www.ios-resolution.com/)
- [Apple Human Interface Guidelines - Display Specifications](https://developer.apple.com/design/human-interface-guidelines/layout)

---

**Document Version:** 1.0
**Last Updated:** December 2024
**Status:** Planning / Not Implemented
