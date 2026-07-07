"""Expenses: money always belongs to a trip, optionally to a specific stop."""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import get_current_user
from ..database import get_session
from ..models import Expense, ExpenseCreate, ExpenseRead, ExpenseUpdate, ItineraryItem, User
from .trips import get_owned_trip

router = APIRouter(prefix="/api", tags=["expenses"])


def _validate_activity(activity_id: int | None, trip_id: int, session: Session) -> None:
    """An expense may only link to a stop on the SAME trip."""
    if activity_id is None:
        return
    item = session.get(ItineraryItem, activity_id)
    if not item or item.trip_id != trip_id:
        raise HTTPException(
            status_code=400,
            detail=f"Itinerary item {activity_id} does not belong to trip {trip_id}",
        )


def get_owned_expense(expense_id: int, user: User, session: Session) -> Expense:
    expense = session.get(Expense, expense_id)
    if not expense:
        raise HTTPException(status_code=404, detail=f"Expense {expense_id} not found")
    get_owned_trip(expense.trip_id, user, session)
    return expense


@router.get("/trips/{trip_id}/expenses", response_model=list[ExpenseRead])
def list_expenses(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    get_owned_trip(trip_id, user, session)
    return session.exec(
        select(Expense)
        .where(Expense.trip_id == trip_id)
        .order_by(Expense.spend_date.desc(), Expense.id.desc())  # type: ignore[union-attr]
    ).all()


@router.post("/trips/{trip_id}/expenses", response_model=ExpenseRead, status_code=201)
def create_expense(
    trip_id: int,
    payload: ExpenseCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    trip = get_owned_trip(trip_id, user, session)
    _validate_activity(payload.activity_id, trip_id, session)

    data = payload.model_dump()
    data["currency"] = data.get("currency") or trip.base_currency  # sensible default
    expense = Expense(**data, trip_id=trip_id)
    session.add(expense)
    session.commit()
    session.refresh(expense)
    return expense


@router.patch("/expenses/{expense_id}", response_model=ExpenseRead)
def update_expense(
    expense_id: int,
    payload: ExpenseUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    expense = get_owned_expense(expense_id, user, session)

    data = payload.model_dump(exclude_unset=True)
    if "activity_id" in data:
        _validate_activity(data["activity_id"], expense.trip_id, session)

    expense.sqlmodel_update(data)
    session.add(expense)
    session.commit()
    session.refresh(expense)
    return expense


@router.delete("/expenses/{expense_id}", status_code=204)
def delete_expense(
    expense_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    expense = get_owned_expense(expense_id, user, session)
    session.delete(expense)
    session.commit()
