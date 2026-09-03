from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from services import simli_service
from api.routes import get_avatar_config
from simli_config import BACKEND_DIR, ENV_FILE, get_simli_settings


def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIMLI_ENABLED", "true")
    monkeypatch.setenv("AVATAR_PROVIDER", "simli")
    monkeypatch.setenv("SIMLI_API_KEY", "primary-secret")
    monkeypatch.setenv("SIMLI_FACE_ID", "face-id")
    monkeypatch.setenv("SIMLI_MAX_SESSION_SECONDS", "1800")
    monkeypatch.setenv("SIMLI_MAX_IDLE_SECONDS", "300")


def test_config_defaults_are_simli_and_mandatory(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("SIMLI_ENABLED", "AVATAR_PROVIDER", "SIMLI_API_KEY", "SIMLI_FACE_ID", "SIMLI_MAX_SESSION_SECONDS", "SIMLI_MAX_IDLE_SECONDS"):
        monkeypatch.delenv(name, raising=False)
    settings = get_simli_settings()
    assert settings.enabled is True
    assert settings.avatar_provider == "simli"
    assert settings.available is False
    assert settings.max_session_seconds == 1800
    assert settings.max_idle_seconds == 300


def test_environment_file_is_backend_env() -> None:
    assert ENV_FILE == BACKEND_DIR / ".env"
    assert ENV_FILE.is_absolute()


def test_config_response_is_truthful_and_secret_free(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    response = get_avatar_config()
    assert response == {
        "provider": "simli",
        "mandatory": True,
        "configured": True,
        "local_available": True,
    }
    serialized = str(response)
    assert "primary-secret" not in serialized
    assert "face-id" not in serialized


def test_missing_credentials_does_not_select_local(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    monkeypatch.delenv("SIMLI_API_KEY")
    response = get_avatar_config()
    assert response["provider"] == "simli"
    assert response["mandatory"] is True
    assert response["configured"] is False


@pytest.mark.parametrize("missing", ["SIMLI_API_KEY", "SIMLI_FACE_ID"])
def test_missing_configuration_is_controlled_503(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    _configured(monkeypatch)
    monkeypatch.delenv(missing)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(simli_service.create_session_token())
    assert exc.value.status_code == 503
    assert "primary-secret" not in str(exc.value.detail)


def test_disabled_is_controlled_503(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    monkeypatch.setenv("SIMLI_ENABLED", "false")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(simli_service.create_session_token())
    assert exc.value.status_code == 503


class _Response:
    def __init__(self, payload: dict[str, str], failure: bool = False) -> None:
        self.payload = payload
        self.failure = failure

    def raise_for_status(self) -> None:
        if self.failure:
            raise httpx.HTTPStatusError("sensitive-upstream-body", request=httpx.Request("POST", "https://example.test"), response=httpx.Response(500))

    def json(self) -> dict[str, str]:
        return self.payload


class _Client:
    response = _Response({"session_token": "temporary-token"})
    posted_json: dict[str, object] | None = None

    def __init__(self, **_: object) -> None:
        pass

    async def __aenter__(self) -> "_Client":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def post(self, *_: object, **kwargs: object) -> _Response:
        payload = kwargs.get("json")
        self.__class__.posted_json = payload if isinstance(payload, dict) else None
        return self.response


def test_success_returns_only_temporary_token(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    assert asyncio.run(simli_service.create_session_token()) == "temporary-token"
    assert _Client.posted_json is not None
    assert _Client.posted_json["handleSilence"] is True
    assert _Client.posted_json["maxSessionLength"] == 1800
    assert _Client.posted_json["maxIdleTime"] == 300


def test_idle_timeout_accepts_300_and_is_not_clamped_to_60(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    monkeypatch.setenv("SIMLI_MAX_IDLE_SECONDS", "300")
    settings = get_simli_settings()
    assert settings.max_idle_seconds == 300


def test_session_must_be_greater_than_idle(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    monkeypatch.setenv("SIMLI_MAX_SESSION_SECONDS", "600")
    monkeypatch.setenv("SIMLI_MAX_IDLE_SECONDS", "600")
    with pytest.raises(ValueError, match="greater than"):
        get_simli_settings()


def test_upstream_failure_does_not_leak(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)
    _Client.response = _Response({}, failure=True)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(simli_service.create_session_token())
    assert exc.value.status_code == 502
    assert "sensitive-upstream-body" not in str(exc.value.detail)
    assert "primary-secret" not in str(exc.value.detail)


def test_upstream_timeout_is_controlled_502(monkeypatch: pytest.MonkeyPatch) -> None:
    _configured(monkeypatch)

    async def timeout(*_: object, **__: object) -> _Response:
        raise httpx.ReadTimeout("timeout")

    monkeypatch.setattr(_Client, "post", timeout)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(simli_service.create_session_token())
    assert exc.value.status_code == 502
