import assert from "node:assert/strict";
import test from "node:test";

import { AudioPlaybackController } from "./AudioPlaybackController.ts";

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start() {}
  stop() { this.onended?.(); }
}

class FakeAnalyser {
  fftSize = 32;
  smoothingTimeConstant = 0;
  connect() {}
  disconnect() {}
  getByteTimeDomainData(data: Uint8Array) { data.fill(128); }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 4;
  destination = {};
  source = new FakeSource();
  analyser = new FakeAnalyser();
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
  createAnalyser() { return this.analyser; }
  createBufferSource() { this.source = new FakeSource(); return this.source; }
  async decodeAudioData() { return { duration: 2, sampleRate: 48_000 }; }
}

function installAudioContext(context: FakeAudioContext) {
  Object.assign(globalThis, { window: { AudioContext: class { constructor() { return context; } } } });
}

test("plays decoded audio and completes naturally exactly once", async () => {
  const context = new FakeAudioContext();
  installAudioContext(context);
  const controller = new AudioPlaybackController();
  let completions = 0;
  const started = await controller.play(new ArrayBuffer(2), () => { completions += 1; });
  assert.equal(started.duration, 2);
  context.currentTime = 4.5;
  assert.equal(controller.getElapsedTime(), 0.5);
  context.source.onended?.();
  context.source.onended?.();
  assert.equal(completions, 1);
  await controller.dispose();
});

test("replacement and skip do not invoke natural completion", async () => {
  const context = new FakeAudioContext();
  installAudioContext(context);
  const controller = new AudioPlaybackController();
  let completions = 0;
  await controller.play(new ArrayBuffer(2), () => { completions += 1; });
  const stale = context.source.onended;
  await controller.play(new ArrayBuffer(2), () => { completions += 1; });
  stale?.();
  controller.cancel("skip");
  assert.equal(completions, 0);
  await controller.dispose();
});

test("decode failures do not create active playback", async () => {
  const context = new FakeAudioContext();
  context.decodeAudioData = async () => { throw new Error("decode failed"); };
  installAudioContext(context);
  const controller = new AudioPlaybackController();
  await assert.rejects(controller.play(new ArrayBuffer(2), () => undefined), /decode failed/);
  assert.equal(controller.getCurrentUtteranceId(), null);
  await controller.dispose();
});
