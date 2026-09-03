/**
 * VisualPoseScheduler
 *
 * Separates the audio timeline (which advances at AudioContext speed) from
 * the rendered mouth pose (which must hold long enough to be visually readable).
 *
 * Contract:
 *   - timelineViseme  → what the audio clock says right now
 *   - renderedViseme  → what is currently committed to the Canvas
 *   - pendingViseme   → latest timeline value waiting to be committed
 *
 * Rules:
 *   1. When timelineViseme changes, store it as pendingViseme (latest-value buffer).
 *   2. Do not commit immediately; keep renderedViseme until its hold expires.
 *   3. On hold expiry, commit pendingViseme directly (skip intermediate queued poses).
 *   4. Never replay a pending viseme whose audio window has already passed.
 *   5. Silence and completion bypass the hold immediately.
 *   6. No FIFO queue. Only one pending slot.
 *
 * All timing uses performance.now() (wall-clock ms) so behaviour is
 * identical at 30 Hz, 60 Hz and 120 Hz.
 */

import type { LocalViseme } from "./LipSyncTimeline.ts";

// ── Visual scheduler configuration ──────────────────────────────────────────
export const POSE_CONFIG = {
  /** Minimum hold for a standard consonant/neutral pose (ms). Phase 3 tuning: 130 ms → ≈7.7 changes/s. */
  NORMAL_MIN_HOLD_MS: 130,
  /** Minimum hold for vowels: aa, ee, oh, oo (ms). Phase 3: 140 ms. */
  VOWEL_MIN_HOLD_MS: 140,
  /** Minimum hold for genuine mbp closures (ms). Phase 3: 70 ms. */
  MBP_MIN_HOLD_MS: 70,
  /** Crossfade duration for normal pose transitions (ms). Phase 3: 38 ms. */
  TRANSITION_MS: 38,
  /** Crossfade duration for mbp closure transitions (ms). Phase 3: 32 ms. */
  MBP_TRANSITION_MS: 32,
  /** Crossfade duration for the final audio-complete closure (ms). Phase 3: 45 ms. */
  FINAL_CLOSE_MS: 45,
};

const VOWELS = new Set<LocalViseme>(["aa", "ae", "ee", "oh", "oo"]);

/** Return the minimum visual hold for a given viseme (ms), with speech-rate adaptation. */
export function minHoldMs(viseme: LocalViseme, targetPaceMs?: number): number {
  if (targetPaceMs && targetPaceMs > 0) {
    // Adaptive hold: if speech pace is rapid (< 120ms/phoneme), scale holds proportionally.
    // Strictly clamped to anti-flicker lower bounds (vowels >= 95ms, consonants >= 85ms, mbp >= 55ms).
    const speedRatio = Math.min(1.0, Math.max(0.65, targetPaceMs / 130));
    if (VOWELS.has(viseme)) {
      return Math.round(Math.max(95, POSE_CONFIG.VOWEL_MIN_HOLD_MS * speedRatio));
    }
    if (viseme === "mbp") {
      return Math.round(Math.max(55, POSE_CONFIG.MBP_MIN_HOLD_MS * speedRatio));
    }
    return Math.round(Math.max(85, POSE_CONFIG.NORMAL_MIN_HOLD_MS * speedRatio));
  }

  if (VOWELS.has(viseme)) return POSE_CONFIG.VOWEL_MIN_HOLD_MS;
  if (viseme === "mbp") return POSE_CONFIG.MBP_MIN_HOLD_MS;
  return POSE_CONFIG.NORMAL_MIN_HOLD_MS;
}

/** Return the crossfade duration for committing a new viseme (ms). */
export function commitTransitionMs(
  viseme: LocalViseme,
  isFinalClose: boolean,
  fromViseme?: LocalViseme,
  targetPaceMs?: number,
): number {
  if (isFinalClose) return POSE_CONFIG.FINAL_CLOSE_MS;
  if (viseme === "mbp") return POSE_CONFIG.MBP_TRANSITION_MS;

  const isFast = Boolean(targetPaceMs && targetPaceMs < 110);
  // Conservative coarticulation: smoother anticipatory crossfade into rounded vowels or rhotic from consonants
  if ((viseme === "oo" || viseme === "oh" || viseme === "r") && fromViseme && !VOWELS.has(fromViseme)) {
    return isFast ? 34 : 42;
  }
  return isFast ? 30 : POSE_CONFIG.TRANSITION_MS;
}

/**
 * Per-utterance visual scheduler state.
 * Lives in a React ref, reset for each utterance.
 */
export type SchedulerState = {
  /** The viseme currently shown on Canvas (committed). */
  renderedViseme: LocalViseme;
  /** The latest timeline viseme waiting to be shown (latest-value buffer). */
  pendingViseme: LocalViseme | null;
  /** performance.now() when renderedViseme was first committed. */
  renderedCommittedAt: number;
  /** performance.now() when the current transition started. */
  transitionStartedAt: number;
  /** Duration of current crossfade (ms). */
  transitionDurationMs: number;
  /** True while in the crossfade portion of the current render. */
  inTransition: boolean;
  /** The previous viseme (for crossfade blending). */
  previousViseme: LocalViseme;
  /** Per-utterance counters for diagnostics. */
  _renderCommits: number;
  _skippedPoses: number;
  _timelinePoses: number;
  /** Adaptive speech-rate tempo tracking */
  lastTimelineViseme: LocalViseme | null;
  lastTimelineChangedAt: number;
  measuredPaceMs: number;
};

