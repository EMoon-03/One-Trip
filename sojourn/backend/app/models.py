"""Data model: everything hangs off a Trip, and every Trip has an owner.

    User 1 ── * Trip
    Trip 1 ── * ItineraryItem
    Trip 1 ── * Expense    (optionally -> ItineraryItem)   "dinner owns its $52"
    Trip 1 ── * Reminder   (optionally -> ItineraryItem)   "leave 2h before the flight"

SQLModel pattern used for every entity:
    FooBase   - shared fields
    Foo       - the table (adds id, FKs, relationships)
    FooCreate - POST body
    FooRead   - response shape
    FooUpdate - PATCH body (everything optional)

MONEY NOTE: amounts are floats for v1 simplicity (easy JSON, easy charts).
Floats accumulate rounding error — before handling real money, migrate to
integer cents or DECIMAL columns. Interviewers love this question.
"""

from datetime import date as date_type
from datetime import datetime, time
from enum import Enum

from pydantic import EmailStr
from sqlmodel import Field, Relationship, SQLModel

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ItineraryCategory(str, Enum):
    flight = "flight"
    lodging = "lodging"
    food = "food"
    activity = "activity"
    transport = "transport"
    other = "other"


class ExpenseCategory(str, Enum):
    flights = "flights"
    lodging = "lodging"
    food = "food"
    activities = "activities"
    transport = "transport"
    shopping = "shopping"
    other = "other"


class ReminderType(str, Enum):
    task = "task"
    departure = "departure"
    budget = "budget"


class ReminderStatus(str, Enum):
    pending = "pending"
    done = "done"
    dismissed = "dismissed"


# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------


class UserBase(SQLModel):
    email: EmailStr = Field(unique=True, index=True)
    display_name: str


class User(UserBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    hashed_password: str  # never the raw password — see app/auth.py


class UserCreate(UserBase):
    # bcrypt ignores bytes past 72, so cap the length instead of pretending.
    password: str = Field(min_length=8, max_length=72)


class UserRead(UserBase):
    id: int


class TokenResponse(SQLModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


# ---------------------------------------------------------------------------
# Trip
# ---------------------------------------------------------------------------


class TripBase(SQLModel):
    name: str
    destination: str
    start_date: date_type
    end_date: date_type
    base_currency: str = "USD"
    total_budget: float = 0.0
    notes: str | None = None


class Trip(TripBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)  # the owner

    items: list["ItineraryItem"] = Relationship(
        back_populates="trip",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    expenses: list["Expense"] = Relationship(
        back_populates="trip",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    reminders: list["Reminder"] = Relationship(
        back_populates="trip",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class TripCreate(TripBase):
    pass


class TripRead(TripBase):
    id: int


class TripUpdate(SQLModel):
    name: str | None = None
    destination: str | None = None
    start_date: date_type | None = None
    end_date: date_type | None = None
    base_currency: str | None = None
    total_budget: float | None = None
    notes: str | None = None


# ---------------------------------------------------------------------------
# ItineraryItem — one stop on the trip
# ---------------------------------------------------------------------------


class ItineraryItemBase(SQLModel):
    date: date_type
    start_time: time | None = None
    end_time: time | None = None
    title: str
    category: ItineraryCategory = ItineraryCategory.activity
    location_name: str | None = None
    # Filled by the location search (Google Places or OSM/Nominatim):
    place_id: str | None = None
    lat: float | None = None
    lng: float | None = None
    notes: str | None = None


class ItineraryItem(ItineraryItemBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)

    trip: Trip = Relationship(back_populates="items")


class ItineraryItemCreate(ItineraryItemBase):
    pass


class ItineraryItemRead(ItineraryItemBase):
    id: int
    trip_id: int


class ItineraryItemUpdate(SQLModel):
    date: date_type | None = None
    start_time: time | None = None
    end_time: time | None = None
    title: str | None = None
    category: ItineraryCategory | None = None
    location_name: str | None = None
    place_id: str | None = None
    lat: float | None = None
    lng: float | None = None
    notes: str | None = None


# ---------------------------------------------------------------------------
# Expense — optionally owned by an itinerary stop
# ---------------------------------------------------------------------------


class ExpenseBase(SQLModel):
    description: str
    amount: float
    category: ExpenseCategory = ExpenseCategory.other
    spend_date: date_type
    is_planned: bool = False  # True = budgeted/estimated, False = actually spent


class Expense(ExpenseBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    activity_id: int | None = Field(default=None, foreign_key="itineraryitem.id")
    currency: str  # set from the trip's base_currency if the client omits it

    trip: Trip = Relationship(back_populates="expenses")


class ExpenseCreate(ExpenseBase):
    activity_id: int | None = None
    currency: str | None = None  # None -> falls back to trip.base_currency


class ExpenseRead(ExpenseBase):
    id: int
    trip_id: int
    activity_id: int | None
    currency: str


class ExpenseUpdate(SQLModel):
    description: str | None = None
    amount: float | None = None
    category: ExpenseCategory | None = None
    spend_date: date_type | None = None
    is_planned: bool | None = None
    activity_id: int | None = None
    currency: str | None = None


# ---------------------------------------------------------------------------
# Reminder — optionally attached to an itinerary stop
# ---------------------------------------------------------------------------


class ReminderBase(SQLModel):
    message: str
    remind_at: datetime
    type: ReminderType = ReminderType.task


class Reminder(ReminderBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    activity_id: int | None = Field(default=None, foreign_key="itineraryitem.id")
    status: ReminderStatus = Field(default=ReminderStatus.pending, index=True)

    trip: Trip = Relationship(back_populates="reminders")


class ReminderCreate(ReminderBase):
    activity_id: int | None = None


class ReminderRead(ReminderBase):
    id: int
    trip_id: int
    activity_id: int | None
    status: ReminderStatus


class ReminderDue(ReminderRead):
    """A due reminder, joined with its trip's name for the global inbox."""

    trip_name: str


class ReminderUpdate(SQLModel):
    message: str | None = None
    remind_at: datetime | None = None
    type: ReminderType | None = None
    status: ReminderStatus | None = None
    activity_id: int | None = None


# ---------------------------------------------------------------------------
# Summary — the finance dashboard payload (computed, not stored)
# ---------------------------------------------------------------------------


class CategoryBreakdown(SQLModel):
    category: ExpenseCategory
    spent: float
    planned: float


class DailySpend(SQLModel):
    date: date_type
    amount: float
    cumulative: float


class TripSummary(SQLModel):
    trip_id: int
    total_budget: float
    total_spent: float      # actual expenses only
    total_planned: float    # budgeted/estimated expenses
    remaining: float        # budget - spent
    pct_used: float
    by_category: list[CategoryBreakdown]
    daily_spend: list[DailySpend]
