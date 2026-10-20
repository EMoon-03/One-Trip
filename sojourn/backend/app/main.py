"""Sojourn API — plan the days, mind the budget, never miss a departure."""

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .geo import GeoError
from .geo.providers import browser_key, search_provider
from .notify.settings import get_settings
from .routers import auth, expenses, itinerary, notifications, places, reminders, trips


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # create tables on startup (v1; replace with Alembic later)

    # Dev convenience: EMBEDDED_WORKER=true runs the reminder worker on a
    # thread inside the API, so `uvicorn` alone delivers reminders. In
    # production run `python -m app.worker` as its own process instead.
    stop = threading.Event()
    worker = None
    if get_settings().embedded_worker:
        from .worker import run_forever

        logging.getLogger("onetrip").setLevel(logging.INFO)
        worker = threading.Thread(target=run_forever, args=(stop,), name="reminder-worker", daemon=True)
        worker.start()
    yield
    stop.set()
    if worker:
        worker.join(timeout=5)


app = FastAPI(
    title="Sojourn API",
    version="0.1.0",
    description="Travel itinerary + finance planner + reminders.",
    lifespan=lifespan,
)

# The Vite dev server runs on another port, so the browser needs CORS headers.
# (In dev the Vite proxy usually hides this; the headers make direct calls and
# tools like the /docs page work regardless.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(trips.router)
app.include_router(itinerary.router)
app.include_router(expenses.router)
app.include_router(reminders.router)
app.include_router(places.router)
app.include_router(notifications.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok"}


@app.get("/api/config", tags=["meta"])
def config():
    """Public runtime config for the frontend.

    Exposing the BROWSER key here is intentional — browser keys are public by
    nature and must be locked down by HTTP-referrer in Google Cloud. The
    server-side GOOGLE_MAPS_API_KEY is never exposed. No key -> the frontend
    falls back to Leaflet + OpenStreetMap.

    place_search tells the frontend which search it's talking to ("google"
    results need a /details call when picked). A misconfiguration (e.g.
    GEOCODER=google with a key missing) reports "unavailable" here instead
    of failing the whole config request.
    """
    try:
        place_search = search_provider()
    except GeoError:
        place_search = "unavailable"
    return {
        "google_maps_browser_key": browser_key(),
        "place_search": place_search,
    }
