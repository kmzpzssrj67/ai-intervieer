"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { LogLevel, SimliClient } from "simli-client/dist/client";
import { API_BASE } from "@/services/interviewApi";
import Avatar, { type AvatarState } from "@/components/Avatar";
import type { AvatarRendererHandle, SpeakResult, SpeechAbortReason } from "./types";
import {
  canSendSimliAudio,
  canCompleteFromSilentEvent,
  chunkPcm16,
  classifySimliStopEvent,
  devLogSimli,
  downmixToMono,
  floatToPcm16LittleEndian,
  getChunkTargetTimeMs,
  getPacingDelayMs,
  isPacingDriftSafe,
  measurePacing,
  resampleLinear,
  sanitizeSimliMessage,
  SIMLI_REQUIRED_SAMPLE_RATE,
  stopSimliClientOnce,
  type LifecycleState,
  type PcmChunk,
} from "./simliLifecycle";

type SimliAvatarProps = {
  interviewId: number;
  localState: AvatarState;
  localVisemeState: AvatarState;
  onUnavailable: (message?: string) => void;
};

type DisplayState = "connecting" | "ready" | "speaking" | "recovering" | "unavailable";
type SimliEventName = "speaking" | "silent" | "stop" | "error" | "startup_error";
type SimliHandler = (...args: unknown[]) => void;
type TerminalReason = "stop" | "error" | "startup" | "rate" | "provider_error" | "session_expired" | "transport" | "unknown";
type SpeechOperation = {
  generation: number;
  utteranceId: string;
  uploadStartedAt: number;
  firstSpeakingAt: number | null;
  finalChunkAt: number | null;
  completedAt: number | null;
  decodedDurationMs: number;
  speakingObserved: boolean;
  uploadComplete: boolean;
  abortReason: SpeechAbortReason | null;
  settled: boolean;
};

const STARTUP_TIMEOUT_MS = 15_000;
const PLAYBACK_FALLBACK_BUFFER_MS = 2_500;

const EXPECTED_ABORT_REASONS: ReadonlySet<SpeechAbortReason> = new Set([
  "user_skip",
  "user_exit",
  "component_unmount",
  "new_utterance",
  "stale_generation",
]);

class SimliSpeechAbortError extends Error {
  constructor(readonly reason: SpeechAbortReason) {
    super(reason);
    this.name = "SimliSpeechAbortError";
  }
}

function getAbortReason(signal: AbortSignal): SpeechAbortReason | null {
  const reason = signal.reason as { code?: SpeechAbortReason } | SpeechAbortReason | undefined;
  if (typeof reason === "string") return reason;
  return reason?.code ?? null;
}

function abortReasonForDisconnect(reason: string): SpeechAbortReason {
  if (reason === "component_unmount" || reason === "pagehide" || reason === "page_unmount") return "component_unmount";
  if (reason === "use_local_avatar" || reason === "interview_completed" || reason === "user_requested") return "user_exit";
  return "user_exit";
}

