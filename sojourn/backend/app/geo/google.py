"""Google Maps Platform calls, kept small and explicit.

Search uses Autocomplete (New) with a SESSION TOKEN: every keystroke request
in a session, plus the one Place Details call when the person picks a
result, share a token. Google bills that whole session as the Place Details
call (and currently doesn't charge the session itself), instead of billing
every keystroke. A session with no pick bills each request as a plain
Autocomplete request.

Field masks decide the price tier. Details asks only for
`location,formattedAddress` — both in the cheapest (Essentials) tier.
"""

import os
from datetime import datetime, timezone

import httpx

from . import GeoError
from .providers import server_key

# Overridable for tests and local fakes; production uses Google's hosts.
# (`or`, not a getenv default: an empty GOOGLE_PLACES_BASE= line must mean "default".)
PLACES_BASE = lambda: (os.getenv("GOOGLE_PLACES_BASE") or "https://places.googleapis.com/v1").rstrip("/")
MAPS_BASE = lambda: (os.getenv("GOOGLE_MAPS_BASE") or "https://maps.googleapis.com/maps/api").rstrip("/")

DETAILS_FIELDS = "location,formattedAddress"  # Place Details Essentials
AUTOCOMPLETE_FIELDS = (
    "suggestions.placePrediction.placeId,"
    "suggestions.placePrediction.text.text,"
    "suggestions.placePrediction.structuredFormat"
)


def _client() -> httpx.Client:
    """One place to build the HTTP client — tests swap in httpx.MockTransport."""
    return httpx.Client(timeout=10)


def _key() -> str:
    key = server_key()
    if not key:
        raise GeoError("GOOGLE_MAPS_API_KEY is not set in backend/.env", 503)
    return key


def _google_error(resp: httpx.Response) -> GeoError:
    """Turn Google's error body into a message a developer can act on."""
    try:
        err = resp.json().get("error", {})
        message = err.get("message") or resp.text[:200]
    except ValueError:
        message = resp.text[:200]
    # 403 here almost always means: API not enabled, or the key is restricted.
    hint = " (is Places API (New) enabled for this key?)" if resp.status_code == 403 else ""
    return GeoError(f"Google Places {resp.status_code}: {message}{hint}", 502)


def autocomplete(query: str, session: str | None) -> list[dict]:
    body: dict = {"input": query}
    if session:
        body["sessionToken"] = session
    try:
        with _client() as client:
            resp = client.post(
                f"{PLACES_BASE()}/places:autocomplete",
                json=body,
                headers={"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": AUTOCOMPLETE_FIELDS},
            )
    except httpx.HTTPError as exc:
        raise GeoError(f"Google Places unreachable: {exc}")
    if resp.status_code != 200:
        raise _google_error(resp)

    results = []
    for suggestion in resp.json().get("suggestions", []):
        p = suggestion.get("placePrediction")
        if not p:
            continue  # query predictions aren't places
        fmt = p.get("structuredFormat", {})
        name = fmt.get("mainText", {}).get("text") or p.get("text", {}).get("text", "")
        secondary = fmt.get("secondaryText", {}).get("text")
        results.append(
            {
                "name": name,
                "address": secondary,
                "label": p.get("text", {}).get("text") or name,  # "Tokyo, Japan"
                "place_id": p["placeId"],
                "lat": None,  # arrives with details(), when the person picks it
                "lng": None,
                "provider": "google",
            }
        )
    return results[:8]


def details(place_id: str, session: str | None = None) -> dict:
    params = {"sessionToken": session} if session else None
    try:
        with _client() as client:
            resp = client.get(
                f"{PLACES_BASE()}/places/{place_id}",
                params=params,
                headers={"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": DETAILS_FIELDS},
            )
    except httpx.HTTPError as exc:
        raise GeoError(f"Google Places unreachable: {exc}")
    if resp.status_code == 404:
        raise GeoError("Google no longer knows this place", 404)
    if resp.status_code != 200:
        raise _google_error(resp)
    data = resp.json()
    loc = data.get("location") or {}
    if "latitude" not in loc:
        raise GeoError("Google returned no location for this place", 502)
    return {
        "place_id": place_id,
        "lat": loc["latitude"],
        "lng": loc["longitude"],
        "address": data.get("formattedAddress"),
        "provider": "google",
    }


def timezone_at(lat: float, lng: float) -> str:
    """Time Zone API -> IANA id like 'Asia/Tokyo'."""
    params = {
        "location": f"{lat},{lng}",
        "timestamp": int(datetime.now(timezone.utc).timestamp()),
        "key": _key(),
    }
    try:
        with _client() as client:
            resp = client.get(f"{MAPS_BASE()}/timezone/json", params=params)
    except httpx.HTTPError as exc:
        raise GeoError(f"Google Time Zone API unreachable: {exc}")
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    status = data.get("status")
    if status == "OK" and data.get("timeZoneId"):
        return data["timeZoneId"]
    if status == "ZERO_RESULTS":
        raise GeoError("No time zone found for that spot (is it over water?)", 404)
    message = data.get("errorMessage") or status or f"HTTP {resp.status_code}"
    hint = " (is the Time Zone API enabled for this key?)" if status == "REQUEST_DENIED" else ""
    raise GeoError(f"Google Time Zone API: {message}{hint}", 502)
