from __future__ import annotations

import asyncio
import base64
import os
import threading
import uuid
from typing import Any

import numpy as np
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

try:
    import edge_tts  # type: ignore
except Exception:  # pragma: no cover - runtime dependency check
    edge_tts = None

try:
    from faster_whisper import WhisperModel  # type: ignore
except Exception:  # pragma: no cover - runtime dependency check
    WhisperModel = None


class TTSRequest(BaseModel):
    text: str
    turn_id: str | None = None


_DEVANAGARI = range(0x0900, 0x0980)
_TELUGU = range(0x0C00, 0x0C80)
_TAMIL = range(0x0B80, 0x0C00)
_MALE_ENGLISH_VOICE = os.getenv("TTS_VOICE_EN", "en-US-AndrewNeural")
_TELUGU_VOICE = os.getenv("TTS_VOICE_TE", "te-IN-MohanNeural")
_HINDI_VOICE = os.getenv("TTS_VOICE_HI", "hi-IN-SwaraNeural")


def detect_voice(text: str) -> str:
    for ch in text:
        code = ord(ch)
        if code in _TELUGU:
            return _TELUGU_VOICE
        if code in _TAMIL:
            return _MALE_ENGLISH_VOICE
        if code in _DEVANAGARI:
            return _HINDI_VOICE
    return _MALE_ENGLISH_VOICE


class WhisperModelManager:
    _instance: "WhisperModelManager | None" = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if getattr(self, "_ready", False):
            return
        self._ready = True
        self.model = self._load_model()

    def _load_model(self):
        if WhisperModel is None:
            raise RuntimeError("faster-whisper is not installed")
        device = os.getenv("STT_DEVICE", "auto").lower()
        if device == "auto":
            try:
                import ctranslate2  # type: ignore

                device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            except Exception:
                device = "cpu"
        compute_type = os.getenv("STT_COMPUTE_TYPE", "float16" if device == "cuda" else "int8")
        model_size = os.getenv("STT_MODEL_SIZE", "small")
        return WhisperModel(model_size, device=device, compute_type=compute_type)

    def transcribe(self, audio: np.ndarray) -> str:
        if audio is None or audio.size == 0:
            return ""
        segments, _ = self.model.transcribe(
            audio,
            language=None,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text and segment.text.strip())
        return text.strip()


_whisper_manager: WhisperModelManager | None = None
_whisper_lock = threading.Lock()


def get_whisper_manager() -> WhisperModelManager:
    global _whisper_manager
    if _whisper_manager is None:
        with _whisper_lock:
            if _whisper_manager is None:
                _whisper_manager = WhisperModelManager()
    return _whisper_manager


def _has_real_speech(audio: np.ndarray) -> bool:
    if audio is None or audio.size == 0:
        return False
    rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
    return rms > 0.005


def _decode_pcm(data_b64: str, sample_rate: int) -> np.ndarray:
    raw = base64.b64decode(data_b64)
    audio = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    target = 16000
    if sample_rate and sample_rate != target and audio.size:
        n_out = int(round(audio.size * target / sample_rate))
        if n_out > 0:
            x_old = np.linspace(0.0, 1.0, num=audio.size, endpoint=False)
            x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
            audio = np.interp(x_new, x_old, audio).astype(np.float32)
    return audio


def _ticks_to_seconds(value: int | float | str | None) -> float:
    try:
        return float(value or 0) / 10_000_000.0
    except (TypeError, ValueError):
        return 0.0


async def _synthesize_mp3_with_words(text: str, turn_id: str | None = None) -> tuple[bytes, list[dict[str, float | str]]]:
    if edge_tts is None:
        raise RuntimeError("edge_tts is not installed")
    voice = detect_voice((text or "").strip())
    communicate = edge_tts.Communicate(text, voice, boundary="WordBoundary")
    buffer = bytearray()
    words: list[dict[str, float | str]] = []
    async for chunk in communicate.stream():
        chunk_type = chunk.get("type")
        if chunk_type == "audio":
            buffer.extend(chunk.get("data", b""))
        elif chunk_type == "WordBoundary":
            word_text = str(chunk.get("text", "") or "").strip()
            if not word_text:
                continue
            words.append(
                {
                    "word": word_text,
                    "start": _ticks_to_seconds(chunk.get("offset")),
                    "duration": _ticks_to_seconds(chunk.get("duration")),
                }
            )
    return bytes(buffer), words


async def tts_response(text: str, turn_id: str | None = None) -> Response:
    value = (text or "").strip()
    if not value:
        return Response(content=b"", media_type="audio/mpeg")
    try:
        audio, _ = await _synthesize_mp3_with_words(value, turn_id)
    except Exception as exc:  # pragma: no cover - runtime error surface
        return Response(content=f"tts unavailable: {exc}".encode(), status_code=503, media_type="text/plain")
    return Response(content=audio, media_type="audio/mpeg")


async def tts_metadata_response(text: str, turn_id: str | None = None) -> JSONResponse:
    value = (text or "").strip()
    if not value:
        return JSONResponse(content={"turn_id": turn_id, "words": []})
    try:
        _, words = await _synthesize_mp3_with_words(value, turn_id)
    except Exception as exc:  # pragma: no cover - runtime error surface
        return JSONResponse(content={"turn_id": turn_id, "words": [], "error": str(exc)}, status_code=503)
    return JSONResponse(content={"turn_id": turn_id, "words": words})


async def ws_chat(websocket: WebSocket) -> None:
    await websocket.accept()
    turn_id: str | None = None

    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")

            if message_type == "ping":
                await websocket.send_json({"type": "pong", "turn_id": turn_id})
                continue

            if message_type in {"listening_start", "listening_end", "listening_cancel", "audio_end", "audio_start", "playback_done"}:
                turn_id = message.get("turn_id") or turn_id
                continue

            if message_type == "audio_pcm16":
                current_turn = message.get("turn_id") or str(uuid.uuid4())
                turn_id = current_turn
                sample_rate = int(message.get("sample_rate", 16000) or 16000)
                data = message.get("data", "")
                if not data:
                    await websocket.send_json({"type": "ignored", "text": "", "reason": "empty audio", "turn_id": current_turn})
                    continue

                try:
                    audio = _decode_pcm(str(data), sample_rate)
                except Exception:
                    await websocket.send_json({"type": "ignored", "text": "", "reason": "decode_failed", "turn_id": current_turn})
                    continue

                if not _has_real_speech(audio):
                    await websocket.send_json({"type": "ignored", "text": "", "reason": "no_speech", "turn_id": current_turn})
                    continue

                stt = get_whisper_manager()
                transcript = await asyncio.to_thread(stt.transcribe, audio)
                transcript = (transcript or "").strip()
                if not transcript:
                    await websocket.send_json({"type": "ignored", "text": "", "reason": "empty_transcript", "turn_id": current_turn})
                    continue

                await websocket.send_json({"type": "transcript", "text": transcript, "turn_id": current_turn})
                continue

            if message_type == "text":
                text = str(message.get("message", "")).strip()
                if not text:
                    await websocket.send_json({"type": "error", "message": "empty message", "turn_id": turn_id})
                    continue
                await websocket.send_json({"type": "transcript", "text": text, "turn_id": turn_id})
                continue

            await websocket.send_json({"type": "error", "message": f"unknown type: {message_type!r}", "turn_id": turn_id})
    except WebSocketDisconnect:
        return
    except Exception as exc:  # pragma: no cover - websocket safety
        try:
            await websocket.send_json({"type": "error", "message": str(exc), "turn_id": turn_id})
        except Exception:
            pass
