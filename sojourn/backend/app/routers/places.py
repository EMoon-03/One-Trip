"""Location search behind a provider abstraction.

Two interchangeable geocoders, one normalized result shape:

    GEOCODER=auto       google if GOOGLE_MAPS_API_KEY is set, else nominatim
    GEOCODER=google     Google Places Text Search (needs the key)
    GEOCODER=nominatim  OpenStreetMap's free geocoder (no key, be gentle*)

Same idea as a multi-provider LLM client: the rest of the app talks to ONE
interface; swapping vendors is config, not code. The server-side API key
never ships to the browser — the frontend only ever calls /api/places/search.

* Nominatim's usage policy: identify yourself via User-Agent and keep it to
  ~1 req/sec. The frontend debounces typing, which keeps us well under.
"""

import os

import httpx
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ..models import User

router = APIRouter(prefix="/api/places", tags=["places"])

GOOGLE_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "Sojourn/0.2 (personal travel planner; https://github.com/example/sojourn)"


def pick_provider() -> str:
    mode = os.getenv("GEOCODER", "auto").lower()
    if mode in ("google", "nominatim"):
        return mode
    return "google" if os.getenv("GOOGLE_MAPS_API_KEY") else "nominatim"


async def _search_google(q: str) -> list[dict]:
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="GEOCODER=google but GOOGLE_MAPS_API_KEY is not set in backend/.env",
        )
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(GOOGLE_URL, params={"query": q, "key": api_key})
    resp.raise_for_status()
    return [
        {
            "name": p.get("name"),
            "address": p.get("formatted_address"),
            "place_id": p.get("place_id"),
            "lat": p.get("geometry", {}).get("location", {}).get("lat"),
            "lng": p.get("geometry", {}).get("location", {}).get("lng"),
            "provider": "google",
        }
        for p in resp.json().get("results", [])[:8]
    ]


async def _search_nominatim(q: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            NOMINATIM_URL,
            params={"q": q, "format": "jsonv2", "limit": 8},
            headers={"User-Agent": USER_AGENT},  # required by OSM's policy
        )
    resp.raise_for_status()
    results = []
    for p in resp.json():
        display = p.get("display_name", "")
        results.append(
            {
                "name": display.split(",")[0] if display else p.get("name"),
                "address": display,
                "place_id": f"osm:{p.get('osm_type')}/{p.get('osm_id')}",
                "lat": float(p["lat"]),
                "lng": float(p["lon"]),
                "provider": "nominatim",
            }
        )
    return results


@router.get("/search")
async def search_places(q: str, user: User = Depends(get_current_user)):
    """Authenticated: this proxies third-party (potentially paid) APIs."""
    provider = pick_provider()
    try:
        if provider == "google":
            return await _search_google(q)
        return await _search_nominatim(q)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Geocoding service unreachable: {exc}")
