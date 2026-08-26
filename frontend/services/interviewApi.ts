export const API_BASE = process.env.NEXT_PUBLIC_INTERVIEW_API_BASE ?? "http://127.0.0.1:8000";

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
