"""Trip CRUD + the finance summary — now scoped to the signed-in user.

Authorization pattern: get_owned_trip answers 404 (not 403) when a trip
exists but belongs to someone else, so the API never reveals which ids
exist. Every child router funnels through it.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, func, select

from ..auth import get_current_user
from ..database import get_session
from ..models import (
    CategoryBreakdown,
    DailySpend,
    Expense,
    Trip,
    TripCreate,
    TripRead,
    TripSummary,
    TripUpdate,
    User,
)

router = APIRouter(prefix="/api/trips", tags=["trips"])


def get_owned_trip(trip_id: int, user: User, session: Session) -> Trip:
    trip = session.get(Trip, trip_id)
    if not trip or trip.user_id != user.id:
        # 404 for "not yours" too — don't leak which trip ids exist.
        raise HTTPException(status_code=404, detail=f"Trip {trip_id} not found")
    return trip


@router.get("", response_model=list[TripRead])
def list_trips(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return session.exec(
        select(Trip).where(Trip.user_id == user.id).order_by(Trip.start_date)
    ).all()


@router.post("", response_model=TripRead, status_code=201)
def create_trip(
    payload: TripCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=422, detail="end_date is before start_date")
    trip = Trip(**payload.model_dump(), user_id=user.id)
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


@router.get("/{trip_id}", response_model=TripRead)
def get_trip(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return get_owned_trip(trip_id, user, session)


@router.patch("/{trip_id}", response_model=TripRead)
def update_trip(
    trip_id: int,
    payload: TripUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    trip = get_owned_trip(trip_id, user, session)
    trip.sqlmodel_update(payload.model_dump(exclude_unset=True))
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


@router.delete("/{trip_id}", status_code=204)
def delete_trip(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    trip = get_owned_trip(trip_id, user, session)
    # ORM-level cascade ("all, delete-orphan") removes items/expenses/reminders.
    session.delete(trip)
    session.commit()


@router.get("/{trip_id}/summary", response_model=TripSummary)
def trip_summary(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    trip = get_owned_trip(trip_id, user, session)

    # --- spend by category, split planned vs actual (one GROUP BY) ---------
    rows = session.exec(
        select(Expense.category, Expense.is_planned, func.sum(Expense.amount))
        .where(Expense.trip_id == trip_id)
        .group_by(Expense.category, Expense.is_planned)
    ).all()

    buckets: dict[str, dict[str, float]] = {}
    for category, is_planned, total in rows:
        bucket = buckets.setdefault(category, {"spent": 0.0, "planned": 0.0})
        bucket["planned" if is_planned else "spent"] = round(float(total or 0), 2)

    by_category = [
        CategoryBreakdown(category=cat, spent=b["spent"], planned=b["planned"])
        for cat, b in sorted(buckets.items(), key=lambda kv: -(kv[1]["spent"] + kv[1]["planned"]))
    ]

    # --- daily actual spend + running total (one GROUP BY) -----------------
    daily_rows = session.exec(
        select(Expense.spend_date, func.sum(Expense.amount))
        .where(Expense.trip_id == trip_id, Expense.is_planned == False)  # noqa: E712
        .group_by(Expense.spend_date)
        .order_by(Expense.spend_date)
    ).all()

    daily_spend: list[DailySpend] = []
    running = 0.0
    for day, total in daily_rows:
        amount = round(float(total or 0), 2)
        running = round(running + amount, 2)
        daily_spend.append(DailySpend(date=day, amount=amount, cumulative=running))

    total_spent = round(sum(b.spent for b in by_category), 2)
    total_planned = round(sum(b.planned for b in by_category), 2)
    budget = trip.total_budget or 0.0

    return TripSummary(
        trip_id=trip_id,
        total_budget=budget,
        total_spent=total_spent,
        total_planned=total_planned,
        remaining=round(budget - total_spent, 2),
        pct_used=round(total_spent / budget * 100, 1) if budget > 0 else 0.0,
        by_category=by_category,
        daily_spend=daily_spend,
    )
