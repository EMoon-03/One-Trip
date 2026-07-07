"""Itinerary stops: nested under a trip for list/create, flat for edit/delete.

Flat routes (/api/itinerary/{id}) authorize by walking up to the owning trip.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import get_current_user
from ..database import get_session
from ..models import (
    Expense,
    ItineraryItem,
    ItineraryItemCreate,
    ItineraryItemRead,
    ItineraryItemUpdate,
    Reminder,
    User,
)
from .trips import get_owned_trip

router = APIRouter(prefix="/api", tags=["itinerary"])


def get_owned_item(item_id: int, user: User, session: Session) -> ItineraryItem:
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Itinerary item {item_id} not found")
    get_owned_trip(item.trip_id, user, session)  # 404s if it's someone else's
    return item


@router.get("/trips/{trip_id}/itinerary", response_model=list[ItineraryItemRead])
def list_items(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    get_owned_trip(trip_id, user, session)
    return session.exec(
        select(ItineraryItem)
        .where(ItineraryItem.trip_id == trip_id)
        .order_by(ItineraryItem.date, ItineraryItem.start_time)
    ).all()


@router.post("/trips/{trip_id}/itinerary", response_model=ItineraryItemRead, status_code=201)
def create_item(
    trip_id: int,
    payload: ItineraryItemCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    get_owned_trip(trip_id, user, session)
    item = ItineraryItem(**payload.model_dump(), trip_id=trip_id)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.patch("/itinerary/{item_id}", response_model=ItineraryItemRead)
def update_item(
    item_id: int,
    payload: ItineraryItemUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    item = get_owned_item(item_id, user, session)
    item.sqlmodel_update(payload.model_dump(exclude_unset=True))
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.delete("/itinerary/{item_id}", status_code=204)
def delete_item(
    item_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    item = get_owned_item(item_id, user, session)

    # Expenses/reminders that pointed at this stop survive — they just lose
    # the link. Done explicitly in the app layer so it behaves identically
    # on SQLite and MySQL (no reliance on DB-level ON DELETE SET NULL).
    for expense in session.exec(select(Expense).where(Expense.activity_id == item_id)):
        expense.activity_id = None
        session.add(expense)
    for reminder in session.exec(select(Reminder).where(Reminder.activity_id == item_id)):
        reminder.activity_id = None
        session.add(reminder)

    session.delete(item)
    session.commit()
