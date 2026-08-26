from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
WORKSPACE_DIR = PROJECT_DIR.parent

# Load local env files without printing or exposing secret values.
# Existing process env values still win.
for env_path in (
    PROJECT_DIR / ".env",
    BACKEND_DIR / ".env",
    WORKSPACE_DIR / "ai-technical-interviewer.env",
):
    if env_path.exists():
        load_dotenv(env_path, override=False)

# Compatibility for the current prototype only: use .env.example if no real env
# file has supplied a Gemini key yet.
if not (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")):
    example_path = PROJECT_DIR / ".env.example"
    if example_path.exists():
        load_dotenv(example_path, override=False)


def get_env(key: str, default: str = "") -> str:
    value = os.getenv(key, default)
    return value.strip() if value else default


GEMINI_API_KEY = get_env("GEMINI_API_KEY") or get_env("GOOGLE_API_KEY")
if GEMINI_API_KEY:
    os.environ["GEMINI_API_KEY"] = GEMINI_API_KEY
    os.environ.pop("GOOGLE_API_KEY", None)

GEMINI_MODEL = get_env("GEMINI_MODEL", "gemini-3.5-flash")
FRONTEND_URL = get_env("FRONTEND_URL", "http://localhost:3000")
