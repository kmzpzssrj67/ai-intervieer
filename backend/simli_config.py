from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parent
ENV_FILE = BACKEND_DIR / ".env"
load_dotenv(ENV_FILE, override=False)


def _flag(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


class SimliConfigError(ValueError):
    pass


def _validated_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)).strip())
    except (TypeError, ValueError):
        raise SimliConfigError(f"{name} must be an integer")
    if value < minimum:
        raise SimliConfigError(f"{name} must be at least {minimum} seconds")
    if value > maximum:
        raise SimliConfigError(f"{name} must be at most {maximum} seconds")
    return value


@dataclass(frozen=True)
class SimliSettings:
    enabled: bool
    avatar_provider: str
    api_key: str
    face_id: str
    max_session_seconds: int
    max_idle_seconds: int

    @property
    def available(self) -> bool:
        return self.enabled and self.avatar_provider == "simli" and bool(self.api_key and self.face_id)


def get_simli_settings() -> SimliSettings:
    provider = os.getenv("AVATAR_PROVIDER", "simli").strip().lower()
    if provider not in {"local", "simli"}:
        provider = "simli"
    max_session_seconds = _validated_int("SIMLI_MAX_SESSION_SECONDS", 1800, 600, 3600)
    max_idle_seconds = _validated_int("SIMLI_MAX_IDLE_SECONDS", 300, 300, 1800)
    if max_session_seconds <= max_idle_seconds:
        raise SimliConfigError("SIMLI_MAX_SESSION_SECONDS must be greater than SIMLI_MAX_IDLE_SECONDS")
    return SimliSettings(
        enabled=_flag("SIMLI_ENABLED", True),
        avatar_provider=provider,
        api_key=os.getenv("SIMLI_API_KEY", "").strip(),
        face_id=os.getenv("SIMLI_FACE_ID", "").strip(),
        max_session_seconds=max_session_seconds,
        max_idle_seconds=max_idle_seconds,
    )
