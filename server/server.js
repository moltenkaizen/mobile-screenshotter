const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;

// Enable CORS for Figma plugin
app.use(cors());
app.use(express.json());

// Device type detection function
async function detectDeviceType() {
  // Try Android first
  try {
    const { stdout: adbOutput } = await execAsync('adb devices');
    const androidDevices = adbOutput.split('\n')
      .filter(line => line.trim() && !line.includes('List of devices'))
      .filter(line => line.includes('\tdevice'));

    if (androidDevices.length > 0) {
      const deviceId = androidDevices[0].split('\t')[0];
      return { type: 'android', connected: true, id: deviceId };
    }
  } catch (e) {
    // ADB not available or no devices
  }

  // Try iOS
  try {
    const { stdout: iosOutput } = await execAsync('idevice_id -l');
    const iosDevices = iosOutput.split('\n').filter(line => line.trim());

    if (iosDevices.length > 0) {
      return { type: 'ios', connected: true, id: iosDevices[0] };
    }
  } catch (e) {
    // libimobiledevice not available or no devices
  }

  return { type: null, connected: false };
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Check if device is connected (Android or iOS)
app.get('/device', async (req, res) => {
  const device = await detectDeviceType();

  if (!device.connected) {
    return res.json({ connected: false, message: 'No device connected' });
  }

  if (device.type === 'android') {
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
        deviceId: device.id,
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
  } else if (device.type === 'ios') {
    try {
      const { stdout: deviceName } = await execAsync(`ideviceinfo -u ${device.id} -k DeviceName`);

      res.json({
        connected: true,
        deviceType: 'ios',
        deviceId: device.id,
        manufacturer: 'Apple',
        model: deviceName.trim() || 'iPhone'
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

// Get device resolution endpoint
app.get('/resolution', async (req, res) => {
  const device = await detectDeviceType();

  if (!device.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (device.type === 'android') {
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
    } else if (device.type === 'ios') {
      // iOS - take a screenshot and read its dimensions
      const tempFile = path.join(__dirname, 'temp_resolution_detect.png');
      await execAsync(`idevicescreenshot -u ${device.id} "${tempFile}"`);

      const sizeOf = require('image-size');
      const dimensions = sizeOf(tempFile);
      fs.unlinkSync(tempFile);

      // Estimate scale factor (2x or 3x)
      // Most modern iPhones are @3x (width > 1100)
      const scale = dimensions.width > 1100 ? 3 : 2;
      const logicalWidth = Math.round(dimensions.width / scale);
      const logicalHeight = Math.round(dimensions.height / scale);

      res.json({
        success: true,
        physical: { width: dimensions.width, height: dimensions.height },
        logical: { width: logicalWidth, height: logicalHeight },
        density: scale * 160, // Fake density to match Android format
        scale: scale,
        rotation: 0,
        isLandscape: dimensions.width > dimensions.height
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
  const device = await detectDeviceType();

  if (!device.connected) {
    return res.status(400).json({ error: 'No device connected' });
  }

  try {
    if (device.type === 'android') {
      // Take screenshot and pull it to local machine
      await execAsync('adb shell screencap -p /sdcard/screenshot.png');
      await execAsync(`adb pull /sdcard/screenshot.png "${tempFile}"`);
      await execAsync('adb shell rm /sdcard/screenshot.png');
    } else if (device.type === 'ios') {
      // iOS - much simpler!
      await execAsync(`idevicescreenshot -u ${device.id} "${tempFile}"`);
    }

    // Read the screenshot file
    const imageBuffer = fs.readFileSync(tempFile);
    const base64Image = imageBuffer.toString('base64');

    // Clean up temp file
    fs.unlinkSync(tempFile);

    // Send as JSON with base64 data
    res.json({
      success: true,
      image: base64Image,
      format: 'png'
    });

  } catch (error) {
    console.error('Screenshot error:', error);

    // Clean up temp file if it exists
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }

    res.status(500).json({
      error: 'Failed to capture screenshot',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Mobile Screenshot Server running on http://localhost:${PORT}`);
  console.log(`📱 Connect your Android (via ADB) or iOS (via USB) device`);
  console.log(`💡 Test connection: http://localhost:${PORT}/health`);
});
