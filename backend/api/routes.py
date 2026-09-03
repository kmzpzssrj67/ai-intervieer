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
    SimliSessionRequest,
    SimliSessionResponse,
)
from models import Interview
from simli_config import get_simli_settings
from services.simli_service import create_session_token
from services.chat_service import ChatService
from services.interview_service import InterviewService
from voice_service import (
    TTSRequest,
    TTSSynthesizeRequest,
    TTSSynthesizeResponse,
    TTSSynthesisError,
    synthesize_tts_bundle,
    tts_metadata_response,
    tts_response,
    ws_chat as voice_ws_chat,
)


router = APIRouter()
chat_service = ChatService()
interview_service = InterviewService()


@router.get("/api/avatar/config")
def get_avatar_config() -> dict[str, object]:
    settings = get_simli_settings()
    return {
        "provider": settings.avatar_provider,
        "mandatory": settings.avatar_provider == "simli",
        "configured": bool(settings.enabled and settings.api_key and settings.face_id),
        "local_available": True,
    }


@router.post("/api/avatar/simli/session", response_model=SimliSessionResponse)
async def create_simli_session(
    req: SimliSessionRequest,
    db: Session = Depends(get_db),
) -> SimliSessionResponse:
    # Development prototype limitation: there is no existing user authentication.
    # Bind token creation to an interview that has already been deliberately started.
    interview = db.query(Interview).filter(Interview.id == req.interview_id).one_or_none()
    if interview is None:
        raise HTTPException(status_code=404, detail="Interview not found")
    if interview.status not in {"active", "in_progress"}:
        raise HTTPException(status_code=409, detail="Interview is not active")
    return SimliSessionResponse(session_token=await create_session_token())


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


@router.post("/tts/synthesize", response_model=TTSSynthesizeResponse)
async def tts_synthesize(req: TTSSynthesizeRequest) -> TTSSynthesizeResponse:
    try:
        return await synthesize_tts_bundle(req.text, req.turn_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except TTSSynthesisError:
        raise HTTPException(status_code=503, detail="TTS synthesis is unavailable") from None


@router.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket) -> None:
    await voice_ws_chat(websocket)
