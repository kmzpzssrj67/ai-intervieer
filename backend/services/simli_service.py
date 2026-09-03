from __future__ import annotations

import httpx
from fastapi import HTTPException

from simli_config import SimliConfigError, get_simli_settings


SIMLI_TOKEN_URL = "https://api.simli.ai/compose/token"


async def create_session_token() -> str:
    try:
        settings = get_simli_settings()
    except SimliConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not settings.enabled or settings.avatar_provider != "simli":
        raise HTTPException(status_code=503, detail="Simli avatar is disabled")
    if not settings.api_key:
        raise HTTPException(status_code=503, detail="Simli avatar is not configured")
    if not settings.face_id:
        raise HTTPException(status_code=503, detail="Simli avatar is not configured")

    payload = {
        "faceId": settings.face_id,
        "apiVersion": "v2",
        "handleSilence": True,
        "maxSessionLength": settings.max_session_seconds,
        "maxIdleTime": settings.max_idle_seconds,
        "startFrame": 0,
        "audioInputFormat": "pcm16",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            response = await client.post(
                SIMLI_TOKEN_URL,
                headers={"x-simli-api-key": settings.api_key},
                json=payload,
            )
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=502, detail="Simli session service timed out") from exc
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else "unknown"
        raise HTTPException(status_code=502, detail=f"Simli session service rejected the requested session limits: HTTP {status}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Simli session service is unavailable") from exc

    try:
        token = response.json().get("session_token", "")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Simli session service returned an invalid response") from exc
    if not isinstance(token, str) or not token:
        raise HTTPException(status_code=502, detail="Simli session service returned an invalid response")
    return token
