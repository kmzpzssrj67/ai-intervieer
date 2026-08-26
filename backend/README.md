# Backend

Local FastAPI backend for AI Technical Interviewer.

```powershell
cd D:\ai_intervewer\ai-technical-interviewer\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Swagger: http://127.0.0.1:8000/docs

If port `8000` is occupied, stop the old process. Do not switch to another backend port.

