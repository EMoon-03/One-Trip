"""Reminder delivery: what the worker does on every tick.

Two phases, each safe to run in several processes at once:

1. FAN-OUT  (schedule_due)
   Find pending reminders whose time has come and that haven't been
   dispatched. Claim each with a conditional UPDATE
       ... SET dispatched_at = now WHERE id = ? AND dispatched_at IS NULL
   Only the process whose UPDATE touched a row continues; it writes one
   ReminderDelivery row per channel the user wants. A unique
   (reminder_id, channel) constraint backs this up.

2. DELIVER  (deliver_pending)
   Find delivery rows that are pending, due for an attempt, and not leased.
   Lease one with another conditional UPDATE (claimed_until = now + lease),
   send it, then record the outcome:
       sent       -> done
       transient  -> retry later with exponential backoff, up to max_attempts
       permanent  -> failed
   If the process dies mid-send, the lease expires and someone retries.

The guarantee is AT-LEAST-ONCE: a crash between "the email left" and "we
wrote sent" can produce a second email. Exactly-once delivery over a network
isn't possible; the lease keeps that window to one send, and Web Push's
Topic header collapses a duplicate that is still queued.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import or_, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from .models import (
    DeliveryStatus,
    ItineraryItem,
    Reminder,
    ReminderDelivery,
    ReminderStatus,
    Trip,
    User,
)
from .notify.channels import (
    Channel,
    Message,
    NothingToDo,
    PermanentError,
    TransientError,
    all_channels,
)
from .notify.settings import NotifySettings, get_settings
from .scheduling import effective_zone
from .timeutil import utc_to_wall, utcnow

log = logging.getLogger("onetrip.worker")

BATCH = 100


@dataclass
class TickResult:
    dispatched: int = 0
    sent: int = 0
    retried: int = 0
    failed: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return any((self.dispatched, self.sent, self.retried, self.failed, self.skipped))


# --------------------------------------------------------------- message --


def _zone_label(zone_name: str) -> str:
    # "America/New_York" -> "New York time"; "UTC" -> "UTC"
    if "/" not in zone_name:
        return zone_name
    return zone_name.rsplit("/", 1)[1].replace("_", " ") + " time"


def build_message(reminder: Reminder, trip: Trip, stop: ItineraryItem | None, settings: NotifySettings) -> Message:
    zone_name = effective_zone(reminder, trip, stop)
    local = utc_to_wall(reminder.remind_at, zone_name)
    when = f"{local:%a, %b} {local.day}, {local:%I:%M %p}".replace(" 0", " ")
    parts = [trip.name, f"{when} ({_zone_label(zone_name)})"]
    if stop is not None:
        parts.append(f"for {stop.title}")
    return Message(
        title=reminder.message,
        body=" · ".join(parts),
        url=f"{settings.app_url}/trips/{trip.id}",
        tag=f"reminder-{reminder.id}",
    )


# ---------------------------------------------------------------- fan-out --


def schedule_due(session: Session, now: datetime, settings: NotifySettings, channels: list[Channel]) -> TickResult:
    result = TickResult()
    candidates = session.exec(
        select(Reminder.id)
        .where(
            Reminder.status == ReminderStatus.pending,
            Reminder.dispatched_at.is_(None),  # type: ignore[union-attr]
            Reminder.remind_at <= now,
        )
        .order_by(Reminder.remind_at)
        .limit(BATCH)
    ).all()

    stale_before = now - timedelta(hours=settings.stale_after_hours)
    for reminder_id in candidates:
        claimed = session.execute(
            update(Reminder)
            .where(Reminder.id == reminder_id, Reminder.dispatched_at.is_(None))  # type: ignore[union-attr]
            .values(dispatched_at=now)
        ).rowcount
        if claimed != 1:
            session.rollback()
            continue  # another worker got it first

        reminder = session.get(Reminder, reminder_id)
        trip = session.get(Trip, reminder.trip_id) if reminder else None
        user = session.get(User, trip.user_id) if trip else None
        if reminder is None or trip is None or user is None:
            session.commit()
            continue

        # Missed by a wide margin (the worker was down, or the reminder was
        # set in the past): don't blast an old reminder at the user.
        missed = reminder.remind_at < stale_before
        for channel in channels:
            if not (channel.available() and channel.wants(user, session)):
                continue
            session.add(
                ReminderDelivery(
                    reminder_id=reminder.id,  # type: ignore[arg-type]
                    channel=channel.name,
                    status=DeliveryStatus.skipped if missed else DeliveryStatus.pending,
                    last_error="Missed: it was more than "
                    f"{settings.stale_after_hours}h overdue when the worker saw it"
                    if missed
                    else None,
                    next_attempt_at=now,
                )
            )
        try:
            session.commit()
            result.dispatched += 1
        except IntegrityError:
            session.rollback()  # rows already exist — someone else fanned out

    return result


# ---------------------------------------------------------------- deliver --


def backoff(attempt: int) -> timedelta:
    """1, 2, 4, 8 … minutes, capped at an hour."""
    return timedelta(minutes=min(2 ** (attempt - 1), 60))


def deliver_pending(session: Session, now: datetime, settings: NotifySettings, channels: list[Channel]) -> TickResult:
    result = TickResult()
    by_name = {c.name: c for c in channels}

    candidates = session.exec(
        select(ReminderDelivery.id)
        .where(
            ReminderDelivery.status == DeliveryStatus.pending,
            ReminderDelivery.next_attempt_at <= now,
            or_(ReminderDelivery.claimed_until.is_(None), ReminderDelivery.claimed_until < now),  # type: ignore[union-attr]
        )
        .order_by(ReminderDelivery.next_attempt_at)
        .limit(BATCH)
    ).all()

    for delivery_id in candidates:
        claimed = session.execute(
            update(ReminderDelivery)
            .where(
                ReminderDelivery.id == delivery_id,
                ReminderDelivery.status == DeliveryStatus.pending,
                or_(ReminderDelivery.claimed_until.is_(None), ReminderDelivery.claimed_until < now),  # type: ignore[union-attr]
            )
            .values(
                claimed_until=now + timedelta(seconds=settings.lease_seconds),
                attempts=ReminderDelivery.attempts + 1,
            )
        ).rowcount
        session.commit()
        if claimed != 1:
            continue

        delivery = session.get(ReminderDelivery, delivery_id)
        assert delivery is not None
        session.refresh(delivery)
        reminder = session.get(Reminder, delivery.reminder_id)
        trip = session.get(Trip, reminder.trip_id) if reminder else None
        user = session.get(User, trip.user_id) if trip else None
        channel = by_name.get(delivery.channel)

        def finish(status: DeliveryStatus, error: str | None = None) -> None:
            delivery.status = status
            delivery.last_error = error[:500] if error else None
            delivery.claimed_until = None
            if status == DeliveryStatus.sent:
                delivery.sent_at = utcnow()
            session.add(delivery)
            session.commit()

        if reminder is None or trip is None or user is None:
            finish(DeliveryStatus.skipped, "The reminder no longer exists")
            result.skipped += 1
            continue
        if reminder.status != ReminderStatus.pending:
            finish(DeliveryStatus.skipped, f"Marked {reminder.status.value} before it was sent")
            result.skipped += 1
            continue
        if channel is None or not channel.available():
            finish(DeliveryStatus.skipped, f"The {delivery.channel} channel is no longer set up")
            result.skipped += 1
            continue

        stop = session.get(ItineraryItem, reminder.activity_id) if reminder.activity_id else None
        try:
            channel.send(build_message(reminder, trip, stop, settings), user, session)
        except NothingToDo as exc:
            finish(DeliveryStatus.skipped, str(exc))
            result.skipped += 1
        except PermanentError as exc:
            finish(DeliveryStatus.failed, str(exc))
            result.failed += 1
            result.errors.append(f"{delivery.channel}: {exc}")
        except TransientError as exc:
            if delivery.attempts >= settings.max_attempts:
                finish(DeliveryStatus.failed, f"Gave up after {delivery.attempts} tries: {exc}")
                result.failed += 1
            else:
                delivery.next_attempt_at = now + backoff(delivery.attempts)
                finish(DeliveryStatus.pending, str(exc))
                result.retried += 1
            result.errors.append(f"{delivery.channel}: {exc}")
        except Exception as exc:  # a bug in a channel must not kill the worker
            log.exception("unexpected error delivering %s", delivery_id)
            delivery.next_attempt_at = now + backoff(delivery.attempts)
            finish(
                DeliveryStatus.failed if delivery.attempts >= settings.max_attempts else DeliveryStatus.pending,
                f"Unexpected error: {exc}",
            )
            result.retried += 1
        else:
            finish(DeliveryStatus.sent)
            result.sent += 1

    return result


# ------------------------------------------------------------------- tick --


def tick(
    session: Session,
    now: datetime | None = None,
    settings: NotifySettings | None = None,
    channels: list[Channel] | None = None,
) -> TickResult:
    """One pass: fan out what's due, then attempt what's pending."""
    now = now or utcnow()
    settings = settings or get_settings()
    channels = channels if channels is not None else all_channels(settings)

    fan = schedule_due(session, now, settings, channels)
    sent = deliver_pending(session, now, settings, channels)
    return TickResult(
        dispatched=fan.dispatched,
        sent=sent.sent,
        retried=sent.retried,
        failed=sent.failed,
        skipped=sent.skipped,
        errors=fan.errors + sent.errors,
    )
