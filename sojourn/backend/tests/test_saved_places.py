"""Saved places & collections: CRUD, filters, isolation, and the trip links."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlmodel import Session

from app.geo import google
from app.geo.refresh import refresh_google_coords
from app.models import ItineraryItem, SavedPlace
from app.routers.saved_places import km_between

from .helpers import make_trip, signup

ICHIRAN = {"name": "Ichiran Shibuya", "category": "food", "lat": 35.6612, "lng": 139.7010, "address": "Shibuya, Tokyo"}
TEAMLAB = {"name": "teamLab Planets", "category": "activity", "lat": 35.6491, "lng": 139.7898}
KYOTO = {"name": "Fushimi Inari", "category": "activity", "lat": 34.9671, "lng": 135.7727}


def save(client, auth, **body) -> dict:
    resp = client.post("/api/saved-places", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def collection(client, auth, name) -> dict:
    resp = client.post("/api/collections", json={"name": name}, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def tokyo_trip(client, auth) -> int:
    return make_trip(client, auth, name="Tokyo", timezone="Asia/Tokyo", start_date="2026-10-01", end_date="2026-10-07")


# ---------------------------------------------------------------------------
# saving and editing
# ---------------------------------------------------------------------------


def test_save_a_place_with_tags_rating_and_notes(client, auth):
    place = save(client, auth, **ICHIRAN, tags=["Ramen", " late  night ", "ramen", ""], rating=5, notes="Get the extra-firm noodles")
    assert place["tags"] == ["ramen", "late night"]  # trimmed, lowercased, deduped
    assert place["status"] == "want"
    assert place["rating"] == 5
    assert place["coords_source"] == "manual"
    assert place["collection_ids"] == [] and place["in_trips"] == []


@pytest.mark.parametrize(
    "bad",
    [
        {"name": ""},
        {"name": "x", "rating": 6},
        {"name": "x", "rating": 0},
        {"name": "x", "lat": 91, "lng": 0},
        {"name": "x", "status": "maybe"},
        {"name": "x", "tags": [f"t{i}" for i in range(13)]},
    ],
)
def test_validation(client, auth, bad):
    assert client.post("/api/saved-places", json=bad, headers=auth).status_code == 422


def test_saving_the_same_place_twice_is_a_conflict(client, auth):
    save(client, auth, name="Ichiran", place_id="ChIJ-ichiran")
    resp = client.post("/api/saved-places", json={"name": "Ichiran again", "place_id": "ChIJ-ichiran"}, headers=auth)
    assert resp.status_code == 409
    assert "Ichiran" in resp.json()["detail"]
    # ...but two hand-made places without a place_id are fine.
    save(client, auth, name="Corner café")
    save(client, auth, name="Corner café")


def test_edit_status_rating_tags_and_clear_rating(client, auth):
    place = save(client, auth, **ICHIRAN, tags=["ramen"], rating=3)
    resp = client.patch(
        f"/api/saved-places/{place['id']}",
        json={"status": "visited", "rating": 5, "tags": ["Ramen", "Tokyo"]},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["status"], body["rating"], body["tags"]) == ("visited", 5, ["ramen", "tokyo"])
    assert body["updated_at"] >= place["updated_at"]

    body = client.patch(f"/api/saved-places/{place['id']}", json={"rating": None}, headers=auth).json()
    assert body["rating"] is None and body["tags"] == ["ramen", "tokyo"]  # untouched fields stay

    # null for a required field leaves it alone instead of failing
    resp = client.patch(f"/api/saved-places/{place['id']}", json={"name": None, "status": None, "tags": None}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert (resp.json()["name"], resp.json()["status"], resp.json()["tags"]) == ("Ichiran Shibuya", "visited", ["ramen", "tokyo"])
    resp = client.patch(f"/api/saved-places/{place['id']}", json={"tags": []}, headers=auth)
    assert resp.json()["tags"] == []


def test_list_filters_by_status_tag_collection_and_text(client, auth):
    eats = collection(client, auth, "Tokyo eats")
    a = save(client, auth, **ICHIRAN, tags=["ramen"], collection_ids=[eats["id"]])
    b = save(client, auth, **TEAMLAB, tags=["museum", "rainy day"], notes="Book ahead")
    c = save(client, auth, **KYOTO, status="visited", tags=["shrine"])

    def ids(**params):
        resp = client.get("/api/saved-places", params=params, headers=auth)
        assert resp.status_code == 200, resp.text
        return {p["id"] for p in resp.json()}

    assert ids() == {a["id"], b["id"], c["id"]}
    assert ids(status="want") == {a["id"], b["id"]}
    assert ids(status="visited") == {c["id"]}
    assert ids(tag="Rainy  Day") == {b["id"]}
    assert ids(collection_id=eats["id"]) == {a["id"]}
    assert ids(q="SHIBUYA") == {a["id"]}      # address
    assert ids(q="book ahead") == {b["id"]}   # notes
    assert ids(q="inari") == {c["id"]}        # name

    tags = client.get("/api/saved-places/tags", headers=auth).json()
    assert {t["tag"]: t["count"] for t in tags} == {"ramen": 1, "museum": 1, "rainy day": 1, "shrine": 1}


# ---------------------------------------------------------------------------
# collections
# ---------------------------------------------------------------------------


def test_collections_count_places_and_a_place_can_be_in_several(client, auth):
    eats = collection(client, auth, "Tokyo eats")
    rainy = collection(client, auth, "Rainy day")
    place = save(client, auth, **ICHIRAN, collection_ids=[eats["id"], rainy["id"], eats["id"]])
    assert place["collection_ids"] == sorted([eats["id"], rainy["id"]])

    counts = {c["name"]: c["place_count"] for c in client.get("/api/collections", headers=auth).json()}
    assert counts == {"Rainy day": 1, "Tokyo eats": 1}

    # Moving it out of one collection
    body = client.patch(f"/api/saved-places/{place['id']}", json={"collection_ids": [rainy["id"]]}, headers=auth).json()
    assert body["collection_ids"] == [rainy["id"]]
    counts = {c["name"]: c["place_count"] for c in client.get("/api/collections", headers=auth).json()}
    assert counts == {"Rainy day": 1, "Tokyo eats": 0}


def test_collection_names_are_unique_per_user_ignoring_case(client, auth):
    collection(client, auth, "Tokyo eats")
    assert client.post("/api/collections", json={"name": "tokyo EATS"}, headers=auth).status_code == 409
    assert client.post("/api/collections", json={"name": "   "}, headers=auth).status_code == 422
    other = signup(client, email="sam@example.com", name="Sam")
    assert client.post("/api/collections", json={"name": "Tokyo eats"}, headers=other).status_code == 201

    rainy = collection(client, auth, "Rainy")
    resp = client.patch(f"/api/collections/{rainy['id']}", json={"name": "Tokyo Eats"}, headers=auth)
    assert resp.status_code == 409
    resp = client.patch(f"/api/collections/{rainy['id']}", json={"name": " Rainy day ", "description": "Indoors"}, headers=auth)
    assert resp.json()["name"] == "Rainy day" and resp.json()["description"] == "Indoors"


def test_deleting_a_collection_keeps_its_places(client, auth):
    eats = collection(client, auth, "Tokyo eats")
    place = save(client, auth, **ICHIRAN, collection_ids=[eats["id"]])
    assert client.delete(f"/api/collections/{eats['id']}", headers=auth).status_code == 204
    body = client.get(f"/api/saved-places/{place['id']}", headers=auth).json()
    assert body["collection_ids"] == []


# ---------------------------------------------------------------------------
# isolation
# ---------------------------------------------------------------------------


def test_other_users_places_and_collections_are_invisible(client, auth):
    mine = save(client, auth, **ICHIRAN)
    my_coll = collection(client, auth, "Mine")
    other = signup(client, email="sam@example.com", name="Sam")

    assert client.get("/api/saved-places", headers=other).json() == []
    assert client.get("/api/collections", headers=other).json() == []
    for method, url, body in [
        ("get", f"/api/saved-places/{mine['id']}", None),
        ("patch", f"/api/saved-places/{mine['id']}", {"rating": 1}),
        ("delete", f"/api/saved-places/{mine['id']}", None),
        ("patch", f"/api/collections/{my_coll['id']}", {"name": "x"}),
        ("delete", f"/api/collections/{my_coll['id']}", None),
        ("get", f"/api/saved-places?collection_id={my_coll['id']}", None),
    ]:
        resp = client.request(method, url, json=body, headers=other)
        assert resp.status_code == 404, (method, url, resp.status_code)

    # Can't file your place into someone else's collection either.
    resp = client.post("/api/saved-places", json={"name": "x", "collection_ids": [my_coll["id"]]}, headers=other)
    assert resp.status_code == 404

    # Or add my place to your trip / your place to my trip.
    their_trip = make_trip(client, other)
    resp = client.post(
        f"/api/saved-places/{mine['id']}/add-to-trip", json={"trip_id": their_trip, "date": "2026-10-02"}, headers=other
    )
    assert resp.status_code == 404
    resp = client.post(
        f"/api/saved-places/{mine['id']}/add-to-trip", json={"trip_id": their_trip, "date": "2026-10-02"}, headers=auth
    )
    assert resp.status_code == 404


def test_saved_places_require_auth(client):
    for url in ["/api/saved-places", "/api/saved-places/tags", "/api/collections"]:
        assert client.get(url).status_code == 401


# ---------------------------------------------------------------------------
# saved place <-> trip
# ---------------------------------------------------------------------------


def test_add_to_trip_makes_a_stop_with_coordinates_and_category(client, auth):
    trip_id = tokyo_trip(client, auth)
    place = save(client, auth, **ICHIRAN, place_id="osm:node/1")
    resp = client.post(
        f"/api/saved-places/{place['id']}/add-to-trip",
        json={"trip_id": trip_id, "date": "2026-10-03", "start_time": "19:30"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    stop = resp.json()
    assert stop["title"] == "Ichiran Shibuya" and stop["category"] == "food"
    assert (stop["lat"], stop["lng"], stop["place_id"]) == (ICHIRAN["lat"], ICHIRAN["lng"], "osm:node/1")
    assert stop["location_name"] == "Shibuya, Tokyo"
    assert stop["start_time"] == "19:30:00"
    assert stop["timezone"] is None  # same zone as the trip
    assert stop["saved_place_id"] == place["id"]

    body = client.get(f"/api/saved-places/{place['id']}", headers=auth).json()
    assert body["in_trips"] == [
        {"stop_id": stop["id"], "trip_id": trip_id, "trip_name": "Tokyo", "trip_timezone": "Asia/Tokyo", "date": "2026-10-03"}
    ]


def test_add_to_trip_in_another_zone_gets_that_zone(client, auth):
    trip_id = tokyo_trip(client, auth)
    jfk = save(client, auth, name="JFK Terminal 1", category="transport", lat=40.6413, lng=-73.7781)
    stop = client.post(
        f"/api/saved-places/{jfk['id']}/add-to-trip", json={"trip_id": trip_id, "date": "2026-10-01"}, headers=auth
    ).json()
    assert stop["timezone"] == "America/New_York"


def test_add_to_trip_rejects_a_date_outside_the_trip(client, auth):
    trip_id = tokyo_trip(client, auth)
    place = save(client, auth, **ICHIRAN)
    resp = client.post(
        f"/api/saved-places/{place['id']}/add-to-trip", json={"trip_id": trip_id, "date": "2026-10-09"}, headers=auth
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Oct 9 isn't part of Tokyo (Oct 1 – Oct 7)"


def test_add_to_trip_keeps_the_google_30_day_clock(client, auth, engine):
    trip_id = tokyo_trip(client, auth)
    place = save(client, auth, **ICHIRAN, place_id="ChIJ-ichiran")
    assert place["coords_source"] == "google"
    fetched = datetime.now(UTC) - timedelta(days=20)
    with Session(engine) as s:
        row = s.get(SavedPlace, place["id"])
        row.coords_fetched_at = fetched
        s.add(row)
        s.commit()

    stop = client.post(
        f"/api/saved-places/{place['id']}/add-to-trip", json={"trip_id": trip_id, "date": "2026-10-02"}, headers=auth
    ).json()
    assert stop["coords_source"] == "google"
    assert stop["location_name"] is None  # Google's address isn't copied into the stop
    with Session(engine) as s:
        copied = s.get(ItineraryItem, stop["id"]).coords_fetched_at
    assert abs(copied - fetched) < timedelta(seconds=1)  # not restarted


def test_save_a_stop_then_saving_again_returns_the_same_place(client, auth):
    trip_id = tokyo_trip(client, auth)
    stop = client.post(
        f"/api/trips/{trip_id}/itinerary",
        json={"date": "2026-10-02", "title": "Tsukiji Outer Market", "category": "food",
              "location_name": "Tsukiji, Tokyo", "place_id": "osm:way/9", "lat": 35.665, "lng": 139.770},
        headers=auth,
    ).json()

    first = client.post(f"/api/itinerary/{stop['id']}/save", headers=auth)
    assert first.status_code == 201, first.text
    place = first.json()
    assert (place["name"], place["category"], place["address"]) == ("Tsukiji Outer Market", "food", "Tsukiji, Tokyo")
    assert place["in_trips"][0]["stop_id"] == stop["id"]

    again = client.post(f"/api/itinerary/{stop['id']}/save", headers=auth)
    assert again.status_code == 200 and again.json()["id"] == place["id"]
    assert len(client.get("/api/saved-places", headers=auth).json()) == 1

    # A second stop at the same place (same place_id) links to the same saved place.
    stop2 = client.post(
        f"/api/trips/{trip_id}/itinerary",
        json={"date": "2026-10-05", "title": "Tsukiji again", "place_id": "osm:way/9", "lat": 35.665, "lng": 139.770},
        headers=auth,
    ).json()
    resp = client.post(f"/api/itinerary/{stop2['id']}/save", headers=auth)
    assert resp.status_code == 200 and resp.json()["id"] == place["id"]
    assert len(resp.json()["in_trips"]) == 2


def test_deleting_a_saved_place_keeps_the_stops_made_from_it(client, auth):
    trip_id = tokyo_trip(client, auth)
    place = save(client, auth, **ICHIRAN)
    stop = client.post(
        f"/api/saved-places/{place['id']}/add-to-trip", json={"trip_id": trip_id, "date": "2026-10-02"}, headers=auth
    ).json()
    assert client.delete(f"/api/saved-places/{place['id']}", headers=auth).status_code == 204
    stops = client.get(f"/api/trips/{trip_id}/itinerary", headers=auth).json()
    assert [(s["id"], s["saved_place_id"]) for s in stops] == [(stop["id"], None)]


def test_deleting_a_trip_leaves_saved_places_alone(client, auth):
    trip_id = tokyo_trip(client, auth)
    place = save(client, auth, **ICHIRAN)
    client.post(f"/api/saved-places/{place['id']}/add-to-trip", json={"trip_id": trip_id, "date": "2026-10-02"}, headers=auth)
    assert client.delete(f"/api/trips/{trip_id}", headers=auth).status_code == 204
    assert client.get(f"/api/saved-places/{place['id']}", headers=auth).json()["in_trips"] == []


# ---------------------------------------------------------------------------
# nearby
# ---------------------------------------------------------------------------


def test_km_between_is_right_at_city_scale():
    # Shibuya Crossing to Tokyo Tower is about 4 km.
    assert km_between(35.6595, 139.7005, 35.6586, 139.7454) == pytest.approx(4.06, abs=0.1)
    assert km_between(0, 0, 0, 1) == pytest.approx(111.2, abs=0.2)


def test_nearby_suggests_want_to_visit_places_close_to_the_trip(client, auth):
    trip_id = tokyo_trip(client, auth)
    client.post(
        f"/api/trips/{trip_id}/itinerary",
        json={"date": "2026-10-02", "title": "Shibuya Sky", "lat": 35.6585, "lng": 139.7022},
        headers=auth,
    )
    ichiran = save(client, auth, **ICHIRAN)        # ~0.3 km away
    teamlab = save(client, auth, **TEAMLAB)        # ~8 km away
    save(client, auth, **KYOTO)                    # ~370 km away: not nearby
    save(client, auth, name="Visited already", lat=35.659, lng=139.703, status="visited")
    save(client, auth, name="No coordinates")

    nearby = client.get(f"/api/trips/{trip_id}/saved-places/nearby", headers=auth).json()
    assert [p["id"] for p in nearby] == [ichiran["id"], teamlab["id"]]  # closest first
    assert nearby[0]["near_stop"] == "Shibuya Sky"
    assert nearby[0]["distance_km"] < 1 < nearby[1]["distance_km"] < 30

    # Once it's on the trip, it's no longer a suggestion.
    client.post(f"/api/saved-places/{ichiran['id']}/add-to-trip", json={"trip_id": trip_id, "date": "2026-10-03"}, headers=auth)
    nearby = client.get(f"/api/trips/{trip_id}/saved-places/nearby", headers=auth).json()
    assert [p["id"] for p in nearby] == [teamlab["id"]]


def test_nearby_is_empty_for_a_trip_without_located_stops(client, auth):
    trip_id = tokyo_trip(client, auth)
    save(client, auth, **ICHIRAN)
    assert client.get(f"/api/trips/{trip_id}/saved-places/nearby", headers=auth).json() == []


# ---------------------------------------------------------------------------
# Google's 30-day rule covers saved places too
# ---------------------------------------------------------------------------


@pytest.fixture()
def fake_google(monkeypatch):
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "server-key")
    state = {"handler": None}
    monkeypatch.setattr(
        google, "_client", lambda: httpx.Client(transport=httpx.MockTransport(lambda r: state["handler"](r)))
    )
    return state


def _age_place(engine, place_id, days):
    with Session(engine) as s:
        row = s.get(SavedPlace, place_id)
        row.coords_fetched_at = datetime.now(UTC) - timedelta(days=days)
        s.add(row)
        s.commit()


def test_google_saved_places_are_refreshed_with_their_address(client, auth, engine, fake_google):
    place = save(client, auth, name="Ichiran", place_id="ChIJ-ichiran", lat=1.0, lng=1.0, address="old")
    _age_place(engine, place["id"], 26)
    fake_google["handler"] = lambda r: httpx.Response(
        200, json={"location": {"latitude": 35.66, "longitude": 139.70}, "formattedAddress": "1-22-7 Jinnan, Shibuya"}
    )
    with Session(engine) as s:
        assert refresh_google_coords(s, datetime.now(UTC)).refreshed == 1
    body = client.get(f"/api/saved-places/{place['id']}", headers=auth).json()
    assert (body["lat"], body["lng"], body["address"]) == (35.66, 139.70, "1-22-7 Jinnan, Shibuya")
    assert body["name"] == "Ichiran"  # the user's own label is never touched


def test_expired_google_saved_places_lose_coordinates_and_address(client, auth, engine, fake_google):
    place = save(client, auth, name="Ichiran", place_id="ChIJ-ichiran", lat=1.0, lng=1.0, address="Shibuya")
    _age_place(engine, place["id"], 31)
    fake_google["handler"] = lambda r: httpx.Response(503, json={"error": {"message": "down"}})
    with Session(engine) as s:
        assert refresh_google_coords(s, datetime.now(UTC)).deleted == 1
    body = client.get(f"/api/saved-places/{place['id']}", headers=auth).json()
    assert (body["lat"], body["address"], body["place_id"]) == (None, None, "ChIJ-ichiran")
