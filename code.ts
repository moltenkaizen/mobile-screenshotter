// This plugin captures screenshots from mobile devices (Android via ADB, iOS via libimobiledevice)
// and places them into the current Figma file

// Show the plugin UI
figma.showUI(__html__, { width: 280, height: 240 });

// Handle messages from the UI
figma.ui.onmessage = async (msg: { type: string; imageData?: string }) => {
  if (msg.type === 'create-screenshot') {
    try {
      if (!msg.imageData) {
        figma.notify('Error: No image data received', { error: true });
        return;
      }

      // Convert base64 to Uint8Array
      const base64Data = msg.imageData;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const binaryString = (globalThis as any).atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Create image in Figma
      const image = figma.createImage(bytes);
      const imageHash = image.hash;

      // Create a rectangle to hold the image
      const rect = figma.createRectangle();

      // Get image dimensions
      const { width, height } = await image.getSizeAsync();

      rect.resize(width, height);

      // Set the image as a fill
      rect.fills = [
        {
          type: 'IMAGE',
          imageHash: imageHash,
          scaleMode: 'FILL'
        }
      ];

      // Position the screenshot near the viewport center
      const viewport = figma.viewport.center;
      rect.x = viewport.x - width / 2;
      rect.y = viewport.y - height / 2;

      // Add to current page
      figma.currentPage.appendChild(rect);

      // Select the new screenshot
      figma.currentPage.selection = [rect];

      // Zoom to fit the screenshot
      figma.viewport.scrollAndZoomIntoView([rect]);

      figma.notify('Screenshot added to canvas!');
    } catch (error: unknown) {
      console.error('Error creating screenshot:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      figma.notify('Failed to create screenshot: ' + errorMessage, { error: true });
    }
  }
};
