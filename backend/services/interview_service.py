from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from assistant.llm.gemini import GeminiClient, GeminiServiceError
from models import Interview, InterviewAssessment, InterviewTopicPerformance, InterviewTurn
from schemas import (
    AssessmentResult,
    EvaluationNextQuestionResult,
    EvaluationResult,
    FinalEvaluationAssessmentResult,
    InterviewAnswerResponse,
    InterviewAssessmentResponse,
    InterviewStartRequest,
    InterviewStartResponse,
    InterviewStateResponse,
    NextQuestionResult,
    QuestionPayload,
)


DIFFICULTIES = ["easy", "medium", "hard"]
START_GREETING = "Hey! Welcome. I'll be your AI technical interviewer today. Let's begin your Python interview."
log = logging.getLogger("interviewer.service")
TOPICS = [
    "Python Basics",
    "Data Types",
    "Lists and Tuples",
    "Dictionaries and Sets",
    "Functions",
    "OOP",
    "Decorators",
    "Generators",
    "Iterators",
    "Exception Handling",
    "File Handling",
    "Memory Management",
    "Garbage Collection",
    "GIL",
    "Multithreading",
    "Multiprocessing",
    "Async Programming",
    "Python Internals",
    "APIs",
    "FastAPI",
    "Databases",
    "SQL",
    "PostgreSQL",
]

COVERAGE_PLAN = {
    1: ("Lists and Tuples", "Mutability, ordering, and use cases", "Compare list and tuple behavior"),
    2: ("Dictionaries and Sets", "Hashing, lookup, uniqueness, and membership", "Test dictionary and set fundamentals"),
    3: ("Functions", "Scope, arguments, return values, and defaults", "Check function behavior and common pitfalls"),
    4: ("Functions", "Scope and Scoping Rules", "Probe function scopes, default arguments, closures, or decorators"),
    5: ("Python Internals", "Advanced Python reasoning", "Assess depth in internals, OOP, async, FastAPI, or databases"),
}

TOPIC_KEYWORDS = {
    "Lists and Tuples": {"list", "lists", "tuple", "tuples", "mutable", "immutable", "sequence", "index"},
    "Dictionaries and Sets": {"dict", "dictionary", "dictionaries", "set", "sets", "hash", "key", "value", "membership"},
    "Functions": {"function", "functions", "argument", "parameter", "default", "scope", "return", "decorator", "lambda"},
    "OOP": {"class", "object", "inheritance", "polymorphism", "method", "self", "dunder"},
    "Async Programming": {"async", "await", "coroutine", "event", "loop", "concurrency"},
    "FastAPI": {"fastapi", "endpoint", "dependency", "request", "response", "pydantic"},
    "Python Internals": {"gil", "memory", "garbage", "reference", "iterator", "generator", "bytecode"},
    "Databases": {"database", "sql", "postgresql", "transaction", "query", "index"},
}

FALLBACK_QUESTIONS = {
    ("Lists and Tuples", "Mutability, ordering, and use cases"): 
        "Explain the primary difference between a Python list and a tuple regarding mutability, and give a specific scenario where you must use a tuple instead of a list.",
    ("Dictionaries and Sets", "Hashing, lookup, uniqueness, and membership"):
        "How does a Python dictionary achieve O(1) average time complexity for lookups under the hood, and what requirements must its keys satisfy?",
    ("Functions", "Scope, arguments, return values, and defaults"):
        "Why can using a mutable object like a list as a default argument in a Python function lead to unexpected behavior, and how do you resolve it?",
    ("Functions", "Scope and Scoping Rules"):
        "Explain how Python resolves variable names using the LEGB scope rules, and what happens if you assign to a variable inside a function without a global keyword when a global variable with the same name exists.",
    ("Python Internals", "Advanced Python reasoning"):
        "What is the Global Interpreter Lock (GIL) in CPython, how does it affect CPU-bound versus I/O-bound multi-threaded applications, and how can you achieve true CPU parallelism?",
    ("OOP", "Advanced Python reasoning"):
        "Explain how Method Resolution Order (MRO) works in Python multiple inheritance, and how the super() function determines which class's method to call next.",
    ("Async Programming", "Advanced Python reasoning"):
        "How does Python's asyncio event loop handle cooperative multitasking under the hood, and what happens if a coroutine blocks the loop with CPU-heavy synchronous operations?",
}

def get_fallback_question(topic: str, subtopic: str) -> str:
    key = (topic, subtopic)
    if key in FALLBACK_QUESTIONS:
        return FALLBACK_QUESTIONS[key]
    
    normalized_topic = topic.lower()
    if "list" in normalized_topic or "tuple" in normalized_topic:
        return FALLBACK_QUESTIONS[("Lists and Tuples", "Mutability, ordering, and use cases")]
    if "dict" in normalized_topic or "set" in normalized_topic:
        return FALLBACK_QUESTIONS[("Dictionaries and Sets", "Hashing, lookup, uniqueness, and membership")]
    if "func" in normalized_topic:
        if "scope" in subtopic.lower() or "scoping" in subtopic.lower():
            return FALLBACK_QUESTIONS[("Functions", "Scope and Scoping Rules")]
        return FALLBACK_QUESTIONS[("Functions", "Scope, arguments, return values, and defaults")]
    if "async" in normalized_topic or "concurrency" in normalized_topic:
        return FALLBACK_QUESTIONS[("Async Programming", "Advanced Python reasoning")]
    if "oop" in normalized_topic or "class" in normalized_topic:
        return FALLBACK_QUESTIONS[("OOP", "Advanced Python reasoning")]
    return "Can you explain the main difference between mutability and immutability in Python, and how it relates to hashability and function argument passing?"


@dataclass(frozen=True)
class TopicPlan:
    question_number: int
    topic: str
    subtopic: str
    difficulty: str
    focus_area: str
    reason: str
    is_follow_up: bool = False

    @property
    def question_type(self) -> str:
        if self.is_follow_up:
            return "weakness_follow_up"
        if self.question_number in {1, 2, 3}:
            return "coverage"
        if self.question_number == 5:
            return "final"
        return "coverage"


