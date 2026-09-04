"use client";

import { useEffect, useRef } from "react";
import type { AvatarState } from "../../types";
import type { AudioPlaybackController } from "./AudioPlaybackController";
import { BlinkController } from "./BlinkController";
import { compositeEyes, EYE_CONFIG } from "./EyeMask";
import { findVisemeAtTime, type LocalViseme, type VisemeEvent, VISEMES } from "./LipSyncTimeline";
import { MOUTH_MASK } from "./MouthMask";
import { compositeVisemes, type VisemeRenderState } from "./VisemeCompositor";
import {
  advanceScheduler,
  createSchedulerState,
  POSE_CONFIG,
  type SchedulerState,
} from "./VisualPoseScheduler";

// ─────────────────────────────────────────────────────────────────────────────
// Asset paths
// ─────────────────────────────────────────────────────────────────────────────

const ASSET_PATHS: Record<LocalViseme, string> = Object.fromEntries(
  VISEMES.map((viseme) => [viseme, `/avatar/mouth/${viseme}.png`]),
) as Record<LocalViseme, string>;

// ─────────────────────────────────────────────────────────────────────────────
// Amplitude smoothing
// Per-frame IIR coefficients at target time constants.
//   attack  ≈ 70 ms  → coeff ≈ 1 - exp(-16.7/70)  ≈ 0.21
//   release ≈ 210 ms → coeff ≈ 1 - exp(-16.7/210) ≈ 0.077
// Narrower intensity band while speaking avoids amplitude-induced opacity jitter.
// ─────────────────────────────────────────────────────────────────────────────
const ENERGY = {
  attack:               0.21,   // IIR coeff — rising amplitude
  release:              0.077,  // IIR coeff — falling amplitude
  minSpeakingIntensity: 0.58,   // floor while confirmed speaking
  maxIntensity:         0.92,   // ceiling
  maxFrameDelta:        0.12,   // max intensity delta per 16.7ms frame
};

