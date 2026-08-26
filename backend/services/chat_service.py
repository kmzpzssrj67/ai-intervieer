from __future__ import annotations

from fastapi import HTTPException

from assistant.llm.gemini import GeminiClient, GeminiServiceError
from schemas import ChatRequest, ChatResponse


class ChatService:
    def __init__(self) -> None:
        self._llm = GeminiClient()

    async def reply(self, req: ChatRequest) -> ChatResponse:
        message = req.message.strip()
        try:
            reply = await self._llm.generate(message)
        except GeminiServiceError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.public_message) from exc
        return ChatResponse(reply=reply.text, provider=reply.provider)
