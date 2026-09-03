export type MouthMaskConfig = {
  sourceWidth: 1254;
  sourceHeight: 1254;
  polygon: Array<{ x: number; y: number }>;
  featherRadius: number;
};

// Calibrated against the existing 1254px frames: top edge is below the nostrils,
// side points include both mouth corners, and the lower edge includes the moving chin.
export const MOUTH_MASK: MouthMaskConfig = {
  sourceWidth: 1254,
  sourceHeight: 1254,
  polygon: [
    { x: 438, y: 538 }, { x: 515, y: 512 }, { x: 627, y: 518 }, { x: 739, y: 512 },
    { x: 816, y: 538 }, { x: 842, y: 628 }, { x: 796, y: 742 }, { x: 704, y: 790 },
    { x: 550, y: 790 }, { x: 458, y: 742 }, { x: 412, y: 628 },
  ],
  featherRadius: 22,
};

export function traceMouthMask(context: CanvasRenderingContext2D, config = MOUTH_MASK): void {
  const [first, ...rest] = config.polygon;
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of rest) context.lineTo(point.x, point.y);
  context.closePath();
}
