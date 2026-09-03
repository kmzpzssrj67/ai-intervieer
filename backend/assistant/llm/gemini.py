from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Literal, Optional

from assistant import config


SYSTEM_PROMPT = (
    "You are an AI technical interviewer for Python interviews. "
    "Behave like a real interviewer, not a teaching assistant. "
    "Keep responses concise, direct, and interview-focused. "
    "Proceed with interview tasks instead of offering open-ended help."
)

GeminiErrorCategory = Literal[
    "missing_key",
    "invalid_key",
    "rate_limit",
    "temporary_failure",
    "unexpected_error",
]

log = logging.getLogger("interviewer.gemini")


@dataclass(frozen=True)
class LLMReply:
    text: str
    provider: str


class GeminiServiceError(Exception):
    def __init__(
        self,
        category: GeminiErrorCategory,
        public_message: str,
        status_code: int,
        log_message: str = "",
    ) -> None:
        super().__init__(public_message)
        self.category = category
        self.public_message = public_message
        self.status_code = status_code
        self.log_message = log_message or public_message


class GeminiClient:
    """Gemini wrapper for model calls."""

    def __init__(self) -> None:
        self.model = config.GEMINI_MODEL
        self._client = None
        self._init_error = ""

        if not config.GEMINI_API_KEY:
            self._init_error = "GEMINI_API_KEY is not configured."
            return

        try:
            from google import genai

            self._client = genai.Client(api_key=config.GEMINI_API_KEY)
        except Exception as exc:  # noqa: BLE001
            self._init_error = f"Gemini SDK initialization failed: {type(exc).__name__}"
            self._client = None
            log.warning("Gemini SDK initialization failed: %s", type(exc).__name__)

    async def generate(self, user_text: str) -> LLMReply:
        if self._client is None:
            raise self._missing_key_error()

        prompt = f"{SYSTEM_PROMPT}\n\nCandidate: {user_text}\nInterviewer:"
        return await self.generate_prompt(prompt)

    async def generate_prompt(self, prompt: str) -> LLMReply:
        if self._client is None:
            raise self._missing_key_error()

        text = await self._request_text(prompt)
        if not text:
            raise GeminiServiceError(
                category="temporary_failure",
                public_message="AI service is temporarily unavailable. Please try again shortly.",
                status_code=503,
                log_message="Gemini returned an empty response",
            )
        return LLMReply(text=text, provider="gemini")

    async def generate_json(self, prompt: str) -> tuple[dict, str]:
        if self._client is None:
            raise self._missing_key_error()

        text = await self._request_text(
            prompt + "\n\nReturn only valid JSON. Do not include markdown fences or commentary."
        )
        if not text:
            raise GeminiServiceError(
                category="temporary_failure",
                public_message="AI service is temporarily unavailable. Please try again shortly.",
                status_code=503,
                log_message="Gemini returned an empty response",
            )
        return self._parse_json_object(text), "gemini"

    async def _request_text(self, prompt: str) -> str:
        last_error: Optional[GeminiServiceError] = None
        for attempt in range(2):
            try:
                response = await asyncio.to_thread(
                    self._client.models.generate_content,
                    model=self.model,
                    contents=prompt,
                )
                return (getattr(response, "text", "") or "").strip()
            except Exception as exc:  # noqa: BLE001
                error = self._classify_error(exc)
                last_error = error
                log.warning(
                    "Gemini request failed category=%s status=%s model=%s attempt=%s detail=%s",
                    error.category,
                    error.status_code,
                    self.model,
                    attempt + 1,
                    error.log_message,
                )
                if error.category in {"missing_key", "invalid_key", "rate_limit", "unexpected_error"}:
                    raise error from exc
                if attempt == 0:
                    await asyncio.sleep(5)
                    continue
                raise error from exc
        raise last_error or GeminiServiceError(
            category="unexpected_error",
            public_message="AI service failed unexpectedly. Please try again later.",
            status_code=502,
        )

    def _missing_key_error(self) -> GeminiServiceError:
        return GeminiServiceError(
            category="missing_key",
            public_message="AI service is not configured. Set GEMINI_API_KEY and restart the backend.",
            status_code=503,
            log_message=self._init_error or "GEMINI_API_KEY is not configured",
        )

    @staticmethod
    def _parse_json_object(text: str) -> dict:
        clean = text.strip()
        clean = re.sub(r"^```(?:json)?\s*", "", clean, flags=re.IGNORECASE)
        clean = re.sub(r"\s*```$", "", clean)
        try:
            return json.loads(clean)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", clean, flags=re.DOTALL)
            if not match:
                raise
            return json.loads(match.group(0))

    @staticmethod
    def _classify_error(exc: Exception) -> GeminiServiceError:
        raw = str(exc).strip()
        lowered = raw.lower()
        safe_detail = raw[:300] if raw else type(exc).__name__

        if (
            "api_key" in lowered
            or "api key" in lowered
            or "permission_denied" in lowered
            or "unauthenticated" in lowered
            or "forbidden" in lowered
            or "401" in lowered
            or "403" in lowered
        ):
            return GeminiServiceError(
                category="invalid_key",
                public_message="AI service credentials are invalid or do not have access to the configured model.",
                status_code=401,
                log_message=safe_detail,
            )
        if "quota" in lowered or "resource_exhausted" in lowered or "429" in lowered:
            return GeminiServiceError(
                category="rate_limit",
                public_message="AI service is temporarily unavailable. Please try again shortly.",
                status_code=429,
                log_message=safe_detail,
            )
        if "unavailable" in lowered or "high demand" in lowered or "503" in lowered or "timeout" in lowered:
            return GeminiServiceError(
                category="temporary_failure",
                public_message="AI service is temporarily unavailable. Please try again shortly.",
                status_code=503,
                log_message=safe_detail,
            )
        return GeminiServiceError(
            category="unexpected_error",
            public_message="AI service failed unexpectedly. Please try again later.",
            status_code=502,
            log_message=safe_detail,
        )




