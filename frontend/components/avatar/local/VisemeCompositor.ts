import { MOUTH_MASK, traceMouthMask } from "./MouthMask.ts";
import type { LocalViseme } from "./LipSyncTimeline.ts";

export type VisemeRenderState = {
  previousViseme: LocalViseme;
  currentViseme: LocalViseme;
  /** AudioContext seconds at which the current crossfade started. */
  transitionStartedAt: number;
  /** Duration of the current crossfade in milliseconds. */
  transitionDurationMs: number;
  /** Mouth openness [0, 1]. In Phase 2, full opacity = 1 is always used during speech. */
  intensity?: number;
};

/**
 * Compute blend weights for a two-way cross-fade between previous and current visemes.
 *
 * Guarantees:
 * 1. previous + current === 1 at all times.
 * 2. Closed mbp is NOT mixed underneath as an amplitude base (closed === 0).
 * 3. Weights are independent of RMS amplitude.
 * 4. During stable pose (elapsedMs >= transitionDurationMs), previous === 0 and current === 1.
 *
 * @param state      Current render state.
 * @param audioTime  AudioContext.currentTime (seconds).
 */
export function transitionWeights(
  state: VisemeRenderState,
  audioTime: number,
): { previous: number; current: number; closed: number } {
  const elapsedMs = Math.max(0, (audioTime - state.transitionStartedAt) * 1000);
  const p         = Math.min(1, elapsedMs / Math.max(1, state.transitionDurationMs));

  let blend: number;
  if (state.previousViseme === "mbp" && state.currentViseme !== "mbp") {
    // Ballistic plosive release: hold sealed lips until release threshold, then snap open
    if (p <= 0.5) {
      blend = Math.pow(p / 0.5, 3) * 0.06;
    } else {
      const rel = (p - 0.5) / 0.5;
      const t = 3 * rel * rel - 2 * rel * rel * rel;
      blend = 0.06 + 0.94 * t;
    }
  } else {
    // Hermite smoothstep easing (3p^2 - 2p^3) eliminates the linear 50% contrast dip
    blend = 3 * p * p - 2 * p * p * p;
  }

  return {
    previous: 1 - blend,
    current:  blend,
    closed:   0,
  };
}

export function compositeVisemes(
  destination: CanvasRenderingContext2D,
  workCanvas: HTMLCanvasElement,
  images: Record<LocalViseme, CanvasImageSource>,
  state: VisemeRenderState,
  audioTime: number,
): void {
  const work = workCanvas.getContext("2d");
  if (!work) return;
  const { sourceWidth, sourceHeight, featherRadius } = MOUTH_MASK;
  work.clearRect(0, 0, sourceWidth, sourceHeight);
  const weights = transitionWeights(state, audioTime);

  // Safe fallback to preserve last valid display if an image is missing
  const prevImg = images[state.previousViseme] || images.mbp;
  const currImg = images[state.currentViseme]  || images.mbp;

  // Crossfade between previous and current visemes only.
  // No mbp is drawn underneath as an amplitude layer.
  if (weights.previous > 0 && prevImg) {
    work.globalAlpha = weights.previous;
    work.drawImage(prevImg, 0, 0, sourceWidth, sourceHeight);
  }
  if (weights.current > 0 && currImg) {
    work.globalAlpha = weights.current;
    work.drawImage(currImg, 0, 0, sourceWidth, sourceHeight);
  }
  work.globalAlpha = 1;

  // Clip to the mouth polygon with feathered edges.
  work.globalCompositeOperation = "destination-in";
  work.save();
  work.filter = `blur(${featherRadius}px)`;
  traceMouthMask(work);
  work.fillStyle = "#fff";
  work.fill();
  work.restore();
  work.globalCompositeOperation = "source-over";
  destination.drawImage(workCanvas, 0, 0, sourceWidth, sourceHeight);
}
