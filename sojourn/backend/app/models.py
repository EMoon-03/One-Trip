"""Data model: everything hangs off a Trip, and every Trip has an owner.

    User 1 ── * Trip
    User 1 ── * PushSubscription                            one per browser/device
    Trip 1 ── * ItineraryItem
    Trip 1 ── * Expense    (optionally -> ItineraryItem)   "dinner owns its $52"
    Trip 1 ── * Reminder   (optionally -> ItineraryItem)   "leave 2h before the flight"
    Reminder 1 ── * ReminderDelivery                        one per channel (email, push…)

TIME NOTE: see app/timeutil.py. Server-side moments are aware UTC
(UTCDateTime columns); what people type is wall-clock time + IANA zone.

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

from pydantic import EmailStr, field_validator, model_validator
from sqlalchemy import Column, DateTime, String, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

from .timeutil import UTCDateTime, is_valid_zone, utcnow


def _check_zone(value: str | None) -> str | None:
    if value is not None and not is_valid_zone(value):
        raise ValueError(f"Unknown time zone '{value}'. Use an IANA name like 'Asia/Tokyo'.")
    return value

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


class DeliveryStatus(str, Enum):
    pending = "pending"   # waiting for its first attempt or a retry
    sent = "sent"
    failed = "failed"     # gave up: permanent error or out of retries
    skipped = "skipped"   # deliberately not sent (missed window, marked done, no device)


# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------


class UserBase(SQLModel):
    email: EmailStr = Field(unique=True, index=True)
    display_name: str


class User(UserBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    hashed_password: str  # never the raw password — see app/auth.py
    email_notifications: bool = True  # send due reminders by email (if the server has SMTP)

    push_subscriptions: list["PushSubscription"] = Relationship(
        back_populates="user",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class UserCreate(UserBase):
    # bcrypt ignores bytes past 72, so cap the length instead of pretending.
    password: str = Field(min_length=8, max_length=72)


class UserRead(UserBase):
    id: int
    email_notifications: bool


class UserUpdate(SQLModel):
    display_name: str | None = None
    email_notifications: bool | None = None


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
    # The destination's IANA zone. Stop times and reminders are read in it
    # unless they name their own zone.
    timezone: str = "UTC"

    _zone = field_validator("timezone")(_check_zone)


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
    timezone: str | None = None

    _zone = field_validator("timezone")(_check_zone)


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
    # None = the trip's zone. A flight out of JFK sets America/New_York so
    # "10:30" means 10:30 in New York, not in Tokyo.
    timezone: str | None = None

    _zone = field_validator("timezone")(_check_zone)


class ItineraryItem(ItineraryItemBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    # Where lat/lng came from ('google' | 'nominatim' | 'manual') and when.
    # Set by the server (geo/refresh.py), never by the client: Google
    # coordinates must be refreshed or deleted within 30 days.
    coords_source: str | None = Field(default=None, max_length=20, index=True)
    coords_fetched_at: datetime | None = Field(default=None, sa_type=UTCDateTime)

    trip: Trip = Relationship(back_populates="items")


class ItineraryItemCreate(ItineraryItemBase):
    pass


class ItineraryItemRead(ItineraryItemBase):
    id: int
    trip_id: int
    coords_source: str | None
    coords_fetched_at: datetime | None


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
    timezone: str | None = None

    _zone = field_validator("timezone")(_check_zone)


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
#
# Two ways to say "when":
#   absolute   local_time + timezone ("Nov 9, 10:30, Tokyo time")
#   relative   offset_minutes before the linked stop starts ("2h before the flight")
# Either way remind_at (UTC) is DERIVED and recomputed whenever its inputs
# change: the stop moves, the trip's zone is corrected, the reminder is edited.

MAX_OFFSET_MINUTES = 60 * 24 * 30  # 30 days


class ReminderBase(SQLModel):
    message: str = Field(min_length=1, max_length=300)
    type: ReminderType = ReminderType.task


class Reminder(ReminderBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    activity_id: int | None = Field(default=None, foreign_key="itineraryitem.id")
    status: ReminderStatus = Field(default=ReminderStatus.pending, index=True)

    # naive wall clock in the effective zone — a plain DateTime on purpose
    local_time: datetime = Field(sa_type=DateTime(timezone=False))
    timezone: str | None = None               # None = follow the trip's zone
    offset_minutes: int | None = None         # set = relative to the stop's start
    remind_at: datetime = Field(sa_type=UTCDateTime, index=True)  # derived, UTC

    # Set (once) by the worker when it fans the reminder out to channels.
    # Cleared when the reminder is rescheduled, so it fires again.
    dispatched_at: datetime | None = Field(default=None, sa_type=UTCDateTime, index=True)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)

    trip: Trip = Relationship(back_populates="reminders")
    deliveries: list["ReminderDelivery"] = Relationship(
        back_populates="reminder",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class ReminderCreate(ReminderBase):
    # Absolute: send remind_at. A naive value ("2026-11-09T10:30") is read in
    # `timezone` (or the trip's zone); an aware value is converted.
    remind_at: datetime | None = None
    timezone: str | None = None
    # Relative: send offset_minutes + activity_id instead of remind_at.
    offset_minutes: int | None = Field(default=None, ge=0, le=MAX_OFFSET_MINUTES)
    activity_id: int | None = None

    _zone = field_validator("timezone")(_check_zone)

    @model_validator(mode="after")
    def _one_way_of_saying_when(self):
        if (self.remind_at is None) == (self.offset_minutes is None):
            raise ValueError("Give either remind_at or offset_minutes (with activity_id), not both")
        if self.offset_minutes is not None and self.activity_id is None:
            raise ValueError("offset_minutes needs activity_id: the stop it counts back from")
        return self


class ReminderUpdate(SQLModel):
    message: str | None = Field(default=None, min_length=1, max_length=300)
    type: ReminderType | None = None
    status: ReminderStatus | None = None
    activity_id: int | None = None
    remind_at: datetime | None = None
    timezone: str | None = None
    offset_minutes: int | None = Field(default=None, ge=0, le=MAX_OFFSET_MINUTES)

    _zone = field_validator("timezone")(_check_zone)


class DeliveryRead(SQLModel):
    channel: str
    status: DeliveryStatus
    attempts: int
    sent_at: datetime | None
    last_error: str | None


class ReminderRead(ReminderBase):
    id: int
    trip_id: int
    activity_id: int | None
    status: ReminderStatus
    remind_at: datetime          # UTC, e.g. "2026-11-09T01:30:00Z"
    local_time: datetime         # wall clock in effective_timezone
    timezone: str | None         # what was chosen (None = trip's zone)
    effective_timezone: str      # what it resolves to right now
    offset_minutes: int | None
    dispatched_at: datetime | None
    deliveries: list[DeliveryRead]


class ReminderDue(ReminderRead):
    """A due reminder, joined with its trip's name for the global inbox."""

    trip_name: str


