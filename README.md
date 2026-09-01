# AI Technical Interviewer

AI Technical Interviewer is a local full-stack prototype for running a hands-free, adaptive Python technical interview. The app asks a question, listens to the candidate through the voice pipeline, submits the final transcript to FastAPI, evaluates the answer with Gemini, and advances through a five-question interview until a final assessment is produced.

## What Is Included

- `backend/` - FastAPI interview backend, database models, schemas, and service logic.
- `frontend/` - Next.js interview UI, avatar video state renderer, API clients, and voice adapter.
- `docs/` - Architecture and implementation notes.
- `frontend/public/` - Avatar videos used by the UI.
- `.env.example` - Safe environment variable template with no secrets.

Local runtime files are intentionally ignored: `.env`, virtualenvs, logs, SQLite databases, `node_modules`, and `.next` build output.

## End-To-End Flow

1. User opens the Next.js frontend at `http://localhost:3000`.
2. User enters a candidate name and launches the interview.
3. Frontend calls `POST /api/interview/start` on the interviewer backend.
4. Backend creates an interview record and returns question 1.
5. Frontend requests TTS from the same FastAPI backend at `POST http://127.0.0.1:8000/tts` and plays the question audio.
6. Avatar switches to `speaking` when audio playback actually starts.
7. When audio ends, avatar switches to `listening`.
8. `InterviewVoiceController` captures mic audio using the VAD lifecycle.
9. VAD detects speech start, tracks audio frames, freezes the silence window when speech stops, and sends final PCM audio to `/ws/chat`.
10. The same backend transcribes the audio and returns a final `transcript` websocket message.
11. Frontend locks the transcript so the answer can only submit once.
12. Frontend calls `POST /api/interview/{interview_id}/answer`.
13. Backend evaluates the answer, records the turn, and either returns `next_question` or marks the assessment available.
14. If `next_question` exists, frontend updates the question, speaks it through TTS, then resumes listening.
15. On the final question, frontend fetches `GET /api/interview/{interview_id}/assessment` and displays the report.

## Services And Ports

| Service | Default URL | Purpose |
| --- | --- | --- |
| Interviewer backend | `http://127.0.0.1:8000` | Interview state, question generation, answer evaluation, assessment, TTS, and STT websocket flow |
| Interviewer frontend | `http://localhost:3000` | Candidate UI, avatar, TTS playback, interview orchestration |

## Backend Architecture

The backend is a FastAPI app exposed from `backend/main.py` and `backend/api/routes.py`.

Important endpoints:

- `GET /health` - health check.
- `POST /api/chat` - basic chat foundation endpoint.
- `POST /api/interview/start` - starts a new interview.
- `POST /api/interview/{interview_id}/answer` - evaluates the current answer and advances the interview.
- `GET /api/interview/{interview_id}` - returns current interview state.
- `GET /api/interview/{interview_id}/assessment` - returns final assessment.
- `WS /ws/chat` - foundation websocket chat route.

Important backend files:

- `backend/models.py` - SQLAlchemy models for interviews, turns, assessments, and topic performance.
- `backend/schemas.py` - Pydantic request/response schemas.
- `backend/database.py` - database setup and compatibility migrations.
- `backend/services/interview_service.py` - adaptive interview flow, scoring, next-question selection, and assessment generation.
- `backend/assistant/llm/gemini.py` - Gemini wrapper with fallback behavior.
- `backend/assistant/config.py` - environment loading for Gemini and frontend origin.

## Frontend Architecture

The frontend is a Next.js App Router app under `frontend/`.

Important frontend files:

- `frontend/app/page.tsx` - interview state machine and UI orchestration.
- `frontend/components/InterviewVoiceController.tsx` - mic/VAD/STT adapter.
- `frontend/components/Avatar.tsx` - state-based avatar video renderer.
- `frontend/services/interviewApi.ts` - API client for interview backend endpoints.
- `frontend/public/*.mp4` - avatar state videos.

## Voice Integration

The interviewer does not use browser `SpeechRecognition`. It uses a dedicated voice pipeline:

- Browser mic is opened with `navigator.mediaDevices.getUserMedia`.
- Audio is processed through `AudioContext` and `ScriptProcessorNode`.
- RMS thresholds detect speech start and silence.
- Speech frames are buffered until VAD endpointing says the user stopped speaking.
- Final PCM is sent to `/ws/chat` as `audio_pcm16`.
- The voice service returns a final `transcript` message.
- The interviewer submits that transcript once to its own FastAPI answer endpoint.

This avoids duplicate speech recognition systems and keeps the voice service as the source of truth for the voice lifecycle.

## Avatar Videos

The avatar uses state-based looping videos from `frontend/public/`:

| State | File | URL path |
| --- | --- | --- |
| `idle` | `idle.mp4` | `/idle.mp4` |
| `speaking` | `speaking.mp4` | `/speaking.mp4` |
| `listening` | `listening.mp4` | `/listening.mp4` |
| `thinking` | `thinking.mp4` | `/thinking.mp4` |

The video renderer preloads all clips, keeps the idle layer available to avoid black flashes, and switches state by opacity. The speaking video loops only the tuned `0:01` to `0:03` segment at a slower playback rate for better lip-sync.

## Environment Variables

Create local env files from `.env.example`. Do not commit real `.env` files.

Backend variables:

```env
GEMINI_API_KEY=
GOOGLE_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
FRONTEND_URL=http://localhost:3000
```

Frontend variables:

```env
NEXT_PUBLIC_INTERVIEW_API_BASE=http://127.0.0.1:8000
NEXT_PUBLIC_VOICE_API=http://127.0.0.1:8000
```

Security note: real Gemini/GCP keys must stay only in local `.env` files or deployment secret stores. This public repo should contain no secrets.

## Running Locally

### 1. Start Interviewer Backend

```powershell
cd D:\ai_intervewer\ai-technical-interviewer\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Swagger docs:

```text
http://127.0.0.1:8000/docs
```

### 2. Start Frontend

```powershell
cd D:\ai_intervewer\ai-technical-interviewer\frontend
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Development Checks

Frontend build:

```powershell
cd frontend
npm run build
```

Backend smoke check:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

## Public Repo Safety Checklist

Before pushing:

- Confirm `backend/.env` is not tracked.
- Confirm `backend/interviewer.db` is not tracked.
- Confirm `frontend/node_modules` and `frontend/.next` are not tracked.
- Confirm logs are not tracked.
- Confirm `.env.example` contains empty placeholders only.

Useful command:

```powershell
git ls-files | Select-String -Pattern '\.env$|\.db$|\.log$|node_modules|\.next'
```
