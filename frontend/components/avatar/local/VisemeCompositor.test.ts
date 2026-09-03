import assert from "node:assert/strict";
import test from "node:test";

import { MOUTH_MASK } from "./MouthMask.ts";
import { transitionWeights } from "./VisemeCompositor.ts";

test("mask uses source coordinates and excludes the upper face", () => {
  assert.equal(MOUTH_MASK.sourceWidth, 1254);
  assert.equal(MOUTH_MASK.sourceHeight, 1254);
  assert.ok(Math.min(...MOUTH_MASK.polygon.map((point) => point.y)) > 500);
  assert.ok(MOUTH_MASK.featherRadius > 0);
});

test("transition mouth opacities always sum to one", () => {
  const state = {
    previousViseme: "mbp" as const,
    currentViseme: "aa" as const,
    transitionStartedAt: 1,
    transitionDurationMs: 50,
    intensity: 0.7,
  };
  for (const time of [1, 1.025, 1.05, 2]) {
    const weights = transitionWeights(state, time);
    assert.ok(Math.abs(weights.previous + weights.current + weights.closed - 1) < 1e-9);
  }
});

test("ballistic mbp -> vowel release prevents translucent teeth at transition midpoint", () => {
  const state = {
    previousViseme: "mbp" as const,
    currentViseme: "ee" as const,
    transitionStartedAt: 1.0,
    transitionDurationMs: 40,
    intensity: 1.0,
  };
  // At p = 0.5 (halfway through transition): mbp must retain > 90% opacity
  const midWeights = transitionWeights(state, 1.020);
  assert.ok(midWeights.previous >= 0.90, `mbp opacity at midpoint must be >= 0.90, got ${midWeights.previous}`);
  assert.ok(midWeights.current <= 0.10, `vowel opacity at midpoint must be <= 0.10, got ${midWeights.current}`);

  // At p = 1.0 (end of transition): vowel must be fully open (1.0)
  const endWeights = transitionWeights(state, 1.040);
  assert.equal(endWeights.current, 1);
  assert.equal(endWeights.previous, 0);
});

test("standard vowel-to-vowel transitions use smoothstep easing", () => {
  const state = {
    previousViseme: "aa" as const,
    currentViseme: "ee" as const,
    transitionStartedAt: 1.0,
    transitionDurationMs: 40,
    intensity: 1.0,
  };
  // At p = 0.5: Hermite 3(0.5)^2 - 2(0.5)^3 = 3(0.25) - 2(0.125) = 0.75 - 0.25 = 0.50
  const midWeights = transitionWeights(state, 1.020);
  assert.ok(Math.abs(midWeights.current - 0.50) < 1e-6);
  assert.ok(Math.abs(midWeights.previous - 0.50) < 1e-6);
});
