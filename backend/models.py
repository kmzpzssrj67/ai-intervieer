from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class Interview(Base):
    __tablename__ = "interviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    candidate_name: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(50), default="not_started", index=True)
    current_question_number: Mapped[int] = mapped_column(Integer, default=0)
    max_questions: Mapped[int] = mapped_column(Integer, default=5)
    current_difficulty: Mapped[str] = mapped_column(String(50), default="easy")
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    turns: Mapped[list["InterviewTurn"]] = relationship(
        "InterviewTurn",
        back_populates="interview",
        cascade="all, delete-orphan",
    )
    assessment: Mapped[Optional["InterviewAssessment"]] = relationship(
        "InterviewAssessment",
        back_populates="interview",
        cascade="all, delete-orphan",
        uselist=False,
    )
    topic_performance: Mapped[list["InterviewTopicPerformance"]] = relationship(
        "InterviewTopicPerformance",
        back_populates="interview",
        cascade="all, delete-orphan",
    )


class InterviewTurn(Base):
    __tablename__ = "interview_turns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    interview_id: Mapped[int] = mapped_column(ForeignKey("interviews.id"), index=True)
    question_number: Mapped[int] = mapped_column(Integer)
    question: Mapped[str] = mapped_column(Text)
    candidate_answer: Mapped[str] = mapped_column(Text, default="")
    difficulty: Mapped[str] = mapped_column(String(50), default="easy")
    topic: Mapped[str] = mapped_column(String(100), default="")
    subtopic: Mapped[str] = mapped_column(String(150), default="")
    answered_question: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    answer_relevance: Mapped[str] = mapped_column(String(20), default="")
    missing_concepts: Mapped[str] = mapped_column(Text, default="[]")
    next_focus: Mapped[str] = mapped_column(Text, default="")
    question_type: Mapped[str] = mapped_column(String(50), default="conceptual")
    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    evaluation: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    interview: Mapped[Interview] = relationship("Interview", back_populates="turns")


class InterviewAssessment(Base):
    __tablename__ = "interview_assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    interview_id: Mapped[int] = mapped_column(ForeignKey("interviews.id"), unique=True, index=True)
    overall_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    technical_level: Mapped[str] = mapped_column(String(50), default="")
    recommendation: Mapped[str] = mapped_column(Text, default="")
    strongest_topics: Mapped[str] = mapped_column(Text, default="[]")
    weakest_topics: Mapped[str] = mapped_column(Text, default="[]")
    key_strengths: Mapped[str] = mapped_column(Text, default="[]")
    key_weaknesses: Mapped[str] = mapped_column(Text, default="[]")
    strengths: Mapped[str] = mapped_column(Text, default="")
    weaknesses: Mapped[str] = mapped_column(Text, default="")
    technical_summary: Mapped[str] = mapped_column(Text, default="")
    improvement_plan: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    interview: Mapped[Interview] = relationship("Interview", back_populates="assessment")


class InterviewTopicPerformance(Base):
    __tablename__ = "interview_topic_performance"
    __table_args__ = (UniqueConstraint("interview_id", "topic", "subtopic", name="uq_topic_performance_scope"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    interview_id: Mapped[int] = mapped_column(ForeignKey("interviews.id"), index=True)
    topic: Mapped[str] = mapped_column(String(100), default="")
    subtopic: Mapped[str] = mapped_column(String(150), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    total_score: Mapped[float] = mapped_column(Float, default=0.0)
    average_score: Mapped[float] = mapped_column(Float, default=0.0)
    weaknesses: Mapped[str] = mapped_column(Text, default="[]")
    missing_concepts: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    interview: Mapped[Interview] = relationship("Interview", back_populates="topic_performance")
