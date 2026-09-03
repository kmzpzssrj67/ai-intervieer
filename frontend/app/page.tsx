"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Avatar, { type AvatarState } from "@/components/Avatar";
import SimliAvatar from "@/components/avatar/SimliAvatar";
import type { AvatarProvider, AvatarRendererHandle } from "@/components/avatar/types";
import { AudioPlaybackController } from "@/components/avatar/local/AudioPlaybackController";
import { buildVisemeTimeline, stabilizeVisemeTimeline, type VisemeEvent } from "@/components/avatar/local/LipSyncTimeline";
import InterviewVoiceController from "@/components/InterviewVoiceController";
import * as api from "@/services/interviewApi";

type Status = "setup" | "active" | "completed";

function devLogInterview(event: string, details?: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") return;
  if (details) {
    console.info(`[interview] ${event}`, details);
    return;
  }
  console.info(`[interview] ${event}`);
}

export default function Page() {
  const [candidateName, setCandidateName] = useState("");
  const [interviewId, setInterviewId] = useState<number | null>(null);
  const [questionNumber, setQuestionNumber] = useState(1);
  const [maxQuestions] = useState(5);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [currentTopic, setCurrentTopic] = useState("");
  const [currentSubtopic, setCurrentSubtopic] = useState("");
  const [currentDifficulty, setCurrentDifficulty] = useState("");
  const [currentQuestionType, setCurrentQuestionType] = useState("");
  const [candidateAnswer, setCandidateAnswer] = useState("");
  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [status, setStatus] = useState<Status>("setup");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendOk, setBackendOk] = useState(true);
  const [assessment, setAssessment] = useState<api.InterviewAssessmentResponse | null>(null);
  const [avatarProvider, setAvatarProvider] = useState<AvatarProvider>("simli");
  const [avatarConfigLoading, setAvatarConfigLoading] = useState(true);
  const [simliConfigured, setSimliConfigured] = useState(false);
  const [simliError, setSimliError] = useState<string | null>(null);
  const [localSpeechError, setLocalSpeechError] = useState<string | null>(null);

  const interviewIdRef = useRef<number | null>(null);
  const activeQuestionRef = useRef(0);
  const isSubmittingAnswerRef = useRef(false);
  const statusRef = useRef<Status>("setup");
  const localPlaybackRef = useRef<AudioPlaybackController | null>(null);
  const [localTimeline, setLocalTimeline] = useState<VisemeEvent[]>([]);
  const simliAvatarRef = useRef<AvatarRendererHandle | null>(null);
  const pendingSpeechRef = useRef<string | null>(null);
  const startInterviewInFlightRef = useRef(false);
  const speechTurnRef = useRef(0);

  function disconnectSimli(reason: string): void {
    void simliAvatarRef.current?.disconnect(reason).catch((exc) => {
      if (process.env.NODE_ENV !== "production") {
        console.info("[simli] simli_error", { stage: "disconnect_owner", sanitizedMessage: exc instanceof Error ? "disconnect failed" : "unknown disconnect failure" });
      }
    });
  }

  function getLocalPlayback(): AudioPlaybackController {
    if (!localPlaybackRef.current) localPlaybackRef.current = new AudioPlaybackController();
    return localPlaybackRef.current;
  }

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  async function loadAvatarConfig() {
    setAvatarConfigLoading(true);
    setSimliError(null);
    try {
      const response = await fetch(`${api.API_BASE}/api/avatar/config`, { cache: "no-store" });
      if (!response.ok) throw new Error("Avatar configuration is unavailable.");
      const config = (await response.json()) as { provider?: string; configured?: boolean };
      setSimliConfigured(config.provider === "simli" && config.configured === true);
      if (config.provider !== "simli" || config.configured !== true) {
        setSimliError("The human avatar is not configured. Configure Simli or explicitly use the local avatar.");
      }
    } catch {
      setSimliConfigured(false);
      setSimliError("The human avatar configuration could not be loaded.");
    } finally {
      setAvatarConfigLoading(false);
    }
  }

  useEffect(() => {
    api.checkHealth().then((ok) => {
      setBackendOk(ok);
      if (!ok) setError("Backend is offline. Make sure FastAPI is running on http://127.0.0.1:8000.");
    });
    void loadAvatarConfig();
  }, []);

  async function speakQuestion(text: string, providerOverride?: AvatarProvider) {
    if (typeof window === "undefined") return;
    const speechTurn = speechTurnRef.current + 1;
    speechTurnRef.current = speechTurn;
    localPlaybackRef.current?.cancel("replaced");
    setLocalTimeline([]);
    setAvatarState("thinking");

    const resumeVoiceListening = () => {
      if (statusRef.current !== "active" || isSubmittingAnswerRef.current) return;
      setCandidateAnswer("");
      setAvatarState("listening");
    };

    const turnId = `INTERVIEW-TTS-${Date.now()}`;
    pendingSpeechRef.current = text;
    setLocalSpeechError(null);
    devLogInterview("question_ready");

    try {
      const activeProvider = providerOverride ?? avatarProvider;
      if (activeProvider === "simli") {
        const [audioRes, metadataRes] = await Promise.all([
          fetch(`${process.env.NEXT_PUBLIC_VOICE_API ?? "http://localhost:8000"}/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, turn_id: turnId }),
          }),
          fetch(`${process.env.NEXT_PUBLIC_VOICE_API ?? "http://localhost:8000"}/tts/metadata`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, turn_id: turnId }),
          }),
        ]);
        if (!audioRes.ok || !metadataRes.ok) throw new Error("Avatar speech synthesis failed.");
        const audioBlob = await audioRes.blob();
        if (!audioBlob.size || !(audioRes.headers.get("content-type") ?? "").includes("audio")) {
          throw new Error("Avatar speech synthesis returned invalid audio.");
        }
        await metadataRes.json();
        if (speechTurn !== speechTurnRef.current) return;
        try {
          if (!simliAvatarRef.current) throw new Error("Human avatar is not mounted");
          setAvatarState("speaking");
          const result = await simliAvatarRef.current.speak(audioBlob, turnId);
          if (speechTurn !== speechTurnRef.current) return;
          if (result.status === "cancelled") {
            pendingSpeechRef.current = null;
            setAvatarState("idle");
            if (result.reason === "user_skip") resumeVoiceListening();
            return;
          }
          if (result.status === "recoverable_failure") {
            setAvatarState("idle");
            setSimliError("Avatar reconnecting. Replay question or skip.");
            return;
          }
          if (result.status === "fatal_failure") {
            setAvatarState("idle");
            setSimliError("Avatar connection unavailable");
            return;
          }
          pendingSpeechRef.current = null;
          setAvatarState("idle");
          resumeVoiceListening();
          return;
        } catch (exc) {
          setAvatarState("idle");
          const message = exc instanceof Error && exc.message.startsWith("Avatar reconnect")
            ? exc.message
            : "Avatar connection unavailable";
          setSimliError(message);
          return;
        }
      }

      devLogInterview("local_tts_requested");
      const speechBundle = await api.synthesizeLocalSpeech(text, turnId);
      devLogInterview("local_tts_received", {
        bytes: speechBundle.audioBuffer.byteLength,
        boundaryCount: speechBundle.wordBoundaries.length,
      });
      if (speechTurn !== speechTurnRef.current) return;

      const controller = getLocalPlayback();
      const started = await controller.play(speechBundle.audioBuffer, (utteranceId) => {
        if (speechTurn !== speechTurnRef.current || controller.getCurrentUtteranceId() !== null) return;
        devLogInterview("local_audio_completed", { utteranceId });
        pendingSpeechRef.current = null;
        setLocalTimeline([]);
        setAvatarState("idle");
        devLogInterview("local_candidate_listening_enabled");
        resumeVoiceListening();
      });
      if (speechTurn !== speechTurnRef.current) {
        controller.cancel("replaced");
        return;
      }
      const rawTimeline = buildVisemeTimeline(speechBundle.wordBoundaries, started.duration, speechBundle.phonemeBoundaries);
      const stabilized = stabilizeVisemeTimeline(rawTimeline, started.duration);
      setLocalTimeline(stabilized);
      setAvatarState("speaking");
      devLogInterview("local_audio_decoded", { duration: started.duration, sampleRate: started.sampleRate });
      devLogInterview("local_audio_started", { utteranceId: started.utteranceId });
      devLogInterview("local_viseme_started", { utteranceId: started.utteranceId });
      if (process.env.NODE_ENV !== "production" && stabilized.length > 0) {
        const durationMs = started.duration * 1000;
        const rawChangesPerSecond = rawTimeline.length / started.duration;
        const stabilizedChangesPerSecond = stabilized.length / started.duration;
        const stabilizedDurations = stabilized.map((e) => (e.end - e.start) * 1000).sort((a, b) => a - b);
        const mid = Math.floor(stabilizedDurations.length / 2);
        const medianEventMs = stabilizedDurations.length % 2 === 0
          ? ((stabilizedDurations[mid - 1] + stabilizedDurations[mid]) / 2)
          : stabilizedDurations[mid];
        console.info("[local-avatar] local_lipsync_timeline", {
          rawEvents: rawTimeline.length,
          stabilizedEvents: stabilized.length,
          durationMs: Math.round(durationMs),
          rawChangesPerSecond: rawChangesPerSecond.toFixed(1),
          stabilizedChangesPerSecond: stabilizedChangesPerSecond.toFixed(1),
          shortestEventMs: stabilizedDurations[0]?.toFixed(1),
          medianEventMs: medianEventMs.toFixed(1),
        });
      }
    } catch (exc) {
      console.error("[TTS] Voice playback failed", exc instanceof Error ? exc.message : "unknown error");
      setAvatarState("idle");
      setLocalSpeechError("The interviewer audio could not be played. Replay the question or skip speech.");
    }
  }

  function stopSpeaking() {
    speechTurnRef.current += 1;
    simliAvatarRef.current?.stopSpeaking();
    localPlaybackRef.current?.cancel("skip");
    setLocalTimeline([]);
    setLocalSpeechError(null);
    pendingSpeechRef.current = null;
    if (statusRef.current === "active" && !isSubmittingAnswerRef.current) setAvatarState("listening");
  }

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidateName.trim() || loading || avatarConfigLoading || startInterviewInFlightRef.current) return;
    if (avatarProvider === "simli" && !simliConfigured) {
      setSimliError("The human avatar must be configured before starting, or you can explicitly use the local avatar.");
      return;
    }
    startInterviewInFlightRef.current = true;
    if (avatarProvider === "local") await getLocalPlayback().prepareFromGesture();
    setError(null);
    setLoading(true);
    setAvatarState("thinking");

    try {
      const resp = await api.startInterview(candidateName, maxQuestions);
      devLogInterview("interview_started");
      interviewIdRef.current = resp.interview_id;
      setInterviewId(resp.interview_id);
      activeQuestionRef.current = resp.question_number;
      setQuestionNumber(resp.question_number);
      setCurrentQuestion(resp.question);
      devLogInterview("question_ready");
      setCurrentTopic(resp.topic || "");
      setCurrentSubtopic(resp.subtopic || "");
      setCurrentDifficulty(resp.difficulty);
      setCurrentQuestionType(resp.question_type || "conceptual");
      setStatus("active");
      statusRef.current = "active";
      setLoading(false);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const openingSpeech = `${resp.greeting} Here is your first question. ${resp.question}`;
      pendingSpeechRef.current = openingSpeech;
      if (avatarProvider === "simli") {
        try {
          if (!simliAvatarRef.current) throw new Error("Human avatar is not mounted");
          await simliAvatarRef.current.connect();
        } catch {
          setAvatarState("idle");
          setSimliError("Avatar connection lost");
          return;
        }
      }
      pendingSpeechRef.current = null;
      void speakQuestion(openingSpeech, avatarProvider);
    } catch (exc) {
      setLoading(false);
      setAvatarState("idle");
      setError(exc instanceof Error ? exc.message : "Failed to start interview.");
    } finally {
      startInterviewInFlightRef.current = false;
    }
  }

  async function submitFinalTranscript(finalTranscript: string) {
    const id = interviewIdRef.current;
    if (!id || isSubmittingAnswerRef.current || statusRef.current !== "active") return;
    const answer = finalTranscript.trim();
    if (!answer) return;

    isSubmittingAnswerRef.current = true;
    setCandidateAnswer(answer);
    setAvatarState("thinking");
    setLoading(true);
    setError(null);
    const answeredQuestion = activeQuestionRef.current;
    console.log(`[API] POST /api/interview/${id}/answer`, { question: answeredQuestion });

    try {
      const resp = await api.submitAnswer(id, answer);
      console.log("[API] Answer response received", resp);

      if (resp.assessment_available || !resp.next_question) {
        setStatus("completed");
        statusRef.current = "completed";
        setAvatarState("idle");
        setAssessment(await api.getAssessment(id));
        setLoading(false);
        return;
      }

      const nq = resp.next_question;
      activeQuestionRef.current = nq.question_number;
      setQuestionNumber(nq.question_number);
      setCurrentQuestion(nq.question);
      setCurrentTopic(nq.topic || "");
      setCurrentSubtopic(nq.subtopic || "");
      setCurrentDifficulty(nq.difficulty);
      setCurrentQuestionType(nq.question_type || "conceptual");
      setCandidateAnswer("");
      setLoading(false);
      void speakQuestion(`${resp.interviewer_acknowledgement || "Thank you."} Let's move to the next question. ${nq.question}`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to submit answer.");
      setLoading(false);
      setAvatarState("listening");
    } finally {
      isSubmittingAnswerRef.current = false;
    }
  }

  function safeParseList(value: string | string[]): string[] {
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value || "[]");
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fallback below */
    }
    return value ? [value] : [];
  }

  async function retryHumanAvatar() {
    if (!interviewIdRef.current) {
      await loadAvatarConfig();
      return;
    }
    setSimliError(null);
    setAvatarState("thinking");
    try {
      await simliAvatarRef.current?.disconnect("retry");
      await simliAvatarRef.current?.connect();
      const pendingSpeech = pendingSpeechRef.current;
      if (pendingSpeech) void speakQuestion(pendingSpeech, "simli");
    } catch {
      setAvatarState("idle");
      setSimliError("Avatar connection lost");
    }
  }

  function replayPendingQuestion() {
    const pendingSpeech = pendingSpeechRef.current;
    if (!pendingSpeech) return;
    setSimliError(null);
    setAvatarState("thinking");
    void speakQuestion(pendingSpeech, "simli");
  }

  function useLocalAvatar() {
    setAvatarProvider("local");
    setSimliError(null);
    disconnectSimli("use_local_avatar");
    const pendingSpeech = pendingSpeechRef.current;
    void getLocalPlayback().prepareFromGesture().then(() => {
      if (pendingSpeech) void speakQuestion(pendingSpeech, "local");
    }).catch(() => setLocalSpeechError("Web Audio playback is unavailable in this browser."));
  }

  function replayLocalQuestion() {
    const pendingSpeech = pendingSpeechRef.current;
    if (!pendingSpeech) return;
    void getLocalPlayback().prepareFromGesture().then(() => speakQuestion(pendingSpeech, "local"));
  }

  useEffect(() => {
    if (status === "completed") {
      disconnectSimli("interview_completed");
      localPlaybackRef.current?.cancel("interview_complete");
    }
  }, [status]);

  useEffect(() => {
    return () => {
      void localPlaybackRef.current?.dispose();
      disconnectSimli("page_unmount");
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#05080f] px-4 py-8 text-[#eaf4ff]">
      <InterviewVoiceController
        enabled={status === "active" && avatarState === "listening" && !loading && !simliError}
        acceptingAnswer={status === "active" && avatarState === "listening" && !isSubmittingAnswerRef.current && !simliError}
        onListeningChange={(listening) => {
          if (listening && statusRef.current === "active") {
            simliAvatarRef.current?.stopSpeaking();
            setAvatarState("listening");
          }
        }}
        onFinalTranscript={(text) => void submitFinalTranscript(text)}
      />

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header className="flex items-center justify-between border-b border-cyan/15 pb-4">
          <div>
            <h1 className="text-3xl font-bold uppercase tracking-normal text-cyan">AI Technical Interviewer</h1>
            <p className="mt-1 text-xs uppercase tracking-normal text-[#6f86ad]">Hands-Free Voice Platform</p>
          </div>
          <div className="rounded-md border border-cyan/20 bg-cyan/5 px-3 py-1 text-xs font-bold uppercase text-cyan">
            {backendOk ? "System Online" : "System Offline"}
          </div>
        </header>

        {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}
        {localSpeechError && avatarProvider === "local" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            <p>{localSpeechError}</p>
            <div className="mt-3 flex gap-3">
              <button type="button" onClick={replayLocalQuestion} className="rounded-md border border-cyan/40 bg-cyan/15 px-4 py-2 font-bold uppercase text-cyan">Replay Question</button>
              <button type="button" onClick={stopSpeaking} className="rounded-md border border-white/25 bg-white/10 px-4 py-2 font-bold uppercase text-white">Skip Speech</button>
            </div>
          </div>
        )}
        {simliError && avatarProvider === "simli" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            <p>{simliError}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={() => void retryHumanAvatar()} className="rounded-md border border-cyan/40 bg-cyan/15 px-4 py-2 font-bold uppercase text-cyan">Retry Human Avatar</button>
              {simliError.startsWith("Avatar reconnect") && <button type="button" onClick={replayPendingQuestion} className="rounded-md border border-emerald-300/40 bg-emerald-300/10 px-4 py-2 font-bold uppercase text-emerald-200">Replay Question</button>}
              <button type="button" onClick={useLocalAvatar} className="rounded-md border border-white/25 bg-white/10 px-4 py-2 font-bold uppercase text-white">Use Local Avatar</button>
            </div>
          </div>
        )}

        {status === "setup" && (
          <section className="panel mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
            <div className="text-center">
              <h2 className="text-2xl font-bold uppercase tracking-normal text-white">Candidate Setup</h2>
              <p className="mt-2 text-sm text-[#8fb2d8]">Enter your name to launch the evaluation.</p>
            </div>
            <form onSubmit={handleStart} className="flex flex-col gap-4">
              <input required value={candidateName} onChange={(event) => setCandidateName(event.target.value)} className="w-full rounded-md border border-cyan/20 bg-[#08101e] px-4 py-3 text-white outline-none focus:border-cyan/70" placeholder="Candidate name" />
              <button type="submit" disabled={loading || avatarConfigLoading || !backendOk || (avatarProvider === "simli" && !simliConfigured)} className="rounded-md border border-cyan/40 bg-cyan/15 py-3 font-bold uppercase tracking-normal text-cyan disabled:cursor-not-allowed disabled:opacity-40">
                {avatarConfigLoading ? "Loading avatar configuration..." : loading ? "Starting session..." : "Launch Interview"}
              </button>
            </form>
          </section>
        )}

        {status === "active" && (
          <section className="grid grid-cols-1 gap-6 md:grid-cols-5">
            <div className="md:col-span-2"><div className="aspect-square md:h-72">{avatarProvider === "simli" && interviewId ? <SimliAvatar ref={simliAvatarRef} interviewId={interviewId} localState={avatarState} localVisemeState="mbp" onUnavailable={(message) => { setAvatarState("idle"); setSimliError(message ?? "Avatar connection lost"); }} /> : <Avatar state={avatarState} playbackController={localPlaybackRef.current} timeline={localTimeline} />}</div></div>
            <div className="flex flex-col gap-6 md:col-span-3">
              <div className="panel flex flex-col gap-4 p-6">
                <div className="flex items-center justify-between"><span className="text-xs font-extrabold uppercase tracking-normal text-[#1fd3ff]">Active Question</span><span className="text-sm font-bold text-[#8fb2d8]">{questionNumber} / {maxQuestions}</span></div>
                <p className="min-h-24 text-lg font-semibold leading-relaxed text-white">{currentQuestion}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#08101e]"><div className="h-full bg-[#1fd3ff] transition-all" style={{ width: `${(questionNumber / maxQuestions) * 100}%` }} /></div>
              </div>
              <div className="panel flex flex-col gap-4 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div><div className="text-xs font-bold uppercase tracking-normal text-[#6f86ad]">Candidate Transcript</div><div className="mt-1 text-xs text-[#8fb2d8]">{currentTopic || "Python"} / {currentSubtopic || "General"} / {currentDifficulty} / {currentQuestionType}</div></div>
                  {avatarState === "speaking" && <button type="button" onClick={stopSpeaking} className="text-xs font-bold uppercase text-yellow-300">Skip Speech</button>}
                </div>
                <div className="min-h-36 overflow-y-auto rounded-md border border-cyan/20 bg-[#08101e] p-4 text-sm leading-relaxed text-white">
                  {candidateAnswer || <span className="text-white/35">{avatarState === "listening" ? "Listening with voice system..." : avatarState === "speaking" ? "Interviewer speaking..." : "Processing..."}</span>}
                </div>
                <div className="flex items-center justify-between rounded-md border border-cyan/15 bg-cyan/5 px-4 py-3 text-xs text-[#8fb2d8]"><span className="font-bold uppercase text-white">{avatarState === "listening" ? "Microphone active" : avatarState === "speaking" ? "Interviewer speaking" : "Thinking"}</span><span>VAD endpointing</span></div>
              </div>
            </div>
          </section>
        )}

        {status === "completed" && assessment && (
          <section className="panel flex flex-col gap-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-cyan/15 pb-5"><div><div className="text-xs font-bold uppercase tracking-normal text-cyan/70">Evaluation Finished</div><h2 className="mt-1 text-3xl font-bold uppercase text-white">Interview Report</h2></div><div className="text-right"><div className="text-sm text-[#8fb2d8]">{assessment.technical_level}</div><div className="text-2xl font-black text-cyan">{assessment.overall_score ?? "N/A"}/10</div></div></div>
            <div className="rounded-md border border-cyan/25 bg-cyan/10 p-4 text-lg font-black uppercase text-cyan">{assessment.recommendation}</div>
            <p className="text-sm leading-7 text-[#eaf4ff]">{assessment.technical_summary}</p>
            <div className="grid gap-4 md:grid-cols-2"><div><h3 className="mb-2 text-sm font-bold uppercase text-emerald-300">Strengths</h3><ul className="list-disc space-y-1 pl-5 text-sm text-[#8fb2d8]">{safeParseList(assessment.key_strengths).map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3 className="mb-2 text-sm font-bold uppercase text-red-300">Improvement Plan</h3><ul className="list-disc space-y-1 pl-5 text-sm text-[#8fb2d8]">{safeParseList(assessment.improvement_plan).map((item) => <li key={item}>{item}</li>)}</ul></div></div>
          </section>
        )}
      </div>
    </main>
  );
}