const SimliAvatar = forwardRef<AvatarRendererHandle, SimliAvatarProps>(function SimliAvatar(
  { interviewId, localState, localVisemeState, onUnavailable },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<SimliClient | null>(null);
  const lifecycleRef = useRef<LifecycleState>("idle");
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const disconnectPromiseRef = useRef<Promise<void> | null>(null);
  const recoveryPromiseRef = useRef<Promise<void> | null>(null);
  const commandQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const generationRef = useRef(0);
  const activeClientGenerationRef = useRef(0);
  const stopRequestedRef = useRef(new Set<number>());
  const recoveredGenerationsRef = useRef(new Set<number>());
  const terminalReasonRef = useRef(new Map<number, TerminalReason>());
  const connectionAttemptAbortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const stoppedClientsRef = useRef(new WeakSet<object>());
  const listenerRefs = useRef(new WeakMap<object, Array<[SimliEventName, SimliHandler]>>());
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const speechAbortRef = useRef<AbortController | null>(null);
  const pacingTimerRefs = useRef(new Set<number>());
  const speechResolveRef = useRef<(() => void) | null>(null);
  const speechRejectRef = useRef<((error: Error) => void) | null>(null);
  const speechTimeoutRef = useRef<number | null>(null);
  const speechGenerationRef = useRef<number | null>(null);
  const speechChunksCompleteRef = useRef(false);
  const speechOperationRef = useRef<SpeechOperation | null>(null);
  const onUnavailableRef = useRef(onUnavailable);
  const recoverFromFailureRef = useRef<((client: SimliClient, generation: number, reason: TerminalReason, duringSpeech: boolean) => Promise<void>) | null>(null);
  const [displayState, setDisplayState] = useState<DisplayState>("connecting");
  const [videoReady, setVideoReady] = useState(false);

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = commandQueueRef.current.catch(() => undefined).then(task);
    commandQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  const setLifecycle = useCallback((next: LifecycleState) => {
    lifecycleRef.current = next;
    if (!mountedRef.current) return;
    if (next === "session_creating" || next === "connecting") setDisplayState("connecting");
    if (next === "ready" || next === "uploading") setDisplayState("ready");
    if (next === "playing") setDisplayState("speaking");
    if (next === "recovering") setDisplayState("recovering");
    if (next === "error" || next === "disconnected") setDisplayState("unavailable");
  }, []);

  const clearSpeechTimer = useCallback(() => {
    if (speechTimeoutRef.current !== null) window.clearTimeout(speechTimeoutRef.current);
    speechTimeoutRef.current = null;
    for (const timer of pacingTimerRefs.current) window.clearTimeout(timer);
    pacingTimerRefs.current.clear();
  }, []);

  const requestSpeechAbort = useCallback((reason: SpeechAbortReason, generation = generationRef.current) => {
    const operation = speechOperationRef.current;
    if (!operation || operation.generation !== generation || operation.abortReason) return;
    operation.abortReason = reason;
    devLogSimli("simli_speech_abort_requested", {
      reason,
      generation,
      lifecycle: lifecycleRef.current,
      uploadCompleted: operation.uploadComplete,
      speakingObserved: operation.speakingObserved,
    });
    speechAbortRef.current?.abort({ code: reason, generation, utteranceId: operation.utteranceId });
  }, []);

  const settleSpeech = useCallback((error?: Error, abortUpload = false, abortReason: SpeechAbortReason = "transport_closed") => {
    if (speechOperationRef.current?.settled) return;
    if (speechOperationRef.current) speechOperationRef.current.settled = true;
    if (abortUpload) requestSpeechAbort(abortReason, speechOperationRef.current?.generation);
    clearSpeechTimer();
    const resolve = speechResolveRef.current;
    const reject = speechRejectRef.current;
    speechResolveRef.current = null;
    speechRejectRef.current = null;
    speechGenerationRef.current = null;
    speechChunksCompleteRef.current = false;
    speechOperationRef.current = null;
    if (abortUpload) speechAbortRef.current = null;
    if (error) {
      reject?.(error);
      return;
    }
    resolve?.();
  }, [clearSpeechTimer, requestSpeechAbort]);

  const sleepPaced = useCallback((delayMs: number, signal: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new SimliSpeechAbortError(getAbortReason(signal) ?? "transport_closed"));
        return;
      }
      const timer = window.setTimeout(() => {
        pacingTimerRefs.current.delete(timer);
        resolve();
      }, Math.max(0, delayMs));
      pacingTimerRefs.current.add(timer);
      signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        pacingTimerRefs.current.delete(timer);
        reject(new SimliSpeechAbortError(getAbortReason(signal) ?? "transport_closed"));
      }, { once: true });
    });
  }, []);

  const canSendAudioToClient = useCallback((client: SimliClient | null, generation: number) => {
    return canSendSimliAudio({
      mounted: mountedRef.current,
      generation,
      currentGeneration: generationRef.current,
      client,
      currentClient: clientRef.current,
      lifecycle: lifecycleRef.current,
    });
  }, []);

  const pcmChunksFromAudioBuffer = useCallback((decoded: AudioBuffer): PcmChunk[] => {
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const mono = downmixToMono(channels);
    const resampled = resampleLinear(mono, decoded.sampleRate, SIMLI_REQUIRED_SAMPLE_RATE);
    return chunkPcm16(floatToPcm16LittleEndian(resampled));
  }, []);

  const sendPacedAudioChunks = useCallback(async (client: SimliClient, generation: number, chunks: PcmChunk[], signal: AbortSignal) => {
    const startedAt = performance.now();
    let sentSamples = 0;
    let maxDriftMs = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      if (!chunk) continue;
      if (!canSendAudioToClient(client, generation) || signal.aborted) {
        const abortReason = getAbortReason(signal);
        devLogSimli("simli_pcm_send_invalidated", {
          clientMatches: client === clientRef.current,
          generationMatches: generation === generationRef.current,
          signalAborted: signal.aborted,
          lifecycle: lifecycleRef.current,
          abortReason,
          chunkIndex,
          totalChunks: chunks.length,
        });
        throw new SimliSpeechAbortError(abortReason ?? "transport_closed");
      }
      const targetTime = getChunkTargetTimeMs(startedAt, sentSamples);
      const now = performance.now();
      if (!isPacingDriftSafe(targetTime, now)) {
        requestSpeechAbort("pacing_drift", generation);
        throw new SimliSpeechAbortError("pacing_drift");
      }
      await sleepPaced(getPacingDelayMs(startedAt, now, sentSamples), signal);
      if (!canSendAudioToClient(client, generation) || signal.aborted) {
        const abortReason = getAbortReason(signal);
        devLogSimli("simli_pcm_send_invalidated", {
          clientMatches: client === clientRef.current,
          generationMatches: generation === generationRef.current,
          signalAborted: signal.aborted,
          lifecycle: lifecycleRef.current,
          abortReason,
          chunkIndex,
          totalChunks: chunks.length,
        });
        throw new SimliSpeechAbortError(abortReason ?? "transport_closed");
      }
      maxDriftMs = Math.max(maxDriftMs, Math.abs(performance.now() - targetTime));
      try {
        client.sendAudioData(chunk.bytes);
      } catch (error) {
        throw new Error(sanitizeSimliMessage(error));
      }
      sentSamples += chunk.samples;
    }
    const finishedAt = performance.now();
    const pacing = measurePacing(startedAt, finishedAt, sentSamples);
    return {
      ...pacing,
      totalSamples: sentSamples,
      maxDriftMs,
      actualSendDurationMs: finishedAt - startedAt,
    };
  }, [canSendAudioToClient, sleepPaced]);

  const releaseInput = useCallback(async () => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already stopped or never started. */
      }
      try {
        source.disconnect();
      } catch {
        /* Source may already be disconnected. */
      }
    }
    trackRef.current?.stop();
    trackRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        /* Browser audio cleanup should not block avatar recovery. */
      }
    }
  }, []);

  const detachListeners = useCallback((client: SimliClient | null) => {
    if (!client) return;
    const listeners = listenerRefs.current.get(client);
    if (!listeners) return;
    for (const [event, handler] of listeners) {
      try {
        client.off(event, handler as never);
      } catch {
        /* Simli throws if an event was already removed. */
      }
    }
    listenerRefs.current.delete(client);
  }, []);

  const releaseMediaElements = useCallback(() => {
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const classifyTerminalReason = useCallback((stage: string, error: unknown): TerminalReason => {
    const message = sanitizeSimliMessage(error).toLowerCase();
    if (message.includes("rate")) return "rate";
    if (message.includes("invalid token") || message.includes("token")) return "provider_error";
    if (message.includes("face")) return "provider_error";
    if (message.includes("allowance") || message.includes("quota")) return "provider_error";
    if (message.includes("session") && (message.includes("limit") || message.includes("expired"))) return "session_expired";
    if (stage === "startup") return "startup";
    if (stage === "stop") return "stop";
    if (stage === "connection") return "transport";
    return "unknown";
  }, []);

  const isRecoverableReason = useCallback((reason: TerminalReason) => {
    return reason === "stop" || reason === "transport" || reason === "startup" || reason === "unknown";
  }, []);

  const disconnectInternal = useCallback(async (reason = "user_requested", expectedClient?: SimliClient | null, expectedGeneration?: number) => {
    if (expectedClient !== undefined && expectedClient !== clientRef.current) return;
    if (expectedGeneration !== undefined && expectedGeneration !== generationRef.current) return;
    if (disconnectPromiseRef.current) return disconnectPromiseRef.current;

    const stateAtStart = lifecycleRef.current;
    const client = clientRef.current;
    const generationAtStart = generationRef.current;
    if (stateAtStart === "idle" || stateAtStart === "disconnected" || stateAtStart === "disconnecting") {
      setLifecycle("disconnected");
      return;
    }
    if (stateAtStart === "error") {
      stopRequestedRef.current.add(generationAtStart);
      terminalReasonRef.current.set(generationAtStart, "stop");
      settleSpeech(undefined, true, abortReasonForDisconnect(reason));
      connectionAttemptAbortControllerRef.current?.abort();
      connectionAttemptAbortControllerRef.current = null;
      await releaseInput();
      releaseMediaElements();
      clientRef.current = null;
      setVideoReady(false);
      setLifecycle("disconnected");
      return;
    }

    devLogSimli("simli_disconnect_start", { generation: generationAtStart, reason });
    stopRequestedRef.current.add(generationAtStart);
    terminalReasonRef.current.set(generationAtStart, "stop");
    setLifecycle("disconnecting");
    const disconnectedGeneration = generationRef.current + 1;
    generationRef.current = disconnectedGeneration;
    activeClientGenerationRef.current = 0;
    connectPromiseRef.current = null;
    connectionAttemptAbortControllerRef.current?.abort();
    connectionAttemptAbortControllerRef.current = null;
    settleSpeech(undefined, true, abortReasonForDisconnect(reason));
    detachListeners(client);

    const promise = (async () => {
      await releaseInput();
      await stopSimliClientOnce(client, stoppedClientsRef.current, stateAtStart, (error) => {
        devLogSimli("simli_error", { stage: "stop", sanitizedMessage: sanitizeSimliMessage(error) });
      });
      if (clientRef.current === client) clientRef.current = null;
      releaseMediaElements();
      if (generationRef.current === disconnectedGeneration) {
        setVideoReady(false);
        setLifecycle("disconnected");
      }
      devLogSimli("simli_disconnected", { generation: generationAtStart, reason });
    })().finally(() => {
      disconnectPromiseRef.current = null;
    });
    disconnectPromiseRef.current = promise;
    return promise;
  }, [detachListeners, releaseInput, releaseMediaElements, setLifecycle, settleSpeech]);

  const handleConnectionFailure = useCallback((stage: string, error: unknown, client: SimliClient | null, generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current || client !== clientRef.current) return;
    if (generation !== activeClientGenerationRef.current || stopRequestedRef.current.has(generation)) return;
    const terminalReason = classifyTerminalReason(stage, error);
    terminalReasonRef.current.set(generation, terminalReason);
    devLogSimli("simli_error", { stage, generation, terminalReason, sanitizedMessage: sanitizeSimliMessage(error) });
    const operation = speechOperationRef.current;
    const duringSpeech = operation?.generation === generation && !operation.settled;
    generationRef.current += 1;
    activeClientGenerationRef.current = 0;
    connectPromiseRef.current = null;
    connectionAttemptAbortControllerRef.current?.abort();
    connectionAttemptAbortControllerRef.current = null;
    detachListeners(client);
    setVideoReady(false);
    if (duringSpeech) settleSpeech(new SimliSpeechAbortError(terminalReason === "stop" ? "provider_stop" : terminalReason === "rate" ? "provider_rate_limit" : terminalReason === "provider_error" ? "provider_error" : terminalReason === "session_expired" ? "session_expired" : "transport_closed"), true, "recovery_started");
    else settleSpeech(undefined, true, "recovery_started");

    if (client && isRecoverableReason(terminalReason) && !recoveredGenerationsRef.current.has(generation)) {
      recoveredGenerationsRef.current.add(generation);
      setLifecycle("recovering");
      const recovery = enqueue(async () => {
        const handler = recoverFromFailureRef.current;
        if (!handler) throw new Error("Simli recovery handler is unavailable");
        await handler(client, generation, terminalReason, duringSpeech);
      }).catch((recoveryError) => {
        devLogSimli("simli_error", { stage: "recovery", generation, sanitizedMessage: sanitizeSimliMessage(recoveryError) });
        if (clientRef.current === null) {
          setLifecycle("error");
          onUnavailableRef.current("Avatar connection unavailable");
        }
      });
      const trackedRecovery = recovery.finally(() => {
        if (recoveryPromiseRef.current === trackedRecovery) recoveryPromiseRef.current = null;
      });
      recoveryPromiseRef.current = trackedRecovery;
      return;
    }

    void releaseInput();
    releaseMediaElements();
    clientRef.current = null;
    setLifecycle("error");
    onUnavailableRef.current("Avatar connection unavailable");
  }, [classifyTerminalReason, detachListeners, enqueue, isRecoverableReason, releaseInput, releaseMediaElements, setLifecycle, settleSpeech]);

  const attachListeners = useCallback((client: SimliClient, generation: number) => {
    const isCurrent = () => mountedRef.current && generation === generationRef.current && client === clientRef.current;
    const speaking = () => {
      if (!isCurrent()) return;
      const operation = speechOperationRef.current;
      if (operation?.generation === generation && operation.firstSpeakingAt === null) {
        operation.firstSpeakingAt = performance.now();
        operation.speakingObserved = true;
        devLogSimli("simli_speech_start", { generation, msFromFirstChunk: Math.round(operation.firstSpeakingAt - operation.uploadStartedAt) });
      } else {
        devLogSimli("simli_speech_start", { generation });
      }
      setLifecycle("playing");
    };
    const silent = () => {
      if (!isCurrent()) return;
      if (stopRequestedRef.current.has(generation)) {
        setLifecycle("disconnected");
        return;
      }
      if (!canCompleteFromSilentEvent({
        lifecycle: lifecycleRef.current,
        generation,
        speechGeneration: speechGenerationRef.current,
        chunksComplete: speechChunksCompleteRef.current,
        speakingObserved: speechOperationRef.current?.speakingObserved ?? false,
        settled: speechOperationRef.current?.settled ?? true,
      })) return;
      const operation = speechOperationRef.current;
      if (operation) operation.completedAt = performance.now();
      devLogSimli("simli_speech_complete", {
        generation,
        msFromFinalChunk: operation?.finalChunkAt ? Math.round(performance.now() - operation.finalChunkAt) : null,
        totalAvatarPlaybackMs: operation?.firstSpeakingAt && operation.completedAt ? Math.round(operation.completedAt - operation.firstSpeakingAt) : null,
      });
      settleSpeech();
      setLifecycle("ready");
    };
    const stopped = (error?: unknown) => {
      const classification = classifySimliStopEvent({
        generation,
        activeGeneration: activeClientGenerationRef.current,
        stopRequested: stopRequestedRef.current.has(generation),
      });
      if (classification === "stale") return;
      if (classification === "intentional") {
        setLifecycle("disconnected");
        return;
      }
      terminalReasonRef.current.set(generation, "stop");
      handleConnectionFailure("stop", error ?? "Simli stopped", client, generation);
    };
    const errored = (error?: unknown) => {
      if (generation !== activeClientGenerationRef.current || stopRequestedRef.current.has(generation)) return;
      terminalReasonRef.current.set(generation, classifyTerminalReason("connection", error ?? "Simli connection lost"));
      handleConnectionFailure("connection", error ?? "Simli connection lost", client, generation);
    };
    const startupErrored = (error?: unknown) => {
      if (generation !== activeClientGenerationRef.current || stopRequestedRef.current.has(generation)) return;
      terminalReasonRef.current.set(generation, classifyTerminalReason("startup", error ?? "Simli startup failed"));
      handleConnectionFailure("startup", error ?? "Simli startup failed", client, generation);
    };
    const listeners: Array<[SimliEventName, SimliHandler]> = [
      ["speaking", speaking],
      ["silent", silent],
      ["stop", stopped],
      ["error", errored],
      ["startup_error", startupErrored],
    ];
    listenerRefs.current.set(client, listeners);
    for (const [event, handler] of listeners) client.on(event, handler as never);
  }, [classifyTerminalReason, handleConnectionFailure, setLifecycle, settleSpeech]);

  const waitForVideo = useCallback((video: HTMLVideoElement, client: SimliClient, generation: number) => {
    return new Promise<void>((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        video.removeEventListener("loadeddata", ready);
        reject(new Error("Simli video did not arrive"));
      }, STARTUP_TIMEOUT_MS);
      const ready = () => {
        window.clearTimeout(timer);
        video.removeEventListener("loadeddata", ready);
        if (!canSendSimliAudio({
          mounted: mountedRef.current,
          generation,
          currentGeneration: generationRef.current,
          client,
          currentClient: clientRef.current,
          lifecycle: "ready",
        })) {
          reject(new Error("Stale Simli video connection"));
          return;
        }
        resolve();
      };
      video.addEventListener("loadeddata", ready, { once: true });
    });
  }, []);

  const connectInternal = useCallback(async () => {
    if (disconnectPromiseRef.current) await disconnectPromiseRef.current;
    const currentState = lifecycleRef.current;
    if (clientRef.current && (currentState === "ready" || currentState === "uploading" || currentState === "playing")) return;
    if (connectPromiseRef.current) return connectPromiseRef.current;

    const promise = (async () => {
      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video || !audio) throw new Error("Avatar media elements are unavailable");
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeClientGenerationRef.current = generation;
      stopRequestedRef.current.delete(generation);
      const connectAbortController = new AbortController();
      connectionAttemptAbortControllerRef.current = connectAbortController;
      setLifecycle("session_creating");
      setVideoReady(false);
      devLogSimli("simli_connect_start");

      const connectStartedAt = performance.now();
      const response = await fetch(`${API_BASE}/api/avatar/simli/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interview_id: interviewId }),
        signal: connectAbortController.signal,
      });
      if (!response.ok) throw new Error("Simli avatar is unavailable");
      const body = (await response.json()) as { session_token?: string };
      if (!body.session_token) throw new Error("Simli avatar session was not created");
      if (!mountedRef.current || generation !== generationRef.current) throw new Error("Stale Simli session");
      devLogSimli("simli_session_created");

      const client = new SimliClient(body.session_token, video, audio, null, LogLevel.CRITICAL, "livekit");
      clientRef.current = client;
      attachListeners(client, generation);

      try {
        setLifecycle("connecting");
        const ownedStartPromise = client.start().catch((error) => {
          if (stopRequestedRef.current.has(generation) || connectAbortController.signal.aborted || generation !== activeClientGenerationRef.current) return;
          throw error;
        });
        await Promise.race([
          ownedStartPromise,
          new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error("Simli startup timed out")), STARTUP_TIMEOUT_MS);
          }),
        ]);
        if (generation !== generationRef.current || client !== clientRef.current || !mountedRef.current) {
          throw new Error("Stale Simli connection");
        }
        setLifecycle("ready");
        await waitForVideo(video, client, generation);
      } catch (error) {
        handleConnectionFailure("connect", error, client, generation);
        throw error;
      }

      if (generation !== generationRef.current || client !== clientRef.current || !mountedRef.current) {
        throw new Error("Stale Simli connection");
      }
      setVideoReady(true);
      setLifecycle("ready");
      devLogSimli("simli_connected", { generation, connectionDurationMs: Math.round(performance.now() - connectStartedAt) });
    })().catch((error) => {
      if (lifecycleRef.current !== "error") {
        handleConnectionFailure("connect", error, clientRef.current, generationRef.current);
      }
      throw error;
    }).finally(() => {
      connectPromiseRef.current = null;
    });
    connectPromiseRef.current = promise;
    return promise;
  }, [attachListeners, handleConnectionFailure, interviewId, setLifecycle, waitForVideo]);

  const connect = useCallback(() => enqueue(connectInternal), [connectInternal, enqueue]);
  const disconnect = useCallback((reason = "user_requested", expectedClient?: SimliClient | null, expectedGeneration?: number) => {
    if ((expectedClient === undefined || expectedClient === clientRef.current) && (expectedGeneration === undefined || expectedGeneration === generationRef.current)) {
      const generation = generationRef.current;
      stopRequestedRef.current.add(generation);
      terminalReasonRef.current.set(generation, "stop");
      settleSpeech(undefined, true, abortReasonForDisconnect(reason));
    }
    return enqueue(() => disconnectInternal(reason, expectedClient, expectedGeneration));
  }, [disconnectInternal, enqueue, settleSpeech]);

  const recoverFromFailure = useCallback(async (oldClient: SimliClient, oldGeneration: number, reason: TerminalReason, duringSpeech: boolean) => {
    devLogSimli("simli_recovery_start", { generation: oldGeneration, terminalReason: reason });
    stopRequestedRef.current.add(oldGeneration);
    detachListeners(oldClient);
    await releaseInput();
    await stopSimliClientOnce(oldClient, stoppedClientsRef.current, "recovering", (error) => {
      devLogSimli("simli_error", { stage: "recovery_stop", sanitizedMessage: sanitizeSimliMessage(error) });
    });
    if (clientRef.current === oldClient) clientRef.current = null;
    releaseMediaElements();
    if (!mountedRef.current) return;
    await connectInternal();
    devLogSimli("simli_recovered", { previousGeneration: oldGeneration, generation: generationRef.current });
    if (duringSpeech) onUnavailableRef.current("Avatar reconnected. Replay question or skip.");
  }, [connectInternal, detachListeners, releaseInput, releaseMediaElements]);

  useEffect(() => {
    recoverFromFailureRef.current = recoverFromFailure;
  }, [recoverFromFailure]);

  const stopSpeaking = useCallback((reason: SpeechAbortReason = "user_skip") => {
    const client = clientRef.current;
    const generation = generationRef.current;
    if (canSendSimliAudio({
      mounted: mountedRef.current,
      generation,
      currentGeneration: generationRef.current,
      client,
      currentClient: clientRef.current,
      lifecycle: lifecycleRef.current,
    })) {
      try {
        client?.ClearBuffer();
      } catch (error) {
        devLogSimli("simli_error", { stage: "clearBuffer", sanitizedMessage: sanitizeSimliMessage(error) });
      }
    }
    settleSpeech(undefined, true, reason);
    void releaseInput();
    if (mountedRef.current && clientRef.current && lifecycleRef.current !== "disconnecting") setLifecycle("ready");
  }, [releaseInput, setLifecycle, settleSpeech]);

  const speakInternal = useCallback(async (audioBlob: Blob, utteranceId: string): Promise<SpeakResult> => {
    try {
      await connectInternal();
    } catch (error) {
      return { status: "fatal_failure", reason: sanitizeSimliMessage(error) };
    }
    const client = clientRef.current;
    const generation = generationRef.current;
    if (!client) return { status: "fatal_failure", reason: "Simli avatar is not connected" };
    if (!canSendSimliAudio({
      mounted: mountedRef.current,
      generation,
      currentGeneration: generationRef.current,
      client,
      currentClient: clientRef.current,
      lifecycle: lifecycleRef.current,
    })) {
      return { status: "fatal_failure", reason: "Simli avatar is not connected" };
    }

    stopSpeaking("new_utterance");
    const context = new AudioContext();
    contextRef.current = context;
    try {
      if (context.state === "suspended") await context.resume();
      devLogSimli("audio_context_state", { state: context.state });
      const decoded = await context.decodeAudioData(await audioBlob.arrayBuffer());
      devLogSimli("tts_received", {
        bytes: audioBlob.size,
        contentType: audioBlob.type || "unknown",
        duration: Number(decoded.duration.toFixed(3)),
      });
      if (!canSendAudioToClient(client, generation)) {
        devLogSimli("simli_pcm_send_invalidated", {
          clientMatches: client === clientRef.current,
          generationMatches: generation === generationRef.current,
          signalAborted: false,
          lifecycle: lifecycleRef.current,
          abortReason: speechOperationRef.current?.abortReason ?? null,
          chunkIndex: 0,
          totalChunks: 0,
        });
        throw new SimliSpeechAbortError("transport_closed");
      }
      const chunks = pcmChunksFromAudioBuffer(decoded);
      if (chunks.length === 0) throw new Error("TTS audio was empty");
      const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.samples, 0);
      const expectedSendDurationMs = Math.round((totalSamples / SIMLI_REQUIRED_SAMPLE_RATE) * 1000);
      speechGenerationRef.current = generation;
      speechChunksCompleteRef.current = false;
      const abortController = new AbortController();
      speechAbortRef.current = abortController;
      speechOperationRef.current = {
        generation,
        utteranceId,
        uploadStartedAt: performance.now(),
        firstSpeakingAt: null,
        finalChunkAt: null,
        completedAt: null,
        decodedDurationMs: decoded.duration * 1000,
        speakingObserved: false,
        uploadComplete: false,
        abortReason: null,
        settled: false,
      };
      setLifecycle("uploading");
      devLogSimli("simli_audio_started", {
        generation,
        decodedDuration: Number(decoded.duration.toFixed(3)),
        originalSampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        totalPcmSamples: totalSamples,
        pcmByteLength: totalSamples * 2,
        chunkCount: chunks.length,
        chunkSamples: chunks[0]?.samples ?? 0,
        expectedSendDurationMs,
      });

      const completion = new Promise<void>((resolve, reject) => {
        speechResolveRef.current = resolve;
        speechRejectRef.current = reject;
      });
      completion.catch(() => undefined);
      const pacing = await sendPacedAudioChunks(client, generation, chunks, abortController.signal);
      speechChunksCompleteRef.current = true;
      speechAbortRef.current = null;
      if (speechOperationRef.current?.generation === generation) {
        speechOperationRef.current.finalChunkAt = performance.now();
        speechOperationRef.current.uploadComplete = true;
      }
      setLifecycle("playing");
      speechTimeoutRef.current = window.setTimeout(() => {
        const operation = speechOperationRef.current;
        if (speechGenerationRef.current !== generation || !operation || operation.settled) return;
        operation.completedAt = performance.now();
        devLogSimli("simli_speech_complete", {
          generation,
          completion: "post_upload_duration_fallback",
          totalAvatarPlaybackMs: operation.firstSpeakingAt ? Math.round(operation.completedAt - operation.firstSpeakingAt) : null,
        });
        settleSpeech();
      }, Math.ceil(decoded.duration * 1000) + PLAYBACK_FALLBACK_BUFFER_MS);
      devLogSimli("simli_audio_chunks_complete", {
        generation,
        expectedSendDurationMs: Math.round(pacing.expectedElapsedMs),
        actualSendDurationMs: Math.round(pacing.actualSendDurationMs),
        maxPacingDriftMs: Math.round(pacing.maxDriftMs),
      });
      await completion;
      devLogSimli("simli_audio_completed");
      return { status: "completed" };
    } catch (error) {
      const abortReason = error instanceof SimliSpeechAbortError ? error.reason : null;
      if (abortReason && EXPECTED_ABORT_REASONS.has(abortReason)) {
        settleSpeech(undefined, true, abortReason);
        return { status: "cancelled", reason: abortReason };
      }
      const failureReason = abortReason ?? "transport_closed";
      settleSpeech(error instanceof Error ? error : new Error("Simli speech failed"), true, failureReason);
      handleConnectionFailure("speech", error, client, generation);
      if (failureReason === "provider_error" || failureReason === "provider_rate_limit" || failureReason === "session_expired") {
        return { status: "fatal_failure", reason: failureReason };
      }
      return { status: "recoverable_failure", reason: failureReason };
    } finally {
      await releaseInput();
      if (mountedRef.current && clientRef.current === client && (lifecycleRef.current === "playing" || lifecycleRef.current === "uploading")) setLifecycle("ready");
    }
  }, [connectInternal, handleConnectionFailure, releaseInput, sendPacedAudioChunks, setLifecycle, settleSpeech, stopSpeaking]);

  const speak = useCallback((audioBlob: Blob, turnId = `simli-${Date.now()}`) => enqueue(() => speakInternal(audioBlob, turnId)), [enqueue, speakInternal]);

  useImperativeHandle(ref, () => ({ connect, speak, stopSpeaking, disconnect }), [connect, disconnect, speak, stopSpeaking]);

  useEffect(() => {
    mountedRef.current = true;
    const handleUnhandledSimliRejection = (event: PromiseRejectionEvent) => {
      const message = sanitizeSimliMessage(event.reason);
      const expectedSdkDisconnect =
        message.toLowerCase().includes("client initiated disconnect") &&
        (lifecycleRef.current === "disconnecting" || lifecycleRef.current === "recovering" || stopRequestedRef.current.has(generationRef.current));
      if (!expectedSdkDisconnect) return;
      event.preventDefault();
      devLogSimli("simli_error", { stage: "sdk_disconnect_promise", sanitizedMessage: message });
    };
    const handlePageExit = () => {
      void disconnect("pagehide", clientRef.current, generationRef.current).catch((error) => {
        devLogSimli("simli_error", { stage: "disconnect_owner", sanitizedMessage: sanitizeSimliMessage(error) });
      });
    };
    window.addEventListener("unhandledrejection", handleUnhandledSimliRejection);
    window.addEventListener("pagehide", handlePageExit);
    return () => {
      const client = clientRef.current;
      const generation = generationRef.current;
      mountedRef.current = false;
      window.removeEventListener("unhandledrejection", handleUnhandledSimliRejection);
      window.removeEventListener("pagehide", handlePageExit);
      void disconnect("component_unmount", client, generation).catch((error) => {
        devLogSimli("simli_error", { stage: "disconnect_owner", sanitizedMessage: sanitizeSimliMessage(error) });
      });
    };
  }, [disconnect]);

  return (
    <div className="avatar-simli-stage" data-avatar-state={displayState}>
      <div className={videoReady ? "avatar-local-layer avatar-local-hidden" : "avatar-local-layer"}>
        <Avatar state={localState} visemeState={localVisemeState} />
      </div>
      <video ref={videoRef} className={videoReady ? "avatar-simli-video avatar-simli-visible" : "avatar-simli-video"} autoPlay playsInline />
      <audio ref={audioRef} autoPlay className="sr-only" />
      <div className="avatar-provider-status">
        {displayState === "connecting" ? "Connecting interviewer" : displayState === "recovering" ? "Reconnecting avatar" : displayState === "speaking" ? "Avatar speaking" : displayState === "unavailable" ? "Avatar connection lost" : "Avatar ready"}
      </div>
    </div>
  );
});

export default SimliAvatar;