# ---------------------------------------------------------------------------
# Delivery — one row per (reminder, channel); the worker's to-do list
# ---------------------------------------------------------------------------


class ReminderDelivery(SQLModel, table=True):
    # The unique constraint is the idempotency guard: even if two workers fan
    # out the same reminder at once, only one email row can exist.
    __table_args__ = (UniqueConstraint("reminder_id", "channel", name="uq_delivery_reminder_channel"),)

    id: int | None = Field(default=None, primary_key=True)
    reminder_id: int = Field(foreign_key="reminder.id", index=True)
    channel: str = Field(max_length=20)
    status: DeliveryStatus = Field(default=DeliveryStatus.pending, index=True)
    attempts: int = 0
    next_attempt_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime, index=True)
    # Lease: a worker that picks this row up owns it until claimed_until.
    # If it crashes mid-send, the lease runs out and another worker retries.
    claimed_until: datetime | None = Field(default=None, sa_type=UTCDateTime)
    last_error: str | None = Field(default=None, max_length=500)
    sent_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)

    reminder: Reminder = Relationship(back_populates="deliveries")


# ---------------------------------------------------------------------------
# Web Push subscription — one per browser that said "yes, notify me"
# ---------------------------------------------------------------------------


class PushSubscription(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    # Endpoints are long URLs; 700 chars keeps the unique index inside MySQL's limit.
    endpoint: str = Field(sa_column=Column(String(700), unique=True, nullable=False))
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)
    user_agent: str | None = Field(default=None, max_length=300)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)

    user: User = Relationship(back_populates="push_subscriptions")


class PushKeys(SQLModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class PushSubscriptionCreate(SQLModel):
    """Exactly the JSON a browser's PushSubscription.toJSON() produces."""

    endpoint: str = Field(min_length=1, max_length=700)
    keys: PushKeys

    @field_validator("endpoint")
    @classmethod
    def _https(cls, value: str) -> str:
        if not value.startswith("https://"):
            raise ValueError("Push endpoints must be https URLs")
        return value


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
