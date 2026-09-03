import assert from "node:assert/strict";
import test from "node:test";
import {
  canSendSimliAudio,
  canCompleteFromSilentEvent,
  chunkPcm16,
  classifySimliStopEvent,
  downmixToMono,
  floatToPcm16LittleEndian,
  getPacingDelayMs,
  isPacingDriftSafe,
  measurePacing,
  preserveFirstAbortReason,
  resampleLinear,
  sanitizeSimliMessage,
  SIMLI_PCM_CHUNK_SAMPLES,
  SIMLI_REQUIRED_SAMPLE_RATE,
  stopSimliClientOnce,
  type LifecycleState,
} from "./simliLifecycle.ts";

class FakeClient {
  stopCalls = 0;
  private readonly mode: "ok" | "sync-error" | "async-error";

  constructor(mode: "ok" | "sync-error" | "async-error" = "ok") {
    this.mode = mode;
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.mode === "sync-error") throw new Error("Invalid State, WS Connection session_abcdefghijklmnopqrstuvwxyz");
    if (this.mode === "async-error") return Promise.reject(new Error("FAILED TO SEND FINAL MESSAGE token_abcdefghijklmnopqrstuvwxyz"));
    return Promise.resolve();
  }
}

test("disconnect called twice invokes client.stop only once", async () => {
  const client = new FakeClient();
  const stopped = new WeakSet<object>();

  await stopSimliClientOnce(client, stopped, "ready");
  await stopSimliClientOnce(client, stopped, "ready");

  assert.equal(client.stopCalls, 1);
});

test("synchronous stop exception is contained", async () => {
  const client = new FakeClient("sync-error");
  const errors: unknown[] = [];

  const stopped = await stopSimliClientOnce(client, new WeakSet<object>(), "ready", (error) => errors.push(error));

  assert.equal(stopped, false);
  assert.equal(client.stopCalls, 1);
  assert.equal(errors.length, 1);
  assert.match(sanitizeSimliMessage(errors[0]), /\[redacted-id\]/);
});

test("asynchronous stop rejection is contained", async () => {
  const client = new FakeClient("async-error");
  const errors: unknown[] = [];

  const stopped = await stopSimliClientOnce(client, new WeakSet<object>(), "playing", (error) => errors.push(error));

  assert.equal(stopped, false);
  assert.equal(client.stopCalls, 1);
  assert.equal(errors.length, 1);
  assert.match(sanitizeSimliMessage(errors[0]), /\[redacted-id\]/);
});

test("stop is skipped for terminal lifecycle states", async () => {
  for (const state of ["idle", "disconnecting", "disconnected", "error"] satisfies LifecycleState[]) {
    const client = new FakeClient();
    await stopSimliClientOnce(client, new WeakSet<object>(), state);
    assert.equal(client.stopCalls, 0, state);
  }
});

test("audio is never sent after disconnect begins", () => {
  const client = {};

  assert.equal(
    canSendSimliAudio({
      mounted: true,
      generation: 1,
      currentGeneration: 1,
      client,
      currentClient: client,
      lifecycle: "disconnecting",
    }),
    false,
  );
});

test("stale callbacks cannot mutate the new client state", () => {
  const staleClient = {};
  const currentClient = {};

  assert.equal(
    canSendSimliAudio({
      mounted: true,
      generation: 1,
      currentGeneration: 2,
      client: staleClient,
      currentClient,
      lifecycle: "ready",
    }),
    false,
  );
});

test("intentional stop does not require failure handling", () => {
  assert.equal(classifySimliStopEvent({ generation: 4, activeGeneration: 4, stopRequested: true }), "intentional");
});

test("SDK stopped event from stale generation is ignored", () => {
  assert.equal(classifySimliStopEvent({ generation: 4, activeGeneration: 5, stopRequested: false }), "stale");
});

test("unexpected current-generation stop is classified as recoverable failure", () => {
  assert.equal(classifySimliStopEvent({ generation: 5, activeGeneration: 5, stopRequested: false }), "unexpected");
});

test("current mounted connected client may send audio", () => {
  const client = {};

  assert.equal(
    canSendSimliAudio({
      mounted: true,
      generation: 2,
      currentGeneration: 2,
      client,
      currentClient: client,
      lifecycle: "playing",
    }),
    true,
  );
});

test("SDK speaking during PCM upload moves lifecycle to playing and still permits remaining chunks", () => {
  const client = {};
  assert.equal(
    canSendSimliAudio({
      mounted: true,
      generation: 3,
      currentGeneration: 3,
      client,
      currentClient: client,
      lifecycle: "uploading",
    }),
    true,
  );

  assert.equal(
    canSendSimliAudio({
      mounted: true,
      generation: 3,
      currentGeneration: 3,
      client,
      currentClient: client,
      lifecycle: "playing",
    }),
    true,
  );
});

