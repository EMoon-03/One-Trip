"""Shared fixtures: an in-memory SQLite database per test, and a client on it.

The `engine` fixture is exposed too, so worker tests can open their own
Session and call delivery.tick() directly — exactly what the worker does.
"""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.database import get_session
from app.main import app

from .helpers import signup


@pytest.fixture(autouse=True)
def _quiet_env(monkeypatch):
    # Tests decide which channels exist; never pick up a developer's .env.
    # Google keys too: a test must never call (and bill) the real Google.
    for name in (
        "SMTP_HOST", "SMTP_FROM", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "EMBEDDED_WORKER",
        "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_BROWSER_KEY", "GEOCODER", "GOOGLE_PLACES_BASE", "GOOGLE_MAPS_BASE",
    ):
        monkeypatch.setenv(name, "")
    monkeypatch.setenv("NOTIFY_CONSOLE", "false")


@pytest.fixture()
def engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across connections
    )
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture()
def client(engine):
    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture()
def auth(client):
    return signup(client)
