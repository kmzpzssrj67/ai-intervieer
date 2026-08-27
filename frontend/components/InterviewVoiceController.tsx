"use client";

import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_VOICE_API ?? "http://localhost:8080";
const WS_URL = API.replace(/^http/i, "ws") + "/ws/chat";

const VAD_START = 0.035;
const VAD_STOP = 0.018;
const VAD_SILENCE_MS = 300;
const VAD_SILENCE_MAX_MS = 1300;
const VAD_SILENCE_GROW_AFTER_MS = 1500;
const VAD_SILENCE_GROW_MS_PER_SEC = 180;
const VAD_MIN_MS = 320;
const VAD_PEAK_MIN = 0.08;
const ECHO_COOLDOWN_MS = 350;

type Props = {
  enabled: boolean;
  acceptingAnswer: boolean;
  onFinalTranscript: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
};

export default function InterviewVoiceController({ enabled, acceptingAnswer, onFinalTranscript, onListeningChange }: Props) {
  const [needTap, setNeedTap] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const currentTurnRef = useRef<string | null>(null);
  const turnSeqRef = useRef(0);
  const busyRef = useRef(false);
  const speakingRef = useRef(false);
  const cooldownRef = useRef(0);
  const micStarted = useRef(false);
  const enabledRef = useRef(enabled);
  const acceptingRef = useRef(acceptingAnswer);
  const finalTranscriptSentRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<{ src?: MediaStreamAudioSourceNode; proc?: ScriptProcessorNode; mute?: GainNode; stream?: MediaStream }>({});
  const wsOpenWaitersRef = useRef<((open: boolean) => void)[]>([]);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const onListeningChangeRef = useRef(onListeningChange);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
    onListeningChangeRef.current = onListeningChange;
  }, [onFinalTranscript, onListeningChange]);
  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      acceptingRef.current = acceptingAnswer;
      finalTranscriptSentRef.current = false;
      cooldownRef.current = performance.now() + ECHO_COOLDOWN_MS;
      void start();
    } else {
      acceptingRef.current = false;
      onListeningChangeRef.current?.(false);
    }
  }, [acceptingAnswer, enabled]);

  useEffect(() => {
    let stopped = false;
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        const waiters = wsOpenWaitersRef.current.splice(0);
        waiters.forEach((resolve) => resolve(true));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "transcript" && typeof msg.text === "string") {
            releaseTurn(msg.turn_id || currentTurnRef.current || "");
            console.log("[Voice] transcript", { text: msg.text, accepting: acceptingRef.current, sent: finalTranscriptSentRef.current });
            if (acceptingRef.current && !finalTranscriptSentRef.current) {
              finalTranscriptSentRef.current = true;
              acceptingRef.current = false;
              onListeningChangeRef.current?.(false);
              onFinalTranscriptRef.current(msg.text.trim());
            }
          } else if ((msg.type === "done" || msg.type === "command") && msg.turn_id) {
            wsSend({ type: "audio_end", turn_id: msg.turn_id, reason: "interview_handoff" });
            releaseTurn(msg.turn_id);
          } else if (msg.type === "ignored" && msg.turn_id) {
            releaseTurn(msg.turn_id);
            onListeningChangeRef.current?.(false);
          }
        } catch {
          /* ignore malformed ws messages */
        }
      };
      ws.onclose = () => {
        const waiters = wsOpenWaitersRef.current.splice(0);
        waiters.forEach((resolve) => resolve(false));
        if (!stopped) window.setTimeout(connect, 1200);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      };
    }
    connect();
    const ping = window.setInterval(() => wsSend({ type: "ping" }), 25000);
    return () => {
      stopped = true;
      window.clearInterval(ping);
      wsRef.current?.close();
      nodesRef.current.stream?.getTracks().forEach((track) => track.stop());
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  function wsSend(obj: unknown): boolean {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function waitForWsOpen(timeoutMs = 3000): Promise<boolean> {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        wsOpenWaitersRef.current = wsOpenWaitersRef.current.filter((fn) => fn !== done);
        resolve(false);
      }, timeoutMs);
      const done = (open: boolean) => {
        window.clearTimeout(timer);
        resolve(open);
      };
      wsOpenWaitersRef.current.push(done);
    });
  }

  function newTurnId(): string {
    turnSeqRef.current += 1;
    return `INTERVIEW-${String(turnSeqRef.current).padStart(4, "0")}`;
  }

  function releaseTurn(turnId: string) {
    if (currentTurnRef.current !== turnId) return;
    busyRef.current = false;
    speakingRef.current = false;
    currentTurnRef.current = null;
  }

  function f32b64(f32: Float32Array): string {
    const u8 = new Uint8Array(f32.buffer);
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
    }
    return btoa(s);
  }

  async function initMic(): Promise<boolean> {
    if (micStarted.current) return true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      return false;
    }

    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    await ctx.resume().catch(() => {});
    const rate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);

    let vSpeaking = false;
    let vFrames: Float32Array[] = [];
    let vSilenceAt = 0;
    let vSilenceNeeded = 0;
    let vSpeechAt = 0;
    let vPeak = 0;
    let listeningSent = false;

    const cancelListening = () => {
      if (!listeningSent) return;
      const turnId = currentTurnRef.current;
      if (turnId) {
        wsSend({ type: "listening_cancel", turn_id: turnId });
        releaseTurn(turnId);
      }
      listeningSent = false;
      onListeningChangeRef.current?.(false);
    };

    const emit = () => {
      const len = vFrames.reduce((total, frame) => total + frame.length, 0);
      if (!len) {
        cancelListening();
        return;
      }
      const audio = new Float32Array(len);
      let offset = 0;
      for (const frame of vFrames) {
        audio.set(frame, offset);
        offset += frame.length;
      }
      const turnId = currentTurnRef.current;
      if (!turnId) return;
      wsSend({ type: "listening_end", turn_id: turnId });
      if (!wsSend({ type: "audio_pcm16", turn_id: turnId, sample_rate: rate, data: f32b64(audio) })) {
        releaseTurn(turnId);
      }
      listeningSent = false;
      onListeningChangeRef.current?.(false);
    };

    proc.onaudioprocess = (event) => {
      const now = performance.now();
      if (!enabledRef.current || !acceptingRef.current || speakingRef.current || now < cooldownRef.current) {
        if (vSpeaking) cancelListening();
        vSpeaking = false;
        vFrames = [];
        vPeak = 0;
        vSilenceAt = 0;
        return;
      }
      if (busyRef.current && !vSpeaking) return;

      const buf = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);

      if (!vSpeaking) {
        if (rms > VAD_START) {
          const turnId = newTurnId();
          currentTurnRef.current = turnId;
          busyRef.current = true;
          vSpeaking = true;
          vSpeechAt = now;
          vSilenceAt = 0;
          vPeak = rms;
          vFrames = [new Float32Array(buf)];
          listeningSent = true;
          onListeningChangeRef.current?.(true);
          if (!wsSend({ type: "listening_start", turn_id: turnId })) {
            releaseTurn(turnId);
            vSpeaking = false;
            vFrames = [];
            listeningSent = false;
            onListeningChangeRef.current?.(false);
          }
        }
      } else {
        vFrames.push(new Float32Array(buf));
        if (rms > vPeak) vPeak = rms;
        if (rms < VAD_STOP) {
          if (!vSilenceAt) {
            vSilenceAt = now;
            const spokenMs = now - vSpeechAt;
            const extraMs = Math.max(0, spokenMs - VAD_SILENCE_GROW_AFTER_MS);
            vSilenceNeeded = Math.min(VAD_SILENCE_MAX_MS, VAD_SILENCE_MS + (extraMs / 1000) * VAD_SILENCE_GROW_MS_PER_SEC);
          } else if (now - vSilenceAt > vSilenceNeeded) {
            vSpeaking = false;
            const longEnough = now - vSpeechAt >= VAD_MIN_MS;
            const loudEnough = vPeak >= VAD_PEAK_MIN;
            if (longEnough && loudEnough) emit();
            else cancelListening();
            vFrames = [];
            vSilenceAt = 0;
            vPeak = 0;
          }
        } else {
          vSilenceAt = 0;
        }
      }
    };

    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    ctxRef.current = ctx;
    nodesRef.current = { src: source, proc, mute, stream };
    micStarted.current = true;
    return true;
  }

  async function start() {
    const mic = await initMic();
    const socketReady = await waitForWsOpen();
    setNeedTap(!mic || !socketReady);
  }

  useEffect(() => {
    const onTap = () => {
      if (!micStarted.current || needTap || enabledRef.current) void start();
    };
    window.addEventListener("pointerdown", onTap);
    return () => window.removeEventListener("pointerdown", onTap);
  }, [needTap]);

  return null;
}








