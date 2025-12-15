const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sharp = require('sharp');

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;

// Store RSD params in memory (set via env vars or interactive prompt)
let iosRSDConfig = {
  address: process.env.IOS_RSD_ADDRESS || null,
  port: process.env.IOS_RSD_PORT || null
};

// Store detected device info (set once at startup)
let connectedDevice = {
  type: null,        // 'android', 'ios', or null
  connected: false,
  id: null,
  info: null         // Full device info for iOS (from usbmux list)
};

// Map iPhone ProductType to device specs
const iPhoneSpecs = {
  'iPhone16,1': { name: 'iPhone 15 Pro', width: 1179, height: 2556, scale: 3 },
  'iPhone16,2': { name: 'iPhone 15 Pro Max', width: 1290, height: 2796, scale: 3 },
  'iPhone15,4': { name: 'iPhone 15 Plus', width: 1290, height: 2796, scale: 3 },
  'iPhone15,5': { name: 'iPhone 15', width: 1179, height: 2556, scale: 3 },
  'iPhone15,2': { name: 'iPhone 14 Pro', width: 1179, height: 2556, scale: 3 },
  'iPhone15,3': { name: 'iPhone 14 Pro Max', width: 1290, height: 2796, scale: 3 },
  'iPhone14,7': { name: 'iPhone 14', width: 1170, height: 2532, scale: 3 },
  'iPhone14,8': { name: 'iPhone 14 Plus', width: 1284, height: 2778, scale: 3 },
  'iPhone14,2': { name: 'iPhone 13 Pro', width: 1170, height: 2532, scale: 3 },
  'iPhone14,3': { name: 'iPhone 13 Pro Max', width: 1284, height: 2778, scale: 3 },
  'iPhone13,2': { name: 'iPhone 12', width: 1170, height: 2532, scale: 3 },
  'iPhone13,3': { name: 'iPhone 12 Pro', width: 1170, height: 2532, scale: 3 },
  'iPhone13,4': { name: 'iPhone 12 Pro Max', width: 1284, height: 2778, scale: 3 },
  // Add more as needed
};

function getFriendlyModelName(productType, deviceName) {
  return iPhoneSpecs[productType]?.name || deviceName || productType || 'iPhone';
}

function getIOSResolution(productType) {
  const specs = iPhoneSpecs[productType];
  if (!specs) {
    // Fallback: assume modern iPhone with @3x
    return {
      physical: { width: 1179, height: 2556 },
      logical: { width: 393, height: 852 },
      scale: 3
    };
  }

  return {
    physical: { width: specs.width, height: specs.height },
    logical: { width: Math.round(specs.width / specs.scale), height: Math.round(specs.height / specs.scale) },
    scale: specs.scale
  };
}

// Enable CORS for Figma plugin
app.use(cors());
app.use(express.json());

// Device type detection function (runs once at startup)
async function detectAndStoreDevice() {
  // Try Android first
  try {
    const { stdout: adbOutput } = await execAsync('adb devices');
    const androidDevices = adbOutput.split('\n')
      .filter(line => line.trim() && !line.includes('List of devices'))
      .filter(line => line.includes('\tdevice'));

    if (androidDevices.length > 0) {
      const deviceId = androidDevices[0].split('\t')[0];
      connectedDevice = {
        type: 'android',
        connected: true,
        id: deviceId,
        info: null
      };
      return;
    }
  } catch (e) {
    // ADB not available or no devices
  }

  // Try iOS using pymobiledevice3
  try {
    const { stdout: iosOutput } = await execAsync('pymobiledevice3 usbmux list');
    // Parse JSON output from pymobiledevice3
    const devices = JSON.parse(iosOutput);
    if (devices && devices.length > 0) {
      // Filter to USB-connected devices only
      const usbDevice = devices.find(d => d.ConnectionType === 'USB');
      if (usbDevice) {
        connectedDevice = {
          type: 'ios',
          connected: true,
          id: usbDevice.Identifier,
          info: usbDevice  // Store full device info for later use
        };
        return;
      }
    }
  } catch (e) {
    // pymobiledevice3 not available or no devices
  }

  // No device found
  connectedDevice = { type: null, connected: false, id: null, info: null };
}

