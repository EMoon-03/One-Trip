"""API tests against an in-memory SQLite database.

Run from backend/:  python -m pytest -q
"""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.database import get_session
from app.main import app


@pytest.fixture()
def client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB across connections
    )
    SQLModel.metadata.create_all(engine)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    yield TestClient(app)
    app.dependency_overrides.clear()


def signup(client: TestClient, email="eddie@example.com", name="Eddie") -> dict:
    """Register a user, return the Authorization header dict."""
    resp = client.post(
        "/api/auth/register",
        json={"email": email, "display_name": name, "password": "wanderlust1"},
    )
    assert resp.status_code == 201, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture()
def auth(client):
    return signup(client)


def make_trip(client: TestClient, auth: dict, **overrides) -> int:
    payload = {
        "name": "Test Trip",
        "destination": "Testville",
        "start_date": "2026-10-01",
        "end_date": "2026-10-07",
        "base_currency": "USD",
        "total_budget": 1000.0,
    }
    payload.update(overrides)
    resp = client.post("/api/trips", json=payload, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------


def test_register_login_me_flow(client):
    reg = client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "display_name": "New", "password": "longenough"},
    )
    assert reg.status_code == 201
    body = reg.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "new@example.com"

    # login uses OAuth2 form fields (username = email)
    login = client.post(
        "/api/auth/login",
        data={"username": "new@example.com", "password": "longenough"},
    )
    assert login.status_code == 200
    token = login.json()["access_token"]

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["display_name"] == "New"


def test_register_duplicate_email_rejected(client):
    signup(client, email="dupe@example.com")
    resp = client.post(
        "/api/auth/register",
        json={"email": "dupe@example.com", "display_name": "Again", "password": "longenough"},
    )
    assert resp.status_code == 400


def test_login_wrong_password_401(client):
    signup(client, email="who@example.com")
    resp = client.post(
        "/api/auth/login",
        data={"username": "who@example.com", "password": "wrong-password"},
    )
    assert resp.status_code == 401


def test_short_password_rejected(client):
    resp = client.post(
        "/api/auth/register",
        json={"email": "short@example.com", "display_name": "S", "password": "tiny"},
    )
    assert resp.status_code == 422


def test_protected_routes_require_auth(client):
    assert client.get("/api/trips").status_code == 401
    assert client.get("/api/reminders/due").status_code == 401
    assert client.get("/api/places/search", params={"q": "tokyo"}).status_code == 401
    assert client.post("/api/trips", json={}).status_code == 401


def test_users_cannot_see_each_others_trips(client):
    auth_a = signup(client, email="a@example.com", name="A")
    auth_b = signup(client, email="b@example.com", name="B")
    trip_a = make_trip(client, auth_a, name="A's trip")

    # B's world: A's trip simply doesn't exist
    assert client.get("/api/trips", headers=auth_b).json() == []
    assert client.get(f"/api/trips/{trip_a}", headers=auth_b).status_code == 404
    assert (
        client.patch(f"/api/trips/{trip_a}", json={"name": "hijack"}, headers=auth_b).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/trips/{trip_a}/expenses",
            json={"description": "x", "amount": 1, "category": "other", "spend_date": "2026-10-01"},
            headers=auth_b,
        ).status_code
        == 404
    )
    # and A still sees it untouched
    assert client.get(f"/api/trips/{trip_a}", headers=auth_a).json()["name"] == "A's trip"


def test_due_reminders_scoped_per_user(client):
    auth_a = signup(client, email="a2@example.com")
    auth_b = signup(client, email="b2@example.com")
    trip_a = make_trip(client, auth_a)
    past = (datetime.now() - timedelta(hours=1)).isoformat(timespec="minutes")
    client.post(
        f"/api/trips/{trip_a}/reminders",
        json={"message": "A's task", "remind_at": past},
        headers=auth_a,
    )

    assert len(client.get("/api/reminders/due", headers=auth_a).json()) == 1
    assert client.get("/api/reminders/due", headers=auth_b).json() == []


# --------------------------------------------------------------------------
# Trips
# --------------------------------------------------------------------------


def test_create_and_get_trip(client, auth):
    trip_id = make_trip(client, auth)
    resp = client.get(f"/api/trips/{trip_id}", headers=auth)
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Test Trip"
    assert body["total_budget"] == 1000.0