test("reproduced stack predicate identifies stale generation instead of generic line-189 failure", () => {
  const oldClient = {};
  const currentClient = {};
  assert.equal(
    canSendSimliAudio({
      mounted: true,
      generation: 3,
      currentGeneration: 4,
      client: oldClient,
      currentClient,
      lifecycle: "playing",
    }),
    false,
  );
});

test("abort preserves first typed reason", () => {
  const first = preserveFirstAbortReason<"transport_closed" | "recovery_started">("transport_closed", "recovery_started");
  assert.equal(first, "transport_closed");
  assert.equal(preserveFirstAbortReason<"user_skip" | "transport_closed">(null, "user_skip"), "user_skip");
});

test("PCM conversion produces mono signed PCM16 little-endian at required rate", () => {
  const mono = downmixToMono([
    new Float32Array([1, 0.5, -1]),
    new Float32Array([1, -0.5, -1]),
  ]);
  const resampled = resampleLinear(mono, 48_000, SIMLI_REQUIRED_SAMPLE_RATE);
  const pcm = floatToPcm16LittleEndian(resampled);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  assert.equal(SIMLI_REQUIRED_SAMPLE_RATE, 16_000);
  assert.deepEqual(Array.from(mono), [1, 0, -1]);
  assert.equal(resampled.length, 1);
  assert.equal(view.getInt16(0, true), 32767);
});

test("PCM chunking uses 3000-sample chunks and preserves order", () => {
  const sampleCount = SIMLI_PCM_CHUNK_SAMPLES + 2;
  const pcm = new Uint8Array(sampleCount * 2);
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = index % 251;

  const chunks = chunkPcm16(pcm);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].bytes.length, SIMLI_PCM_CHUNK_SAMPLES * 2);
  assert.equal(chunks[1].bytes.length, 4);
  assert.deepEqual(
    Array.from(new Uint8Array([...chunks[0].bytes, ...chunks[1].bytes])),
    Array.from(pcm),
  );
  assert.equal(chunks[0].durationMs, (SIMLI_PCM_CHUNK_SAMPLES / SIMLI_REQUIRED_SAMPLE_RATE) * 1000);
});

test("sample-count pacing corrects drift against an absolute clock", () => {
  const startedAt = 1_000;
  const sentSamples = 3_000;

  assert.equal(getPacingDelayMs(startedAt, 1_100, sentSamples), 87.5);
  assert.equal(getPacingDelayMs(startedAt, 1_300, sentSamples), 0);

  const measurement = measurePacing(startedAt, 1_188, sentSamples);
  assert.equal(measurement.expectedElapsedMs, 187.5);
  assert.equal(measurement.driftMs, 0.5);
});

test("early silent event cannot complete active upload", () => {
  assert.equal(canCompleteFromSilentEvent({
    lifecycle: "playing",
    generation: 7,
    speechGeneration: 7,
    chunksComplete: false,
    speakingObserved: true,
    settled: false,
  }), false);
});

test("silent before speaking cannot complete after upload", () => {
  assert.equal(canCompleteFromSilentEvent({
    lifecycle: "playing",
    generation: 7,
    speechGeneration: 7,
    chunksComplete: true,
    speakingObserved: false,
    settled: false,
  }), false);
});

test("duplicate silent after settlement cannot complete playback twice", () => {
  assert.equal(canCompleteFromSilentEvent({
    lifecycle: "playing",
    generation: 7,
    speechGeneration: 7,
    chunksComplete: true,
    speakingObserved: true,
    settled: true,
  }), false);
});

test("candidate listening begins only after speaking then post-upload silent guard passes", () => {
  assert.equal(canCompleteFromSilentEvent({
    lifecycle: "playing",
    generation: 7,
    speechGeneration: 7,
    chunksComplete: true,
    speakingObserved: true,
    settled: false,
  }), true);
});

test("duration fallback must be scheduled from upload completion by caller", () => {
  assert.equal(canCompleteFromSilentEvent({
    lifecycle: "uploading",
    generation: 7,
    speechGeneration: 7,
    chunksComplete: true,
    speakingObserved: true,
    settled: false,
  }), false);
});

test("sample-clock pacing rejects unsafe background-tab drift", () => {
  assert.equal(isPacingDriftSafe(1_000, 2_400), true);
  assert.equal(isPacingDriftSafe(1_000, 2_501), false);
});
