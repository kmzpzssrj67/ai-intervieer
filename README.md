# AI Technical Interviewer

Local backend and frontend for an adaptive Python technical interviewer.

This project is independent from `D:\Bluye`. Bluye was inspected for architecture and reusable patterns, but this folder owns its own backend, frontend, dependencies, and SQLite database.

## Backend

```powershell
cd D:\ai_intervewer\ai-technical-interviewer\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

If port `8000` is occupied, stop the old process. Do not switch to a different backend port.

Swagger: http://127.0.0.1:8000/docs

## Frontend

```powershell
cd D:\ai_intervewer\ai-technical-interviewer\frontend
npm install
npm run dev
```

Frontend: http://localhost:3000

## Current API

- `GET /health`
- `POST /api/chat`
- `POST /api/interview/start`
- `POST /api/interview/{interview_id}/answer`
- `GET /api/interview/{interview_id}`
- `GET /api/interview/{interview_id}/assessment`
- `WS /ws/chat`

## Database

SQLite is created at `backend/interviewer.db` when the backend starts.