def test_trip_rejects_backwards_dates(client, auth):
    resp = client.post(
        "/api/trips",
        json={
            "name": "Bad",
            "destination": "Nowhere",
            "start_date": "2026-10-07",
            "end_date": "2026-10-01",
        },
        headers=auth,
    )
    assert resp.status_code == 422


def test_update_trip(client, auth):
    trip_id = make_trip(client, auth)
    resp = client.patch(f"/api/trips/{trip_id}", json={"total_budget": 2500.0}, headers=auth)
    assert resp.status_code == 200
    assert resp.json()["total_budget"] == 2500.0
    # other fields untouched
    assert resp.json()["destination"] == "Testville"


def test_missing_trip_is_404(client, auth):
    assert client.get("/api/trips/999", headers=auth).status_code == 404


# --------------------------------------------------------------------------
# Itinerary
# --------------------------------------------------------------------------


def test_itinerary_sorted_by_date_then_time(client, auth):
    trip_id = make_trip(client, auth)
    for item in [
        {"date": "2026-10-02", "start_time": "09:00", "title": "B", "category": "activity"},
        {"date": "2026-10-01", "start_time": "18:00", "title": "A2", "category": "food"},
        {"date": "2026-10-01", "start_time": "08:00", "title": "A1", "category": "flight"},
    ]:
        assert (
            client.post(f"/api/trips/{trip_id}/itinerary", json=item, headers=auth).status_code
            == 201
        )

    titles = [i["title"] for i in client.get(f"/api/trips/{trip_id}/itinerary", headers=auth).json()]
    assert titles == ["A1", "A2", "B"]


