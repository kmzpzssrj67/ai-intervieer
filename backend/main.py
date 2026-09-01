from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import router
from database import create_tables
from voice_service import get_whisper_manager


def create_app() -> FastAPI:
    app = FastAPI(
        title="AI Technical Interviewer API",
        version="0.1.0",
        description="Initial local foundation for a voice-to-voice AI technical interviewer.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3001",
        ],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def on_startup() -> None:
        create_tables()
        get_whisper_manager()

    app.include_router(router)
    return app


app = create_app()
