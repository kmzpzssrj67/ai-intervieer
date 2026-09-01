from fastapi.testclient import TestClient

from main import app


client = TestClient(app)


def test_health_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200


def test_tts_route_returns_audio() -> None:
    response = client.post("/tts", json={"text": "hello there", "turn_id": "turn-1"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")


def test_ws_chat_route_exists() -> None:
    with client.websocket_connect("/ws/chat") as websocket:
        websocket.send_json({"type": "ping"})
        data = websocket.receive_json()
        assert data["type"] == "pong"
