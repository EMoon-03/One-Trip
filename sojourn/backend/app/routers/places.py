"""Place search, place details and time-zone lookup.

    GET /api/places/search?q=…&session=…     typeahead results
    GET /api/places/details?place_id=…&session=…   coordinates for a picked Google result
    GET /api/places/timezone?lat=…&lng=…     IANA zone for a point

Google results come from Autocomplete (New) WITHOUT coordinates; the client
calls /details once, when the person picks one, with the same session token.
That's Google's session pricing: many keystrokes, one billed lookup.
Nominatim results already carry coordinates, so /details isn't needed.

The server-side key never reaches the browser: the frontend only ever
talks to these endpoints. All three are authenticated, because they proxy
paid (Google) or rate-limited (OSM) services.

Plain `def` endpoints on purpose: the geo clients are synchronous (the
worker uses them too), and FastAPI runs `def` endpoints in a thread pool.
"""

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import get_current_user
from ..geo import GeoError, google, nominatim
from ..geo.providers import search_provider
from ..geo.timezones import zone_for
from ..models import User

router = APIRouter(prefix="/api/places", tags=["places"])


def _raise(exc: GeoError):
    raise HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/search")
def search_places(
    q: str = Query(..., min_length=1, max_length=200),
    session: str | None = Query(None, max_length=100, description="Autocomplete session token (Google)"),
    user: User = Depends(get_current_user),
):
    try:
        if search_provider() == "google":
            return google.autocomplete(q, session)
        return nominatim.search(q)
    except GeoError as exc:
        _raise(exc)


@router.get("/details")
def place_details(
    place_id: str = Query(..., min_length=1, max_length=300),
    session: str | None = Query(None, max_length=100),
    user: User = Depends(get_current_user),
):
    if place_id.startswith("osm:"):
        raise HTTPException(status_code=400, detail="OpenStreetMap results already include coordinates")
    try:
        search_provider()  # enforces the Google key-pairing rule
        return google.details(place_id, session)
    except GeoError as exc:
        _raise(exc)


@router.get("/timezone")
def place_timezone(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    user: User = Depends(get_current_user),
):
    try:
        zone_name, source = zone_for(lat, lng)
    except GeoError as exc:
        _raise(exc)
    return {"timezone": zone_name, "source": source}
