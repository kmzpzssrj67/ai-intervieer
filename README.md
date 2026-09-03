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

## Avatar Systems

The application supports two avatar modes configured via `AVATAR_PROVIDER` in `backend/.env` (default: `local`):

### 1. High-Precision Local 2D Canvas Avatar (Default)

The local talking avatar renders client-side using an offscreen double-buffered HTML5 Canvas compositor driven by the hardware `AudioContext.currentTime` clock:

- **13 Calibrated Viseme Mouth Shapes:** `mbp`, `aa`, `ae`, `ee`, `oh`, `oo`, `fv`, `sh`, `ldt`, `kg`, `sz`, `th`, `r` + `idle` and `thinking` states.
- **Hardware Clock Synchronization:** Monotonic audio clock guarantees zero cumulative drift across lengthy technical answers.
- **Feathered Spatial Mouth Mask:** 11-point calibrated polygon with 22px Gaussian feathering isolating the mouth while filtering out 83% of generative background variance with zero facial seams.
- **Dynamic Anti-Flicker Scheduler:** Tempo-tracking visual dwell governor enforcing an adaptive ceiling ($\le 8.5\text{ changes/s}$) to prevent 60/120 Hz display strobe chatter.
- **Ballistic Asymmetric Bilabial Release:** Lips remain sealed through the onset of /p/, /b/, /m/ plosives before bursting open rapidly, preventing translucent teeth artifacts during crossfades.
- **Accelerated Silence Closure:** Post-utterance dwell drops to $\le 35\text{ ms}$ upon RMS silence confirmation, closing the mouth cleanly without lingering open.
- **Speech Text & Number Normalizer:** Expands numbers, currency, decimals, percentages, and technical acronyms (e.g. `SQL`, `PostgreSQL`, `JWT`, `API`, `LLM`) into canonical spoken words before TTS synthesis and pronunciation mapping.
- **Acoustic Phoneme Boundary Interface:** Built-in support for millisecond-precision phoneme boundaries from backend forced alignment, with seamless automatic fallback to the syllable-aware heuristic engine.
- **Debug HUD:** Append `?debugSync=1` to the frontend URL to display real-time FPS, clock time, active visemes, transitions, and audio RMS meters.

### 2. Optional Simli LiveRTC Avatar

Set `AVATAR_PROVIDER=simli` and provide your `SIMLI_API_KEY` and `SIMLI_FACE_ID` to stream a photo-realistic cloud WebRTC avatar.

## Environment Variables

Create local env files from `.env.example`. Do not commit real `.env` files.

### Backend (`backend/.env`):

```env
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash
FRONTEND_URL=http://localhost:3000

# Avatar Provider: 'local' (default) or 'simli'
AVATAR_PROVIDER=local
SIMLI_ENABLED=false
SIMLI_API_KEY=
SIMLI_FACE_ID=
```

### Frontend (`frontend/.env.local`):

```env
NEXT_PUBLIC_INTERVIEW_API_BASE=http://127.0.0.1:8000
NEXT_PUBLIC_VOICE_API=http://127.0.0.1:8000
```

## Running Locally

### 1. Start Interviewer Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Verify:
```bash
curl http://127.0.0.1:8000/health
```

Interactive Swagger API docs: `http://127.0.0.1:8000/docs`

### 2. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Open in browser: `http://localhost:3000`

## Automated Test Verification

### Frontend Unit & Lip-Sync Tests

```bash
cd frontend
npm run test:local-avatar
```
Runs the full 82-test suite covering the visual pose scheduler, transition easing, mask geometry, text normalizers, and timeline stabilization.

### Backend Tests

```bash
cd backend
pytest tests/test_local_tts.py
pytest tests/test_simli_service.py
```

### Production Build Check

```bash
cd frontend
npx tsc --noEmit
npm run build
```

## Public Repo Safety Checklist

Before pushing to git:

- Confirm `backend/.env` is not tracked.
- Confirm `frontend/.env.local` is not tracked.
- Confirm `backend/interviewer.db` is not tracked.
- Confirm `node_modules` and `.next` build caches are not tracked.
- Confirm `.env.example` contains placeholders only.

