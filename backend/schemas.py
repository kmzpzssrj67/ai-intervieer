from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator


AnswerRelevance = Literal["high", "medium", "low", "none"]
Difficulty = Literal["easy", "medium", "hard"]
QuestionType = str


class ListCoercionMixin(BaseModel):
    @field_validator(
        "strengths",
        "weaknesses",
        "missing_concepts",
        "strongest_topics",
        "weakest_topics",
        "key_strengths",
        "key_weaknesses",
        "improvement_plan",
        mode="before",
        check_fields=False,
    )
    @classmethod
    def coerce_string_to_list(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            return [value] if value.strip() else []
        return value


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="Candidate or test message.")


class ChatResponse(BaseModel):
    reply: str
    provider: str


class InterviewStartRequest(BaseModel):
    candidate_name: str = Field(..., min_length=1, max_length=255)
    max_questions: int = Field(5, ge=1, le=5)


class QuestionPayload(BaseModel):
    question_number: int
    question: str
    difficulty: str
    topic: str = ""
    subtopic: str = ""
    question_type: str = "conceptual"


class InterviewStartResponse(BaseModel):
    interview_id: int
    greeting: str
    question_number: int
    question: str
    difficulty: str
    status: str
    topic: str = ""
    subtopic: str = ""
    question_type: str = "conceptual"


class InterviewAnswerRequest(BaseModel):
    answer: str = Field(..., min_length=1)


class EvaluationResult(ListCoercionMixin):
    score: float = Field(..., ge=0, le=10)
    answered_question: bool
    answer_relevance: AnswerRelevance
    topic: str = Field(..., min_length=1)

    @field_validator("answered_question", mode="before")
    @classmethod
    def normalize_answered_question(cls, value):
        """Coerce non-boolean Gemini responses to bool.

        Gemini sometimes returns the question text or other strings instead
        of a boolean.  Any non-empty string that is not explicitly
        'false', 'no', or '0' is treated as True.
        """
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            return value.strip().lower() not in {"false", "no", "0", ""}
        return bool(value)

    @field_validator("answer_relevance", mode="before")
    @classmethod
    def normalize_answer_relevance(cls, value):
        normalized = str(value or "").strip().lower()
        mapping = {
            "exact": "high",
            "correct": "high",
            "relevant": "high",
            "mostly_relevant": "high",
            "direct": "high",
            "partial": "medium",
            "partially_relevant": "medium",
            "some": "medium",
            "weak": "low",
            "barely_relevant": "low",
            "irrelevant": "none",
            "unrelated": "none",
            "no": "none",
        }
        return mapping.get(normalized, normalized)
    subtopic: str = ""
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    missing_concepts: list[str] = Field(default_factory=list)
    evaluation: str = Field(..., min_length=1)
    next_focus: str = ""
    suggested_focus: str = ""
    recommended_question_type: QuestionType = "conceptual"


class NextQuestionResult(BaseModel):
    question: str = Field(..., min_length=1)
    difficulty: Difficulty = "easy"
    topic: str = Field(..., min_length=1)
    subtopic: str = ""
    focus_area: str = ""
    question_type: QuestionType = "conceptual"


class EvaluationNextQuestionResult(EvaluationResult):
    interviewer_acknowledgement: str = ""
    next_selection_reason: str = ""
    next_question: NextQuestionResult


class AssessmentResult(ListCoercionMixin):
    overall_score: float = Field(..., ge=0, le=10)
    technical_level: Literal["Beginner", "Intermediate", "Advanced"]
    recommendation: Literal["Strong Hire", "Hire", "Borderline", "No Hire"]
    strongest_topics: list[str] = Field(default_factory=list)
    weakest_topics: list[str] = Field(default_factory=list)
    key_strengths: list[str] = Field(default_factory=list)
    key_weaknesses: list[str] = Field(default_factory=list)
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    technical_summary: str = Field(..., min_length=1)
    improvement_plan: list[str] = Field(default_factory=list)


class FinalEvaluationAssessmentResult(EvaluationResult):
    assessment: AssessmentResult


class InterviewAnswerResponse(BaseModel):
    interview_id: int
    status: str
    question_number: int
    score: float
    evaluation: str
    next_question: Optional[QuestionPayload] = None
    assessment_available: bool = False
    answered_question: Optional[bool] = None
    answer_relevance: str = ""
    topic: str = ""
    subtopic: str = ""
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    missing_concepts: list[str] = Field(default_factory=list)
    next_focus: str = ""
    interviewer_acknowledgement: str = ""
    next_selection_reason: str = ""


class InterviewTurnPayload(BaseModel):
    id: int
    question_number: int
    question: str
    candidate_answer: str
    difficulty: str
    topic: str = ""
    subtopic: str = ""
    answered_question: Optional[bool] = None
    answer_relevance: str = ""
    missing_concepts: str = "[]"
    next_focus: str = ""
    question_type: str = "conceptual"
    score: Optional[float]
    evaluation: str
    created_at: datetime

    model_config = {"from_attributes": True}


class TopicPerformancePayload(BaseModel):
    topic: str
    subtopic: str
    attempts: int
    average_score: float
    weaknesses: str
    missing_concepts: str

    model_config = {"from_attributes": True}


class InterviewStateResponse(BaseModel):
    id: int
    candidate_name: str
    status: str
    current_question_number: int
    max_questions: int
    current_difficulty: str
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    current_question: Optional[QuestionPayload]
    turns: list[InterviewTurnPayload]
    topic_performance: list[TopicPerformancePayload] = Field(default_factory=list)


class InterviewAssessmentResponse(BaseModel):
    id: int
    interview_id: int
    overall_score: Optional[float]
    technical_level: str = ""
    recommendation: str
    strongest_topics: str = "[]"
    weakest_topics: str = "[]"
    key_strengths: str = "[]"
    key_weaknesses: str = "[]"
    strengths: str
    weaknesses: str
    technical_summary: str
    improvement_plan: str = "[]"
    created_at: datetime

    model_config = {"from_attributes": True}




class SimliSessionRequest(BaseModel):
    interview_id: int


class SimliSessionResponse(BaseModel):
    session_token: str

