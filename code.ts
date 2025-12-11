// This plugin captures screenshots from mobile devices (Android via ADB, iOS via libimobiledevice)
// and places them into the current Figma file

interface ResolutionData {
  physical: { width: number; height: number };
  logical: { width: number; height: number };
  density: number;
  scale: number;
}

// Show the plugin UI
figma.showUI(__html__, { width: 280, height: 295 });

// Handle messages from the UI
figma.ui.onmessage = async (msg: {
  type: string;
  imageData?: number[];
  useLogicalSize?: boolean;
  resolutionData?: ResolutionData;
}) => {
  if (msg.type === 'create-screenshot') {
    try {
      if (!msg.imageData || !msg.resolutionData) {
        figma.notify('Error: Missing screenshot data', { error: true });
        return;
      }

      const bytes = new Uint8Array(msg.imageData);
      const image = figma.createImage(bytes);
      const imageHash = image.hash;
      const { width: physicalWidth, height: physicalHeight } = await image.getSizeAsync();

      // Always create frame, use logical or physical size based on toggle
      await createFramedScreenshot(
        imageHash,
        physicalWidth,
        physicalHeight,
        msg.resolutionData,
        msg.useLogicalSize ?? true
      );
    } catch (error: unknown) {
      console.error('Error creating screenshot:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      figma.notify('Failed to create screenshot: ' + errorMessage, { error: true });
    }
  }
};

async function createFramedScreenshot(
  imageHash: string,
  physicalWidth: number,
  physicalHeight: number,
  resolutionData: ResolutionData,
  useLogicalSize: boolean
): Promise<void> {
  // Create frame
  const frame = figma.createFrame();

  // Generate timestamp for frame name
  const now = new Date();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();
  const hours = now.getHours();
  const minutesNum = now.getMinutes();
  const minutes = minutesNum < 10 ? '0' + minutesNum : minutesNum.toString();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;

  frame.name = `Screenshot - ${month} ${day}, ${year} ${displayHours}:${minutes} ${ampm}`;

  // Choose frame size based on toggle
  const frameWidth = useLogicalSize ? resolutionData.logical.width : resolutionData.physical.width;
  const frameHeight = useLogicalSize ? resolutionData.logical.height : resolutionData.physical.height;

  // Resize frame
  frame.resize(frameWidth, frameHeight);
  frame.constrainProportions = true;

  // Create image rectangle
  const imageRect = figma.createRectangle();
  imageRect.name = 'Screenshot Image';

  // Resize image to match frame dimensions
  imageRect.resize(frameWidth, frameHeight);

  imageRect.fills = [{ type: 'IMAGE', imageHash: imageHash, scaleMode: 'FILL' }];

  // Set constraints to STRETCH in both directions
  imageRect.constraints = {
    horizontal: 'STRETCH',
    vertical: 'STRETCH'
  };

  // Add image to frame
  frame.appendChild(imageRect);

  // Position frame in viewport
  const viewport = figma.viewport.center;
  frame.x = viewport.x - frameWidth / 2;
  frame.y = viewport.y - frameHeight / 2;

  // Add to page, select, and zoom
  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);

  figma.notify('Screenshot added to canvas!');
}
