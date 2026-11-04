"""Reminders v2: time zones, 'before a stop' reminders, and the delivery worker.

Worker tests call app.delivery.tick() directly with a fake clock (`now=`)
and fake channels, so they're fast and deterministic — no sleeping, no SMTP.
"""

import smtplib
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select

from app.delivery import backoff, build_message, schedule_due, tick
from app.models import (
    DeliveryStatus,
    ItineraryItem,
    PushSubscription,
    Reminder,
    ReminderDelivery,
    Trip,
    User,
)
from app.notify.channels import (
    ConsoleChannel,
    EmailChannel,
    Message,
    PermanentError,
    PushChannel,
    TransientError,
)
from app.notify.settings import get_settings

from .helpers import make_trip, signup

UTC = timezone.utc


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


def tokyo_trip(client, auth, **kw) -> int:
    return make_trip(client, auth, start_date="2026-11-10", end_date="2026-11-16", timezone="Asia/Tokyo", **kw)


def add_stop(client, auth, trip_id, **kw) -> dict:
    body = {"title": "Flight JFK → HND", "date": "2026-11-10", "start_time": "10:30", "category": "flight"}
    body.update(kw)
    resp = client.post(f"/api/trips/{trip_id}/itinerary", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def add_reminder(client, auth, trip_id, **kw) -> dict:
    body = {"message": "Do the thing"}
    body.update(kw)
    resp = client.post(f"/api/trips/{trip_id}/reminders", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


def settings(**overrides):
    return replace(get_settings(), **overrides)


class FakeChannel:
    """Records what it was asked to send; can be told to fail."""

    def __init__(self, name="fake", fail=None):
        self.name = name
        self.sent: list[Message] = []
        self.fail = fail  # an exception instance to raise, or None

    def available(self):
        return True

    def wants(self, user, session):
        return True

    def send(self, message, user, session):
        if self.fail:
            raise self.fail
        self.sent.append(message)


# ==========================================================================
# Time zones
# ==========================================================================


def test_naive_time_is_read_in_the_trip_zone(client, auth):
    trip_id = tokyo_trip(client, auth)
    r = add_reminder(client, auth, trip_id, remind_at="2026-11-09T10:30")
    assert r["remind_at"].startswith("2026-11-09T01:30:00")  # 10:30 JST = 01:30 UTC
    assert r["remind_at"].endswith("Z") or r["remind_at"].endswith("+00:00")
    assert r["local_time"] == "2026-11-09T10:30:00"
    assert r["timezone"] is None
    assert r["effective_timezone"] == "Asia/Tokyo"


def test_reminder_can_use_its_own_zone_and_dst_is_respected(client, auth):
    trip_id = tokyo_trip(client, auth)
    # US clocks go back on Nov 1 2026: Oct 31 is EDT (UTC-4), Nov 2 is EST (UTC-5).
    before = add_reminder(client, auth, trip_id, remind_at="2026-10-31T10:30", timezone="America/New_York")
    after = add_reminder(client, auth, trip_id, remind_at="2026-11-02T10:30", timezone="America/New_York")
    assert before["remind_at"].startswith("2026-10-31T14:30")
    assert after["remind_at"].startswith("2026-11-02T15:30")
    assert after["effective_timezone"] == "America/New_York"


def test_aware_input_is_converted_into_the_zone(client, auth):
    trip_id = tokyo_trip(client, auth)
    r = add_reminder(client, auth, trip_id, remind_at="2026-11-09T01:30:00Z")
    assert r["local_time"] == "2026-11-09T10:30:00"


def test_unknown_zones_are_rejected(client, auth):
    resp = client.post(
        "/api/trips",
        json={"name": "x", "destination": "y", "start_date": "2026-01-01", "end_date": "2026-01-02", "timezone": "Mars/Olympus"},
        headers=auth,
    )
    assert resp.status_code == 422
    trip_id = tokyo_trip(client, auth)
    resp = client.post(
        f"/api/trips/{trip_id}/reminders",
        json={"message": "x", "remind_at": "2026-11-09T10:30", "timezone": "Nowhere/Land"},
        headers=auth,
    )
    assert resp.status_code == 422


def test_fixing_the_trip_zone_keeps_wall_clock_and_moves_the_moment(client, auth):
    trip_id = make_trip(client, auth)  # created on UTC by mistake
    follows_trip = add_reminder(client, auth, trip_id, remind_at="2026-10-02T09:00")
    own_zone = add_reminder(client, auth, trip_id, remind_at="2026-10-02T09:00", timezone="America/New_York")
    assert follows_trip["remind_at"].startswith("2026-10-02T09:00")

    resp = client.patch(f"/api/trips/{trip_id}", json={"timezone": "Asia/Tokyo"}, headers=auth)
    assert resp.status_code == 200
    reminders = {r["id"]: r for r in client.get(f"/api/trips/{trip_id}/reminders", headers=auth).json()}

    moved = reminders[follows_trip["id"]]
    assert moved["local_time"] == "2026-10-02T09:00:00"          # still 9:00 on the wall…
    assert moved["remind_at"].startswith("2026-10-02T00:00")      # …which is now 00:00 UTC
    assert reminders[own_zone["id"]]["remind_at"] == own_zone["remind_at"]  # had its own zone: unchanged


# ==========================================================================
# "Before a stop" reminders
# ==========================================================================


def test_reminder_counts_back_from_a_stop_in_the_stops_zone(client, auth):
    trip_id = tokyo_trip(client, auth)
    flight = add_stop(client, auth, trip_id, timezone="America/New_York")  # 10:30 EST = 15:30 UTC
    r = add_reminder(client, auth, trip_id, message="Leave for JFK", activity_id=flight["id"], offset_minutes=180)
    assert r["remind_at"].startswith("2026-11-10T12:30")
    assert r["local_time"] == "2026-11-10T07:30:00"
    assert r["effective_timezone"] == "America/New_York"
    assert r["offset_minutes"] == 180


def test_moving_the_stop_moves_its_reminders(client, auth):
    trip_id = tokyo_trip(client, auth)
    flight = add_stop(client, auth, trip_id, timezone="America/New_York")
    r = add_reminder(client, auth, trip_id, activity_id=flight["id"], offset_minutes=120)

    client.patch(f"/api/itinerary/{flight['id']}", json={"start_time": "13:00", "date": "2026-11-11"}, headers=auth)
    after = client.get(f"/api/trips/{trip_id}/reminders", headers=auth).json()[0]
    assert after["id"] == r["id"]
    assert after["remind_at"].startswith("2026-11-11T16:00")  # 13:00 EST - 2h = 11:00 EST = 16:00 UTC


def test_stop_losing_its_time_or_being_deleted_freezes_the_reminder(client, auth):
    trip_id = tokyo_trip(client, auth)
    stop = add_stop(client, auth, trip_id)
    r = add_reminder(client, auth, trip_id, activity_id=stop["id"], offset_minutes=60)

    client.patch(f"/api/itinerary/{stop['id']}", json={"start_time": None}, headers=auth)
    frozen = client.get(f"/api/trips/{trip_id}/reminders", headers=auth).json()[0]
    assert frozen["offset_minutes"] is None
    assert frozen["remind_at"] == r["remind_at"]  # same moment, now absolute

    stop2 = add_stop(client, auth, trip_id, title="Dinner", start_time="19:00")
    r2 = add_reminder(client, auth, trip_id, activity_id=stop2["id"], offset_minutes=30)
    assert client.delete(f"/api/itinerary/{stop2['id']}", headers=auth).status_code == 204
    kept = next(x for x in client.get(f"/api/trips/{trip_id}/reminders", headers=auth).json() if x["id"] == r2["id"])
    assert kept["activity_id"] is None and kept["offset_minutes"] is None
    assert kept["remind_at"] == r2["remind_at"]


def test_relative_reminder_validation(client, auth):
    trip_id = tokyo_trip(client, auth)
    untimed = add_stop(client, auth, trip_id, title="Somewhere", start_time=None)
    post = lambda body: client.post(f"/api/trips/{trip_id}/reminders", json={"message": "x", **body}, headers=auth)
    assert post({"offset_minutes": 30}).status_code == 422                                  # no stop
    assert post({"offset_minutes": 30, "activity_id": untimed["id"]}).status_code == 422     # stop has no time
    assert post({"offset_minutes": 30, "remind_at": "2026-11-10T09:00", "activity_id": untimed["id"]}).status_code == 422
    assert post({}).status_code == 422                                                       # no time at all


def test_patch_can_switch_between_absolute_and_relative(client, auth):
    trip_id = tokyo_trip(client, auth)
    stop = add_stop(client, auth, trip_id, start_time="18:00")  # Tokyo time
    r = add_reminder(client, auth, trip_id, remind_at="2026-11-10T09:00")

    rel = client.patch(f"/api/reminders/{r['id']}", json={"activity_id": stop["id"], "offset_minutes": 60}, headers=auth).json()
    assert rel["local_time"] == "2026-11-10T17:00:00" and rel["offset_minutes"] == 60

    back = client.patch(f"/api/reminders/{r['id']}", json={"remind_at": "2026-11-10T08:00"}, headers=auth).json()
    assert back["offset_minutes"] is None and back["local_time"] == "2026-11-10T08:00:00"


# ==========================================================================
# The worker
# ==========================================================================


def _seed_due(client, auth, engine, *, minutes_ago=5, **kw) -> int:
    trip_id = make_trip(client, auth)
    when = (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat()
    return add_reminder(client, auth, trip_id, remind_at=when, **kw)["id"]


def _deliveries(engine, reminder_id):
    with Session(engine) as s:
        return s.exec(select(ReminderDelivery).where(ReminderDelivery.reminder_id == reminder_id)).all()


def test_due_reminder_is_sent_exactly_once(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel()
    with Session(engine) as s:
        first = tick(s, settings=settings(), channels=[ch])
        second = tick(s, settings=settings(), channels=[ch])
    assert (first.dispatched, first.sent) == (1, 1)
    assert (second.dispatched, second.sent) == (0, 0)
    assert len(ch.sent) == 1 and ch.sent[0].title == "Do the thing"
    [d] = _deliveries(engine, rid)
    assert d.status == DeliveryStatus.sent and d.attempts == 1 and d.sent_at is not None

    # …and the API reports it, so the UI can say "Sent".
    r = client.get("/api/trips/1/reminders", headers=auth).json()[0]
    assert r["dispatched_at"] is not None and r["deliveries"][0]["status"] == "sent"


def test_future_reminders_wait(client, auth, engine):
    trip_id = make_trip(client, auth)
    add_reminder(client, auth, trip_id, remind_at=(datetime.now(UTC) + timedelta(hours=1)).isoformat())
    ch = FakeChannel()
    with Session(engine) as s:
        assert not tick(s, settings=settings(), channels=[ch])
        # …until the clock reaches them
        assert tick(s, now=datetime.now(UTC) + timedelta(hours=1, minutes=1), settings=settings(), channels=[ch]).sent == 1


def test_done_before_its_time_never_sends(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    client.patch(f"/api/reminders/{rid}", json={"status": "done"}, headers=auth)
    ch = FakeChannel()
    with Session(engine) as s:
        assert not tick(s, settings=settings(), channels=[ch])
    assert ch.sent == []


def test_marked_done_between_fan_out_and_send_is_skipped(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel()
    with Session(engine) as s:
        schedule_due(s, datetime.now(UTC), settings(), [ch])
    client.patch(f"/api/reminders/{rid}", json={"status": "dismissed"}, headers=auth)
    with Session(engine) as s:
        result = tick(s, settings=settings(), channels=[ch])
    assert result.skipped == 1 and ch.sent == []
    assert "dismissed" in _deliveries(engine, rid)[0].last_error


def test_transient_failures_back_off_then_give_up(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel(fail=TransientError("SMTP unreachable"))
    cfg = settings(max_attempts=3)
    now = datetime.now(UTC)
    with Session(engine) as s:
        assert tick(s, now=now, settings=cfg, channels=[ch]).retried == 1
        # Not retried before the backoff elapses…
        assert tick(s, now=now + timedelta(seconds=30), settings=cfg, channels=[ch]).retried == 0
        # …then retried after it: 1 min, then 2 min.
        assert tick(s, now=now + backoff(1) + timedelta(seconds=1), settings=cfg, channels=[ch]).retried == 1
        final = tick(s, now=now + backoff(1) + backoff(2) + timedelta(seconds=2), settings=cfg, channels=[ch])
    assert final.failed == 1
    [d] = _deliveries(engine, rid)
    assert d.status == DeliveryStatus.failed and d.attempts == 3 and "Gave up" in d.last_error


def test_permanent_failure_stops_immediately(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel(fail=PermanentError("Address refused"))
    with Session(engine) as s:
        assert tick(s, settings=settings(), channels=[ch]).failed == 1
    [d] = _deliveries(engine, rid)
    assert d.status == DeliveryStatus.failed and d.attempts == 1


def test_one_channel_failing_does_not_block_another(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    good, bad = FakeChannel("good"), FakeChannel("bad", fail=TransientError("down"))
    with Session(engine) as s:
        tick(s, settings=settings(), channels=[good, bad])
    statuses = {d.channel: d.status for d in _deliveries(engine, rid)}
    assert statuses == {"good": DeliveryStatus.sent, "bad": DeliveryStatus.pending}
    assert len(good.sent) == 1


def test_long_overdue_reminders_are_skipped_not_blasted(client, auth, engine):
    rid = _seed_due(client, auth, engine, minutes_ago=60 * 13)  # > 12h stale window
    ch = FakeChannel()
    with Session(engine) as s:
        tick(s, settings=settings(stale_after_hours=12), channels=[ch])
    assert ch.sent == []
    [d] = _deliveries(engine, rid)
    assert d.status == DeliveryStatus.skipped and "Missed" in d.last_error


def test_a_crashed_worker_lease_expires_and_another_retries(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel()
    now = datetime.now(UTC)
    cfg = settings(lease_seconds=120)
    with Session(engine) as s:
        schedule_due(s, now, cfg, [ch])
        # Simulate worker A: it claimed the delivery, then died before sending.
        d = s.exec(select(ReminderDelivery).where(ReminderDelivery.reminder_id == rid)).one()
        d.claimed_until, d.attempts = now + timedelta(seconds=120), 1
        s.add(d)
        s.commit()
        # Worker B can't touch it while the lease is live…
        assert tick(s, now=now + timedelta(seconds=60), settings=cfg, channels=[ch]).sent == 0
        # …but picks it up once the lease runs out.
        assert tick(s, now=now + timedelta(seconds=121), settings=cfg, channels=[ch]).sent == 1
    assert len(ch.sent) == 1 and _deliveries(engine, rid)[0].attempts == 2


def test_two_workers_fanning_out_together_create_one_row_per_channel(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel()
    now = datetime.now(UTC)
    with Session(engine) as a, Session(engine) as b:
        assert schedule_due(a, now, settings(), [ch]).dispatched == 1
        assert schedule_due(b, now, settings(), [ch]).dispatched == 0  # claim already taken
    assert len(_deliveries(engine, rid)) == 1


def test_rescheduling_a_sent_reminder_rearms_it(client, auth, engine):
    rid = _seed_due(client, auth, engine)
    ch = FakeChannel()
    with Session(engine) as s:
        tick(s, settings=settings(), channels=[ch])
    later = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    r = client.patch(f"/api/reminders/{rid}", json={"remind_at": later}, headers=auth).json()
    assert r["dispatched_at"] is None and r["deliveries"] == []
    # Editing just the text does NOT re-send.
    with Session(engine) as s:
        tick(s, now=datetime.now(UTC) + timedelta(hours=2, minutes=1), settings=settings(), channels=[ch])
    client.patch(f"/api/reminders/{rid}", json={"message": "Renamed"}, headers=auth)
    with Session(engine) as s:
        tick(s, now=datetime.now(UTC) + timedelta(hours=3), settings=settings(), channels=[ch])
    assert len(ch.sent) == 2


def test_message_reads_in_the_stops_zone(client, auth, engine):
    trip_id = tokyo_trip(client, auth, name="Tokyo, Off the Clock")
    flight = add_stop(client, auth, trip_id, timezone="America/New_York")
    r = add_reminder(client, auth, trip_id, message="Leave for JFK", activity_id=flight["id"], offset_minutes=180)
    with Session(engine) as s:
        reminder = s.get(Reminder, r["id"])
        msg = build_message(reminder, s.get(Trip, trip_id), s.get(ItineraryItem, flight["id"]), settings(app_url="https://app.test"))
    assert msg.title == "Leave for JFK"
    assert "Tue, Nov 10, 7:30 AM (New York time)" in msg.body
    assert "for Flight JFK → HND" in msg.body
    assert msg.url == f"https://app.test/trips/{trip_id}"


# ==========================================================================
# Channels
# ==========================================================================


class FakeSMTP:
    instances: list["FakeSMTP"] = []
    fail_with: Exception | None = None

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.sent, self.tls, self.login_args = host, port, [], False, None
        FakeSMTP.instances.append(self)
        if FakeSMTP.fail_with:
            raise FakeSMTP.fail_with

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self, context=None):
        self.tls = True

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, mail):
        self.sent.append(mail)


@pytest.fixture()
def fake_smtp(monkeypatch):
    FakeSMTP.instances, FakeSMTP.fail_with = [], None
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def _email_settings():
    return settings(smtp_host="smtp.test", smtp_port=587, smtp_from="One Trip <trips@test>", smtp_user="u", smtp_password="p")


def test_email_channel_sends_a_readable_email(engine, client, auth, fake_smtp):
    with Session(engine) as s:
        user = s.exec(select(User)).one()
        EmailChannel(_email_settings()).send(Message("Leave for JFK", "Tokyo · 7:30 AM", "https://x/trips/1", "r1"), user, s)
    [server] = fake_smtp.instances
    assert server.tls and server.login_args == ("u", "p")
    [mail] = server.sent
    assert mail["Subject"] == "Reminder: Leave for JFK" and mail["To"] == "eddie@example.com"
    assert "https://x/trips/1" in mail.get_body(("plain",)).get_content()


def test_email_errors_are_classified(engine, client, auth, fake_smtp):
    with Session(engine) as s:
        user = s.exec(select(User)).one()
        ch = EmailChannel(_email_settings())
        msg = Message("t", "b", "u", "tag")
        fake_smtp.fail_with = ConnectionRefusedError("refused")
        with pytest.raises(TransientError):
            ch.send(msg, user, s)
        fake_smtp.fail_with = smtplib.SMTPRecipientsRefused({"eddie@example.com": (550, b"no such user")})
        with pytest.raises(PermanentError):
            ch.send(msg, user, s)


def test_email_respects_the_users_switch(client, auth, engine):
    client.patch("/api/auth/me", json={"email_notifications": False}, headers=auth)
    with Session(engine) as s:
        user = s.exec(select(User)).one()
        assert EmailChannel(_email_settings()).wants(user, s) is False


def _push_settings():
    return settings(vapid_public_key="pub", vapid_private_key="priv", vapid_subject="mailto:t@test")


def _add_sub(engine, endpoint="https://push.test/abc"):
    with Session(engine) as s:
        user = s.exec(select(User)).first()
        s.add(PushSubscription(user_id=user.id, endpoint=endpoint, p256dh="k", auth="a"))
        s.commit()


@pytest.mark.parametrize(
    "status,expect",
    [(201, "sent"), (410, "gone"), (404, "gone"), (503, "transient"), (429, "transient")],
)
def test_push_channel_outcomes(client, auth, engine, status, expect):
    _add_sub(engine)
    calls = []

    def sender(info, payload, **kw):
        calls.append((info, payload, kw))
        return status

    ch = PushChannel(_push_settings(), sender=sender)
    with Session(engine) as s:
        user = s.exec(select(User)).one()
        msg = Message("Leave", "body", "https://x", "reminder-7")
        if expect == "sent":
            ch.send(msg, user, s)
            assert calls[0][2]["headers"]["Topic"] == "reminder-7"
        elif expect == "gone":
            with pytest.raises(Exception) as exc:
                ch.send(msg, user, s)
            assert "unsubscribed" in str(exc.value)
            assert s.exec(select(PushSubscription)).all() == []  # dead endpoint forgotten
        else:
            with pytest.raises(TransientError):
                ch.send(msg, user, s)


def test_console_channel_logs(caplog, client, auth, engine):
    with Session(engine) as s:
        user = s.exec(select(User)).one()
        ConsoleChannel(settings(console=True)).send(Message("Hello", "there", "https://x", "t"), user, s)
    assert "Hello" in caplog.text


# ==========================================================================
# Notifications API
# ==========================================================================


SUB = {"endpoint": "https://push.test/device-1", "keys": {"p256dh": "BPk", "auth": "auth1"}}


def test_config_reflects_server_setup(client, auth, monkeypatch):
    cfg = client.get("/api/notifications/config", headers=auth).json()
    assert cfg["email"]["available"] is False and cfg["push"]["available"] is False
    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    monkeypatch.setenv("SMTP_FROM", "trips@test")
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "pubkey")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "privkey")
    cfg = client.get("/api/notifications/config", headers=auth).json()
    assert cfg["email"] == {"available": True, "enabled": True, "address": "eddie@example.com"}
    assert cfg["push"] == {"available": True, "public_key": "pubkey", "devices": 0}


def test_push_subscription_lifecycle_and_ownership(client, auth, monkeypatch):
    assert client.post("/api/notifications/push-subscriptions", json=SUB, headers=auth).status_code == 503
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "pubkey")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "privkey")

    assert client.post("/api/notifications/push-subscriptions", json=SUB, headers=auth).status_code == 201
    assert client.post("/api/notifications/push-subscriptions", json=SUB, headers=auth).status_code == 201  # idempotent
    assert client.get("/api/notifications/config", headers=auth).json()["push"]["devices"] == 1

    other = signup(client, email="b@example.com", name="B")
    # B can't remove A's device…
    client.delete("/api/notifications/push-subscriptions", params={"endpoint": SUB["endpoint"]}, headers=other)
    assert client.get("/api/notifications/config", headers=auth).json()["push"]["devices"] == 1
    # …but if B signs in on the same browser and subscribes, the device moves to B.
    client.post("/api/notifications/push-subscriptions", json=SUB, headers=other)
    assert client.get("/api/notifications/config", headers=auth).json()["push"]["devices"] == 0
    assert client.get("/api/notifications/config", headers=other).json()["push"]["devices"] == 1

    client.delete("/api/notifications/push-subscriptions", params={"endpoint": SUB["endpoint"]}, headers=other)
    assert client.get("/api/notifications/config", headers=other).json()["push"]["devices"] == 0


def test_push_endpoint_must_be_https(client, auth, monkeypatch):
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "pubkey")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "privkey")
    bad = {**SUB, "endpoint": "http://evil.test/x"}
    assert client.post("/api/notifications/push-subscriptions", json=bad, headers=auth).status_code == 422


def test_send_test_reports_per_channel(client, auth, monkeypatch, caplog):
    monkeypatch.setenv("NOTIFY_CONSOLE", "true")
    # push is configured on the server, but this user has no devices: not tested, not a failure
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "pubkey")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "privkey")
    results = client.post("/api/notifications/test", headers=auth).json()
    assert results == [{"channel": "console", "ok": True, "detail": "Printed in the server log"}]
    assert "Test notification" in caplog.text


def test_patch_me_updates_preferences(client, auth):
    me = client.patch("/api/auth/me", json={"email_notifications": False}, headers=auth).json()
    assert me["email_notifications"] is False
    assert client.patch("/api/auth/me", json={"display_name": "  "}, headers=auth).status_code == 422


def test_notification_routes_require_auth(client):
    assert client.get("/api/notifications/config").status_code == 401
    assert client.post("/api/notifications/test").status_code == 401


# ==========================================================================
# Real Web Push wire format (no browser needed)
# ==========================================================================


def test_real_webpush_request_decrypts_and_is_signed(client, auth, engine):
    """Send through the REAL pywebpush path to a fake push service on
    localhost, then do what Chrome/Firefox's push service and the browser do:
    check the VAPID signature and decrypt the payload with the browser's keys."""
    import base64
    import json as _json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    import http_ece
    import jwt as pyjwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from app.notify.channels import _pywebpush_sender
    from app.notify.vapid import generate

    b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    unb64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

    # The "browser": its own key pair + auth secret, as PushManager.subscribe() would make.
    browser_key = ec.generate_private_key(ec.SECP256R1())
    browser_pub = browser_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    auth_secret = b"0123456789abcdef"

    received = {}

    class PushService(BaseHTTPRequestHandler):
        def do_POST(self):
            received["headers"] = dict(self.headers)
            received["body"] = self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(201)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), PushService)
    threading.Thread(target=server.handle_request, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}/push/abc"

    vapid_pub, vapid_priv = generate()
    status = _pywebpush_sender(
        {"endpoint": endpoint, "keys": {"p256dh": b64(browser_pub), "auth": b64(auth_secret)}},
        _json.dumps({"title": "Leave for JFK", "body": "7:30 AM", "url": "/trips/1", "tag": "reminder-1"}),
        private_key=vapid_priv,
        subject="mailto:test@example.com",
        headers={"Topic": "reminder-1", "Urgency": "high"},
    )
    server.server_close()
    assert status == 201

    h = {k.lower(): v for k, v in received["headers"].items()}
    assert h["content-encoding"] == "aes128gcm"
    assert h["topic"] == "reminder-1" and h["urgency"] == "high" and int(h["ttl"]) == 6 * 3600

    # VAPID: "vapid t=<jwt>, k=<public key>" — the push service checks this.
    scheme, params = h["authorization"].split(" ", 1)
    fields = dict(p.strip().split("=", 1) for p in params.split(","))
    assert scheme == "vapid" and fields["k"] == vapid_pub
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(vapid_pub))
    claims = pyjwt.decode(fields["t"], key=pub, algorithms=["ES256"], audience=f"http://127.0.0.1:{server.server_port}")
    assert claims["sub"] == "mailto:test@example.com"

    # The browser can decrypt it; nobody in between can.
    plain = http_ece.decrypt(received["body"], private_key=browser_key, auth_secret=auth_secret, version="aes128gcm")
    assert _json.loads(plain) == {"title": "Leave for JFK", "body": "7:30 AM", "url": "/trips/1", "tag": "reminder-1"}
