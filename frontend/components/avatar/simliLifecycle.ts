"use client";

export type LifecycleState =
  | "idle"
  | "session_creating"
  | "connecting"
  | "ready"
  | "uploading"
  | "playing"
  | "recovering"
  | "disconnecting"
  | "disconnected"
  | "error";

type StopCapableClient = {
  stop(): Promise<void>;
};

export type SimliAudioSendGuard = {
  mounted: boolean;
  generation: number;
  currentGeneration: number;
  client: object | null;
  currentClient: object | null;
  lifecycle: LifecycleState;
};

export type SimliEventGuard = {
  generation: number;
  activeGeneration: number;
  stopRequested: boolean;
};

const NON_SEND_STATES: ReadonlySet<LifecycleState> = new Set([
  "idle",
  "session_creating",
  "connecting",
  "recovering",
  "disconnecting",
  "disconnected",
  "error",
]);

export function canStopSimliClient(state: LifecycleState): boolean {
  return state === "session_creating" || state === "connecting" || state === "ready" || state === "uploading" || state === "playing" || state === "recovering";
}

export function canSendSimliAudio(guard: SimliAudioSendGuard): boolean {
  return (
    guard.mounted &&
    guard.generation === guard.currentGeneration &&
    guard.client !== null &&
    guard.client === guard.currentClient &&
    !NON_SEND_STATES.has(guard.lifecycle)
  );
}

export function classifySimliStopEvent(guard: SimliEventGuard): "stale" | "intentional" | "unexpected" {
  if (guard.generation !== guard.activeGeneration) return "stale";
  if (guard.stopRequested) return "intentional";
  return "unexpected";
}

export function canCompleteFromSilentEvent(guard: {
  lifecycle: LifecycleState;
  generation: number;
  speechGeneration: number | null;
  chunksComplete: boolean;
  speakingObserved: boolean;
  settled: boolean;
}): boolean {
  return (
    guard.lifecycle === "playing" &&
    guard.generation === guard.speechGeneration &&
    guard.chunksComplete &&
    guard.speakingObserved &&
    !guard.settled
  );
}

export function sanitizeSimliMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Simli error";
  const withoutUrls = raw.replace(/wss?:\/\/\S+/gi, "[redacted-url]");
  const withoutTokens = withoutUrls.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted-id]");
  return withoutTokens.slice(0, 180);
}

export async function stopSimliClientOnce(
  client: StopCapableClient | null,
  stoppedClients: WeakSet<object>,
  lifecycle: LifecycleState,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  if (!client || !canStopSimliClient(lifecycle) || stoppedClients.has(client)) return false;
  stoppedClients.add(client);
  try {
    await client.stop();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

export function devLogSimli(event: string, details?: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") return;
  if (details) {
    console.info(`[simli] ${event}`, details);
    return;
  }
  console.info(`[simli] ${event}`);
}

export const SIMLI_REQUIRED_SAMPLE_RATE = 16_000;
export const SIMLI_PCM_CHUNK_SAMPLES = 3_000;
export const SIMLI_MAX_SAFE_PACING_DRIFT_MS = 1_500;

export type PcmChunk = {
  bytes: Uint8Array;
  durationMs: number;
  samples: number;
};

export type PacingMeasurement = {
  expectedElapsedMs: number;
  actualElapsedMs: number;
  driftMs: number;
};

export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array();
  if (channels.length === 1) return channels[0];

  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    mono[index] = sum / channels.length;
  }
  return mono;
}

export function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (input.length === 0) return new Float32Array();
  if (sourceRate === targetRate) return input;
  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const rateRatio = sourceRate / targetRate;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourcePosition = outputIndex * rateRatio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = sourcePosition - leftIndex;
    output[outputIndex] = (input[leftIndex] ?? 0) * (1 - fraction) + (input[rightIndex] ?? 0) * fraction;
  }
  return output;
}

export function floatToPcm16LittleEndian(input: Float32Array): Uint8Array {
  const output = new Uint8Array(input.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    view.setInt16(index * 2, value, true);
  }
  return output;
}

export function chunkPcm16(pcmBytes: Uint8Array, sampleRate = SIMLI_REQUIRED_SAMPLE_RATE, chunkSamples = SIMLI_PCM_CHUNK_SAMPLES): PcmChunk[] {
  const bytesPerSample = 2;
  const chunkBytes = chunkSamples * bytesPerSample;
  const chunks: PcmChunk[] = [];
  for (let offset = 0; offset < pcmBytes.length; offset += chunkBytes) {
    const bytes = pcmBytes.slice(offset, Math.min(offset + chunkBytes, pcmBytes.length));
    chunks.push({
      bytes,
      samples: bytes.length / bytesPerSample,
      durationMs: (bytes.length / bytesPerSample / sampleRate) * 1000,
    });
  }
  return chunks;
}

export function getChunkTargetElapsedMs(sentSamples: number, sampleRate = SIMLI_REQUIRED_SAMPLE_RATE): number {
  return (sentSamples / sampleRate) * 1000;
}

export function getChunkTargetTimeMs(startedAtMs: number, sentSamplesBeforeChunk: number, sampleRate = SIMLI_REQUIRED_SAMPLE_RATE): number {
  return startedAtMs + getChunkTargetElapsedMs(sentSamplesBeforeChunk, sampleRate);
}

export function getPacingDelayMs(startedAtMs: number, nowMs: number, sentSamplesBeforeChunk: number, sampleRate = SIMLI_REQUIRED_SAMPLE_RATE): number {
  return Math.max(0, getChunkTargetTimeMs(startedAtMs, sentSamplesBeforeChunk, sampleRate) - nowMs);
}

export function isPacingDriftSafe(targetTimeMs: number, nowMs: number, maxDriftMs = SIMLI_MAX_SAFE_PACING_DRIFT_MS): boolean {
  return nowMs - targetTimeMs <= maxDriftMs;
}

export function preserveFirstAbortReason<T extends string>(current: T | null, next: T): T {
  return current ?? next;
}

export function measurePacing(startedAtMs: number, finishedAtMs: number, totalSamples: number, sampleRate = SIMLI_REQUIRED_SAMPLE_RATE): PacingMeasurement {
  const expectedElapsedMs = getChunkTargetElapsedMs(totalSamples, sampleRate);
  const actualElapsedMs = finishedAtMs - startedAtMs;
  return {
    expectedElapsedMs,
    actualElapsedMs,
    driftMs: actualElapsedMs - expectedElapsedMs,
  };
}