class InterviewService:
    def __init__(self) -> None:
        self._llm = GeminiClient()

    async def start(self, db: Session, req: InterviewStartRequest) -> InterviewStartResponse:
        interview = Interview(
            candidate_name=req.candidate_name.strip(),
            status="in_progress",
            current_question_number=1,
            max_questions=req.max_questions,
            current_difficulty="easy",
            started_at=datetime.utcnow(),
        )
        db.add(interview)
        db.flush()

        first_plan = self._coverage_plan_for(question_number=1, difficulty="easy")
        try:
            question = await self._generate_question(
                candidate_name=interview.candidate_name,
                question_number=1,
                max_questions=interview.max_questions,
                history=[],
                plan=first_plan,
            )
        except HTTPException:
            db.rollback()
            raise

        turn = InterviewTurn(
            interview_id=interview.id,
            question_number=1,
            question=question.question,
            difficulty=question.difficulty,
            topic=question.topic,
            subtopic=question.subtopic,
            question_type=question.question_type,
        )
        interview.current_difficulty = question.difficulty
        db.add(turn)
        db.commit()
        db.refresh(interview)
        return InterviewStartResponse(
            interview_id=interview.id,
            greeting=START_GREETING,
            question_number=question.question_number,
            question=question.question,
            difficulty=question.difficulty,
            status=interview.status,
            topic=question.topic,
            subtopic=question.subtopic,
            question_type=question.question_type,
        )

    def _simulate_topic_performance(
        self,
        topic_performance: list[InterviewTopicPerformance],
        evaluation: EvaluationResult,
    ) -> list[InterviewTopicPerformance]:
        simulated = []
        found = False
        for tp in topic_performance:
            new_tp = InterviewTopicPerformance(
                topic=tp.topic,
                subtopic=tp.subtopic,
                attempts=tp.attempts,
                average_score=tp.average_score,
                weaknesses=tp.weaknesses,
                missing_concepts=tp.missing_concepts,
            )
            if new_tp.topic == evaluation.topic:
                found = True
                new_tp.attempts += 1
                new_tp.average_score = (tp.average_score * tp.attempts + evaluation.score) / new_tp.attempts
                if evaluation.score <= 4:
                    try:
                        weak_list = json.loads(tp.weaknesses or "[]")
                    except Exception:
                        weak_list = []
                    weak_list.extend(evaluation.weaknesses)
                    new_tp.weaknesses = json.dumps(weak_list)
                    
                    try:
                        missing_list = json.loads(tp.missing_concepts or "[]")
                    except Exception:
                        missing_list = []
                    missing_list.extend(evaluation.missing_concepts)
                    new_tp.missing_concepts = json.dumps(missing_list)
            simulated.append(new_tp)
            
        if not found:
            new_tp = InterviewTopicPerformance(
                topic=evaluation.topic,
                subtopic=evaluation.subtopic,
                attempts=1,
                average_score=evaluation.score,
                weaknesses=json.dumps(evaluation.weaknesses),
                missing_concepts=json.dumps(evaluation.missing_concepts),
            )
            simulated.append(new_tp)
        return simulated

    async def answer(self, db: Session, interview_id: int, answer_text: str) -> InterviewAnswerResponse:
        interview = self._get_interview(db, interview_id)
        if interview.status == "completed":
            raise HTTPException(status_code=400, detail="Interview is already completed.")
        if interview.status != "in_progress":
            raise HTTPException(status_code=400, detail="Interview is not in progress.")

        turn = self._get_current_turn(db, interview)
        if turn.candidate_answer.strip():
            raise HTTPException(status_code=400, detail="Current question has already been answered.")

        history_before_answer = self._turns(db, interview.id)
        topic_performance = self._topic_performance(db, interview.id)
        is_final = turn.question_number >= interview.max_questions

        try:
            if is_final:
                final_result = await self._evaluate_and_assess(
                    interview=interview,
                    turn=turn,
                    answer_text=answer_text,
                    history=history_before_answer,
                    topic_performance=topic_performance,
                )
                evaluation = EvaluationResult.model_validate(final_result.model_dump(exclude={"assessment"}))
                evaluation.score = self._rubric_score(evaluation)
                
                # Align topic/subtopic if answer is unrelated
                if evaluation.answer_relevance == "none":
                    evaluation.topic = turn.topic
                    evaluation.subtopic = turn.subtopic
                
                assessment = final_result.assessment
                combined = None
                selected_plan = None
                next_question = None
            else:
                next_question_number = turn.question_number + 1

                # Calculate options:
                # OPTION A: assuming strong answer
                eval_strong = EvaluationResult(
                    score=10.0,
                    answered_question=True,
                    answer_relevance="high",
                    topic=turn.topic,
                    subtopic=turn.subtopic,
                    evaluation="Strong",
                )
                diff_strong = self._next_difficulty(
                    current=turn.difficulty,
                    score_hint=10.0,
                    answered_question=True,
                    answer_relevance="high",
                )
                sim_perf_strong = self._simulate_topic_performance(topic_performance, eval_strong)
                plan_if_strong = self._select_next_plan(
                    question_number=next_question_number,
                    current_turn=turn,
                    current_difficulty=diff_strong,
                    evaluation=eval_strong,
                    topic_performance=sim_perf_strong,
                    history=history_before_answer,
                )

                # OPTION B: assuming weak/unrelated answer
                eval_weak = EvaluationResult(
                    score=2.0,
                    answered_question=False,
                    answer_relevance="none",
                    topic=turn.topic,
                    subtopic=turn.subtopic,
                    evaluation="Weak",
                )
                diff_weak = self._next_difficulty(
                    current=turn.difficulty,
                    score_hint=2.0,
                    answered_question=False,
                    answer_relevance="none",
                )
                sim_perf_weak = self._simulate_topic_performance(topic_performance, eval_weak)
                plan_if_weak = self._select_next_plan(
                    question_number=next_question_number,
                    current_turn=turn,
                    current_difficulty=diff_weak,
                    evaluation=eval_weak,
                    topic_performance=sim_perf_weak,
                    history=history_before_answer,
                )

                # Call Gemini with both plans
                combined = await self._evaluate_and_generate_next(
                    interview=interview,
                    turn=turn,
                    answer_text=answer_text,
                    history=history_before_answer,
                    topic_performance=topic_performance,
                    plan_if_strong=plan_if_strong,
                    plan_if_weak=plan_if_weak,
                )
                evaluation = EvaluationResult.model_validate(
                    combined.model_dump(exclude={"next_question", "interviewer_acknowledgement", "next_selection_reason"})
                )
                evaluation.score = self._rubric_score(evaluation)
                
                # Align topic/subtopic if answer is unrelated
                if evaluation.answer_relevance == "none":
                    evaluation.topic = turn.topic
                    evaluation.subtopic = turn.subtopic
                
                assessment = None

                # Determine which plan matches the actual score outcome
                is_weak = evaluation.score <= 4 or not evaluation.answered_question or evaluation.answer_relevance in {"none", "low"}
                selected_plan = plan_if_weak if is_weak else plan_if_strong

                # Validate the generated question against selected plan
                is_valid = False
                if combined and combined.next_question:
                    nq = combined.next_question
                    is_valid = (
                        nq.question.strip()
                        and len(nq.question.strip().split()) >= 6
                        and nq.question.strip().endswith("?")
                        and nq.topic.strip().lower() == selected_plan.topic.strip().lower()
                        and nq.subtopic.strip().lower() == selected_plan.subtopic.strip().lower()
                    )

                if not is_valid:
                    log.warning("Gemini generated question failed validation. Retrying once with correction prompt...")
                    # Build retry prompt
                    used_questions = [item.question for item in history_before_answer]
                    base_prompt = f"""
You are a realistic Python technical interviewer. Evaluate the candidate's answer to THIS exact question using the strict rubric, then propose exactly one next question in the same JSON response.

Current candidate: {interview.candidate_name}
Question number: {turn.question_number} of {interview.max_questions}
Current difficulty: {turn.difficulty}
Current topic: {turn.topic or 'Python'}
Current subtopic: {turn.subtopic or 'General'}
Current question: {turn.question}
Candidate answer: {answer_text}
Previous questions: {json.dumps(used_questions)}
Topic performance so far: {json.dumps(self._topic_summary(topic_performance))}
Python topic categories: {json.dumps(TOPICS)}

Python-controlled next-question plan options based on your evaluation score:

OPTION A (Use if candidate's answer is evaluated as STRONG/CORRECT, i.e., score > 4 and answer_relevance is high/medium):
- Target Topic: {plan_if_strong.topic}
- Target Subtopic: {plan_if_strong.subtopic}
- Target Difficulty: {plan_if_strong.difficulty}
- Focus Area: {plan_if_strong.focus_area}
- Question Type: {plan_if_strong.question_type}

OPTION B (Use if candidate's answer is evaluated as WEAK, INCORRECT, or UNRELATED, i.e., score <= 4 or answer_relevance is low/none):
- Target Topic: {plan_if_weak.topic}
- Target Subtopic: {plan_if_weak.subtopic}
- Target Difficulty: {plan_if_weak.difficulty}
- Focus Area: {plan_if_weak.focus_area}
- Question Type: {plan_if_weak.question_type}

Strict scoring rubric:
0-1: completely unrelated, no real attempt, nonsense, or did not answer this question.
2-3: related but mostly incorrect, major misunderstanding, missing the core concept.
4-5: partial understanding with some correct concepts but important gaps or inaccuracies.
6-7: mostly correct, main concept understood, some missing depth or minor inaccuracies.
8-9: strong accurate answer with practical understanding and only minor gaps.
10: excellent, complete, technically accurate, with examples or practical reasoning where relevant.

Critical relevance rule:
First decide whether the candidate answered THIS exact question. Compare the candidate's answer with the expected question topic and subtopic. If the candidate answers about a completely different concept (e.g. they answer about scoping when the question was about dictionaries/hashability), set answer_relevance="none", answered_question=false, score=0 or 1, and the topic and subtopic in your evaluation MUST be the expected topic and subtopic of the question, not the candidate's unrelated topic.

Next question behavior:
- You MUST select the appropriate Python-controlled plan option (Option A or Option B) based on your evaluation score.
- Generate a question specifically matching the selected option's topic, subtopic, difficulty, and focus area. Do not choose any other topic or deviate from the planned subtopic/focus.
- In your return JSON, the 'topic' and 'subtopic' fields under 'next_question' MUST exactly match the selected option's target topic and target subtopic.
- Do not repeat previous questions or ask semantically identical questions.
- Keep interviewer style concise. Avoid tutoring language.

Return strict JSON only with:
score, answered_question, answer_relevance, topic, subtopic, strengths, weaknesses, missing_concepts, evaluation, next_focus, suggested_focus, recommended_question_type, interviewer_acknowledgement, next_selection_reason, next_question.
next_question must include: question, difficulty, topic, subtopic, focus_area, question_type.
""".strip()
                    correction_prompt = base_prompt + f"""

Correction Instruction: Your previous next_question did not match the selected target topic/subtopic.
Based on your score, the selected next plan option is OPTION {"B" if is_weak else "A"}.
You MUST generate a question specifically about:
Target Topic: {selected_plan.topic}
Target Subtopic: {selected_plan.subtopic}
Deterministic Difficulty: {selected_plan.difficulty}
Focus Area: {selected_plan.focus_area}

Please evaluate the candidate's answer again and generate the response JSON again. Make sure next_question.topic is exactly "{selected_plan.topic}" and next_question.subtopic is exactly "{selected_plan.subtopic}".
""".strip()
                    try:
                        retry_combined = await self._json_model(correction_prompt, EvaluationNextQuestionResult)
                        if retry_combined and retry_combined.next_question:
                            nq = retry_combined.next_question
                            is_valid = (
                                nq.question.strip()
                                and len(nq.question.strip().split()) >= 6
                                and nq.question.strip().endswith("?")
                                and nq.topic.strip().lower() == selected_plan.topic.strip().lower()
                                and nq.subtopic.strip().lower() == selected_plan.subtopic.strip().lower()
                            )
                            if is_valid:
                                combined = retry_combined
                                log.info("Gemini next question retry succeeded.")
                    except Exception as e:
                        log.error("Gemini next question retry failed: %s", e)

                if not is_valid:
                    log.warning("Gemini next question validation failed twice. Using safe fallback question.")
                    fallback_q = get_fallback_question(selected_plan.topic, selected_plan.subtopic)
                    next_question = QuestionPayload(
                        question_number=next_question_number,
                        question=fallback_q,
                        difficulty=selected_plan.difficulty,
                        topic=selected_plan.topic,
                        subtopic=selected_plan.subtopic,
                        question_type=selected_plan.question_type,
                    )
                else:
                    next_question = self._build_next_question(
                        proposed=combined.next_question,
                        plan=selected_plan,
                        question_number=next_question_number,
                        previous_questions=[item.question for item in history_before_answer],
                    )
        except HTTPException:
            db.rollback()
            raise

        turn.candidate_answer = answer_text.strip()
        turn.score = evaluation.score
        turn.answered_question = evaluation.answered_question
        turn.answer_relevance = evaluation.answer_relevance
        turn.topic = evaluation.topic or turn.topic
        turn.subtopic = evaluation.subtopic or turn.subtopic
        turn.missing_concepts = json.dumps(evaluation.missing_concepts)
        turn.next_focus = evaluation.next_focus or evaluation.suggested_focus
        turn.evaluation = self._format_evaluation(evaluation)
        self._record_topic_performance(db, interview.id, evaluation)

        if is_final:
            interview.status = "completed"
            interview.completed_at = datetime.utcnow()
            db.add(
                InterviewAssessment(
                    interview_id=interview.id,
                    overall_score=assessment.overall_score if assessment else None,
                    technical_level=assessment.technical_level if assessment else "",
                    recommendation=assessment.recommendation if assessment else "",
                    strongest_topics=json.dumps(assessment.strongest_topics if assessment else []),
                    weakest_topics=json.dumps(assessment.weakest_topics if assessment else []),
                    key_strengths=json.dumps(assessment.key_strengths if assessment else []),
                    key_weaknesses=json.dumps(assessment.key_weaknesses if assessment else []),
                    strengths=json.dumps(assessment.strengths if assessment else []),
                    weaknesses=json.dumps(assessment.weaknesses if assessment else []),
                    technical_summary=assessment.technical_summary if assessment else "",
                    improvement_plan=json.dumps(assessment.improvement_plan if assessment else []),
                )
            )
            db.commit()
            return self._answer_response(
                interview=interview,
                turn=turn,
                evaluation=evaluation,
                next_question=None,
                assessment_available=True,
                next_selection_reason="Interview completed after question 5.",
            )

        db.add(
            InterviewTurn(
                interview_id=interview.id,
                question_number=next_question.question_number,
                question=next_question.question,
                difficulty=next_question.difficulty,
                topic=next_question.topic,
                subtopic=next_question.subtopic,
                question_type=next_question.question_type,
            )
        )
        interview.current_question_number = next_question.question_number
        interview.current_difficulty = next_question.difficulty
        db.commit()

        return self._answer_response(
            interview=interview,
            turn=turn,
            evaluation=evaluation,
            next_question=next_question,
            assessment_available=False,
            acknowledgement=combined.interviewer_acknowledgement if combined else "",
            next_selection_reason=selected_plan.reason if selected_plan else "",
        )

    def get_state(self, db: Session, interview_id: int) -> InterviewStateResponse:
        interview = self._get_interview(db, interview_id)
        turns = self._turns(db, interview.id)
        current_turn = None
        if interview.status == "in_progress":
            current_turn = next(
                (turn for turn in turns if turn.question_number == interview.current_question_number),
                None,
            )
        return InterviewStateResponse(
            id=interview.id,
            candidate_name=interview.candidate_name,
            status=interview.status,
            current_question_number=interview.current_question_number,
            max_questions=interview.max_questions,
            current_difficulty=interview.current_difficulty,
            started_at=interview.started_at,
            completed_at=interview.completed_at,
            current_question=self._question_payload(current_turn) if current_turn else None,
            turns=turns,
            topic_performance=self._topic_performance(db, interview.id),
        )

    def get_assessment(self, db: Session, interview_id: int) -> InterviewAssessmentResponse:
        interview = self._get_interview(db, interview_id)
        if interview.status != "completed":
            raise HTTPException(status_code=404, detail="Assessment is available only after the interview is completed.")
        assessment = (
            db.query(InterviewAssessment)
            .filter(InterviewAssessment.interview_id == interview.id)
            .one_or_none()
        )
        if assessment is None:
            raise HTTPException(status_code=404, detail="Assessment has not been generated yet.")
        return InterviewAssessmentResponse.model_validate(assessment)

    async def _evaluate_and_generate_next(
        self,
        interview: Interview,
        turn: InterviewTurn,
        answer_text: str,
        history: list[InterviewTurn],
        topic_performance: list[InterviewTopicPerformance],
        plan_if_strong: TopicPlan,
        plan_if_weak: TopicPlan,
    ) -> EvaluationNextQuestionResult:
        used_questions = [item.question for item in history]
        prompt = f"""
You are a realistic Python technical interviewer. Evaluate the candidate's answer to THIS exact question using the strict rubric, then propose exactly one next question in the same JSON response.

Current candidate: {interview.candidate_name}
Question number: {turn.question_number} of {interview.max_questions}
Current difficulty: {turn.difficulty}
Current topic: {turn.topic or 'Python'}
Current subtopic: {turn.subtopic or 'General'}
Current question: {turn.question}
Candidate answer: {answer_text}
Previous questions: {json.dumps(used_questions)}
Topic performance so far: {json.dumps(self._topic_summary(topic_performance))}
Python topic categories: {json.dumps(TOPICS)}

Python-controlled next-question plan options based on your evaluation score:

OPTION A (Use if candidate's answer is evaluated as STRONG/CORRECT, i.e., score > 4 and answer_relevance is high/medium):
- Target Topic: {plan_if_strong.topic}
- Target Subtopic: {plan_if_strong.subtopic}
- Target Difficulty: {plan_if_strong.difficulty}
- Focus Area: {plan_if_strong.focus_area}
- Question Type: {plan_if_strong.question_type}

OPTION B (Use if candidate's answer is evaluated as WEAK, INCORRECT, or UNRELATED, i.e., score <= 4 or answer_relevance is low/none):
- Target Topic: {plan_if_weak.topic}
- Target Subtopic: {plan_if_weak.subtopic}
- Target Difficulty: {plan_if_weak.difficulty}
- Focus Area: {plan_if_weak.focus_area}
- Question Type: {plan_if_weak.question_type}

Strict scoring rubric:
0-1: completely unrelated, no real attempt, nonsense, or did not answer this question.
2-3: related but mostly incorrect, major misunderstanding, missing the core concept.
4-5: partial understanding with some correct concepts but important gaps or inaccuracies.
6-7: mostly correct, main concept understood, some missing depth or minor inaccuracies.
8-9: strong accurate answer with practical understanding and only minor gaps.
10: excellent, complete, technically accurate, with examples or practical reasoning where relevant.

Critical relevance rule:
First decide whether the candidate answered THIS exact question. Compare the candidate's answer with the expected question topic and subtopic. If the candidate answers about a completely different concept (e.g. they answer about scoping when the question was about dictionaries/hashability), set answer_relevance="none", answered_question=false, score=0 or 1, and the topic and subtopic in your evaluation MUST be the expected topic and subtopic of the question, not the candidate's unrelated topic.

Next question behavior:
- You MUST select the appropriate Python-controlled plan option (Option A or Option B) based on your evaluation score.
- Generate a question specifically matching the selected option's topic, subtopic, difficulty, and focus area. Do not choose any other topic or deviate from the planned subtopic/focus.
- In your return JSON, the 'topic' and 'subtopic' fields under 'next_question' MUST exactly match the selected option's target topic and target subtopic.
- Do not repeat previous questions or ask semantically identical questions.
- Keep interviewer style concise. Avoid tutoring language.

Return strict JSON only with:
score, answered_question, answer_relevance, topic, subtopic, strengths, weaknesses, missing_concepts, evaluation, next_focus, suggested_focus, recommended_question_type, interviewer_acknowledgement, next_selection_reason, next_question.
next_question must include: question, difficulty, topic, subtopic, focus_area, question_type.
""".strip()
        return await self._json_model(prompt, EvaluationNextQuestionResult)

    async def _evaluate_and_assess(
        self,
        interview: Interview,
        turn: InterviewTurn,
        answer_text: str,
        history: list[InterviewTurn],
        topic_performance: list[InterviewTopicPerformance],
    ) -> FinalEvaluationAssessmentResult:
        completed_history = []
        for item in history:
            completed_history.append(
                {
                    "question_number": item.question_number,
                    "question": item.question,
                    "answer": answer_text if item.id == turn.id else item.candidate_answer,
                    "difficulty": item.difficulty,
                    "topic": item.topic,
                    "subtopic": item.subtopic,
                    "answered_question": item.answered_question,
                    "answer_relevance": item.answer_relevance,
                    "score": item.score,
                    "evaluation": self._evaluation_dict(item.evaluation),
                    "missing_concepts": self._json_list(item.missing_concepts),
                }
            )
        prompt = f"""
You are completing a five-question adaptive Python technical interview. Evaluate the final answer using the same strict rubric, then generate an evidence-based final assessment using ALL interview history.

Candidate: {interview.candidate_name}
Final question number: {turn.question_number} of {interview.max_questions}
Final question topic: {turn.topic}
Final question subtopic: {turn.subtopic}
Final question difficulty: {turn.difficulty}
Final question: {turn.question}
Final candidate answer: {answer_text}
Interview history including the final answer: {json.dumps(completed_history)}
Topic performance so far: {json.dumps(self._topic_summary(topic_performance))}

Assessment rules:
- Do not simply average scores.
- Consider score trend, difficulty reached, answer relevance, repeated weaknesses, topic performance, depth, consistency, and recovery after mistakes.
- Be realistic and evidence-based.
- Recommendations must be one of Strong Hire, Hire, Borderline, No Hire.
- Technical level must be Beginner, Intermediate, or Advanced.

Return strict JSON only with:
score, answered_question, answer_relevance, topic, subtopic, strengths, weaknesses, missing_concepts, evaluation, next_focus, suggested_focus, recommended_question_type, assessment.
assessment must include: overall_score, technical_level, recommendation, strongest_topics, weakest_topics, key_strengths, key_weaknesses, strengths, weaknesses, technical_summary, improvement_plan.
""".strip()
        return await self._json_model(prompt, FinalEvaluationAssessmentResult)

    async def _generate_question(
        self,
        candidate_name: str,
        question_number: int,
        max_questions: int,
        history: list[InterviewTurn],
        plan: TopicPlan,
    ) -> QuestionPayload:
        used_questions = [turn.question for turn in history]
        prompt = f"""
Create the first Python technical interview question. The API handles the greeting, so return only question data.

Candidate: {candidate_name}
Question number: {question_number} of {max_questions}
Target topic: {plan.topic}
Target subtopic: {plan.subtopic}
Deterministic difficulty: {plan.difficulty}
Focus area: {plan.focus_area}
Selection reason: {plan.reason}
Previous questions in this interview only: {json.dumps(used_questions)}
Available topic categories: {json.dumps(TOPICS)}

Rules:
- Ask exactly one concise Python question.
- Use a realistic interviewer style.
- The question must test the target topic/subtopic and match the deterministic difficulty.
- Do not tutor, explain, or ask whether the candidate is ready.
- Do not repeat a previous question or ask a semantically identical question.
- Do not include the answer inside the question.
- Keep it answerable in 2 to 5 minutes.
- For easy questions, test Python fundamentals.
- The returned 'topic' and 'subtopic' MUST describe the ACTUAL technical content of the question you generated (e.g., if the question is about list comprehensions, topic="Lists and Tuples", subtopic="List Comprehensions").
- Do not use generic values like "Weakness follow-up" or "Advanced Python reasoning" for the topic or subtopic.

Return strict JSON only with: question, difficulty, topic, subtopic, focus_area, question_type.
""".strip()

        result = None
        try:
            result = await self._json_model(prompt, NextQuestionResult)
        except Exception as e:
            log.warning("Q1 generation first attempt failed: %s", e)

        # Validate Q1
        is_valid = (
            result
            and result.question.strip()
            and len(result.question.strip().split()) >= 6
            and result.question.strip().endswith("?")
            and result.topic.strip().lower() == plan.topic.strip().lower()
            and result.subtopic.strip().lower() == plan.subtopic.strip().lower()
        )

        if not is_valid:
            log.warning("Q1 generation failed validation. Retrying once with correction prompt...")
            correction_prompt = prompt + f"\n\nCorrection: Your previous response did not match the planned topic/subtopic. You MUST generate a question specifically testing Topic: {plan.topic}, Subtopic: {plan.subtopic}."
            try:
                retry_result = await self._json_model(correction_prompt, NextQuestionResult)
                if retry_result:
                    is_valid = (
                        retry_result.question.strip()
                        and len(retry_result.question.strip().split()) >= 6
                        and retry_result.question.strip().endswith("?")
                        and retry_result.topic.strip().lower() == plan.topic.strip().lower()
                        and retry_result.subtopic.strip().lower() == plan.subtopic.strip().lower()
                    )
                    if is_valid:
                        result = retry_result
                        log.info("Q1 retry succeeded.")
            except Exception as e:
                log.error("Q1 retry failed: %s", e)

        if not is_valid:
            log.warning("Q1 validation failed twice. Using safe fallback question.")
            fallback_q = get_fallback_question(plan.topic, plan.subtopic)
            return QuestionPayload(
                question_number=question_number,
                question=fallback_q,
                difficulty=plan.difficulty,
                topic=plan.topic,
                subtopic=plan.subtopic,
                question_type="coverage",
            )
        else:
            return self._build_next_question(
                proposed=result,
                plan=plan,
                question_number=question_number,
                previous_questions=used_questions,
            )

    async def _json_model(self, prompt: str, schema_type):
        try:
            payload, _provider = await self._llm.generate_json(prompt)
            return schema_type.model_validate(payload)
        except GeminiServiceError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.public_message) from exc
        except ValidationError as exc:
            log.warning("Gemini structured response validation failed for %s: %s", schema_type.__name__, exc)
            raise HTTPException(status_code=502, detail="AI service returned invalid structured data. Please try again shortly.") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail="AI service failed unexpectedly. Please try again later.") from exc

    def _record_topic_performance(self, db: Session, interview_id: int, evaluation: EvaluationResult) -> None:
        topic = evaluation.topic.strip() or "Python"
        subtopic = evaluation.subtopic.strip() or "General"
        record = (
            db.query(InterviewTopicPerformance)
            .filter(
                InterviewTopicPerformance.interview_id == interview_id,
                InterviewTopicPerformance.topic == topic,
                InterviewTopicPerformance.subtopic == subtopic,
            )
            .one_or_none()
        )
        if record is None:
            record = InterviewTopicPerformance(
                interview_id=interview_id,
                topic=topic,
                subtopic=subtopic,
                attempts=0,
                total_score=0.0,
                average_score=0.0,
                weaknesses="[]",
                missing_concepts="[]",
            )
            db.add(record)
        record.attempts = (record.attempts or 0) + 1
        record.total_score = (record.total_score or 0.0) + float(evaluation.score)
        record.average_score = round(record.total_score / record.attempts, 2)
        record.weaknesses = json.dumps(self._merge_lists(self._json_list(record.weaknesses), evaluation.weaknesses))
        record.missing_concepts = json.dumps(
            self._merge_lists(self._json_list(record.missing_concepts), evaluation.missing_concepts)
        )
        record.updated_at = datetime.utcnow()


    def _select_next_plan(
        self,
        question_number: int,
        current_turn: InterviewTurn,
        current_difficulty: str,
        evaluation: EvaluationResult | None,
        topic_performance: list[InterviewTopicPerformance],
        history: list[InterviewTurn],
    ) -> TopicPlan:
        difficulty = current_difficulty
        if evaluation is not None:
            difficulty = self._next_difficulty(
                current=current_turn.difficulty,
                score_hint=evaluation.score,
                answered_question=evaluation.answered_question,
                answer_relevance=evaluation.answer_relevance,
            )

        weak_or_unrelated = bool(
            evaluation
            and (evaluation.score <= 4 or not evaluation.answered_question or evaluation.answer_relevance in {"none", "low"})
        )
        has_previous_follow_up = any(t.question_type == "weakness_follow_up" for t in history)
        if weak_or_unrelated and not has_previous_follow_up:
            focus = self._follow_up_focus(evaluation, current_turn)
            return TopicPlan(
                question_number=question_number,
                topic=evaluation.topic or current_turn.topic or "Python Basics",
                subtopic=evaluation.subtopic or current_turn.subtopic or focus,
                difficulty=difficulty,
                focus_area=focus,
                reason="Weak or unrelated answer; staying on the same concept with a different follow-up.",
                is_follow_up=True,
            )

        if question_number == 4:
            weakest = self._weakest_topic(topic_performance)
            if weakest and weakest.average_score < 6:
                focus = self._first_json_item(weakest.missing_concepts) or self._first_json_item(weakest.weaknesses) or weakest.subtopic
                return TopicPlan(
                    question_number=question_number,
                    topic=weakest.topic,
                    subtopic=weakest.subtopic,
                    difficulty=difficulty,
                    focus_area=f"Follow up on {focus}",
                    reason="Coverage slot 4 targets the weakest observed topic.",
                    is_follow_up=True,
                )

        if question_number == 5:
            strong_topics = [item.topic for item in topic_performance if (item.average_score or 0) >= 8]
            advanced_topic = "Python Internals"
            if any(topic in strong_topics for topic in ["Functions", "Lists and Tuples", "Dictionaries and Sets"]):
                advanced_topic = "Async Programming" if difficulty == "hard" else "OOP"
            weakest = self._weakest_topic(topic_performance)
            if weakest and weakest.average_score < 5:
                return TopicPlan(
                    question_number, weakest.topic, weakest.subtopic, difficulty,
                    f"Final evidence check on {weakest.subtopic} from a new angle",
                    "Final question checks whether the candidate can recover on a weak area.", True
                )
            return TopicPlan(
                question_number, advanced_topic, "Advanced Python reasoning", difficulty,
                f"Assess deeper reasoning in {advanced_topic}",
                "Final question increases depth based on earlier performance.", False
            )

        return self._coverage_plan_for(question_number=question_number, difficulty=difficulty)

    @staticmethod
    def _coverage_plan_for(question_number: int, difficulty: str) -> TopicPlan:
        topic, subtopic, focus = COVERAGE_PLAN.get(question_number, COVERAGE_PLAN[3])
        return TopicPlan(
            question_number=question_number,
            topic=topic,
            subtopic=subtopic,
            difficulty=difficulty,
            focus_area=focus,
            reason=f"Coverage slot {question_number} targets {topic}.",
            is_follow_up=False,
        )

    def _build_next_question(
        self,
        proposed: NextQuestionResult | None,
        plan: TopicPlan,
        question_number: int,
        previous_questions: list[str],
    ) -> QuestionPayload:
        question_text = proposed.question.strip() if proposed and proposed.question else ""
        is_fallback = False
        if not self._is_good_question(question_text, plan, previous_questions):
            question_text = self._fallback_question_for_plan(plan, previous_questions)
            is_fallback = True

        # Stored topic and subtopic must accurately represent the generated question content.
        if proposed and not is_fallback:
            topic = proposed.topic.strip() or plan.topic
            subtopic = proposed.subtopic.strip() or plan.subtopic
        else:
            topic = plan.topic
            subtopic = plan.subtopic

        # Stored question type to keep WHAT is tested and WHY it was selected separate.
        if plan.is_follow_up:
            question_type = "weakness_follow_up"
        elif question_number in {1, 2, 3}:
            question_type = "coverage"
        elif question_number == 5:
            question_type = "final"
        else:
            question_type = "coverage"

        return QuestionPayload(
            question_number=question_number,
            question=question_text,
            difficulty=plan.difficulty,
            topic=topic,
            subtopic=subtopic,
            question_type=question_type,
        )

    def _is_good_question(self, question: str, plan: TopicPlan, previous_questions: list[str]) -> bool:
        normalized = self._normalize_question(question)
        if not normalized or len(normalized.split()) < 6:
            return False
        if not question.strip().endswith("?"):
            return False
        if self._is_duplicate_question(question, previous_questions):
            return False
        banned = ["the answer is", "you should", "would you like", "let me explain", "here is", "ready"]
        if any(item in normalized for item in banned):
            return False
        keywords = TOPIC_KEYWORDS.get(plan.topic, set()) | self._keywords(plan.subtopic) | self._keywords(plan.focus_area)
        return not keywords or any(keyword in normalized for keyword in keywords)

    def _is_duplicate_question(self, question: str, previous_questions: list[str]) -> bool:
        normalized = self._normalize_question(question)
        words = self._keywords(normalized)
        for previous in previous_questions:
            previous_normalized = self._normalize_question(previous)
            if normalized == previous_normalized:
                return True
            previous_words = self._keywords(previous_normalized)
            if len(words) >= 5 and previous_words:
                overlap = len(words & previous_words) / max(len(words | previous_words), 1)
                if overlap >= 0.78:
                    return True
        return False

    def _fallback_question_for_plan(self, plan: TopicPlan, previous_questions: list[str]) -> str:
        focus = plan.focus_area or plan.subtopic or plan.topic
        if plan.is_follow_up:
            candidates = [
                f"Let's stay with {plan.subtopic}. What would happen in a small Python example involving {focus}?",
                f"From another angle, how would you reason about {focus} in Python?",
            ]
        elif plan.difficulty == "hard":
            candidates = [
                f"In Python, what trade-offs or edge cases would you consider when working with {focus}?",
                f"How would you debug a subtle production issue related to {focus} in Python?",
            ]
        else:
            candidates = [
                f"What is the key difference involved in {focus} in Python?",
                f"Can you explain {focus} in Python with a small example?",
            ]
        for candidate in candidates:
            if not self._is_duplicate_question(candidate, previous_questions):
                return candidate
        return f"Can you give a different Python example that demonstrates {focus}?"

    @staticmethod
    def _rubric_score(evaluation: EvaluationResult) -> float:
        score = max(0.0, min(10.0, float(evaluation.score)))
        relevance = evaluation.answer_relevance
        if not evaluation.answered_question or relevance == "none":
            return min(score, 1.0)
        if relevance == "low":
            return min(score, 3.0)
        if relevance == "medium":
            return min(score, 7.0)
        return score

    @staticmethod
    def _next_difficulty(current: str, score_hint: float | None, answered_question: bool, answer_relevance: str) -> str:
        index = DIFFICULTIES.index(current) if current in DIFFICULTIES else 0
        if not answered_question or answer_relevance == "none":
            return DIFFICULTIES[max(index - 1, 0)]
        if score_hint is None:
            return DIFFICULTIES[index]
        if score_hint >= 8:
            index = min(index + 1, len(DIFFICULTIES) - 1)
        elif score_hint <= 4:
            index = max(index - 1, 0)
        return DIFFICULTIES[index]

    @staticmethod
    def _format_evaluation(evaluation: EvaluationResult) -> str:
        return json.dumps(
            {
                "score": evaluation.score,
                "answered_question": evaluation.answered_question,
                "answer_relevance": evaluation.answer_relevance,
                "topic": evaluation.topic,
                "subtopic": evaluation.subtopic,
                "strengths": evaluation.strengths,
                "weaknesses": evaluation.weaknesses,
                "missing_concepts": evaluation.missing_concepts,
                "evaluation": evaluation.evaluation,
                "next_focus": evaluation.next_focus,
                "suggested_focus": evaluation.suggested_focus,
                "recommended_question_type": evaluation.recommended_question_type,
            }
        )

    @staticmethod
    def _question_payload(turn: InterviewTurn | None) -> QuestionPayload | None:
        if turn is None:
            return None
        return QuestionPayload(
            question_number=turn.question_number,
            question=turn.question,
            difficulty=turn.difficulty,
            topic=turn.topic,
            subtopic=turn.subtopic,
            question_type=turn.question_type,
        )

    @staticmethod
    def _answer_response(
        interview: Interview,
        turn: InterviewTurn,
        evaluation: EvaluationResult,
        next_question: QuestionPayload | None,
        assessment_available: bool,
        acknowledgement: str = "",
        next_selection_reason: str = "",
    ) -> InterviewAnswerResponse:
        return InterviewAnswerResponse(
            interview_id=interview.id,
            status=interview.status,
            question_number=turn.question_number,
            score=evaluation.score,
            evaluation=turn.evaluation,
            next_question=next_question,
            assessment_available=assessment_available,
            answered_question=evaluation.answered_question,
            answer_relevance=evaluation.answer_relevance,
            topic=evaluation.topic,
            subtopic=evaluation.subtopic,
            strengths=evaluation.strengths,
            weaknesses=evaluation.weaknesses,
            missing_concepts=evaluation.missing_concepts,
            next_focus=evaluation.next_focus or evaluation.suggested_focus,
            interviewer_acknowledgement=acknowledgement,
            next_selection_reason=next_selection_reason,
        )

    @staticmethod
    def _fallback_question(evaluation: EvaluationResult, difficulty: str) -> NextQuestionResult:
        focus = evaluation.next_focus or evaluation.subtopic or evaluation.topic or "Python fundamentals"
        return NextQuestionResult(
            question=f"Let's stay with {focus}. Can you explain the core idea with a small Python example?",
            difficulty=difficulty,
            topic=evaluation.topic or "Python Basics",
            subtopic=evaluation.subtopic or focus,
            focus_area=focus,
            question_type="follow_up",
        )

    def _unique_question_text(
        self,
        proposed: str,
        previous_questions: list[str],
        evaluation: EvaluationResult,
        difficulty: str,
    ) -> str:
        normalized = self._normalize_question(proposed)
        previous = {self._normalize_question(question) for question in previous_questions}
        if normalized and normalized not in previous:
            return proposed
        return self._fallback_question(evaluation, difficulty).question

    @staticmethod
    def _normalize_question(question: str) -> str:
        return " ".join(question.lower().strip().rstrip("?").split())

    @staticmethod
    def _keywords(text: str) -> set[str]:
        stop_words = {
            "what", "when", "where", "would", "could", "should", "about", "with", "that", "this",
            "from", "into", "your", "python", "explain", "using", "small", "example", "different",
            "angle", "happen", "happens", "core", "idea", "involved", "consider", "working",
        }
        return {word for word in re.findall(r"[a-z0-9_]+", text.lower()) if len(word) > 2 and word not in stop_words}

    @staticmethod
    def _follow_up_focus(evaluation: EvaluationResult, current_turn: InterviewTurn) -> str:
        if evaluation.missing_concepts:
            return evaluation.missing_concepts[0]
        if evaluation.weaknesses:
            return evaluation.weaknesses[0]
        return evaluation.next_focus or current_turn.subtopic or current_turn.topic or "the previous concept"

    @staticmethod
    def _weakest_topic(records: list[InterviewTopicPerformance]) -> InterviewTopicPerformance | None:
        if not records:
            return None
        return min(records, key=lambda item: (item.average_score or 0.0, -(item.attempts or 0)))

    @staticmethod
    def _first_json_item(raw: str | None) -> str:
        items = InterviewService._json_list(raw)
        return items[0] if items else ""

    @staticmethod
    def _topic_summary(records: list[InterviewTopicPerformance]) -> list[dict]:
        return [
            {
                "topic": item.topic,
                "subtopic": item.subtopic,
                "attempts": item.attempts,
                "average_score": item.average_score,
                "weaknesses": InterviewService._json_list(item.weaknesses),
                "missing_concepts": InterviewService._json_list(item.missing_concepts),
            }
            for item in records
        ]

    @staticmethod
    def _evaluation_dict(raw: str) -> dict:
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {"evaluation": raw}

    @staticmethod
    def _json_list(raw: str | None) -> list[str]:
        if not raw:
            return []
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return [raw] if raw else []
        return payload if isinstance(payload, list) else []

    @staticmethod
    def _merge_lists(existing: list[str], incoming: list[str]) -> list[str]:
        merged: list[str] = []
        for item in [*existing, *incoming]:
            clean = str(item).strip()
            if clean and clean not in merged:
                merged.append(clean)
        return merged[:12]

    @staticmethod
    def _get_interview(db: Session, interview_id: int) -> Interview:
        interview = db.query(Interview).filter(Interview.id == interview_id).one_or_none()
        if interview is None:
            raise HTTPException(status_code=404, detail="Interview not found.")
        return interview

    @staticmethod
    def _get_current_turn(db: Session, interview: Interview) -> InterviewTurn:
        turn = (
            db.query(InterviewTurn)
            .filter(
                InterviewTurn.interview_id == interview.id,
                InterviewTurn.question_number == interview.current_question_number,
            )
            .one_or_none()
        )
        if turn is None:
            raise HTTPException(status_code=500, detail="Current interview turn is missing.")
        return turn

    @staticmethod
    def _turns(db: Session, interview_id: int) -> list[InterviewTurn]:
        return (
            db.query(InterviewTurn)
            .filter(InterviewTurn.interview_id == interview_id)
            .order_by(InterviewTurn.question_number.asc())
            .all()
        )

    @staticmethod
    def _topic_performance(db: Session, interview_id: int) -> list[InterviewTopicPerformance]:
        return (
            db.query(InterviewTopicPerformance)
            .filter(InterviewTopicPerformance.interview_id == interview_id)
            .order_by(InterviewTopicPerformance.average_score.asc())
            .all()
        )



