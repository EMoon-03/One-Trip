"""Reminders — the MVP delivery model:

    compute what's due when the client asks, show an in-app inbox. Zero infra.

GET /api/reminders/due is that endpoint, now scoped to *your* trips. The
"real version" (a scheduled worker that flips statuses and pushes
notifications) is deliberately left as the next milestone — see the README.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import get_current_user
from ..database import get_session
from ..models import (
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


@router.get("/reminders/due", response_model=list[ReminderDue])
def due_reminders(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Every pending reminder whose time has arrived — across *your* trips only."""
    rows = session.exec(
        select(Reminder, Trip.name)
        .join(Trip, Reminder.trip_id == Trip.id)  # type: ignore[arg-type]
        .where(
            Trip.user_id == user.id,
            Reminder.status == ReminderStatus.pending,
            Reminder.remind_at <= datetime.now(),
        )
        .order_by(Reminder.remind_at)
    ).all()
    return [
        ReminderDue(**reminder.model_dump(), trip_name=trip_name)
        for reminder, trip_name in rows
    ]


@router.get("/trips/{trip_id}/reminders", response_model=list[ReminderRead])
def list_reminders(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    get_owned_trip(trip_id, user, session)
    return session.exec(
        select(Reminder).where(Reminder.trip_id == trip_id).order_by(Reminder.remind_at)
    ).all()


@router.post("/trips/{trip_id}/reminders", response_model=ReminderRead, status_code=201)
def create_reminder(
    trip_id: int,
    payload: ReminderCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    get_owned_trip(trip_id, user, session)
    _validate_activity(payload.activity_id, trip_id, session)
    reminder = Reminder(**payload.model_dump(), trip_id=trip_id)
    session.add(reminder)
    session.commit()
    session.refresh(reminder)
    return reminder


@router.patch("/reminders/{reminder_id}", response_model=ReminderRead)
def update_reminder(
    reminder_id: int,
    payload: ReminderUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    reminder = get_owned_reminder(reminder_id, user, session)

    data = payload.model_dump(exclude_unset=True)
    if "activity_id" in data:
        _validate_activity(data["activity_id"], reminder.trip_id, session)

    reminder.sqlmodel_update(data)
    session.add(reminder)
    session.commit()
    session.refresh(reminder)
    return reminder


@router.delete("/reminders/{reminder_id}", status_code=204)
def delete_reminder(
    reminder_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    reminder = get_owned_reminder(reminder_id, user, session)
    session.delete(reminder)
    session.commit()
