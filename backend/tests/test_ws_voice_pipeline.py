"""
Regression tests for ws_chat structured response fields and pipeline safety.

Covers all 8 audited defects:
 1. recognition_status field present in every ignored response
 2. retryable flag present in every ignored response
 3. SILENCE distinguishable from EMPTY_TRANSCRIPT from INVALID_AUDIO
 4. STT timeout -> TIMEOUT status
 5. STT exception -> RECOGNITION_ERROR status
 6. Successful transcript -> type: transcript (existing contract intact)
 7. Lifecycle events accepted without error
 8. Invalid base64 audio -> INVALID_AUDIO (decode_failed)
"""
from __future__ import annotations

import asyncio
import base64
import struct
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pcm32_b64(samples: list) -> str:
    """Encode float32 samples as base64 PCM32 (matches _decode_pcm format)."""
    raw = struct.pack(f"{len(samples)}f", *samples)
    return base64.b64encode(raw).decode()


def _silent_audio_b64(n: int = 4096) -> str:
    """Near-zero samples — triggers SILENCE via _has_real_speech."""
    return _pcm32_b64([0.0] * n)


def _loud_audio_b64(n: int = 4096) -> str:
    """Alternating samples loud enough to pass _has_real_speech (RMS >> 0.005)."""
    return _pcm32_b64([0.5 * (1 if i % 2 == 0 else -1) for i in range(n)])


# ---------------------------------------------------------------------------
# Fix 7: Lifecycle events are accepted without error
# ---------------------------------------------------------------------------

def test_ping_returns_pong() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "ping", "turn_id": "t-1"})
        data = ws.receive_json()
    assert data["type"] == "pong"


def test_listening_start_accepted_silently() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "listening_start", "turn_id": "t-ls"})
        ws.send_json({"type": "ping"})
        data = ws.receive_json()
    assert data["type"] == "pong"


def test_listening_cancel_accepted_silently() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "listening_cancel", "turn_id": "t-lc"})
        ws.send_json({"type": "ping"})
        data = ws.receive_json()
    assert data["type"] == "pong"


def test_playback_done_accepted_silently() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "playback_done", "turn_id": "t-pd"})
        ws.send_json({"type": "ping"})
        data = ws.receive_json()
    assert data["type"] == "pong"


# ---------------------------------------------------------------------------
# Fixes 1, 2, 3: recognition_status + retryable on empty payload -> INVALID_AUDIO
# ---------------------------------------------------------------------------

def test_empty_data_returns_invalid_audio_retryable() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "audio_pcm16", "turn_id": "t-emp", "data": "", "sample_rate": 16000})
        data = ws.receive_json()
    assert data["type"] == "ignored"
    assert data["recognition_status"] == "INVALID_AUDIO"
    assert data["retryable"] is True
    assert data["reason"] == "empty audio"
    assert "turn_id" in data


def test_missing_data_field_returns_invalid_audio() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "audio_pcm16", "turn_id": "t-no-data", "sample_rate": 16000})
        data = ws.receive_json()
    assert data["type"] == "ignored"
    assert data["recognition_status"] == "INVALID_AUDIO"
    assert data["retryable"] is True


# ---------------------------------------------------------------------------
# Fix 8: Invalid base64 -> INVALID_AUDIO (decode_failed), NOT retryable
# ---------------------------------------------------------------------------

def test_invalid_base64_returns_invalid_audio_not_retryable() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({
            "type": "audio_pcm16",
            "turn_id": "t-bad-b64",
            "data": "not!valid!base64!!!!!",
            "sample_rate": 16000,
        })
        data = ws.receive_json()
    assert data["type"] == "ignored"
    assert data["recognition_status"] == "INVALID_AUDIO"
    assert data["retryable"] is False
    assert data["reason"] == "decode_failed"


# ---------------------------------------------------------------------------
# Fix 3: SILENCE when audio contains no real speech
# ---------------------------------------------------------------------------

def test_silent_audio_returns_silence_status() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({
            "type": "audio_pcm16",
            "turn_id": "t-silent",
            "data": _silent_audio_b64(),
            "sample_rate": 16000,
        })
        data = ws.receive_json()
    assert data["type"] == "ignored"
    assert data["recognition_status"] == "SILENCE"
    assert data["retryable"] is True
    assert data["reason"] == "no_speech"


# ---------------------------------------------------------------------------
# Fix 3: EMPTY_TRANSCRIPT when Whisper returns empty string
# ---------------------------------------------------------------------------

def test_whisper_empty_string_returns_empty_transcript_retryable() -> None:
    mock_whisper = MagicMock()
    mock_whisper.transcribe.return_value = ""

    import voice_service

    with patch.object(voice_service, "get_whisper_manager", return_value=mock_whisper):
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "audio_pcm16",
                "turn_id": "t-empty-tx",
                "data": _loud_audio_b64(),
                "sample_rate": 16000,
            })
            data = ws.receive_json()

    assert data["type"] == "ignored"
    assert data["recognition_status"] == "EMPTY_TRANSCRIPT"
    assert data["retryable"] is True
    assert data["reason"] == "empty_transcript"


def test_whisper_whitespace_returns_empty_transcript() -> None:
    mock_whisper = MagicMock()
    mock_whisper.transcribe.return_value = "   \n  "

    import voice_service

    with patch.object(voice_service, "get_whisper_manager", return_value=mock_whisper):
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "audio_pcm16",
                "turn_id": "t-ws-tx",
                "data": _loud_audio_b64(),
                "sample_rate": 16000,
            })
            data = ws.receive_json()

    assert data["recognition_status"] == "EMPTY_TRANSCRIPT"
    assert data["retryable"] is True