export function createSchedulerState(): SchedulerState {
  return {
    renderedViseme: "mbp",
    pendingViseme: null,
    renderedCommittedAt: 0,
    transitionStartedAt: 0,
    transitionDurationMs: 0,
    inTransition: false,
    previousViseme: "mbp",
    _renderCommits: 0,
    _skippedPoses: 0,
    _timelinePoses: 0,
    lastTimelineViseme: null,
    lastTimelineChangedAt: 0,
    measuredPaceMs: POSE_CONFIG.NORMAL_MIN_HOLD_MS,
  };
}

/**
 * Advance the scheduler by one animation frame.
 *
 * @param state        Mutable scheduler state (React ref value).
 * @param timelineViseme  Current viseme from the audio timeline, or null for gap/silence.
 * @param nowMs        performance.now() at this frame.
 * @param isSilent     True if the silence hysteresis has confirmed silence.
 * @param isComplete   True if audio playback has naturally ended.
 * @param isSkipped    True if the user pressed Skip.
 * @returns Whether the rendered viseme changed this frame (triggers crossfade start).
 */
export function advanceScheduler(
  state: SchedulerState,
  timelineViseme: LocalViseme | null,
  nowMs: number,
  isSilent: boolean,
  isComplete: boolean,
  isSkipped: boolean,
): boolean {
  // ── Immediate overrides: completion and skip bypass the hold ──────────────
  if (isComplete || isSkipped) {
    if (state.renderedViseme !== "mbp" || state.pendingViseme !== null) {
      state.previousViseme = state.renderedViseme;
      state.renderedViseme = "mbp";
      state.pendingViseme = null;
      state.renderedCommittedAt = nowMs;
      state.transitionStartedAt = nowMs;
      state.transitionDurationMs = POSE_CONFIG.FINAL_CLOSE_MS;
      state.inTransition = true;
      state._renderCommits += 1;
      return true;
    }
    return false;
  }

  // ── Determine the "desired" viseme from audio + silence state ─────────────
  const desired: LocalViseme = isSilent || timelineViseme === null ? "mbp" : timelineViseme;

  // Track timeline changes and measure incoming speech pace
  if (desired !== state.lastTimelineViseme) {
    if (state.lastTimelineChangedAt > 0) {
      const delta = nowMs - state.lastTimelineChangedAt;
      if (delta >= 30 && delta <= 600) {
        state.measuredPaceMs = state.measuredPaceMs * 0.6 + delta * 0.4;
      }
    }
    state.lastTimelineViseme = desired;
    state.lastTimelineChangedAt = nowMs;
    state._timelinePoses += 1;
  }

  // ── Update pending slot (latest-value buffer, not a queue) ────────────────
  if (desired !== state.renderedViseme) {
    // Only update pending if different from what's rendered.
    state.pendingViseme = desired;
  } else {
    // Timeline has come back to match the rendered pose — discard stale pending.
    state.pendingViseme = null;
  }

  // ── Check whether current hold has expired ────────────────────────────────
  if (state.pendingViseme === null) {
    // Nothing to commit; continue holding current pose.
    state.inTransition = nowMs - state.transitionStartedAt < state.transitionDurationMs;
    return false;
  }

  const holdElapsed = nowMs - state.renderedCommittedAt;
  let hold = minHoldMs(state.renderedViseme, state.measuredPaceMs);

  // Accelerated closure upon confirmed silence:
  // When audio has stopped and silence is confirmed, do not linger in an open mouth pose.
  // Cap remaining dwell to 35ms (sufficient to prevent strobe flicker, while closing promptly).
  if (isSilent && state.pendingViseme === "mbp") {
    hold = Math.min(hold, 35);
  }

  if (holdElapsed < hold) {
    // Hold not yet expired — keep current pose, pending slot retains latest value.
    state.inTransition = nowMs - state.transitionStartedAt < state.transitionDurationMs;
    return false;
  }

  // ── Hold expired: commit the pending pose ─────────────────────────────────
  const toCommit = state.pendingViseme;

  // Check: is this a silence/completion case?
  const isFinalClose = isSilent && toCommit === "mbp";

  state.previousViseme = state.renderedViseme;
  state.renderedViseme = toCommit;
  state.pendingViseme = null;
  state.renderedCommittedAt = nowMs;
  state.transitionStartedAt = nowMs;
  state.transitionDurationMs = commitTransitionMs(toCommit, isFinalClose, state.previousViseme, state.measuredPaceMs);
  state.inTransition = true;
  state._renderCommits += 1;
  return true;
}

/** Blend progress [0, 1] for the current crossfade. */
export function blendProgress(state: SchedulerState, nowMs: number): number {
  if (state.transitionDurationMs <= 0) return 1;
  const elapsed = nowMs - state.transitionStartedAt;
  return Math.min(1, Math.max(0, elapsed / state.transitionDurationMs));
}
