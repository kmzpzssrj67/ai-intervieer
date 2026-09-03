import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeLocalSpeech } from "../../../services/interviewApi.ts";

test("local speech performs one request and validates the bundle", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      audio_base64: btoa("mp3"),
      content_type: "audio/mpeg",
      word_boundaries: [{ text: "API", start: 0.1, duration: 0.2 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const bundle = await synthesizeLocalSpeech("Explain API", "turn-1");
    assert.equal(calls, 1);
    assert.equal(bundle.audioBuffer.byteLength, 3);
    assert.deepEqual(bundle.wordBoundaries, [{ text: "API", start: 0.1, duration: 0.2 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local speech rejects malformed timing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    audio_base64: btoa("mp3"),
    content_type: "audio/mpeg",
    word_boundaries: [{ text: "bad", start: -1, duration: 0.2 }],
  }), { status: 200 });
  try {
    await assert.rejects(synthesizeLocalSpeech("bad", "turn-2"), /invalid word timing/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
