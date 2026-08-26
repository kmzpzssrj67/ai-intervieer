# Bluye Reuse Notes

Read-only source inspected: `D:\Bluye`

## Reusable Bluye Files Inspected

- `backend/api/fastapi_app.py`: FastAPI app factory, CORS setup, health route, chat route, TTS/STT routes, WebSocket registration.
- `backend/api/websocket.py`: `/ws/chat` lifecycle, JSON message contract, sentence/done/error response pattern, audio message handling.
- `backend/assistant/llm/gemini.py`: Gemini client wrapper, prompt assembly, fallback behavior, threaded blocking SDK call pattern.
- `backend/assistant/config.py`: `.env` loading and Gemini/TTS/STT environment variable conventions.
- `backend/requirements-assistant.txt`: dependency families for FastAPI, Uvicorn, Gemini, STT, TTS, and audio handling.
- `dashboard/package.json`: Next 15, React 19, TypeScript, Tailwind frontend stack.
- `dashboard/services/bluyeApi.ts`: single frontend API service module pattern.
- `dashboard/components/BluyeAvatar.tsx`: video-driven avatar state component.
- `dashboard/components/VoiceController.tsx`: browser mic, VAD, WebSocket, and TTS playback controller.
- `dashboard/app/page.tsx`, `dashboard/app/globals.css`, `dashboard/tailwind.config.ts`: dashboard layout and styling patterns.

## Reused In This Phase

- FastAPI app factory plus module-level `app` for `uvicorn main:app --reload`.
- CORS middleware for local Next.js development.
- Pydantic request/response models around chat.
- Service-layer separation for chat and LLM access.
- Optional Gemini connection with local fallback when `GOOGLE_API_KEY` is missing.
- Basic `/ws/chat` JSON contract inspired by Bluye's `done/error` message shape.
- Next.js App Router, TypeScript, Tailwind, and a single frontend API client module.

## Not Copied Yet

- Bluye's STT, TTS, audio VAD, full WebSocket voice controller, and avatar video engine were not copied because they depend on heavier runtime pieces and media assets that are outside the requested first foundation.
- They have placeholder packages/folders in `backend/assistant/` so the next phase can bring them in deliberately.
