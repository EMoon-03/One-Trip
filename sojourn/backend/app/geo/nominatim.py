"""OpenStreetMap's free geocoder. Usage policy: identify yourself with a
User-Agent and stay around 1 request/second — the frontend's debounce keeps
typing well under that."""

import httpx

from . import GeoError

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "OneTrip/0.3 (personal travel planner; https://github.com/EMoon-03/One-Trip)"


def _client() -> httpx.Client:
    return httpx.Client(timeout=10)


def search(query: str) -> list[dict]:
    try:
        with _client() as client:
            resp = client.get(
                NOMINATIM_URL,
                params={"q": query, "format": "jsonv2", "limit": 8},
                headers={"User-Agent": USER_AGENT},
            )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise GeoError(f"Place search unreachable: {exc}")
    results = []
    for p in resp.json():
        display = p.get("display_name", "")
        parts = [s.strip() for s in display.split(",") if s.strip()]
        name = parts[0] if parts else p.get("name", "")
        # "Tokyo, Japan" rather than the full "Tokyo, …, 100-0001, Japan"
        label = name if len(parts) < 2 else f"{name}, {parts[-1]}"
        results.append(
            {
                "name": name,
                "address": display,
                "label": label,
                "place_id": f"osm:{p.get('osm_type')}/{p.get('osm_id')}",
                "lat": float(p["lat"]),
                "lng": float(p["lon"]),
                "provider": "nominatim",
            }
        )
    return results
