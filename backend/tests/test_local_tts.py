from __future__ import annotations

import base64

import pytest

import voice_service


@pytest.fixture
def anyio_backend():
    return "asyncio"


class FakeCommunicate:
    calls = 0
    chunks: list[dict[str, object]] = []

    def __init__(self, text: str, voice: str, boundary: str) -> None:
        type(self).calls += 1
        assert text
        assert voice
        assert boundary == "WordBoundary"

    async def stream(self):
        for chunk in self.chunks:
            yield chunk


@pytest.fixture(autouse=True)
def fake_edge_tts(monkeypatch: pytest.MonkeyPatch):
    FakeCommunicate.calls = 0
    FakeCommunicate.chunks = [
        {"type": "audio", "data": b"mp3-a"},
        {"type": "WordBoundary", "text": "Python", "offset": 1_600_000, "duration": 4_200_000},
        {"type": "audio", "data": b"mp3-b"},
    ]
    monkeypatch.setattr(voice_service, "edge_tts", type("FakeEdgeTts", (), {"Communicate": FakeCommunicate}))


@pytest.mark.anyio
async def test_bundle_uses_one_stream_for_audio_and_boundaries() -> None:
    result = await voice_service.synthesize_tts_bundle("Explain Python", "turn-1")

    assert FakeCommunicate.calls == 1
    assert base64.b64decode(result.audio_base64) == b"mp3-amp3-b"
    assert result.content_type == "audio/mpeg"
    assert result.word_boundaries[0].model_dump() == {"text": "Python", "start": 0.16, "duration": 0.42}


@pytest.mark.anyio
async def test_bundle_rejects_empty_text() -> None:
    with pytest.raises(ValueError, match="required"):
        await voice_service.synthesize_tts_bundle("   ")
    assert FakeCommunicate.calls == 0


@pytest.mark.anyio
async def test_bundle_rejects_empty_audio() -> None:
    FakeCommunicate.chunks = [{"type": "WordBoundary", "text": "Hello", "offset": 0, "duration": 10}]
    with pytest.raises(voice_service.TTSSynthesisError, match="no audio"):
        await voice_service.synthesize_tts_bundle("Hello")


@pytest.mark.anyio
async def test_provider_failure_is_sanitized() -> None:
    class FailingCommunicate(FakeCommunicate):
        async def stream(self):
            raise RuntimeError("provider secret detail")
            yield

    voice_service.edge_tts = type("FakeEdgeTts", (), {"Communicate": FailingCommunicate})
    with pytest.raises(voice_service.TTSSynthesisError) as caught:
        await voice_service.synthesize_tts_bundle("Hello")
    assert "secret" not in str(caught.value)


def test_tick_conversion() -> None:
    assert voice_service._ticks_to_seconds(2_500_000) == 0.25
