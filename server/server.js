const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { imageSize } = require('image-size');

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;
const BASE_DENSITY = 160; // Android baseline density (mdpi)
const QUICK_TIMEOUT = 15000;       // fast device queries (adb/pymd3 info)
const SCREENSHOT_TIMEOUT = 30000;  // screenshot capture may be slower

function makeTempPath() {
  return path.join(os.tmpdir(), `mobile-screenshot-${crypto.randomUUID()}.png`);
}

// Reject anything that isn't a plain IPv4/IPv6 literal or numeric port, so
// values from CLI args / env / interactive input can't inject shell metachars
// when interpolated into the pymobiledevice3 command.
function isValidRSDAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (addr.length === 0 || addr.length > 64) return false;
  return /^[0-9a-fA-F:.%]+$/.test(addr);
}

function isValidRSDPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// Store RSD params in memory (set via env vars, --rsd flag, or interactive prompt)
let iosRSDConfig = {
  address: process.env.IOS_RSD_ADDRESS || null,
  port: process.env.IOS_RSD_PORT || null
};

// Parse --rsd "address port" from CLI args (e.g. npm start -- --rsd "fd17:e13c:9ab0::1 56673")
(function parseArgv() {
  const rsdIdx = process.argv.indexOf('--rsd');
  if (rsdIdx !== -1 && process.argv[rsdIdx + 1]) {
    const parts = process.argv[rsdIdx + 1].trim().split(/\s+/);
    if (parts.length >= 2) {
      iosRSDConfig.address = parts[0];
      iosRSDConfig.port = parts[1];
    }
  }
})();

// Drop env/CLI-provided values that fail validation so they can't reach exec.
if (iosRSDConfig.address && !isValidRSDAddress(iosRSDConfig.address)) {
  console.log('⚠️  Ignoring invalid IOS_RSD_ADDRESS / --rsd address value.');
  iosRSDConfig.address = null;
}
if (iosRSDConfig.port && !isValidRSDPort(iosRSDConfig.port)) {
  console.log('⚠️  Ignoring invalid IOS_RSD_PORT / --rsd port value.');
  iosRSDConfig.port = null;
}

// Store detected device info (set once at startup)
let connectedDevice = {
  type: null,        // 'android', 'ios', or null
  connected: false,
  id: null,
  info: null         // Full device info for iOS (from usbmux list)
};

