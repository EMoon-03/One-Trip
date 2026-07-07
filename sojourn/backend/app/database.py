"""Database engine + session plumbing.

The whole SQLite-vs-MySQL decision lives in ONE place: DATABASE_URL.
  sqlite:///./sojourn.db                                  -> zero-config dev
  mysql+pymysql://sojourn:sojourn@localhost:3306/sojourn  -> docker compose up -d

Models, queries, and routers are identical either way — that swappability
is what the ORM buys us.
"""

import os

from dotenv import load_dotenv
from sqlmodel import Session, SQLModel, create_engine

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./sojourn.db")

# SQLite needs this flag because FastAPI may touch the connection from
# different threads; other engines ignore connect_args entirely.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, echo=False, connect_args=connect_args)


def init_db() -> None:
    """Create all tables. Fine for v1; swap for Alembic migrations later."""
    SQLModel.metadata.create_all(engine)


def get_session():
    """FastAPI dependency: one session per request."""
    with Session(engine) as session:
        yield session