def test_itinerary_item_stores_coordinates(client, auth):
    trip_id = make_trip(client, auth)
    resp = client.post(
        f"/api/trips/{trip_id}/itinerary",
        json={
            "date": "2026-10-01",
            "title": "Haneda",
            "category": "flight",
            "location_name": "Haneda Airport",
            "place_id": "osm:node/123",
            "lat": 35.5494,
            "lng": 139.7798,
        },
        headers=auth,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["lat"] == 35.5494 and body["lng"] == 139.7798


# --------------------------------------------------------------------------
# Expenses
# --------------------------------------------------------------------------


def test_expense_currency_defaults_to_trip_currency(client, auth):
    trip_id = make_trip(client, auth, base_currency="JPY")
    resp = client.post(
        f"/api/trips/{trip_id}/expenses",
        json={"description": "Ramen", "amount": 1200, "category": "food", "spend_date": "2026-10-02"},
        headers=auth,
    )
    assert resp.status_code == 201
    assert resp.json()["currency"] == "JPY"


def test_expense_rejects_activity_from_other_trip(client, auth):
    trip_a = make_trip(client, auth, name="A")
    trip_b = make_trip(client, auth, name="B")
    item = client.post(
        f"/api/trips/{trip_a}/itinerary",
        json={"date": "2026-10-01", "title": "Museum", "category": "activity"},
        headers=auth,
    ).json()

    resp = client.post(
        f"/api/trips/{trip_b}/expenses",
        json={
            "description": "Ticket",
            "amount": 20,
            "category": "activities",
            "spend_date": "2026-10-01",
            "activity_id": item["id"],
        },
        headers=auth,
    )
    assert resp.status_code == 400


def test_deleting_stop_unlinks_expense_but_keeps_it(client, auth):
    trip_id = make_trip(client, auth)
    item = client.post(
        f"/api/trips/{trip_id}/itinerary",
        json={"date": "2026-10-01", "title": "Dinner", "category": "food"},
        headers=auth,
    ).json()
    expense = client.post(
        f"/api/trips/{trip_id}/expenses",
        json={
            "description": "Dinner bill",
            "amount": 52,
            "category": "food",
            "spend_date": "2026-10-01",
            "activity_id": item["id"],
        },
        headers=auth,
    ).json()
    assert expense["activity_id"] == item["id"]

    assert client.delete(f"/api/itinerary/{item['id']}", headers=auth).status_code == 204

    remaining = client.get(f"/api/trips/{trip_id}/expenses", headers=auth).json()
    assert len(remaining) == 1
    assert remaining[0]["activity_id"] is None  # link cleared, money kept


# --------------------------------------------------------------------------
# Summary (the finance math)
# --------------------------------------------------------------------------


def test_summary_math(client, auth):
    trip_id = make_trip(client, auth, total_budget=1000.0)

    def spend(desc, amount, category, day, planned=False):
        resp = client.post(
            f"/api/trips/{trip_id}/expenses",
            json={
                "description": desc,
                "amount": amount,
                "category": category,
                "spend_date": day,
                "is_planned": planned,
            },
            headers=auth,
        )
        assert resp.status_code == 201

    spend("Lunch", 100.0, "food", "2026-10-01")
    spend("Dinner", 50.0, "food", "2026-10-02")
    spend("Hotel estimate", 300.0, "lodging", "2026-10-01", planned=True)

    s = client.get(f"/api/trips/{trip_id}/summary", headers=auth).json()
    assert s["total_spent"] == 150.0
    assert s["total_planned"] == 300.0
    assert s["remaining"] == 850.0
    assert s["pct_used"] == 15.0

    cats = {c["category"]: c for c in s["by_category"]}
    assert cats["food"]["spent"] == 150.0 and cats["food"]["planned"] == 0.0
    assert cats["lodging"]["planned"] == 300.0 and cats["lodging"]["spent"] == 0.0

    # daily burn: planned expenses must NOT appear in the spend curve
    assert s["daily_spend"] == [
        {"date": "2026-10-01", "amount": 100.0, "cumulative": 100.0},
        {"date": "2026-10-02", "amount": 50.0, "cumulative": 150.0},
    ]


def test_summary_with_zero_budget_has_no_division_error(client, auth):
    trip_id = make_trip(client, auth, total_budget=0.0)
    s = client.get(f"/api/trips/{trip_id}/summary", headers=auth).json()
    assert s["pct_used"] == 0.0


# --------------------------------------------------------------------------
# Reminders
# --------------------------------------------------------------------------


def test_due_reminders_only_pending_and_past(client, auth):
    trip_id = make_trip(client, auth, name="Reminder Trip")
    past = (datetime.now() - timedelta(hours=2)).isoformat(timespec="minutes")
    future = (datetime.now() + timedelta(days=2)).isoformat(timespec="minutes")

    due = client.post(
        f"/api/trips/{trip_id}/reminders",
        json={"message": "Check in", "remind_at": past, "type": "departure"},
        headers=auth,
    ).json()
    client.post(
        f"/api/trips/{trip_id}/reminders",
        json={"message": "Later", "remind_at": future, "type": "task"},
        headers=auth,
    )
    finished = client.post(
        f"/api/trips/{trip_id}/reminders",
        json={"message": "Already handled", "remind_at": past, "type": "task"},
        headers=auth,
    ).json()
    client.patch(f"/api/reminders/{finished['id']}", json={"status": "done"}, headers=auth)

    due_list = client.get("/api/reminders/due", headers=auth).json()
    assert [r["id"] for r in due_list] == [due["id"]]
    assert due_list[0]["trip_name"] == "Reminder Trip"


def test_reminder_status_roundtrip(client, auth):
    trip_id = make_trip(client, auth)
    r = client.post(
        f"/api/trips/{trip_id}/reminders",
        json={"message": "Pack chargers", "remind_at": "2026-10-01T09:00", "type": "task"},
        headers=auth,
    ).json()
    assert r["status"] == "pending"
    updated = client.patch(
        f"/api/reminders/{r['id']}", json={"status": "done"}, headers=auth
    ).json()
    assert updated["status"] == "done"


# --------------------------------------------------------------------------
# Cascade
# --------------------------------------------------------------------------


def test_deleting_trip_removes_children(client, auth):
    trip_id = make_trip(client, auth)
    client.post(
        f"/api/trips/{trip_id}/itinerary",
        json={"date": "2026-10-01", "title": "Stop", "category": "activity"},
        headers=auth,
    )
    client.post(
        f"/api/trips/{trip_id}/expenses",
        json={"description": "Thing", "amount": 10, "category": "other", "spend_date": "2026-10-01"},
        headers=auth,
    )
    client.post(
        f"/api/trips/{trip_id}/reminders",
        json={"message": "Do thing", "remind_at": "2026-10-01T09:00"},
        headers=auth,
    )

    assert client.delete(f"/api/trips/{trip_id}", headers=auth).status_code == 204
    assert client.get(f"/api/trips/{trip_id}", headers=auth).status_code == 404
    assert client.get(f"/api/trips/{trip_id}/expenses", headers=auth).status_code == 404
    assert client.get("/api/reminders/due", headers=auth).json() == []