// Check if iOS tunnel RSD params are configured
function getIOSRSDParams() {
  const address = iosRSDConfig.address;
  const port = iosRSDConfig.port;

  if (!address || !port) {
    return {
      configured: false,
      address: null,
      port: null,
      instructions: 'iOS tunnel not configured. Please restart server to enter RSD values.'
    };
  }

  return { configured: true, address, port };
}

// Build pymobiledevice3 command with RSD params
function buildPymobiledevice3Command(baseCommand) {
  const rsd = getIOSRSDParams();

  if (!rsd.configured) {
    throw new Error(rsd.instructions);
  }

  return `${baseCommand} --rsd ${rsd.address} ${rsd.port}`;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Check if device is connected (Android or iOS)
app.get('/device', async (req, res) => {
  if (!connectedDevice.connected) {
    return res.json({ connected: false, message: 'No device connected' });
  }

  if (connectedDevice.type === 'android') {
    try {
      // Get device manufacturer and model
      let manufacturer = 'Unknown';
      let model = 'Unknown';
      try {
        const { stdout: mfgOutput } = await execAsync('adb shell getprop ro.product.manufacturer');
        manufacturer = mfgOutput.trim();
      } catch (e) {
        // If getprop fails, use default
      }

      try {
        const { stdout: modelOutput } = await execAsync('adb shell getprop ro.product.model');
        model = modelOutput.trim();
      } catch (e) {
        // If getprop fails, use default
      }

      res.json({
        connected: true,
        deviceType: 'android',
        deviceId: connectedDevice.id,
        manufacturer: manufacturer,
        model: model
      });
    } catch (error) {
      res.status(500).json({
        connected: false,
        error: 'Failed to get device info',
        message: error.message
      });
    }
  } else if (connectedDevice.type === 'ios') {
    // Use stored device info - no need to call pymobiledevice3 again!
    res.json({
      connected: true,
      deviceType: 'ios',
      deviceId: connectedDevice.info.Identifier,
      manufacturer: 'Apple',
      model: getFriendlyModelName(connectedDevice.info.ProductType, connectedDevice.info.DeviceName)
    });
  }
});

// Get device resolution endpoint
app.get('/resolution', async (req, res) => {
  if (!connectedDevice.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (connectedDevice.type === 'android') {
      // Get physical size (always in default/portrait orientation)
      const { stdout: sizeOutput } = await execAsync('adb shell wm size');
      const sizeMatch = sizeOutput.match(/(\d+)x(\d+)/);
      if (!sizeMatch) throw new Error('Could not parse screen size');
      let physicalWidth = parseInt(sizeMatch[1]);
      let physicalHeight = parseInt(sizeMatch[2]);

      // Get density
      const { stdout: densityOutput } = await execAsync('adb shell wm density');
      const densityMatch = densityOutput.match(/density:\s*(\d+)/);
      if (!densityMatch) throw new Error('Could not parse screen density');
      const density = parseInt(densityMatch[1]);

      // Get current rotation (0=portrait, 1=landscape-left, 2=upside-down, 3=landscape-right)
      let rotation = 0;
      try {
        const { stdout: rotationOutput } = await execAsync('adb shell dumpsys window | grep mCurrentRotation');
        // Output looks like: "mCurrentRotation=ROTATION_90" or just "ROTATION_90"
        const rotationMatch = rotationOutput.match(/ROTATION_(\d+)/);
        if (rotationMatch) {
          const rotationDegrees = parseInt(rotationMatch[1]);
          // Convert degrees to rotation number: 0=0°, 90=1, 180=2, 270=3
          rotation = rotationDegrees / 90;
        }
      } catch (e) {
        // If rotation fetch fails, assume portrait (0)
        rotation = 0;
      }

      // If device is in landscape (rotation 1 or 3), swap width and height
      const isLandscape = (rotation === 1 || rotation === 3);
      if (isLandscape) {
        [physicalWidth, physicalHeight] = [physicalHeight, physicalWidth];
      }

      // Calculate logical resolution
      const scale = density / 160;
      const logicalWidth = Math.round(physicalWidth / scale);
      const logicalHeight = Math.round(physicalHeight / scale);

      res.json({
        success: true,
        physical: { width: physicalWidth, height: physicalHeight },
        logical: { width: logicalWidth, height: logicalHeight },
        density: density,
        scale: scale,
        rotation: rotation,
        isLandscape: isLandscape
      });
    } else if (connectedDevice.type === 'ios') {
      // iOS - look up resolution from stored device specs (no API call needed!)
      const resolutionInfo = getIOSResolution(connectedDevice.info.ProductType);

      res.json({
        success: true,
        physical: resolutionInfo.physical,
        logical: resolutionInfo.logical,
        density: resolutionInfo.scale * 160,
        scale: resolutionInfo.scale,
        rotation: 0,
        isLandscape: false
      });
    }
  } catch (error) {
    console.error('Resolution error:', error);
    res.status(500).json({
      error: 'Failed to get screen resolution',
      message: error.message
    });
  }
});

// Take screenshot endpoint
app.get('/screenshot', async (req, res) => {
  const tempFile = path.join(__dirname, 'temp_screenshot.png');
  let finalFile = tempFile; // Track which file to read (PNG or JPEG)

  if (!connectedDevice.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (connectedDevice.type === 'android') {
      // Take screenshot and pull it to local machine
      await execAsync('adb shell screencap -p /sdcard/screenshot.png');
      await execAsync(`adb pull /sdcard/screenshot.png "${tempFile}"`);
      await execAsync('adb shell rm /sdcard/screenshot.png');
    } else if (connectedDevice.type === 'ios') {
      // Take screenshot using pymobiledevice3 with RSD params
      try {
        const cmd = buildPymobiledevice3Command(
          `pymobiledevice3 developer dvt screenshot "${tempFile}"`
        );
        await execAsync(cmd);
      } catch (error) {
        // If error mentions tunnel, provide helpful message
        if (error.message && (error.message.includes('tunneld') || error.message.includes('RemoteXPC'))) {
          const rsd = getIOSRSDParams();
          throw new Error(rsd.configured ?
            'Tunnel not running. Start it with: sudo pymobiledevice3 remote start-tunnel' :
            rsd.instructions
          );
        }
        throw error;
      }
    }

    // Convert PNG to JPEG for better compression (both Android and iOS)
    const jpegFile = tempFile.replace('.png', '.jpg');
    await sharp(tempFile)
      .jpeg({ quality: 85 })
      .toFile(jpegFile);

    // Delete original PNG, use JPEG instead
    fs.unlinkSync(tempFile);
    finalFile = jpegFile;

    // Read the screenshot file and encode
    const imageBuffer = fs.readFileSync(finalFile);
    const base64Image = imageBuffer.toString('base64');

    // Clean up temp file
    fs.unlinkSync(finalFile);

    // Get resolution data to include in response (saves separate fetch)
    let resolutionData = null;
    if (connectedDevice.type === 'ios') {
      // iOS: Use cached device specs (instant)
      const resInfo = getIOSResolution(connectedDevice.info.ProductType);
      resolutionData = {
        success: true,
        physical: resInfo.physical,
        logical: resInfo.logical,
        density: resInfo.scale * 160,
        scale: resInfo.scale,
        rotation: 0,
        isLandscape: false
      };
    } else if (connectedDevice.type === 'android') {
      // Android: Fetch current resolution (rotation may have changed)
      try {
        const { stdout: sizeOutput } = await execAsync('adb shell wm size');
        const sizeMatch = sizeOutput.match(/(\d+)x(\d+)/);
        const { stdout: densityOutput } = await execAsync('adb shell wm density');
        const densityMatch = densityOutput.match(/density:\s*(\d+)/);

        if (sizeMatch && densityMatch) {
          let physicalWidth = parseInt(sizeMatch[1]);
          let physicalHeight = parseInt(sizeMatch[2]);
          const density = parseInt(densityMatch[1]);

          // Check rotation
          let rotation = 0;
          try {
            const { stdout: rotationOutput } = await execAsync('adb shell dumpsys window | grep mCurrentRotation');
            const rotationMatch = rotationOutput.match(/ROTATION_(\d+)/);
            if (rotationMatch) {
              rotation = parseInt(rotationMatch[1]) / 90;
            }
          } catch (e) { /* ignore */ }

          const isLandscape = (rotation === 1 || rotation === 3);
          if (isLandscape) {
            [physicalWidth, physicalHeight] = [physicalHeight, physicalWidth];
          }

          const scale = density / 160;
          resolutionData = {
            success: true,
            physical: { width: physicalWidth, height: physicalHeight },
            logical: { width: Math.round(physicalWidth / scale), height: Math.round(physicalHeight / scale) },
            density: density,
            scale: scale,
            rotation: rotation,
            isLandscape: isLandscape
          };
        }
      } catch (e) { /* resolution fetch failed, client can fallback */ }
    }

    // Send as JSON with base64 data and resolution
    res.json({
      success: true,
      image: base64Image,
      format: 'jpeg',
      resolution: resolutionData  // Include resolution to skip separate fetch
    });

  } catch (error) {
    console.error('Screenshot error:', error);

    // Clean up temp files if they exist
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (finalFile !== tempFile && fs.existsSync(finalFile)) {
      fs.unlinkSync(finalFile);
    }

    res.status(500).json({
      error: 'Failed to capture screenshot',
      message: error.message
    });
  }
});

// Prompt for iOS RSD configuration if needed
async function promptForIOSConfig() {
  console.log('🔍 Detecting connected devices...\n');
  await detectAndStoreDevice();

  if (!connectedDevice.connected) {
    console.log('❌ No device detected');
    console.log('   Connect an Android device (via ADB) or iOS device (via USB)\n');
    return;
  }

  if (connectedDevice.type === 'android') {
    // Get Android device details
    try {
      const { stdout: manufacturer } = await execAsync('adb shell getprop ro.product.manufacturer');
      const { stdout: model } = await execAsync('adb shell getprop ro.product.model');
      console.log(`✓ Detected: ${manufacturer.trim()} ${model.trim()} (Android)`);
      console.log(`  Device ID: ${connectedDevice.id}\n`);
    } catch (e) {
      console.log(`✓ Detected: Android device (ID: ${connectedDevice.id})\n`);
    }
    return;
  }

  if (connectedDevice.type === 'ios') {
    // iOS device info already in connectedDevice.info
    const modelName = getFriendlyModelName(
      connectedDevice.info.ProductType,
      connectedDevice.info.DeviceName
    );
    console.log(`✓ Detected: ${modelName} (iOS ${connectedDevice.info.ProductVersion})`);
    console.log(`  Device ID: ${connectedDevice.info.Identifier}\n`);

    // Only prompt if RSD not already configured
    if (!iosRSDConfig.address) {
      console.log('\n📱 iOS tunnel configuration required.');
      console.log('   Start tunnel in another terminal: sudo pymobiledevice3 remote start-tunnel');
      console.log('   Then enter the RSD connection info below:\n');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      return new Promise((resolve) => {
        rl.question('RSD Address: ', (address) => {
          rl.question('RSD Port: ', (port) => {
            iosRSDConfig.address = address.trim();
            iosRSDConfig.port = port.trim();
            rl.close();
            console.log('');
            resolve();
          });
        });
      });
    } else {
      console.log(`✓ iOS tunnel already configured: ${iosRSDConfig.address}:${iosRSDConfig.port}\n`);
    }
  }
}

// Start server
async function startServer() {
  await promptForIOSConfig();

  app.listen(PORT, () => {
    console.log(`🚀 Mobile Screenshot Server running on http://localhost:${PORT}`);
    console.log(`📱 Connect your Android (via ADB) or iOS (via USB) device`);
    console.log(`💡 Test connection: http://localhost:${PORT}/health`);

    // Check iOS tunnel configuration
    const rsd = getIOSRSDParams();
    if (rsd.configured) {
      console.log(`✓ iOS tunnel configured: ${rsd.address}:${rsd.port}`);
    }
  });
}

startServer();
