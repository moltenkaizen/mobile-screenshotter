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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Check if ADB device is connected
app.get('/device', async (req, res) => {
  try {
    const { stdout } = await execAsync('adb devices');
    const lines = stdout.split('\n').filter(line => line.trim() && !line.includes('List of devices'));

    if (lines.length === 0) {
      return res.json({ connected: false, message: 'No device connected' });
    }

    const deviceInfo = lines[0].split('\t');
    res.json({
      connected: true,
      deviceId: deviceInfo[0],
      status: deviceInfo[1]
    });
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: 'ADB not found or not in PATH',
      message: error.message
    });
  }
});

// Take screenshot endpoint
app.get('/screenshot', async (req, res) => {
  const tempFile = path.join(__dirname, 'temp_screenshot.png');

  try {
    // Check if device is connected
    const { stdout: devicesOutput } = await execAsync('adb devices');
    const deviceLines = devicesOutput.split('\n').filter(line => line.trim() && !line.includes('List of devices'));

    if (deviceLines.length === 0) {
      return res.status(400).json({ error: 'No Android device connected' });
    }

    // Take screenshot and pull it to local machine
    await execAsync('adb shell screencap -p /sdcard/screenshot.png');
    await execAsync(`adb pull /sdcard/screenshot.png "${tempFile}"`);
    await execAsync('adb shell rm /sdcard/screenshot.png');

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
  console.log(`🚀 Android Screenshot Server running on http://localhost:${PORT}`);
  console.log(`📱 Make sure your Android device is connected via ADB`);
  console.log(`💡 Test connection: http://localhost:${PORT}/health`);
});
