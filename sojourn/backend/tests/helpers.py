from fastapi.testclient import TestClient


def signup(client: TestClient, email="eddie@example.com", name="Eddie") -> dict:
    """Register a user, return the Authorization header dict."""
    resp = client.post(
        "/api/auth/register",
        json={"email": email, "display_name": name, "password": "wanderlust1"},
    )
    assert resp.status_code == 201, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


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
