"""Google Maps Platform integration, against a mocked Google.

httpx.MockTransport plays Google: each test sees exactly what we sent
(URL, headers, body) and decides what Google answers.
"""

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlmodel import Session, select

from app.geo import google, nominatim
from app.geo.refresh import refresh_google_coords
from app.models import ItineraryItem

from .helpers import make_trip

UTC = timezone.utc


@pytest.fixture()
def keys(monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "server-key")
    monkeypatch.setenv("GOOGLE_MAPS_BROWSER_KEY", "browser-key")
    monkeypatch.setenv("GEOCODER", "auto")


@pytest.fixture()
def fake_google(monkeypatch):
    """Route google.py's HTTP through a handler the test controls."""
    state = {"requests": [], "handler": None}

    def transport(request: httpx.Request):
        state["requests"].append(request)
        return state["handler"](request)

    monkeypatch.setattr(google, "_client", lambda: httpx.Client(transport=httpx.MockTransport(transport)))
    return state


def autocomplete_reply(request):
    return httpx.Response(200, json={"suggestions": [
        {"placePrediction": {
            "placeId": "ChIJ-tokyo",
            "text": {"text": "Tokyo, Japan"},
            "structuredFormat": {"mainText": {"text": "Tokyo"}, "secondaryText": {"text": "Japan"}},
        }},
        {"queryPrediction": {"text": {"text": "tokyo ramen"}}},  # not a place: ignored
    ]})


# ---------------------------------------------------------------- pairing --


def test_auto_uses_google_only_when_both_keys_are_set(client, auth, monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "server-key")
    monkeypatch.setenv("GOOGLE_MAPS_BROWSER_KEY", "")
    assert client.get("/api/config").json()["place_search"] == "nominatim"
    monkeypatch.setenv("GOOGLE_MAPS_BROWSER_KEY", "browser-key")
    assert client.get("/api/config").json()["place_search"] == "google"


def test_forcing_google_without_the_map_key_is_refused(client, auth, monkeypatch):
    monkeypatch.setenv("GEOCODER", "google")
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "server-key")
    monkeypatch.setenv("GOOGLE_MAPS_BROWSER_KEY", "")
    resp = client.get("/api/places/search", params={"q": "tokyo"}, headers=auth)
    assert resp.status_code == 503 and "Google map" in resp.json()["detail"]
    assert client.get("/api/config").json()["place_search"] == "unavailable"


# ----------------------------------------------------------------- search --


def test_google_search_uses_autocomplete_with_the_session_token(client, auth, keys, fake_google):
    fake_google["handler"] = autocomplete_reply
    resp = client.get("/api/places/search", params={"q": "toky", "session": "sess-1"}, headers=auth)
    assert resp.status_code == 200
    assert resp.json() == [{
        "name": "Tokyo", "address": "Japan", "label": "Tokyo, Japan", "place_id": "ChIJ-tokyo",
        "lat": None, "lng": None, "provider": "google",
    }]
    [req] = fake_google["requests"]
    assert req.method == "POST" and req.url.path.endswith("/places:autocomplete")
    assert req.headers["X-Goog-Api-Key"] == "server-key"
    assert "suggestions.placePrediction.placeId" in req.headers["X-Goog-FieldMask"]
    assert json.loads(req.content) == {"input": "toky", "sessionToken": "sess-1"}


def test_details_asks_only_for_essentials_fields(client, auth, keys, fake_google):
    fake_google["handler"] = lambda r: httpx.Response(
        200, json={"location": {"latitude": 35.68, "longitude": 139.76}, "formattedAddress": "Tokyo, Japan"}
    )
    resp = client.get("/api/places/details", params={"place_id": "ChIJ-tokyo", "session": "sess-1"}, headers=auth)
    assert resp.json() == {"place_id": "ChIJ-tokyo", "lat": 35.68, "lng": 139.76, "address": "Tokyo, Japan", "provider": "google"}
    [req] = fake_google["requests"]
    assert req.url.path.endswith("/places/ChIJ-tokyo")
    assert req.headers["X-Goog-FieldMask"] == "location,formattedAddress"  # cheapest tier
    assert req.url.params["sessionToken"] == "sess-1"  # closes the billing session


