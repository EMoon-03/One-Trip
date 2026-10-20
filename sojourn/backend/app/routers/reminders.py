"""Reminders.

Scheduling (what UTC moment a reminder means) lives in app/scheduling.py;
delivery (actually telling the person) lives in app/delivery.py and runs in
the worker. This router only validates input and stores intent.

GET /api/reminders/due still powers the in-app bell: it's the fallback
channel that works with zero configuration.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import get_current_user
from ..database import get_session
from ..models import (
    DeliveryRead,
    ItineraryItem,
    Reminder,
    ReminderCreate,
    ReminderDue,
    ReminderRead,
    ReminderStatus,
    ReminderUpdate,
    Trip,
    User,
)
from ..scheduling import ScheduleError, effective_zone, freeze, schedule
from ..timeutil import to_wall, utcnow
from .trips import get_owned_trip

router = APIRouter(prefix="/api", tags=["reminders"])


def _validate_activity(activity_id: int | None, trip_id: int, session: Session) -> None:
    if activity_id is None:
        return
    item = session.get(ItineraryItem, activity_id)
    if not item or item.trip_id != trip_id:
        raise HTTPException(
            status_code=400,
            detail=f"Itinerary item {activity_id} does not belong to trip {trip_id}",
        )


def get_owned_reminder(reminder_id: int, user: User, session: Session) -> Reminder:
    reminder = session.get(Reminder, reminder_id)
    if not reminder:
        raise HTTPException(status_code=404, detail=f"Reminder {reminder_id} not found")
    get_owned_trip(reminder.trip_id, user, session)
    return reminder


def to_read(reminder: Reminder, trip: Trip, session: Session) -> ReminderRead:
    stop = session.get(ItineraryItem, reminder.activity_id) if reminder.activity_id else None
    return ReminderRead(
        id=reminder.id,  # type: ignore[arg-type]
        trip_id=reminder.trip_id,
        activity_id=reminder.activity_id,
        message=reminder.message,
        type=reminder.type,
        status=reminder.status,
        remind_at=reminder.remind_at,
        local_time=reminder.local_time,
        timezone=reminder.timezone,
        effective_timezone=effective_zone(reminder, trip, stop),
        offset_minutes=reminder.offset_minutes,
        dispatched_at=reminder.dispatched_at,
        deliveries=[
            DeliveryRead.model_validate(d, from_attributes=True)
            for d in sorted(reminder.deliveries, key=lambda d: d.channel)
        ],
    )


def _schedule_or_422(reminder: Reminder, trip: Trip, session: Session) -> None:
    try:
        schedule(reminder, trip, session)
    except ScheduleError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/reminders/due", response_model=list[ReminderDue])
def due_reminders(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Every pending reminder whose time has arrived — across *your* trips only."""
    rows = session.exec(
        select(Reminder, Trip)
        .join(Trip, Reminder.trip_id == Trip.id)  # type: ignore[arg-type]
        .where(
            Trip.user_id == user.id,
            Reminder.status == ReminderStatus.pending,
            Reminder.remind_at <= utcnow(),
        )
        .order_by(Reminder.remind_at)
    ).all()
    return [
        ReminderDue(**to_read(reminder, trip, session).model_dump(), trip_name=trip.name)
        for reminder, trip in rows
    ]


@router.get("/trips/{trip_id}/reminders", response_model=list[ReminderRead])
def list_reminders(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    trip = get_owned_trip(trip_id, user, session)
    reminders = session.exec(
        select(Reminder).where(Reminder.trip_id == trip_id).order_by(Reminder.remind_at)
    ).all()
    return [to_read(r, trip, session) for r in reminders]


@router.post("/trips/{trip_id}/reminders", response_model=ReminderRead, status_code=201)
def create_reminder(
    trip_id: int,
    payload: ReminderCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    trip = get_owned_trip(trip_id, user, session)
    _validate_activity(payload.activity_id, trip_id, session)

    reminder = Reminder(
        trip_id=trip_id,
        message=payload.message,
        type=payload.type,
        activity_id=payload.activity_id,
        offset_minutes=payload.offset_minutes,
        timezone=payload.timezone if payload.offset_minutes is None else None,
    )
    if payload.remind_at is not None:
        reminder.local_time = to_wall(payload.remind_at, effective_zone(reminder, trip))
    _schedule_or_422(reminder, trip, session)

    session.add(reminder)
    session.commit()
    session.refresh(reminder)
    return to_read(reminder, trip, session)


@router.patch("/reminders/{reminder_id}", response_model=ReminderRead)
def update_reminder(
    reminder_id: int,
    payload: ReminderUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    reminder = get_owned_reminder(reminder_id, user, session)
    trip = session.get(Trip, reminder.trip_id)
    assert trip is not None

    data = payload.model_dump(exclude_unset=True)
    if "activity_id" in data:
        _validate_activity(data["activity_id"], reminder.trip_id, session)
    if data.get("remind_at") is not None and data.get("offset_minutes") is not None:
        raise HTTPException(status_code=422, detail="Give either remind_at or offset_minutes, not both")

    for key in ("message", "type", "status", "activity_id"):
        if key in data:
            setattr(reminder, key, data[key])

    if data.get("offset_minutes") is not None:
        # switch to (or stay) relative
        reminder.offset_minutes = data["offset_minutes"]
        reminder.timezone = None
    elif data.get("remind_at") is not None:
        # switch to (or stay) absolute
        reminder.offset_minutes = None
        if "timezone" in data:
            reminder.timezone = data["timezone"]
        reminder.local_time = to_wall(data["remind_at"], effective_zone(reminder, trip))
    elif "timezone" in data and reminder.offset_minutes is None:
        # same wall clock, different zone ("I meant 9:00 *my* time")
        reminder.timezone = data["timezone"]
    elif reminder.offset_minutes is not None and "activity_id" in data and data["activity_id"] is None:
        # unlinked from its stop: keep the moment, drop the relation
        freeze(reminder, trip, None)

    if reminder.offset_minutes is not None and reminder.activity_id is None:
        raise HTTPException(status_code=422, detail="offset_minutes needs a stop (activity_id)")

    _schedule_or_422(reminder, trip, session)

    session.add(reminder)
    session.commit()
    session.refresh(reminder)
    return to_read(reminder, trip, session)


@router.delete("/reminders/{reminder_id}", status_code=204)
def delete_reminder(
    reminder_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    reminder = get_owned_reminder(reminder_id, user, session)
    session.delete(reminder)
    session.commit()
