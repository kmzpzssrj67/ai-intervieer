/**
 * BlinkController handles natural human eye-blink scheduling and easing.
 *
 * Characteristics:
 * - Randomized intervals: 2.5s to 5.0s between blinks
 * - Organic blink duration: ~130ms total
 * - Smooth eyelid acceleration and deceleration curve (hermite smoothstep)
 * - Occasional double-blinks (~15% probability) for natural realism
 */

export type BlinkParams = {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  closeDurationMs?: number;
  holdDurationMs?: number;
  openDurationMs?: number;
  blinkDurationMs?: number;
  doubleBlinkChance?: number;
};

export class BlinkController {
  private minIntervalMs: number;
  private maxIntervalMs: number;
  private closeDurationMs: number;
  private holdDurationMs: number;
  private openDurationMs: number;
  private blinkDurationMs: number;
  private doubleBlinkChance: number;

  private nextBlinkAtMs: number = 0;
  private currentBlinkStartMs: number = 0;
  private isDoubleBlink: boolean = false;
  private doubleBlinkSecondStartMs: number = 0;

  constructor(params?: BlinkParams) {
    this.minIntervalMs = params?.minIntervalMs ?? 2800;
    this.maxIntervalMs = params?.maxIntervalMs ?? 3500;
    this.doubleBlinkChance = params?.doubleBlinkChance ?? 0.08;

    if (params?.closeDurationMs != null && params?.holdDurationMs != null && params?.openDurationMs != null) {
      this.closeDurationMs = params.closeDurationMs;
      this.holdDurationMs = params.holdDurationMs;
      this.openDurationMs = params.openDurationMs;
      this.blinkDurationMs = this.closeDurationMs + this.holdDurationMs + this.openDurationMs;
    } else if (params?.blinkDurationMs != null) {
      this.blinkDurationMs = params.blinkDurationMs;
      this.closeDurationMs = Math.round(this.blinkDurationMs * 0.35);
      this.holdDurationMs = Math.round(this.blinkDurationMs * 0.23);
      this.openDurationMs = this.blinkDurationMs - this.closeDurationMs - this.holdDurationMs;
    } else {
      this.closeDurationMs = 110;
      this.holdDurationMs = 70;
      this.openDurationMs = 130;
      this.blinkDurationMs = 310;
    }
  }

  public reset(nowMs: number): void {
    this.scheduleNext(nowMs);
  }

  public cancelBlink(nowMs: number): void {
    this.scheduleNext(nowMs);
  }

  private scheduleNext(nowMs: number): void {
    const delay = this.minIntervalMs + Math.random() * (this.maxIntervalMs - this.minIntervalMs);
    this.nextBlinkAtMs = nowMs + delay;
    this.currentBlinkStartMs = 0;
    this.isDoubleBlink = false;
    this.doubleBlinkSecondStartMs = 0;
  }

  /**
   * Evaluates eyelid opacity for a single blink:
   * - Close: 110ms (100–120ms) with smooth Hermite easing (0 -> 1)
   * - Fully closed hold: 70ms (60–80ms) with opacity 1.0
   * - Open: 130ms (120–150ms) with smooth Hermite easing (1 -> 0)
   * Total blink duration: ~310ms (280–350ms)
   */
  private evaluateSingleBlink(elapsedMs: number): number {
    if (elapsedMs <= 0 || elapsedMs >= this.blinkDurationMs) return 0;

    const closeDur = this.closeDurationMs;
    const holdDur = this.holdDurationMs;
    const openDur = this.openDurationMs;

    if (elapsedMs < closeDur) {
      const p = elapsedMs / closeDur;
      return 3 * p * p - 2 * p * p * p;
    } else if (elapsedMs < closeDur + holdDur) {
      return 1.0;
    } else {
      const p = 1.0 - (elapsedMs - closeDur - holdDur) / openDur;
      return Math.max(0, 3 * p * p - 2 * p * p * p);
    }
  }

  /**
   * Returns current blink blend opacity in range [0, 1].
   * Returns 0 if eyes are completely open.
   */
  public getBlinkProgress(nowMs: number): number {
    if (this.nextBlinkAtMs === 0) {
      this.reset(nowMs);
      return 0;
    }

    // Trigger new blink if scheduled time reached
    if (nowMs >= this.nextBlinkAtMs && this.currentBlinkStartMs === 0) {
      this.currentBlinkStartMs = nowMs;
      this.isDoubleBlink = Math.random() < this.doubleBlinkChance;
      if (this.isDoubleBlink) {
        // Second blink starts ~80ms after first blink finishes
        this.doubleBlinkSecondStartMs = nowMs + this.blinkDurationMs + 80;
      }
    }

    // Currently in active blink
    if (this.currentBlinkStartMs > 0) {
      const elapsed1 = nowMs - this.currentBlinkStartMs;
      if (elapsed1 < this.blinkDurationMs) {
        return this.evaluateSingleBlink(elapsed1);
      }

      // Check double-blink second pulse
      if (this.isDoubleBlink && this.doubleBlinkSecondStartMs > 0) {
        if (nowMs >= this.doubleBlinkSecondStartMs) {
          const elapsed2 = nowMs - this.doubleBlinkSecondStartMs;
          if (elapsed2 < this.blinkDurationMs) {
            return this.evaluateSingleBlink(elapsed2);
          } else {
            // Double blink finished
            this.scheduleNext(nowMs);
            return 0;
          }
        }
        // In pause between double-blinks
        return 0;
      }

      // Single blink finished
      this.scheduleNext(nowMs);
      return 0;
    }

    return 0;
  }

  public isBlinking(nowMs: number): boolean {
    return this.getBlinkProgress(nowMs) > 0.001;
  }
}