def test_google_errors_are_loud_not_silent(client, auth, keys, fake_google):
    # The old code turned a refused key into "No matches". Now it says why.
    fake_google["handler"] = lambda r: httpx.Response(
        403, json={"error": {"code": 403, "message": "Places API (New) has not been used in project 123", "status": "PERMISSION_DENIED"}}
    )
    resp = client.get("/api/places/search", params={"q": "tokyo"}, headers=auth)
    assert resp.status_code == 502
    assert "has not been used" in resp.json()["detail"] and "enabled" in resp.json()["detail"]


def test_osm_ids_dont_need_details(client, auth, keys):
    assert client.get("/api/places/details", params={"place_id": "osm:node/1"}, headers=auth).status_code == 400


def test_nominatim_results_carry_coordinates_and_a_short_label(client, auth, monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "")
    reply = [{"display_name": "Shibuya, Tokyo, 150-0002, Japan", "lat": "35.66", "lon": "139.70", "osm_type": "node", "osm_id": 9}]
    monkeypatch.setattr(nominatim, "_client", lambda: httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=reply))))
    [r] = client.get("/api/places/search", params={"q": "shibuya"}, headers=auth).json()
    assert r["label"] == "Shibuya, Japan" and r["lat"] == 35.66 and r["place_id"] == "osm:node/9"


def test_places_routes_need_auth(client):
    for path in ("/api/places/search?q=x", "/api/places/details?place_id=x", "/api/places/timezone?lat=0&lng=0"):
        assert client.get(path).status_code == 401


# -------------------------------------------------------------- time zone --


def test_timezone_from_google(client, auth, keys, fake_google):
    fake_google["handler"] = lambda r: httpx.Response(200, json={"status": "OK", "timeZoneId": "America/New_York"})
    resp = client.get("/api/places/timezone", params={"lat": 40.64, "lng": -73.78}, headers=auth)
    assert resp.json() == {"timezone": "America/New_York", "source": "google"}
    [req] = fake_google["requests"]
    assert req.url.path.endswith("/timezone/json") and req.url.params["location"] == "40.64,-73.78"
    assert req.url.params["key"] == "server-key" and int(req.url.params["timestamp"]) > 0


def test_timezone_falls_back_offline_when_google_refuses(client, auth, keys, fake_google, caplog):
    fake_google["handler"] = lambda r: httpx.Response(200, json={"status": "REQUEST_DENIED", "errorMessage": "API not enabled"})
    resp = client.get("/api/places/timezone", params={"lat": 35.5494, "lng": 139.7798}, headers=auth)
    assert resp.json() == {"timezone": "Asia/Tokyo", "source": "offline"}
    assert "Time Zone API" in caplog.text  # …and the developer is told why


def test_timezone_offline_without_any_key(client, auth, monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "")
    resp = client.get("/api/places/timezone", params={"lat": 40.9415, "lng": -73.9593}, headers=auth)  # Cresskill, NJ
    assert resp.json() == {"timezone": "America/New_York", "source": "offline"}
    assert client.get("/api/places/timezone", params={"lat": 95, "lng": 0}, headers=auth).status_code == 422


# ------------------------------------------------------ coordinate stamping --


