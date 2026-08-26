"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Avatar, { type AvatarState } from "@/components/Avatar";
import BluyeInterviewVoiceController from "@/components/BluyeInterviewVoiceController";
import * as api from "@/services/interviewApi";

type Status = "setup" | "active" | "completed";

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

  const interviewIdRef = useRef<number | null>(null);
  const activeQuestionRef = useRef(0);
  const isSubmittingAnswerRef = useRef(false);
  const statusRef = useRef<Status>("setup");
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    api.checkHealth().then((ok) => {
      setBackendOk(ok);
      if (!ok) setError("Backend is offline. Make sure FastAPI is running on http://127.0.0.1:8000.");
    });
  }, []);

  async function speakQuestion(text: string) {
    if (typeof window === "undefined") return;
    speechAudioRef.current?.pause();
    setAvatarState("thinking");

    const resumeBluyeListening = () => {
      if (statusRef.current !== "active" || isSubmittingAnswerRef.current) return;
      setCandidateAnswer("");
      setAvatarState("listening");
    };

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BLUYE_API ?? "http://localhost:8080"}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, turn_id: `INTERVIEW-TTS-${Date.now()}` }),
      });
      if (!res.ok) throw new Error(`Bluye TTS failed: ${res.status}`);
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      speechAudioRef.current = audio;
      audio.onplay = () => setAvatarState("speaking");
      audio.onended = resumeBluyeListening;
      audio.onerror = resumeBluyeListening;
      await audio.play();
    } catch (exc) {
      console.error("[TTS] Bluye Edge TTS failed", exc);
      resumeBluyeListening();
    }
  }

  function stopSpeaking() {
    speechAudioRef.current?.pause();
    if (statusRef.current === "active" && !isSubmittingAnswerRef.current) setAvatarState("listening");
  }

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidateName.trim() || loading) return;
    setError(null);
    setLoading(true);
    setAvatarState("thinking");

    try {
      const resp = await api.startInterview(candidateName, maxQuestions);
      interviewIdRef.current = resp.interview_id;
      setInterviewId(resp.interview_id);
      activeQuestionRef.current = resp.question_number;
      setQuestionNumber(resp.question_number);
      setCurrentQuestion(resp.question);
      setCurrentTopic(resp.topic || "");
      setCurrentSubtopic(resp.subtopic || "");
      setCurrentDifficulty(resp.difficulty);
      setCurrentQuestionType(resp.question_type || "conceptual");
      setStatus("active");
      statusRef.current = "active";
      setLoading(false);
      void speakQuestion(`${resp.greeting} Here is your first question. ${resp.question}`);
    } catch (exc) {
      setLoading(false);
      setAvatarState("idle");
      setError(exc instanceof Error ? exc.message : "Failed to start interview.");
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

  useEffect(() => {
    return () => {
      speechAudioRef.current?.pause();
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#05080f] px-4 py-8 text-[#eaf4ff]">
      <BluyeInterviewVoiceController
        enabled={status === "active" && avatarState === "listening" && !loading}
        acceptingAnswer={status === "active" && avatarState === "listening" && !isSubmittingAnswerRef.current}
        onListeningChange={(listening) => {
          if (listening && statusRef.current === "active") setAvatarState("listening");
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

        {status === "setup" && (
          <section className="panel mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
            <div className="text-center">
              <h2 className="text-2xl font-bold uppercase tracking-normal text-white">Candidate Setup</h2>
              <p className="mt-2 text-sm text-[#8fb2d8]">Enter your name to launch the evaluation.</p>
            </div>
            <form onSubmit={handleStart} className="flex flex-col gap-4">
              <input required value={candidateName} onChange={(event) => setCandidateName(event.target.value)} className="w-full rounded-md border border-cyan/20 bg-[#08101e] px-4 py-3 text-white outline-none focus:border-cyan/70" placeholder="Candidate name" />
              <button type="submit" disabled={loading || !backendOk} className="rounded-md border border-cyan/40 bg-cyan/15 py-3 font-bold uppercase tracking-normal text-cyan disabled:cursor-not-allowed disabled:opacity-40">
                {loading ? "Starting session..." : "Launch Interview"}
              </button>
            </form>
          </section>
        )}

        {status === "active" && (
          <section className="grid grid-cols-1 gap-6 md:grid-cols-5">
            <div className="md:col-span-2"><div className="aspect-square md:h-72"><Avatar state={avatarState} /></div></div>
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
                  {candidateAnswer || <span className="text-white/35">{avatarState === "listening" ? "Listening with Bluye voice system..." : avatarState === "speaking" ? "Interviewer speaking..." : "Processing..."}</span>}
                </div>
                <div className="flex items-center justify-between rounded-md border border-cyan/15 bg-cyan/5 px-4 py-3 text-xs text-[#8fb2d8]"><span className="font-bold uppercase text-white">{avatarState === "listening" ? "Bluye microphone active" : avatarState === "speaking" ? "Interviewer speaking" : "Thinking"}</span><span>Bluye VAD endpointing</span></div>
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




