// This plugin captures screenshots from mobile devices (Android via ADB, iOS via pymobiledevice3)
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
      const totalStart = Date.now();
      console.log('[FIGMA] ========== Processing screenshot ==========');

      if (!msg.imageData || !msg.resolutionData) {
        figma.notify('Error: Missing screenshot data', { error: true });
        return;
      }

      let start = Date.now();
      const bytes = new Uint8Array(msg.imageData);
      console.log(`[FIGMA] Uint8Array conversion: ${Date.now() - start}ms (${(bytes.length / 1024).toFixed(0)} KB)`);

      start = Date.now();
      const image = figma.createImage(bytes);
      console.log(`[FIGMA] createImage: ${Date.now() - start}ms`);

      start = Date.now();
      const imageHash = image.hash;
      console.log(`[FIGMA] get hash: ${Date.now() - start}ms`);

      start = Date.now();
      const { width: physicalWidth, height: physicalHeight } = await image.getSizeAsync();
      console.log(`[FIGMA] getSizeAsync: ${Date.now() - start}ms (${physicalWidth}x${physicalHeight})`);

      start = Date.now();
      // Always create frame, use logical or physical size based on toggle
      await createFramedScreenshot(
        imageHash,
        msg.resolutionData,
        msg.useLogicalSize ?? true
      );
      console.log(`[FIGMA] createFramedScreenshot: ${Date.now() - start}ms`);
      console.log(`[FIGMA] ========== TOTAL: ${Date.now() - totalStart}ms ==========`);
    } catch (error: unknown) {
      console.error('Error creating screenshot:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      figma.notify('Failed to create screenshot: ' + errorMessage, { error: true });
    }
  }
};

async function createFramedScreenshot(
  imageHash: string,
  resolutionData: ResolutionData,
  useLogicalSize: boolean
): Promise<void> {
  let start = Date.now();

  // Create frame
  const frame = figma.createFrame();
  console.log(`[FRAME] createFrame: ${Date.now() - start}ms`);

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
  start = Date.now();
  frame.resize(frameWidth, frameHeight);
  console.log(`[FRAME] resize frame: ${Date.now() - start}ms`);

  // Create image rectangle
  start = Date.now();
  const imageRect = figma.createRectangle();
  imageRect.name = 'Screenshot Image';
  console.log(`[FRAME] createRectangle: ${Date.now() - start}ms`);

  // Resize image to match frame dimensions
  start = Date.now();
  imageRect.resize(frameWidth, frameHeight);
  console.log(`[FRAME] resize rect: ${Date.now() - start}ms`);

  start = Date.now();
  imageRect.fills = [{ type: 'IMAGE', imageHash: imageHash, scaleMode: 'FILL' }];
  console.log(`[FRAME] set fills: ${Date.now() - start}ms`);

  // Set constraints to STRETCH in both directions
  imageRect.constraints = {
    horizontal: 'STRETCH',
    vertical: 'STRETCH'
  };

  // Add image to frame
  start = Date.now();
  frame.appendChild(imageRect);
  console.log(`[FRAME] appendChild to frame: ${Date.now() - start}ms`);

  // Find the best parent container (Section or page)
  const viewport = figma.viewport.center;
  let parentContainer: BaseNode & ChildrenMixin = figma.currentPage;

  // Check if viewport center is inside any Section (sections are always top-level)
  start = Date.now();
  const sections = figma.currentPage.children.filter(node => node.type === 'SECTION') as SectionNode[];
  console.log(`[FRAME] filter sections: ${Date.now() - start}ms (found ${sections.length})`);

  for (const section of sections) {
    if (viewport.x >= section.x &&
        viewport.x <= section.x + section.width &&
        viewport.y >= section.y &&
        viewport.y <= section.y + section.height) {
      parentContainer = section;
      break;
    }
  }

  // Position frame in viewport center (adjust for Section-relative coordinates if needed)
  if (parentContainer.type === 'SECTION') {
    frame.x = viewport.x - parentContainer.x - frameWidth / 2;
    frame.y = viewport.y - parentContainer.y - frameHeight / 2;
  } else {
    frame.x = viewport.x - frameWidth / 2;
    frame.y = viewport.y - frameHeight / 2;
  }

  // Add to parent container and select
  start = Date.now();
  parentContainer.appendChild(frame);
  console.log(`[FRAME] appendChild to parent: ${Date.now() - start}ms`);

  start = Date.now();
  figma.currentPage.selection = [frame];
  console.log(`[FRAME] set selection: ${Date.now() - start}ms`);

  figma.notify('Screenshot added to canvas!');
}