def _stop(client, auth, trip_id, **kw):
    body = {"title": "Somewhere", "date": "2026-10-02", **kw}
    resp = client.post(f"/api/trips/{trip_id}/itinerary", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_stops_record_where_their_coordinates_came_from(client, auth):
    trip_id = make_trip(client, auth)
    g = _stop(client, auth, trip_id, place_id="ChIJ-x", lat=1.0, lng=2.0)
    o = _stop(client, auth, trip_id, place_id="osm:node/1", lat=1.0, lng=2.0)
    m = _stop(client, auth, trip_id, lat=1.0, lng=2.0)
    n = _stop(client, auth, trip_id)
    assert (g["coords_source"], o["coords_source"], m["coords_source"], n["coords_source"]) == ("google", "nominatim", "manual", None)
    assert g["coords_fetched_at"] is not None and n["coords_fetched_at"] is None

    # Editing the title keeps the fetch time; moving the coordinates resets it.
    t0 = g["coords_fetched_at"]
    assert client.patch(f"/api/itinerary/{g['id']}", json={"title": "Renamed"}, headers=auth).json()["coords_fetched_at"] == t0
    moved = client.patch(f"/api/itinerary/{g['id']}", json={"lat": 3.0, "lng": 4.0}, headers=auth).json()
    assert moved["coords_fetched_at"] >= t0 and moved["coords_source"] == "google"


# ------------------------------------------------------------ 30-day rule --


def _age(engine, stop_id, days):
    with Session(engine) as s:
        item = s.get(ItineraryItem, stop_id)
        item.coords_fetched_at = datetime.now(UTC) - timedelta(days=days)
        s.add(item)
        s.commit()


def _load(engine, stop_id):
    with Session(engine) as s:
        return s.get(ItineraryItem, stop_id)


def test_google_coordinates_are_refreshed_after_25_days(client, auth, engine, keys, fake_google):
    trip_id = make_trip(client, auth)
    fresh = _stop(client, auth, trip_id, place_id="ChIJ-fresh", lat=1.0, lng=1.0)
    stale = _stop(client, auth, trip_id, place_id="ChIJ-stale", lat=1.0, lng=1.0)
    manual = _stop(client, auth, trip_id, lat=1.0, lng=1.0)
    _age(engine, stale["id"], 26)
    _age(engine, manual["id"], 400)
    fake_google["handler"] = lambda r: httpx.Response(200, json={"location": {"latitude": 9.5, "longitude": 8.5}})

    with Session(engine) as s:
        result = refresh_google_coords(s, datetime.now(UTC))
    assert (result.refreshed, result.deleted) == (1, 0)
    assert [r.url.path.rsplit("/", 1)[-1] for r in fake_google["requests"]] == ["ChIJ-stale"]  # only the stale one
    item = _load(engine, stale["id"])
    assert (item.lat, item.lng) == (9.5, 8.5)
    assert datetime.now(UTC) - item.coords_fetched_at < timedelta(minutes=1)
    assert _load(engine, manual["id"]).lat == 1.0  # hand-entered coordinates never expire


def test_failed_refresh_keeps_coordinates_until_day_30_then_deletes_them(client, auth, engine, keys, fake_google):
    trip_id = make_trip(client, auth)
    day27 = _stop(client, auth, trip_id, place_id="ChIJ-27", lat=1.0, lng=1.0)
    day31 = _stop(client, auth, trip_id, place_id="ChIJ-31", lat=1.0, lng=1.0)
    _age(engine, day27["id"], 27)
    _age(engine, day31["id"], 31)
    fake_google["handler"] = lambda r: httpx.Response(503, json={"error": {"message": "backend error"}})

    with Session(engine) as s:
        result = refresh_google_coords(s, datetime.now(UTC))
    assert result.deleted == 1 and result.failed == 2
    assert _load(engine, day27["id"]).lat == 1.0           # still inside the 30 days: try again later
    gone = _load(engine, day31["id"])
    assert gone.lat is None and gone.place_id == "ChIJ-31"  # place_id may be kept, so it can come back

    # Next run, Google is healthy again: the deleted coordinates are restored.
    fake_google["handler"] = lambda r: httpx.Response(200, json={"location": {"latitude": 5.0, "longitude": 6.0}})
    with Session(engine) as s:
        refresh_google_coords(s, datetime.now(UTC))
    assert (_load(engine, day31["id"]).lat, _load(engine, day27["id"]).lat) == (5.0, 5.0)


def test_without_a_key_expired_google_coordinates_are_deleted(client, auth, engine, monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "")
    trip_id = make_trip(client, auth)
    stop = _stop(client, auth, trip_id, place_id="ChIJ-old", lat=1.0, lng=1.0)
    _age(engine, stop["id"], 30)
    with Session(engine) as s:
        assert refresh_google_coords(s, datetime.now(UTC)).deleted == 1
    assert _load(engine, stop["id"]).lat is None


def test_a_place_google_deleted_loses_its_coordinates_immediately(client, auth, engine, keys, fake_google):
    trip_id = make_trip(client, auth)
    stop = _stop(client, auth, trip_id, place_id="ChIJ-closed", lat=1.0, lng=1.0)
    _age(engine, stop["id"], 26)
    fake_google["handler"] = lambda r: httpx.Response(404, json={"error": {"message": "not found"}})
    with Session(engine) as s:
        assert refresh_google_coords(s, datetime.now(UTC)).deleted == 1


def test_worker_runs_the_coordinate_refresh_on_its_first_pass(monkeypatch):
    import app.worker as worker

    calls = []
    monkeypatch.setattr(worker, "_last_place_refresh", None)
    monkeypatch.setattr(worker, "refresh_google_coords", lambda session, now: calls.append(now) or None)
    monkeypatch.setattr(worker.time, "monotonic", lambda: 120.0)  # machine booted 2 minutes ago
    worker.refresh_places_if_due()
    worker.refresh_places_if_due()  # …and not again within the hour
    assert len(calls) == 1
