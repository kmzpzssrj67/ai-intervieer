# AI Technical Interviewer — Backend

FastAPI backend providing the core interview orchestration, evaluation engine, speech-to-text (STT), text-to-speech (TTS), and avatar streaming services.

## Overview

- **Interview Engine (`api/routes.py`, `services/interview_service.py`):** Drives the 5-question adaptive Python technical interview, scoring answers and generating technical feedback using Google Gemini.
- **Voice Service (`voice_service.py`):**
  - Synthesizes speech using Microsoft Edge TTS (`en-US-AndrewNeural`).
  - Emits word boundaries and phoneme timing metadata for avatar lip-sync.
  - Receives candidate audio via WebSocket (`/ws/chat`) and transcribes using Faster-Whisper.
- **Simli Service (`services/simli_service.py`):** Optional LiveRTC streaming avatar provider.
- **Database (`models.py`, `database.py`):** SQLite persistence via SQLAlchemy for interviews, turns, topic performance, and final assessment summaries.

## Setup & Running

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

### Environment Variables

Copy `.env.example` to `.env` and provide your keys:

```env
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash
FRONTEND_URL=http://localhost:3000

# Optional Simli WebRTC Avatar (Default: local avatar)
AVATAR_PROVIDER=local
SIMLI_ENABLED=false
SIMLI_API_KEY=
SIMLI_FACE_ID=
```

### Endpoints

- `GET /health`: Health check.
- `POST /api/interview/start`: Start a new candidate interview.
- `POST /api/interview/{id}/answer`: Submit an answer for real-time scoring.
- `GET /api/interview/{id}/assessment`: Retrieve final comprehensive assessment report.
- `POST /tts/synthesize`: Synthesize speech bundle with MP3 audio and timing metadata.
- `WS /ws/chat`: Real-time audio streaming and speech recognition.
- Interactive API Docs: `http://127.0.0.1:8000/docs`

### Tests

```bash
pytest tests/test_local_tts.py
pytest tests/test_simli_service.py
```