// ─────────────────────────────────────────────────────────────────────────────
// Time-based silence hysteresis
// All durations in ms. Uses performance.now() — refresh-rate independent.
// ─────────────────────────────────────────────────────────────────────────────
const SILENCE = {
  enterThreshold:  0.010,  // RMS below this for confirmMs → silence
  exitThreshold:   0.016,  // RMS above this for speechConfirmMs → speech
  confirmMs:       70,     // ms below threshold before closing
  speechConfirmMs: 30,     // ms above threshold before opening
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ImageBundle = {
  idle:       HTMLImageElement;
  thinking:   HTMLImageElement;
  eyesClosed: HTMLImageElement;
  visemes:    Record<LocalViseme, HTMLImageElement>;
};

type CanvasCache = {
  cssWidth:    number;
  cssHeight:   number;
  pixelRatio:  number;
  pixelWidth:  number;
  pixelHeight: number;
};

type Props = {
  state: AvatarState;
  playbackController?: AudioPlaybackController | null;
  timeline?: VisemeEvent[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Image loader — called once at mount, never inside the animation loop
// ─────────────────────────────────────────────────────────────────────────────

async function loadAndDecodeImage(src: string, name: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  try {
    await img.decode();
  } catch {
    // decode() may reject on some browsers even when the image loaded fine.
    // If src is set and complete, the image is usable.
    if (!img.complete || img.naturalWidth === 0) {
      if (process.env.NODE_ENV !== "production") {
        console.info("[local-avatar] local_avatar_asset_error", { name });
      }
      throw new Error(`Avatar asset failed: ${name}`);
    }
  }
  return img;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function LocalAvatarCanvas({
  state,
  playbackController = null,
  timeline = [],
}: Props) {
  // Canvas displayed to the user.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  // Offscreen Canvas 1: full-frame buffer (1254x1254) for atomic blitting to visible canvas.
  const fullFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Offscreen Canvas 2: mouth-only work buffer (1254x1254) for blending and feather-masking.
  const mouthCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Offscreen Canvas 3: eye-only work buffer (1254x1254) for blinking feather-masking.
  const eyeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Blink controller for natural timing and eyelid easing.
  const blinkControllerRef = useRef<BlinkController>(new BlinkController());

  // All decoded images — set once after preload, stable for component lifetime.
  const imagesRef = useRef<ImageBundle | null>(null);

  // Cached canvas pixel dimensions — updated only when CSS size or DPR changes.
  const canvasCacheRef = useRef<CanvasCache | null>(null);

  // rAF handle.
  const frameRef = useRef<number | null>(null);

  // Generation counter — incremented on every effect cleanup.
  // Inactive callbacks self-cancel if generation has moved.
  const generationRef = useRef(0);

  const resizeRef = useRef<ResizeObserver | null>(null);

  // Compositor render state (drives VisemeCompositor).
  const renderStateRef = useRef<VisemeRenderState>({
    previousViseme:       "mbp",
    currentViseme:        "mbp",
    transitionStartedAt:  0,
    transitionDurationMs: POSE_CONFIG.TRANSITION_MS,
    intensity:            0,
  });

  // Visual pose scheduler.
  const schedulerRef = useRef<SchedulerState>(createSchedulerState());

  // Smoothed RMS energy.
  const smoothedEnergyRef = useRef(0);

  // Timestamp of last rendered frame for time-based smoothing.
  const lastFrameTimeRef = useRef<number | null>(null);

  // Time-based silence hysteresis state.
  const silenceRef = useRef({
    isSilent:           true,
    thresholdCrossedAt: null as number | null,
  });

  // Per-utterance diagnostic counters (dev only, logged once on completion).
  const diagRef = useRef({ startedAt: 0 });

  // ── Image preload ──────────────────────────────────────────────────────────
  // Runs once. All images are decoded before the animation loop starts.
  // Offscreen double buffers are also initialized here.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadAndDecodeImage("/avatar/idle.png", "idle"),
      loadAndDecodeImage("/avatar/thinking.png", "thinking"),
      loadAndDecodeImage("/avatar/eyes/closed.png", "eyesClosed"),
      ...VISEMES.map((v) => loadAndDecodeImage(ASSET_PATHS[v], v)),
    ]).then((results) => {
      if (cancelled) return;
      const [idle, thinking, eyesClosed, ...visemeImages] = results;
      const visemes = Object.fromEntries(
        VISEMES.map((v, i) => [v, visemeImages[i]]),
      ) as Record<LocalViseme, HTMLImageElement>;
      imagesRef.current = { idle, thinking, eyesClosed, visemes };

      // Initialize offscreen frame, mouth, and eye work canvases once.
      if (!fullFrameCanvasRef.current) {
        const fc = document.createElement("canvas");
        fc.width  = MOUTH_MASK.sourceWidth;
        fc.height = MOUTH_MASK.sourceHeight;
        fullFrameCanvasRef.current = fc;
      }
      if (!mouthCanvasRef.current) {
        const mc = document.createElement("canvas");
        mc.width  = MOUTH_MASK.sourceWidth;
        mc.height = MOUTH_MASK.sourceHeight;
        mouthCanvasRef.current = mc;
      }
      if (!eyeCanvasRef.current) {
        const ec = document.createElement("canvas");
        ec.width  = EYE_CONFIG.sourceWidth;
        ec.height = EYE_CONFIG.sourceHeight;
        eyeCanvasRef.current = ec;
      }

      drawFrame(0);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // ── Canvas resize — guarded so dimensions change only on actual size delta ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const applyResize = () => {
      const rect  = canvas.getBoundingClientRect();
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const pw    = Math.max(1, Math.round(rect.width  * ratio));
      const ph    = Math.max(1, Math.round(rect.height * ratio));
      const cache = canvasCacheRef.current;

      // Only assign canvas.width / canvas.height if pixel dimensions or DPR changed.
      // Reassigning canvas.width clears canvas content immediately.
      if (!cache || cache.pixelWidth !== pw || cache.pixelHeight !== ph || cache.pixelRatio !== ratio) {
        canvas.width  = pw;
        canvas.height = ph;
        canvasCacheRef.current = {
          cssWidth:   rect.width,
          cssHeight:  rect.height,
          pixelRatio: ratio,
          pixelWidth: pw,
          pixelHeight: ph,
        };
        drawFrame();
      }
    };

    resizeRef.current = new ResizeObserver(applyResize);
    resizeRef.current.observe(canvas);
    applyResize();
    return () => {
      resizeRef.current?.disconnect();
      resizeRef.current = null;
    };
  }, []);

  // ── Animation loop with generation guard ───────────────────────────────────
  useEffect(() => {
    // Cancel any still-pending frame from the previous render.
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (state !== "speaking" || !playbackController) {
      // Reset per-utterance state.
      smoothedEnergyRef.current = 0;
      lastFrameTimeRef.current  = null;
      silenceRef.current = { isSilent: true, thresholdCrossedAt: null };
      schedulerRef.current = createSchedulerState();
      renderStateRef.current = {
        previousViseme: "mbp", currentViseme: "mbp",
        transitionStartedAt: 0, transitionDurationMs: POSE_CONFIG.TRANSITION_MS, intensity: 0,
      };

      // In "thinking" state: strictly NO blinking.
      // Reset blink controller schedule so leaving thinking schedules a clean ~3s delay.
      if (state === "thinking") {
        blinkControllerRef.current.cancelBlink(performance.now());
        drawFrame(0);
        return () => {
          generationRef.current += 1;
          if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
          }
        };
      }

      // In "idle" state: normal natural blinking (~3s interval)
      const myGeneration = generationRef.current;
      let wasBlinking = false;

      const idleTick = () => {
        if (generationRef.current !== myGeneration) return;

        const nowMs = performance.now();
        const blinkOpacity = blinkControllerRef.current.getBlinkProgress(nowMs);
        const isBlinkingNow = blinkOpacity > 0.001;

        if (isBlinkingNow || wasBlinking) {
          drawFrame(blinkOpacity);
          wasBlinking = isBlinkingNow;
        }

        frameRef.current = requestAnimationFrame(idleTick);
      };

      drawFrame(0);
      frameRef.current = requestAnimationFrame(idleTick);
      return () => {
        generationRef.current += 1;
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      };
    }

    // New utterance — reset state and capture generation.
    schedulerRef.current     = createSchedulerState();
    silenceRef.current       = { isSilent: true, thresholdCrossedAt: null };
    diagRef.current          = { startedAt: performance.now() };
    lastFrameTimeRef.current = null;

    const myGeneration = generationRef.current;

    // Capture stable references at effect start.
    const capturedController = playbackController;
    const capturedTimeline   = timeline;

    const tick = () => {
      // Invalidate if this loop was superseded by an effect cleanup/restart.
      if (generationRef.current !== myGeneration) return;

      drawFrameForSpeech(capturedController, capturedTimeline);

      if (capturedController.getCurrentUtteranceId() !== null) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      // Increment generation so any in-flight callback self-cancels.
      generationRef.current += 1;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [state, playbackController, timeline]);

  // ── drawFrame: for non-speaking frames (idle, thinking) ───────────────────
  // Double-buffered: builds on offscreen frameCanvas, then single blit to visible canvas.
  function drawFrame(blinkOpacity: number = 0): void {
    const canvas    = canvasRef.current;
    const images    = imagesRef.current;
    const fullFrame = fullFrameCanvasRef.current;
    const eyeWork   = eyeCanvasRef.current;
    if (!canvas || !images || !fullFrame) return;

    const fullCtx = fullFrame.getContext("2d");
    const ctx     = canvas.getContext("2d");
    if (!fullCtx || !ctx) return;

    const currentState = stateRef.current;
    const baseImg = currentState === "thinking" ? images.thinking : images.idle;
    fullCtx.drawImage(baseImg, 0, 0, MOUTH_MASK.sourceWidth, MOUTH_MASK.sourceHeight);

    // If blinking (and not thinking), composite closed eyes onto fullFrame before blit
    if (currentState !== "thinking" && blinkOpacity > 0.001 && eyeWork && images.eyesClosed) {
      compositeEyes(fullCtx, eyeWork, images.eyesClosed, blinkOpacity, EYE_CONFIG);
    }

    // Atomic blit to visible canvas without progressive clear.
    ctx.drawImage(fullFrame, 0, 0, canvas.width, canvas.height);
  }

  // ── drawFrameForSpeech: per-rAF tick during active speech ─────────────────
  // Completely double-buffered:
  // 1. fullFrame receives idle base
  // 2. mouthCanvas blends and masks mouth poses
  // 3. fullFrame receives masked mouth
  // 4. visible canvas receives completed fullFrame in one atomic drawImage
  function drawFrameForSpeech(
    controller: AudioPlaybackController,
    tl: VisemeEvent[],
  ): void {
    const canvas    = canvasRef.current;
    const images    = imagesRef.current;
    const fullFrame = fullFrameCanvasRef.current;
    const mouthWork = mouthCanvasRef.current;
    if (!canvas || !images || !fullFrame || !mouthWork) return;

    const fullCtx = fullFrame.getContext("2d");
    const ctx     = canvas.getContext("2d");
    if (!fullCtx || !ctx) return;

    const audioTime = controller.getElapsedTime();
    const nowMs     = performance.now();
    const isActive  = controller.getCurrentUtteranceId() !== null;

    // Time delta for frame-rate-independent smoothing.
    const lastTime = lastFrameTimeRef.current ?? nowMs;
    const dt       = Math.min(100, Math.max(1, nowMs - lastTime));
    lastFrameTimeRef.current = nowMs;

    // ── Amplitude smoothing with per-frame delta clamp ────────────────────
    const energy      = controller.getEnergy();
    const prevSmooth  = smoothedEnergyRef.current;
    const coeff       = energy > prevSmooth ? ENERGY.attack : ENERGY.release;
    const rawSmoothed = prevSmooth + (energy - prevSmooth) * coeff;
    const maxDelta    = (dt / 16.7) * ENERGY.maxFrameDelta;
    const smoothed    = Math.min(
      prevSmooth + maxDelta,
      Math.max(prevSmooth - maxDelta, rawSmoothed),
    );
    smoothedEnergyRef.current = smoothed;

    // ── Time-based silence hysteresis ─────────────────────────────────────
    const silence = silenceRef.current;
    if (silence.isSilent) {
      if (smoothed >= SILENCE.exitThreshold) {
        if (silence.thresholdCrossedAt === null) silence.thresholdCrossedAt = nowMs;
        else if (nowMs - silence.thresholdCrossedAt >= SILENCE.speechConfirmMs) {
          silence.isSilent = false;
          silence.thresholdCrossedAt = null;
        }
      } else {
        silence.thresholdCrossedAt = null;
      }
    } else {
      if (smoothed < SILENCE.enterThreshold) {
        if (silence.thresholdCrossedAt === null) silence.thresholdCrossedAt = nowMs;
        else if (nowMs - silence.thresholdCrossedAt >= SILENCE.confirmMs) {
          silence.isSilent = true;
          silence.thresholdCrossedAt = null;
        }
      } else {
        silence.thresholdCrossedAt = null;
      }
    }

    // ── Timeline lookup ───────────────────────────────────────────────────
    const timelineViseme = findVisemeAtTime(tl, audioTime);
    const isComplete     = !isActive;

    // ── Visual pose scheduler ─────────────────────────────────────────────
    const sched = schedulerRef.current;
    const committed = advanceScheduler(
      sched,
      timelineViseme,
      nowMs,
      silence.isSilent,
      isComplete,
      false,
    );

    // ── Sync VisemeRenderState on commit ──────────────────────────────────
    const renderState = renderStateRef.current;
    if (committed) {
      renderState.previousViseme       = sched.previousViseme;
      renderState.currentViseme        = sched.renderedViseme;
      renderState.transitionStartedAt  = audioTime;
      renderState.transitionDurationMs = sched.transitionDurationMs;
    }

    // ── Phase 2: Amplitude is used strictly for silence/speaking decision ──
    // Whole-patch opacity is never modulated by RMS amplitude.
    renderState.intensity = 1;

    // ── Full-frame double-buffered composition ────────────────────────────
    // Step 1: Draw base idle face to offscreen frame canvas.
    fullCtx.drawImage(images.idle, 0, 0, MOUTH_MASK.sourceWidth, MOUTH_MASK.sourceHeight);

    // Step 1.5: If blinking during speech, composite closed eyes onto face
    const blinkOpacity = blinkControllerRef.current.getBlinkProgress(nowMs);
    const eyeWork      = eyeCanvasRef.current;
    if (blinkOpacity > 0.001 && eyeWork && images.eyesClosed) {
      compositeEyes(fullCtx, eyeWork, images.eyesClosed, blinkOpacity, EYE_CONFIG);
    }

    // Step 2: Composite masked blended mouth on top of idle face in offscreen frame.
    compositeVisemes(fullCtx, mouthWork, images.visemes, renderState, audioTime);

    // Step 3: Single atomic blit to visible canvas — no clearRect, no intermediate frame.
    ctx.drawImage(fullFrame, 0, 0, canvas.width, canvas.height);

    // ── Phase 8 Debug HUD: active only in dev when ?debugSync=1 or __DEBUG_SYNC is set ──
    const isDebugSync =
      process.env.NODE_ENV !== "production" &&
      typeof window !== "undefined" &&
      (new URLSearchParams(window.location.search).get("debugSync") === "1" ||
        (window as unknown as { __DEBUG_SYNC?: boolean }).__DEBUG_SYNC === true);

    if (isDebugSync) {
      const elapsedSinceTrans = (audioTime - renderState.transitionStartedAt) * 1000;
      const progress = Math.min(1, Math.max(0, elapsedSinceTrans / Math.max(1, renderState.transitionDurationMs)));

      ctx.save();
      ctx.fillStyle = "rgba(10, 15, 25, 0.85)";
      ctx.strokeStyle = "rgba(56, 189, 248, 0.6)";
      ctx.lineWidth = 1.5;
      const hudW = Math.min(340, canvas.width - 20);
      const hudH = 175;
      ctx.fillRect(10, 10, hudW, hudH);
      ctx.strokeRect(10, 10, hudW, hudH);

      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 11px monospace";
      ctx.fillText("AI INTERVIEWER SYNC HUD (?debugSync=1)", 20, 28);

      ctx.fillStyle = "#f1f5f9";
      ctx.font = "10px monospace";
      ctx.fillText(`Audio Time:       ${audioTime.toFixed(3)}s`, 20, 46);
      ctx.fillText(`Silence / RMS:    ${silence.isSilent ? "SILENCE" : "SPEAKING"} (${energy.toFixed(4)})`, 20, 62);
      ctx.fillText(`Rendered Viseme:  ${sched.renderedViseme.toUpperCase()}`, 20, 78);
      ctx.fillText(`Previous Viseme:  ${sched.previousViseme.toUpperCase()}`, 20, 94);
      ctx.fillText(`Pending Viseme:   ${(sched.pendingViseme ?? "none").toUpperCase()}`, 20, 110);
      ctx.fillText(`Crossfade:        ${(progress * 100).toFixed(0)}% (${renderState.transitionDurationMs}ms)`, 20, 126);
      const audioElapsedSec = Math.max(0.1, audioTime);
      const rateStr = (sched._renderCommits / audioElapsedSec).toFixed(1);
      ctx.fillText(`Pose Changes/Sec: ${rateStr}/s (max 8.5/s)`, 20, 142);
      ctx.fillText(`Timeline Events:  ${sched._timelinePoses} poses`, 20, 158);
      ctx.restore();
    }

    // ── Dev diagnostic: log once per utterance on completion ─────────────
    if (isComplete && process.env.NODE_ENV !== "production") {
      const durationMs = nowMs - diagRef.current.startedAt;
      const rendered   = sched._renderCommits;
      const skipped    = sched._skippedPoses;
      const tls        = sched._timelinePoses;
      console.info("[local-avatar] local_avatar_visual_rate", {
        timelinePoseCount:        tls,
        renderedPoseCount:        rendered,
        skippedPoseCount:         skipped,
        utteranceDurationMs:      Math.round(durationMs),
        renderedChangesPerSecond: durationMs > 0 ? (rendered / (durationMs / 1000)).toFixed(1) : "0",
        averageRenderedHoldMs:    rendered > 0 ? (durationMs / rendered).toFixed(0) : "0",
      });
    }
  }

  return (
    <canvas
      ref={canvasRef}
      className="avatar-canvas"
      role="img"
      aria-label={`Avatar ${state}`}
    />
  );
}
