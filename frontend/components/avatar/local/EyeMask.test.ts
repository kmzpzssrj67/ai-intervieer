import assert from "node:assert/strict";
import test from "node:test";

import { EYE_CONFIG, traceEyeMask } from "./EyeMask.ts";
import { BlinkController } from "./BlinkController.ts";
import { MOUTH_MASK } from "./MouthMask.ts";

test("EyeConfig uses 1254px source frame and resides strictly in upper face inside glasses lenses", () => {
  assert.equal(EYE_CONFIG.sourceWidth, 1254);
  assert.equal(EYE_CONFIG.sourceHeight, 1254);

  // Both eye centers must be in upper half of the face
  assert.ok(EYE_CONFIG.leftEye.centerY < 500, "Left eye must be above y=500");
  assert.ok(EYE_CONFIG.rightEye.centerY < 500, "Right eye must be above y=500");

  // Left eye is to viewer's left of right eye
  assert.ok(EYE_CONFIG.leftEye.centerX < EYE_CONFIG.rightEye.centerX, "Left eye x < Right eye x");

  // Both eyes have valid dimensions fitted to lenses
  assert.ok(EYE_CONFIG.leftEye.radiusX <= 105, "Left eye radiusX must be <= 105 to stay inside lens frame");
  assert.ok(EYE_CONFIG.leftEye.radiusY <= 80, "Left eye radiusY must be <= 80 to stay inside lens frame");
  assert.ok(EYE_CONFIG.rightEye.radiusX <= 105, "Right eye radiusX must be <= 105 to stay inside lens frame");
  assert.ok(EYE_CONFIG.rightEye.radiusY <= 80, "Right eye radiusY must be <= 80 to stay inside lens frame");
  assert.ok(EYE_CONFIG.featherRadius > 0);
});

test("Eye mask and Mouth mask strictly NEVER overlap vertically", () => {
  const eyeMaxY = Math.max(
    EYE_CONFIG.leftEye.centerY + EYE_CONFIG.leftEye.radiusY,
    EYE_CONFIG.rightEye.centerY + EYE_CONFIG.rightEye.radiusY,
  );
  const mouthMinY = Math.min(...MOUTH_MASK.polygon.map((p) => p.y));

  assert.ok(
    eyeMaxY < mouthMinY,
    `Eye bottom (${eyeMaxY}px) must be above mouth top (${mouthMinY}px) to prevent compositor collisions`,
  );
});

test("traceEyeMask executes without error on mock canvas context", () => {
  let ellipseCalls = 0;
  let beginPathCalls = 0;

  const mockCtx = {
    beginPath: () => { beginPathCalls++; },
    ellipse: () => { ellipseCalls++; },
    moveTo: () => {},
    closePath: () => {},
  } as unknown as CanvasRenderingContext2D;

  traceEyeMask(mockCtx, EYE_CONFIG);

  assert.equal(beginPathCalls, 1);
  assert.equal(ellipseCalls, 2, "Must trace exactly two eye ellipses (left and right)");
});

test("BlinkController default scheduling is approximately 3 seconds (2.8s - 3.5s)", () => {
  const controller = new BlinkController();
  const t0 = 1000;
  controller.reset(t0);

  // Before 2800ms: must never trigger
  assert.equal(controller.getBlinkProgress(t0 + 2000), 0, "No blink before 2.8s");
  assert.equal(controller.getBlinkProgress(t0 + 2700), 0, "No blink before 2.8s");

  // By 3600ms: must have triggered a blink
  let triggered = false;
  for (let t = t0 + 2800; t <= t0 + 3600; t += 10) {
    if (controller.getBlinkProgress(t) > 0) {
      triggered = true;
      break;
    }
  }
  assert.ok(triggered, "Blink must trigger in ~3s window (2.8s - 3.5s)");
});

test("BlinkController produces natural, smooth ~310ms blink with hold", () => {
  const controller = new BlinkController({
    minIntervalMs: 100,
    maxIntervalMs: 100,
    closeDurationMs: 110,
    holdDurationMs: 70,
    openDurationMs: 130,
    doubleBlinkChance: 0,
  });

  controller.reset(0);
  assert.equal(controller.getBlinkProgress(50), 0);

  // t=100ms: start closing
  const atStart = controller.getBlinkProgress(100);
  assert.ok(atStart >= 0 && atStart <= 0.1);

  // Mid-closing at t=155ms (55ms into 110ms close)
  const midClose = controller.getBlinkProgress(155);
  assert.ok(midClose > 0.3 && midClose < 0.8, `Mid-close should be intermediate, got ${midClose}`);

  // Closed hold at t=240ms (within hold interval: 100 + 110 to 100 + 180)
  const atHold = controller.getBlinkProgress(240);
  assert.equal(atHold, 1.0, "Eyelids must remain fully closed during hold phase");

  // Mid-opening at t=320ms (40ms into 130ms open: 100 + 180 + 40)
  const midOpen = controller.getBlinkProgress(320);
  assert.ok(midOpen > 0.3 && midOpen < 0.9, `Mid-open should be intermediate, got ${midOpen}`);

  // End of blink at t=420ms (100 + 310 + 10): back to 0
  const atEnd = controller.getBlinkProgress(420);
  assert.equal(atEnd, 0, "Eyes must return to open (0) after blink duration");
});

test("BlinkController.cancelBlink cleanly cancels active blink and delays next blink", () => {
  const controller = new BlinkController({
    minIntervalMs: 3000,
    maxIntervalMs: 3000,
    blinkDurationMs: 220,
    doubleBlinkChance: 0,
  });

  controller.reset(0);

  // Trigger blink at t=3000ms
  controller.getBlinkProgress(3000);
  // Active blink in progress at t=3050ms
  const duringBlink = controller.getBlinkProgress(3050);
  assert.ok(duringBlink > 0, "Blink should be active");

  // Entering thinking state: cancel active blink at t=3060ms
  controller.cancelBlink(3060);

  // Immediately after cancellation, progress must be 0
  assert.equal(controller.getBlinkProgress(3060), 0, "Blink must be immediately 0 after cancel");
  assert.equal(controller.getBlinkProgress(3100), 0, "Blink must not resume in cancelled window");

  // Next blink must not occur until t = 3060 + 3000 = 6060ms
  assert.equal(controller.getBlinkProgress(5500), 0, "No blink during rescheduled delay");
  controller.getBlinkProgress(6060);
  assert.ok(controller.getBlinkProgress(6110) > 0, "Clean new blink triggered at rescheduled time");
});
