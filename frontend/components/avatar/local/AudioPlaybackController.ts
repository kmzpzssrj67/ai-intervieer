export type PlaybackCancelReason = "skip" | "replaced" | "unmount" | "interview_complete";

export type PlaybackStart = {
  utteranceId: number;
  duration: number;
  sampleRate: number;
};

type ActivePlayback = {
  utteranceId: number;
  source: AudioBufferSourceNode;
  startedAt: number;
  settled: boolean;
};

export class AudioPlaybackController {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private active: ActivePlayback | null = null;
  private generation = 0;
  private samples: Uint8Array<ArrayBuffer> | null = null;

  async prepareFromGesture(): Promise<void> {
    const context = this.getOrCreateContext();
    if (context.state === "suspended") await context.resume();
  }

  async play(
    encodedAudio: ArrayBuffer,
    onNaturalEnd: (utteranceId: number) => void,
  ): Promise<PlaybackStart> {
    this.cancel("replaced");
    const context = this.getOrCreateContext();
    if (context.state === "suspended") await context.resume();
    const decoded = await context.decodeAudioData(encodedAudio.slice(0));
    if (decoded.duration <= 0) throw new Error("Decoded TTS audio is empty.");

    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(this.analyser!);
    const utteranceId = ++this.generation;
    const active: ActivePlayback = { utteranceId, source, startedAt: context.currentTime, settled: false };
    this.active = active;
    source.onended = () => {
      if (this.active !== active || active.settled) return;
      active.settled = true;
      source.disconnect();
      this.active = null;
      onNaturalEnd(utteranceId);
    };
    source.start();
    return { utteranceId, duration: decoded.duration, sampleRate: decoded.sampleRate };
  }

  getElapsedTime(): number {
    if (!this.context || !this.active) return 0;
    return Math.max(0, this.context.currentTime - this.active.startedAt);
  }

  getCurrentUtteranceId(): number | null {
    return this.active?.utteranceId ?? null;
  }

  getEnergy(): number {
    if (!this.analyser || !this.active) return 0;
    if (!this.samples || this.samples.length !== this.analyser.fftSize) {
      this.samples = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    }
    this.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    return Math.sqrt(sum / this.samples.length);
  }

  cancel(reason: PlaybackCancelReason): number | null {
    const active = this.active;
    if (!active) return null;
    active.settled = true;
    this.active = null;
    active.source.onended = null;
    try {
      active.source.stop();
    } catch {
      // The source may already have ended.
    }
    active.source.disconnect();
    if (process.env.NODE_ENV !== "production") {
      console.info("[local-avatar] local_audio_cancelled", { utteranceId: active.utteranceId, reason });
    }
    return active.utteranceId;
  }

  async dispose(): Promise<void> {
    this.cancel("unmount");
    this.analyser?.disconnect();
    this.analyser = null;
    this.samples = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }

  private getOrCreateContext(): AudioContext {
    if (this.context) return this.context;
    const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) throw new Error("Web Audio playback is not supported by this browser.");
    this.context = new AudioCtor();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.35;
    this.analyser.connect(this.context.destination);
    return this.context;
  }
}