// Map iPhone ProductType to device specs
const iPhoneSpecs = {
  // iPhone 16 family (2024-2025)
  'iPhone17,1': { name: 'iPhone 16 Pro', width: 1206, height: 2622, scale: 3 },
  'iPhone17,2': { name: 'iPhone 16 Pro Max', width: 1320, height: 2868, scale: 3 },
  'iPhone17,3': { name: 'iPhone 16', width: 1179, height: 2556, scale: 3 },
  'iPhone17,4': { name: 'iPhone 16 Plus', width: 1290, height: 2796, scale: 3 },
  'iPhone17,5': { name: 'iPhone 16e', width: 1170, height: 2532, scale: 3 },
  // iPhone 15 family
  'iPhone16,1': { name: 'iPhone 15 Pro', width: 1179, height: 2556, scale: 3 },
  'iPhone16,2': { name: 'iPhone 15 Pro Max', width: 1290, height: 2796, scale: 3 },
  'iPhone15,4': { name: 'iPhone 15 Plus', width: 1290, height: 2796, scale: 3 },
  'iPhone15,5': { name: 'iPhone 15', width: 1179, height: 2556, scale: 3 },
  // iPhone 14 family
  'iPhone15,2': { name: 'iPhone 14 Pro', width: 1179, height: 2556, scale: 3 },
  'iPhone15,3': { name: 'iPhone 14 Pro Max', width: 1290, height: 2796, scale: 3 },
  'iPhone14,7': { name: 'iPhone 14', width: 1170, height: 2532, scale: 3 },
  'iPhone14,8': { name: 'iPhone 14 Plus', width: 1284, height: 2778, scale: 3 },
  // iPhone 13 family
  'iPhone14,2': { name: 'iPhone 13 Pro', width: 1170, height: 2532, scale: 3 },
  'iPhone14,3': { name: 'iPhone 13 Pro Max', width: 1284, height: 2778, scale: 3 },
  // iPhone 12 family
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

// Get Android resolution (extracted to avoid duplication)
async function getAndroidResolution() {
  // Get physical size (always in default/portrait orientation)
  const { stdout: sizeOutput } = await execAsync('adb shell wm size', { timeout: QUICK_TIMEOUT });
  const sizeMatch = sizeOutput.match(/(\d+)x(\d+)/);
  if (!sizeMatch) throw new Error('Could not parse screen size');
  let physicalWidth = parseInt(sizeMatch[1]);
  let physicalHeight = parseInt(sizeMatch[2]);

  // Get density
  const { stdout: densityOutput } = await execAsync('adb shell wm density', { timeout: QUICK_TIMEOUT });
  const densityMatch = densityOutput.match(/density:\s*(\d+)/);
  if (!densityMatch) throw new Error('Could not parse screen density');
  const density = parseInt(densityMatch[1]);

  // Get current rotation (0=portrait, 1=landscape-left, 2=upside-down, 3=landscape-right)
  let rotation = 0;
  try {
    const { stdout: rotationOutput } = await execAsync('adb shell dumpsys window | grep mCurrentRotation', { timeout: QUICK_TIMEOUT });
    const rotationMatch = rotationOutput.match(/ROTATION_(\d+)/);
    if (rotationMatch) {
      // Some Android builds print the enum value (0..3), others print degrees (0, 90, 180, 270).
      // Normalize to enum: values < 4 are already the enum, larger values are degrees.
      const raw = parseInt(rotationMatch[1], 10);
      rotation = raw < 4 ? raw : raw / 90;
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
  const scale = density / BASE_DENSITY;
  const logicalWidth = Math.round(physicalWidth / scale);
  const logicalHeight = Math.round(physicalHeight / scale);

  return {
    success: true,
    physical: { width: physicalWidth, height: physicalHeight },
    logical: { width: logicalWidth, height: logicalHeight },
    density: density,
    scale: scale,
    rotation: rotation,
    isLandscape: isLandscape
  };
}

// Enable CORS for Figma plugin only. Plugin iframes run sandboxed so the
// browser sends `Origin: null`; some clients (curl, same-process) send no
// Origin at all. Reject any *real* origin so drive-by web pages can't fetch
// /screenshot even though we're bound to loopback.
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null') return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  },
  exposedHeaders: ['X-Resolution']
}));
app.use(express.json());

// Tracks whether the underlying CLI was missing (vs. installed but no device).
// Used at startup to give the user a clearer hint about what to install.
let detectionDiagnostics = { adbMissing: false, pymd3Missing: false };

function isCommandMissing(err) {
  if (!err) return false;
  if (err.code === 127 || err.code === 'ENOENT') return true;
  const text = (err.stderr || err.message || '').toLowerCase();
  return text.includes('command not found') || text.includes('not recognized');
}

