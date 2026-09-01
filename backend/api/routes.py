from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from database import get_db
from schemas import (
    ChatRequest,
    ChatResponse,
    InterviewAnswerRequest,
    InterviewAnswerResponse,
    InterviewAssessmentResponse,
    InterviewStartRequest,
    InterviewStartResponse,
    InterviewStateResponse,
)
from services.chat_service import ChatService
from services.interview_service import InterviewService
from voice_service import TTSRequest, tts_metadata_response, tts_response, ws_chat as voice_ws_chat


router = APIRouter()
chat_service = ChatService()
interview_service = InterviewService()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    return await chat_service.reply(req)


@router.post("/api/interview/start", response_model=InterviewStartResponse)
async def start_interview(
    req: InterviewStartRequest,
    db: Session = Depends(get_db),
) -> InterviewStartResponse:
    return await interview_service.start(db, req)


@router.post("/api/interview/{interview_id}/answer", response_model=InterviewAnswerResponse)
async def answer_interview_question(
    interview_id: int,
    req: InterviewAnswerRequest,
    db: Session = Depends(get_db),
) -> InterviewAnswerResponse:
    return await interview_service.answer(db, interview_id, req.answer)


@router.get("/api/interview/{interview_id}", response_model=InterviewStateResponse)
def get_interview(
    interview_id: int,
    db: Session = Depends(get_db),
) -> InterviewStateResponse:
    return interview_service.get_state(db, interview_id)


@router.get("/api/interview/{interview_id}/assessment", response_model=InterviewAssessmentResponse)
def get_interview_assessment(
    interview_id: int,
    db: Session = Depends(get_db),
) -> InterviewAssessmentResponse:
    return interview_service.get_assessment(db, interview_id)


@router.get("/tts")
async def tts_get(text: str = "") -> Response:
    if not text.strip():
        return Response(content=b"", media_type="audio/mpeg")
    return await tts_response(text)


@router.post("/tts")
async def tts(req: TTSRequest) -> Response:
    return await tts_response(req.text, req.turn_id)


@router.post("/tts/metadata")
async def tts_metadata(req: TTSRequest) -> JSONResponse:
    return await tts_metadata_response(req.text, req.turn_id)


@router.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket) -> None:
    await voice_ws_chat(websocket)

