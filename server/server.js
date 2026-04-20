const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;
const BASE_DENSITY = 160; // Android baseline density (mdpi)

// Store RSD params in memory (set via env vars, --rsd flag, or interactive prompt)
let iosRSDConfig = {
  address: process.env.IOS_RSD_ADDRESS || null,
  port: process.env.IOS_RSD_PORT || null
};

// Handle to the auto-spawned tunnel child process (iOS only)
let tunnelProcess = null;

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

// Get Android resolution (extracted to avoid duplication)
async function getAndroidResolution() {
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
    const rotationMatch = rotationOutput.match(/ROTATION_(\d+)/);
    if (rotationMatch) {
      rotation = parseInt(rotationMatch[1]) / 90;
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

// Enable CORS for Figma plugin
app.use(cors({
  exposedHeaders: ['X-Resolution']
}));
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
  const tempFile = path.join(__dirname, 'temp_screenshot.png');

  if (!connectedDevice.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (connectedDevice.type === 'android') {
      // Stream screenshot directly from device (faster than file-based approach)
      await execAsync(`adb exec-out screencap -p > "${tempFile}"`, { maxBuffer: 50 * 1024 * 1024 });
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

    const imageBuffer = fs.readFileSync(tempFile);
    fs.unlinkSync(tempFile);

    // Get resolution data to include in headers (saves separate fetch)
    let resolutionData = null;
    if (connectedDevice.type === 'ios') {
      // iOS: Use cached device specs (instant)
      const resInfo = getIOSResolution(connectedDevice.info.ProductType);
      resolutionData = {
        success: true,
        physical: resInfo.physical,
        logical: resInfo.logical,
        density: resInfo.scale * BASE_DENSITY,
        scale: resInfo.scale,
        rotation: 0,
        isLandscape: false
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

// Attempt to auto-spawn the iOS tunnel. Resolves with { address, port } on success, rejects otherwise.
function startTunnel() {
  return new Promise((resolve, reject) => {
    console.log('🔌 Starting iOS tunnel automatically...');
    console.log('   (you may be prompted for your sudo password)\n');

    const child = spawn(
      'sudo',
      ['pymobiledevice3', 'remote', 'start-tunnel'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    tunnelProcess = child;

    let stderrBuf = '';
    let resolved = false;

    const done = (address, port) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ address, port });
    };

    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) {}
      tunnelProcess = null;
      reject(err);
    };

    // Give the user time to type their sudo password and for the tunnel to initialise
    const timer = setTimeout(() => fail(new Error('Timed out waiting for tunnel (60s)')), 60000);

    function tryParse(buf) {
      for (const line of buf.split('\n')) {
        const t = line.trim();
        if (!t) continue;

        // "--rsd fd17:e13c:9ab0::1 56673" (confirmed real output format)
        const rsdMatch = t.match(/--rsd\s+([\S]+)\s+(\d+)/);
        if (rsdMatch) return done(rsdMatch[1], rsdMatch[2]);
      }

      // Multi-line fallback: "RSD Address:" followed by "RSD Port:"
      const addrMatch = buf.match(/RSD Address:\s*([\S]+)/i);
      const portMatch = buf.match(/RSD Port:\s*(\d+)/i);
      if (addrMatch && portMatch) return done(addrMatch[1], portMatch[1]);
    }

    child.stdout.on('data', () => {}); // drain stdout (unused without --script-mode)

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString(); // buffer silently; only shown on failure
      tryParse(stderrBuf);
    });

    child.on('error', (err) => fail(new Error(`Failed to spawn tunnel: ${err.message}`)));

    child.on('close', (code) => {
      if (!resolved) {
        if (stderrBuf) process.stderr.write(stderrBuf); // show suppressed output on failure
        fail(new Error(`Tunnel process exited early (code ${code})`));
      }
    });
  });
}

// Clean up tunnel child process on server exit
function cleanupTunnel() {
  if (tunnelProcess) {
    console.log('\n🔌 Stopping tunnel...');
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
  }
}

process.on('SIGINT',  () => { cleanupTunnel(); process.exit(0); });
process.on('SIGTERM', () => { cleanupTunnel(); process.exit(0); });

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

    // --rsd flag or env var already populated iosRSDConfig — skip everything
    if (iosRSDConfig.address) {
      console.log(`✓ iOS tunnel configured: ${iosRSDConfig.address}:${iosRSDConfig.port}\n`);
      return;
    }

    // Auto-tunnel attempt
    try {
      const { address, port } = await startTunnel();
      iosRSDConfig.address = address;
      iosRSDConfig.port = port;
      console.log(`\n✓ iOS tunnel ready: ${address} ${port}\n`);
      return;
    } catch (autoErr) {
      console.log(`\n⚠️  Auto-tunnel failed: ${autoErr.message}`);
      console.log('   Falling back to manual entry...\n');
    }

    // Fallback: single-line manual prompt
    console.log('   Run in another terminal:  sudo pymobiledevice3 remote start-tunnel');
    console.log('   Then paste the address and port below as:  <address> <port>');
    console.log('   Example:  fd17:e13c:9ab0::1 56673\n');

    // Drain any characters buffered in stdin (e.g. Enter from sudo password prompt)
    await new Promise(r => setTimeout(r, 100));
    while (process.stdin.read() !== null) {}

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await new Promise((resolve) => {
      rl.question('RSD address and port: ', (answer) => {
        const parts = answer.trim().split(/\s+/);
        if (parts.length >= 2) {
          iosRSDConfig.address = parts[0];
          iosRSDConfig.port = parts[1];
        } else {
          console.log('\n⚠️  No RSD info entered — iOS screenshots will not work.');
          console.log('   Restart the server to try again.\n');
        }
        rl.close();
        resolve();
      });
    });
  }
}

// Start server
async function startServer() {
  await promptForIOSConfig();

  app.listen(PORT, () => {
    process.stdout.write('\n'); // ensure clean line after any tunnel output
    console.log(`🚀 Server running on http://localhost:${PORT}`);

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