// Device type detection function (runs once at startup)
async function detectAndStoreDevice() {
  detectionDiagnostics = { adbMissing: false, pymd3Missing: false };

  // Try Android first
  try {
    const { stdout: adbOutput } = await execAsync('adb devices', { timeout: QUICK_TIMEOUT });
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
    if (isCommandMissing(e)) detectionDiagnostics.adbMissing = true;
  }

  // Try iOS using pymobiledevice3
  try {
    const { stdout: iosOutput } = await execAsync('pymobiledevice3 usbmux list', { timeout: QUICK_TIMEOUT });
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
    if (isCommandMissing(e)) detectionDiagnostics.pymd3Missing = true;
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

  if (!isValidRSDAddress(rsd.address) || !isValidRSDPort(rsd.port)) {
    throw new Error('Invalid iOS tunnel RSD parameters — restart the server and re-enter them.');
  }

  return `${baseCommand} --rsd ${rsd.address} ${rsd.port}`;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Check if device is connected (Android or iOS)
app.get('/device', async (req, res) => {
  // Re-run detection if we previously saw no device — supports plugging in
  // after server start without requiring a restart.
  if (!connectedDevice.connected) {
    await detectAndStoreDevice();
  }

  if (!connectedDevice.connected) {
    return res.json({ connected: false, message: 'No device connected' });
  }

  if (connectedDevice.type === 'android') {
    try {
      // Get device manufacturer and model
      let manufacturer = 'Unknown';
      let model = 'Unknown';
      try {
        const { stdout: mfgOutput } = await execAsync('adb shell getprop ro.product.manufacturer', { timeout: QUICK_TIMEOUT });
        manufacturer = mfgOutput.trim();
      } catch (e) {
        // If getprop fails, use default
      }

      try {
        const { stdout: modelOutput } = await execAsync('adb shell getprop ro.product.model', { timeout: QUICK_TIMEOUT });
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
    if (!connectedDevice.info) {
      return res.status(500).json({ connected: false, error: 'iOS device missing info' });
    }
    // Use stored device info - no need to call pymobiledevice3 again!
    res.json({
      connected: true,
      deviceType: 'ios',
      deviceId: connectedDevice.info.Identifier,
      manufacturer: 'Apple',
      model: getFriendlyModelName(connectedDevice.info.ProductType, connectedDevice.info.DeviceName)
    });
  } else {
    res.status(400).json({ connected: false, error: 'Unknown device type' });
  }
});

// Get device resolution endpoint
app.get('/resolution', async (req, res) => {
  if (!connectedDevice.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (connectedDevice.type === 'android') {
      const resolutionData = await getAndroidResolution();
      res.json(resolutionData);
    } else if (connectedDevice.type === 'ios') {
      if (!connectedDevice.info) {
        return res.status(500).json({ error: 'iOS device missing info' });
      }
      const resolutionInfo = getIOSResolution(connectedDevice.info.ProductType);
      res.json({
        success: true,
        physical: resolutionInfo.physical,
        logical: resolutionInfo.logical,
        density: resolutionInfo.scale * BASE_DENSITY,
        scale: resolutionInfo.scale,
        rotation: 0,
        isLandscape: false
      });
    } else {
      res.status(400).json({ error: 'Unknown device type' });
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
  // Re-run detection if we previously saw no device — supports plugging in
  // after server start without requiring a restart.
  if (!connectedDevice.connected) {
    await detectAndStoreDevice();
  }

  if (!connectedDevice.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  const tempFile = makeTempPath();

  try {
    if (connectedDevice.type === 'android') {
      // Stream screenshot directly from device (faster than file-based approach)
      await execAsync(`adb exec-out screencap -p > "${tempFile}"`, { timeout: SCREENSHOT_TIMEOUT, maxBuffer: 50 * 1024 * 1024 });
    } else if (connectedDevice.type === 'ios') {
      if (!connectedDevice.info) {
        return res.status(500).json({ error: 'iOS device missing info' });
      }
      // Take screenshot using pymobiledevice3 with RSD params
      try {
        const cmd = buildPymobiledevice3Command(
          `pymobiledevice3 developer dvt screenshot "${tempFile}"`
        );
        await execAsync(cmd, { timeout: SCREENSHOT_TIMEOUT });
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

    const imageBuffer = fs.readFileSync(tempFile);
    fs.unlinkSync(tempFile);

    // Get resolution data to include in headers (saves separate fetch)
    let resolutionData = null;
    if (connectedDevice.type === 'ios') {
      // iOS: Use cached device specs (instant) and infer orientation from
      // the captured PNG — iPhoneSpecs are stored portrait, so if the PNG
      // is wider than tall, the device was rotated.
      const resInfo = getIOSResolution(connectedDevice.info.ProductType);
      let physical = resInfo.physical;
      let logical = resInfo.logical;
      let isLandscape = false;
      let rotation = 0;

      try {
        const actual = imageSize(imageBuffer);
        if (actual.width > actual.height) {
          physical = { width: physical.height, height: physical.width };
          logical = { width: logical.height, height: logical.width };
          isLandscape = true;
          rotation = 1; // can't distinguish left/right from dims alone
        }
      } catch (_) { /* detection failed, fall through as portrait */ }

      resolutionData = {
        success: true,
        physical,
        logical,
        density: resInfo.scale * BASE_DENSITY,
        scale: resInfo.scale,
        rotation,
        isLandscape
      };
    } else if (connectedDevice.type === 'android') {
      // Android: Fetch current resolution (rotation may have changed)
      try {
        resolutionData = await getAndroidResolution();
      } catch (e) { /* resolution fetch failed, client can fallback */ }
    }

    // Send resolution as JSON header, image as raw binary
    res.set('Content-Type', 'image/png');
    if (resolutionData) {
      res.set('X-Resolution', JSON.stringify(resolutionData));
    }
    res.send(imageBuffer);

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

// Prompt for iOS RSD configuration if needed
async function promptForIOSConfig() {
  console.log('🔍 Detecting connected devices...\n');
  await detectAndStoreDevice();

  if (!connectedDevice.connected) {
    console.log('❌ No device detected');
    const { adbMissing, pymd3Missing } = detectionDiagnostics;
    if (adbMissing && pymd3Missing) {
      console.log('   Neither `adb` nor `pymobiledevice3` was found in PATH.');
      console.log('   Install Android platform-tools and/or pymobiledevice3 per the README.\n');
    } else if (adbMissing) {
      console.log('   `adb` not found in PATH — install Android platform-tools for Android support.');
      console.log('   (iOS detection ran but found no device.)\n');
    } else if (pymd3Missing) {
      console.log('   `pymobiledevice3` not found in PATH — install it for iOS support.');
      console.log('   (Android detection ran but found no device.)\n');
    } else {
      console.log('   Connect an Android device (via ADB) or iOS device (via USB)\n');
    }
    return;
  }

  if (connectedDevice.type === 'android') {
    // Get Android device details
    try {
      const { stdout: manufacturer } = await execAsync('adb shell getprop ro.product.manufacturer', { timeout: QUICK_TIMEOUT });
      const { stdout: model } = await execAsync('adb shell getprop ro.product.model', { timeout: QUICK_TIMEOUT });
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

    // --rsd flag or env var already populated iosRSDConfig — skip everything
    if (iosRSDConfig.address) {
      console.log(`✓ iOS tunnel configured: ${iosRSDConfig.address}:${iosRSDConfig.port}\n`);
      return;
    }

    await interactiveTunnelSetup();
  }
}

function askOnce(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Ask for an RSD address/port from a user-managed tunnel. We intentionally
// don't auto-spawn `sudo pymobiledevice3 remote start-tunnel` ourselves —
// letting the user run it in a separate terminal avoids the TTY/password
// kludge and keeps this process unprivileged.
async function interactiveTunnelSetup() {
  console.log('iOS tunnel required:');
  console.log('  1. In another terminal, run:  sudo pymobiledevice3 remote start-tunnel');
  console.log('  2. Paste its `--rsd <addr> <port>` line below (with or without the --rsd).');
  console.log('     e.g.  --rsd fd17:e13c:9ab0::1 56673');
  console.log('');

  while (true) {
    const answer = (await askOnce('RSD: ')).trim();

    if (answer === '') {
      console.log('⚠️  No input. Paste the --rsd line from your tunnel, or Ctrl+C to abort.\n');
      continue;
    }

    let parts = answer.split(/\s+/);
    if (parts[0] === '--rsd') parts = parts.slice(1);

    if (parts.length >= 2 && isValidRSDAddress(parts[0]) && isValidRSDPort(parts[1])) {
      iosRSDConfig.address = parts[0];
      iosRSDConfig.port = parts[1];
      console.log(`\n✓ iOS tunnel configured: ${parts[0]} ${parts[1]}\n`);
      return;
    }

    console.log('⚠️  Invalid RSD values. Expected <addr> <port>, e.g. fd17:e13c:9ab0::1 56673\n');
  }
}

// Start server
async function startServer() {
  await promptForIOSConfig();

  // Bind to loopback explicitly — the plugin connects via localhost, and
  // binding to 0.0.0.0 would expose device control + screenshots to anyone
  // on the same network.
  app.listen(PORT, '127.0.0.1', () => {
    process.stdout.write('\n'); // ensure clean line after any tunnel output
    console.log(`🚀 Server running on http://127.0.0.1:${PORT}`);

    const rsd = getIOSRSDParams();
    if (rsd.configured) {
      console.log(`✓ iOS tunnel active: ${rsd.address} ${rsd.port}`);
    } else if (connectedDevice.type === 'ios') {
      console.log(`⚠️  iOS tunnel not configured — screenshots will fail`);
    }

    console.log('\n  ✅ Ready — switch to Figma and use the plugin\n');
  });
}

startServer();