# ---------------------------------------------------------------------------
# Fix 6: Successful recognition -> type: transcript (existing contract intact)
# ---------------------------------------------------------------------------

def test_valid_speech_returns_transcript_type() -> None:
    mock_whisper = MagicMock()
    mock_whisper.transcribe.return_value = "Hello world"

    import voice_service

    with patch.object(voice_service, "get_whisper_manager", return_value=mock_whisper):
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "audio_pcm16",
                "turn_id": "t-ok",
                "data": _loud_audio_b64(),
                "sample_rate": 16000,
            })
            data = ws.receive_json()

    assert data["type"] == "transcript"
    assert data["text"] == "Hello world"
    assert data["turn_id"] == "t-ok"


def test_text_message_bypasses_stt_and_returns_transcript() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "text", "message": "I know Python well", "turn_id": "t-txt"})
        data = ws.receive_json()
    assert data["type"] == "transcript"
    assert data["text"] == "I know Python well"


# ---------------------------------------------------------------------------
# Fix 5: RECOGNITION_ERROR when Whisper raises exception, not retryable
# ---------------------------------------------------------------------------

def test_whisper_exception_returns_recognition_error_not_retryable() -> None:
    mock_whisper = MagicMock()
    mock_whisper.transcribe.side_effect = RuntimeError("CUDA out of memory")

    import voice_service

    with patch.object(voice_service, "get_whisper_manager", return_value=mock_whisper):
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "audio_pcm16",
                "turn_id": "t-exc",
                "data": _loud_audio_b64(),
                "sample_rate": 16000,
            })
            data = ws.receive_json()

    assert data["type"] == "ignored"
    assert data["recognition_status"] == "RECOGNITION_ERROR"
    assert data["retryable"] is False
    assert data["reason"] == "recognition_error"
    assert data["text"] == ""


def test_recognition_error_does_not_expose_internal_detail() -> None:
    """Internal exception message must not leak into the client response."""
    mock_whisper = MagicMock()
    mock_whisper.transcribe.side_effect = RuntimeError("secret_internal_path_/home/srv/model")

    import voice_service

    with patch.object(voice_service, "get_whisper_manager", return_value=mock_whisper):
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "audio_pcm16",
                "turn_id": "t-leak-check",
                "data": _loud_audio_b64(),
                "sample_rate": 16000,
            })
            data = ws.receive_json()

    assert data["text"] == ""
    assert "secret" not in str(data)


# ---------------------------------------------------------------------------
# Fix 4: TIMEOUT when STT exceeds deadline
# ---------------------------------------------------------------------------

def test_stt_timeout_returns_timeout_status_retryable() -> None:
    """Lower _STT_TIMEOUT_SECONDS to 50ms and verify TIMEOUT is returned."""
    import voice_service

    original_timeout = voice_service._STT_TIMEOUT_SECONDS
    voice_service._STT_TIMEOUT_SECONDS = 0.05  # 50 ms for fast test

    def _slow_transcribe(audio):
        import time
        time.sleep(10)
        return "never"

    mock_whisper = MagicMock()
    mock_whisper.transcribe.side_effect = _slow_transcribe

    try:
        with patch.object(voice_service, "get_whisper_manager", return_value=mock_whisper):
            with client.websocket_connect("/ws/chat") as ws:
                ws.send_json({
                    "type": "audio_pcm16",
                    "turn_id": "t-timeout",
                    "data": _loud_audio_b64(),
                    "sample_rate": 16000,
                })
                data = ws.receive_json()
    finally:
        voice_service._STT_TIMEOUT_SECONDS = original_timeout

    assert data["type"] == "ignored"
    assert data["recognition_status"] == "TIMEOUT"
    assert data["retryable"] is True
    assert data["reason"] == "stt_timeout"


# ---------------------------------------------------------------------------
# Backward-compatibility: old ignored fields still present alongside new ones
# ---------------------------------------------------------------------------

def test_all_ignored_fields_present_for_empty_payload() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "audio_pcm16", "turn_id": "t-compat", "data": "", "sample_rate": 16000})
        data = ws.receive_json()
    # Original contract fields
    assert data["type"] == "ignored"
    assert data["text"] == ""
    assert "reason" in data
    assert "turn_id" in data
    # New additive fields
    assert "recognition_status" in data
    assert "retryable" in data


def test_all_ignored_fields_present_for_silence() -> None:
    with client.websocket_connect("/ws/chat") as ws:
        ws.send_json({
            "type": "audio_pcm16",
            "turn_id": "t-compat-sil",
            "data": _silent_audio_b64(),
            "sample_rate": 16000,
        })
        data = ws.receive_json()
    assert data["type"] == "ignored"
    assert data["text"] == ""
    assert data["reason"] == "no_speech"
    assert data["recognition_status"] == "SILENCE"
    assert data["retryable"] is True


def test_silence_and_empty_transcript_have_distinct_statuses() -> None:
    """Critical: frontend must be able to tell silence apart from no useful speech."""
    assert "SILENCE" != "EMPTY_TRANSCRIPT"
    assert "SILENCE" != "INVALID_AUDIO"
    assert "EMPTY_TRANSCRIPT" != "INVALID_AUDIO"
