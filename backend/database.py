from __future__ import annotations

import os

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker


load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not configured. Set it in backend/.env before starting the backend.")
if not DATABASE_URL.startswith("postgresql+psycopg://"):
    raise RuntimeError("DATABASE_URL must use postgresql+psycopg:// for PostgreSQL.")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def create_tables() -> None:
    import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    ensure_schema()


def ensure_schema() -> None:
    statements = [
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS topic VARCHAR(100) DEFAULT ''",
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS subtopic VARCHAR(150) DEFAULT ''",
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS answered_question BOOLEAN",
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS answer_relevance VARCHAR(20) DEFAULT ''",
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS missing_concepts TEXT DEFAULT '[]'",
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS next_focus TEXT DEFAULT ''",
        "ALTER TABLE interview_turns ADD COLUMN IF NOT EXISTS question_type VARCHAR(50) DEFAULT 'conceptual'",
        "ALTER TABLE interview_assessments ADD COLUMN IF NOT EXISTS technical_level VARCHAR(50) DEFAULT ''",
        "ALTER TABLE interview_assessments ADD COLUMN IF NOT EXISTS strongest_topics TEXT DEFAULT '[]'",
        "ALTER TABLE interview_assessments ADD COLUMN IF NOT EXISTS weakest_topics TEXT DEFAULT '[]'",
        "ALTER TABLE interview_assessments ADD COLUMN IF NOT EXISTS key_strengths TEXT DEFAULT '[]'",
        "ALTER TABLE interview_assessments ADD COLUMN IF NOT EXISTS key_weaknesses TEXT DEFAULT '[]'",
        "ALTER TABLE interview_assessments ADD COLUMN IF NOT EXISTS improvement_plan TEXT DEFAULT '[]'",
    ]
    with engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
