export type EyeConfig = {
  sourceWidth: 1254;
  sourceHeight: 1254;
  leftEye: {
    centerX: number;
    centerY: number;
    radiusX: number;
    radiusY: number;
    offsetX: number;
    offsetY: number;
  };
  rightEye: {
    centerX: number;
    centerY: number;
    radiusX: number;
    radiusY: number;
    offsetX: number;
    offsetY: number;
  };
  featherRadius: number;
};

// Calibrated against matching 1254px avatar frames:
// Mask fits strictly inside the glasses lens apertures (y: 350-475).
// Preserves black glasses frames, eyebrows, nose bridge, and surrounding face.
export const EYE_CONFIG: EyeConfig = {
  sourceWidth: 1254,
  sourceHeight: 1254,
  leftEye: {
    centerX: 500,
    centerY: 425,
    radiusX: 95,
    radiusY: 72,
    offsetX: 0,
    offsetY: 0,
  },
  rightEye: {
    centerX: 735,
    centerY: 425,
    radiusX: 98,
    radiusY: 72,
    offsetX: 0,
    offsetY: 0,
  },
  featherRadius: 12,
};

/**
 * Trace the complete elliptical boundaries of both eyes.
 * Used for destination-in feathered alpha masking identical to traceMouthMask.
 * Both eyes are traced as complete ellipses inside the glasses lenses with independent subpaths.
 */
export function traceEyeMask(
  context: CanvasRenderingContext2D,
  config: EyeConfig = EYE_CONFIG,
): void {
  context.beginPath();

  // Left eye (viewer's left)
  context.moveTo(config.leftEye.centerX + config.leftEye.radiusX, config.leftEye.centerY);
  context.ellipse(
    config.leftEye.centerX,
    config.leftEye.centerY,
    config.leftEye.radiusX,
    config.leftEye.radiusY,
    0,
    0,
    Math.PI * 2,
  );
  context.closePath();

  // Right eye (viewer's right)
  context.moveTo(config.rightEye.centerX + config.rightEye.radiusX, config.rightEye.centerY);
  context.ellipse(
    config.rightEye.centerX,
    config.rightEye.centerY,
    config.rightEye.radiusX,
    config.rightEye.radiusY,
    0,
    0,
    Math.PI * 2,
  );
  context.closePath();
}

/**
 * Composites the closed eye patches from closedImage onto destination context.
 * Uses the exact same destination-in masked feathering technique as VisemeCompositor.
 *
 * @param destination  Context receiving the composite (e.g. fullFrame canvas)
 * @param workCanvas   Dedicated offscreen buffer (1254x1254)
 * @param closedImage  Decoded HTMLImageElement for closed.png
 * @param progress     Blink progression blend weight [0, 1] (0 = fully open, 1 = fully closed)
 * @param config       Eye configuration
 */
export function compositeEyes(
  destination: CanvasRenderingContext2D,
  workCanvas: HTMLCanvasElement,
  closedImage: CanvasImageSource,
  progress: number,
  config: EyeConfig = EYE_CONFIG,
): void {
  const alpha = Math.min(1, Math.max(0, progress));
  if (alpha <= 0.001) return;

  const work = workCanvas.getContext("2d");
  if (!work) return;

  const { sourceWidth, sourceHeight, leftEye, rightEye, featherRadius } = config;
  work.clearRect(0, 0, sourceWidth, sourceHeight);

  // Step 1: Draw full closedImage onto work canvas without hard clipping (matching VisemeCompositor)
  if (leftEye.offsetX === 0 && leftEye.offsetY === 0 && rightEye.offsetX === 0 && rightEye.offsetY === 0) {
    work.drawImage(closedImage, 0, 0, sourceWidth, sourceHeight);
  } else {
    // If any per-eye offset is configured, draw each half with its respective offset
    const midX = 620;
    work.save();
    work.beginPath();
    work.rect(0, 0, midX, sourceHeight);
    work.clip();
    work.drawImage(closedImage, leftEye.offsetX, leftEye.offsetY, sourceWidth, sourceHeight);
    work.restore();

    work.save();
    work.beginPath();
    work.rect(midX, 0, sourceWidth - midX, sourceHeight);
    work.clip();
    work.drawImage(closedImage, rightEye.offsetX, rightEye.offsetY, sourceWidth, sourceHeight);
    work.restore();
  }

  // Step 2: Feather mask edges using destination-in (identical to VisemeCompositor)
  work.globalCompositeOperation = "destination-in";
  work.save();
  work.filter = `blur(${featherRadius}px)`;
  traceEyeMask(work, config);
  work.fillStyle = "#fff";
  work.fill();
  work.restore();
  work.filter = "none";
  work.globalCompositeOperation = "source-over";

  // Step 3: Composite masked closed-eye layer onto destination with blink transition opacity
  destination.save();
  destination.globalAlpha = alpha;
  destination.drawImage(workCanvas, 0, 0, sourceWidth, sourceHeight);
  destination.restore();
}

