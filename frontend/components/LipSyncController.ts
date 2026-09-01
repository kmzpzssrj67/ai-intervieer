import type { Viseme } from "./types";

const MIN_FRAME_MS = 80;
const MAX_FRAME_MS = 150;

export type LipSyncListener = (viseme: Viseme) => void;

export class LipSyncController {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private animationFrameId: number | null = null;
  private listener: LipSyncListener | null = null;
  private lastViseme: Viseme = "rest";
  private lastEmitAt = 0;
  private smoothedLevel = 0;

  attach(audioElement: HTMLAudioElement | null, listener?: LipSyncListener): void {
    this.listener = listener ?? this.listener;
    this.audioElement = audioElement;

    if (!audioElement) {
      this.stop();
      return;
    }

    if (!this.audioContext) {
      const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        this.emit("rest");
        return;
      }
      this.audioContext = new AudioCtor();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      this.source = this.audioContext.createMediaElementSource(audioElement);
      this.source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
    }

    this.start();
  }

  start(): void {
    if (this.animationFrameId !== null || !this.analyser || !this.audioElement) return;

    const tick = () => {
      if (!this.analyser || !this.audioElement || this.audioElement.paused || this.audioElement.ended) {
        this.emit("rest");
        this.animationFrameId = null;
        return;
      }

      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      const rms = this.getRms(data);
      this.smoothedLevel = this.smoothedLevel * 0.7 + rms * 0.3;
      const viseme = this.resolveViseme(this.smoothedLevel);
      this.emit(viseme, true);
      this.animationFrameId = window.requestAnimationFrame(tick);
    };

    this.animationFrameId = window.requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.emit("rest");
  }

  dispose(): void {
    this.stop();
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.audioElement = null;
  }

  private emit(viseme: Viseme, respectTiming = false): void {
    const now = performance.now();
    if (!respectTiming || now - this.lastEmitAt >= MIN_FRAME_MS) {
      if (this.lastViseme !== viseme || now - this.lastEmitAt >= MAX_FRAME_MS) {
        this.lastViseme = viseme;
        this.lastEmitAt = now;
        this.listener?.(viseme);
      }
    }
  }

  private getRms(data: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / data.length);
    return Math.min(1, rms * 2.5);
  }

  private resolveViseme(level: number): Viseme {
    if (level < 0.05) return "closed";
    if (level < 0.15) return "open";
    if (level < 0.35) return "wide";
    return "round";
  }
}
