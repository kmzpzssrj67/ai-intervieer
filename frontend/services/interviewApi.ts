import { normalizeTextForSpeech } from "../components/avatar/local/TextNormalizer.ts";

export const API_BASE = process.env.NEXT_PUBLIC_INTERVIEW_API_BASE ?? "http://127.0.0.1:8000";
const VOICE_API_BASE = process.env.NEXT_PUBLIC_VOICE_API ?? "http://localhost:8000";

export interface QuestionPayload {
  question_number: number;
  question: string;
  difficulty: string;
  topic?: string;
  subtopic?: string;
  question_type?: string;
}

export interface InterviewStartResponse {
  interview_id: number;
  greeting: string;
  question_number: number;
  question: string;
  difficulty: string;
  status: string;
  topic?: string;
  subtopic?: string;
  question_type?: string;
}

export interface InterviewAnswerResponse {
  interview_id: number;
  status: string;
  question_number: number;
  score: number;
  evaluation: string;
  next_question: QuestionPayload | null;
  assessment_available: boolean;
  answered_question?: boolean | null;
  answer_relevance?: string;
  topic?: string;
  subtopic?: string;
  strengths?: string[];
  weaknesses?: string[];
  missing_concepts?: string[];
  next_focus?: string;
  interviewer_acknowledgement?: string;
  next_selection_reason?: string;
}

export interface InterviewAssessmentResponse {
  id: number;
  interview_id: number;
  overall_score: number | null;
  technical_level: string;
  recommendation: string;
  strongest_topics: string | string[];
  weakest_topics: string | string[];
  key_strengths: string | string[];
  key_weaknesses: string | string[];
  strengths: string;
  weaknesses: string;
  technical_summary: string;
  improvement_plan: string | string[];
  created_at: string;
}

export interface WordBoundary {
  text: string;
  start: number;
  duration: number;
}

export interface PhonemeBoundary {
  phoneme: string;
  start: number;
  duration: number;
}

export type LocalSpeechBundle = {
  audioBuffer: ArrayBuffer;
  contentType: string;
  wordBoundaries: WordBoundary[];
  phonemeBoundaries?: PhonemeBoundary[];
};

const MAX_LOCAL_TTS_BYTES = 12 * 1024 * 1024;

function decodeBase64Audio(value: string): ArrayBuffer {
  if (!value || value.length > Math.ceil((MAX_LOCAL_TTS_BYTES * 4) / 3) + 4) {
    throw new Error("TTS audio payload is empty or too large.");
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("TTS audio payload is invalid.");
  }
  if (!decoded.length || decoded.length > MAX_LOCAL_TTS_BYTES) {
    throw new Error("TTS audio payload is empty or too large.");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`, { method: "GET", cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

export async function startInterview(candidateName: string, maxQuestions = 5): Promise<InterviewStartResponse> {
  const res = await fetch(`${API_BASE}/api/interview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_name: candidateName, max_questions: maxQuestions }),
  });
  if (!res.ok) throw new Error((await res.text()) || `Failed to start interview: ${res.status}`);
  return (await res.json()) as InterviewStartResponse;
}

export async function submitAnswer(interviewId: number, answerText: string): Promise<InterviewAnswerResponse> {
  const res = await fetch(`${API_BASE}/api/interview/${interviewId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: answerText }),
  });
  if (!res.ok) throw new Error((await res.text()) || `Failed to submit answer: ${res.status}`);
  return (await res.json()) as InterviewAnswerResponse;
}

export async function getAssessment(interviewId: number): Promise<InterviewAssessmentResponse> {
  const res = await fetch(`${API_BASE}/api/interview/${interviewId}/assessment`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) throw new Error((await res.text()) || `Failed to fetch assessment: ${res.status}`);
  return (await res.json()) as InterviewAssessmentResponse;
}

export async function synthesizeLocalSpeech(text: string, turnId: string): Promise<LocalSpeechBundle> {
  const spokenText = normalizeTextForSpeech(text);
  const res = await fetch(`${VOICE_API_BASE}/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: spokenText, turn_id: turnId }),
  });
  if (!res.ok) throw new Error(`TTS synthesis failed: ${res.status}`);
  const data = (await res.json()) as {
    audio_base64?: unknown;
    content_type?: unknown;
    word_boundaries?: unknown;
    phoneme_boundaries?: unknown;
  };
  if (data.content_type !== "audio/mpeg" || typeof data.audio_base64 !== "string" || !Array.isArray(data.word_boundaries)) {
    throw new Error("TTS synthesis returned an invalid response.");
  }
  const wordBoundaries = data.word_boundaries.map((entry) => {
    const boundary = entry as Partial<WordBoundary>;
    if (
      typeof boundary.text !== "string" ||
      !Number.isFinite(boundary.start) ||
      !Number.isFinite(boundary.duration) ||
      (boundary.start ?? -1) < 0 ||
      (boundary.duration ?? -1) < 0
    ) {
      throw new Error("TTS synthesis returned invalid word timing.");
    }
    return { text: boundary.text, start: boundary.start as number, duration: boundary.duration as number };
  });

  let phonemeBoundaries: PhonemeBoundary[] | undefined;
  if (Array.isArray(data.phoneme_boundaries)) {
    phonemeBoundaries = data.phoneme_boundaries
      .filter((entry) => {
        const pb = entry as Partial<PhonemeBoundary>;
        return (
          typeof pb.phoneme === "string" &&
          Number.isFinite(pb.start) &&
          Number.isFinite(pb.duration) &&
          (pb.start ?? -1) >= 0 &&
          (pb.duration ?? -1) > 0
        );
      })
      .map((entry) => {
        const pb = entry as PhonemeBoundary;
        return { phoneme: pb.phoneme, start: pb.start, duration: pb.duration };
      });
  }

  return {
    audioBuffer: decodeBase64Audio(data.audio_base64),
    contentType: data.content_type,
    wordBoundaries,
    phonemeBoundaries,
  };
}
