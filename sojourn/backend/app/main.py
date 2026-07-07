"""Sojourn API — plan the days, mind the budget, never miss a departure."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .routers import auth, expenses, itinerary, places, reminders, trips


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # create tables on startup (v1; replace with Alembic later)
    yield


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
    """
    return {"google_maps_browser_key": os.getenv("GOOGLE_MAPS_BROWSER_KEY")}
