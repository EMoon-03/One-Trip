"""Seed a demo user + trip so the UI has something to show on first run.

    python -m app.seed

Prints the demo login. Dates are relative to *today* so the trip is always
upcoming and one reminder is always already due (to demo the badge). Stops
carry real coordinates so the Map tab has pins with zero configuration.
Safe to re-run.
"""

from datetime import date, datetime, time, timedelta

from sqlmodel import Session, select

from .auth import hash_password
from .database import engine, init_db
from .models import (
    Expense,
    ItineraryItem,
    Reminder,
    ReminderType,
    Trip,
    User,
)

DEMO_EMAIL = "demo@sojourn.app"
DEMO_PASSWORD = "wanderlust"
DEMO_TRIP = "Tokyo, Off the Clock"


def seed() -> None:
    init_db()
    with Session(engine) as session:
        user = session.exec(select(User).where(User.email == DEMO_EMAIL)).first()
        if not user:
            user = User(
                email=DEMO_EMAIL,
                display_name="Demo Traveler",
                hashed_password=hash_password(DEMO_PASSWORD),
            )
            session.add(user)
            session.commit()
            session.refresh(user)

        existing = session.exec(
            select(Trip).where(Trip.name == DEMO_TRIP, Trip.user_id == user.id)
        ).first()
        if existing:
            print(f'Demo trip "{DEMO_TRIP}" already exists — nothing to do.')
            print(f"Login: {DEMO_EMAIL} / {DEMO_PASSWORD}")
            return

        start = date.today() + timedelta(days=21)

        trip = Trip(
            user_id=user.id,
            name=DEMO_TRIP,
            destination="Tokyo, Japan",
            start_date=start,
            end_date=start + timedelta(days=5),
            base_currency="USD",
            total_budget=3000.0,
            notes="First solo trip. Gym clothes packed — hotel has a rack.",
        )
        session.add(trip)
        session.commit()
        session.refresh(trip)

        def day(n: int) -> date:
            return start + timedelta(days=n)

        items = [
            ItineraryItem(trip_id=trip.id, date=day(0), start_time=time(10, 30), end_time=time(15, 20),
                          title="Flight JFK → HND", category="flight", location_name="Haneda Airport",
                          lat=35.5494, lng=139.7798),
            ItineraryItem(trip_id=trip.id, date=day(0), start_time=time(17, 0),
                          title="Check in — Shibuya Stream Excel", category="lodging", location_name="Shibuya",
                          lat=35.6572, lng=139.7020),
            ItineraryItem(trip_id=trip.id, date=day(1), start_time=time(7, 30),
                          title="Breakfast at Tsukiji Outer Market", category="food", location_name="Tsukiji",
                          lat=35.6655, lng=139.7708),
            ItineraryItem(trip_id=trip.id, date=day(1), start_time=time(10, 0), end_time=time(13, 0),
                          title="teamLab Planets", category="activity", location_name="Toyosu",
                          lat=35.6491, lng=139.7897),
            ItineraryItem(trip_id=trip.id, date=day(2), start_time=time(9, 0),
                          title="Meiji Shrine + Harajuku walk", category="activity", location_name="Shibuya",
                          lat=35.6764, lng=139.6993),
            ItineraryItem(trip_id=trip.id, date=day(3), start_time=time(8, 15), end_time=time(19, 0),
                          title="Day trip: Hakone loop", category="transport", location_name="Hakone",
                          lat=35.2323, lng=139.1069,
                          notes="Buy the Hakone Free Pass at Shinjuku."),
            ItineraryItem(trip_id=trip.id, date=day(4), start_time=time(19, 30),
                          title="Omakase dinner (booked)", category="food", location_name="Ginza",
                          lat=35.6717, lng=139.7650),
        ]
        session.add_all(items)
        session.commit()
        for item in items:
            session.refresh(item)

        flight, hotel, tsukiji, teamlab, _, hakone, omakase = items

        expenses = [
            # already paid (actual)
            Expense(trip_id=trip.id, activity_id=flight.id, description="Round-trip airfare",
                    amount=890.00, currency="USD", category="flights", spend_date=date.today() - timedelta(days=9)),
            Expense(trip_id=trip.id, activity_id=teamlab.id, description="teamLab tickets ×1",
                    amount=27.50, currency="USD", category="activities", spend_date=date.today() - timedelta(days=4)),
            Expense(trip_id=trip.id, description="Travel insurance",
                    amount=64.00, currency="USD", category="other", spend_date=date.today() - timedelta(days=4)),
            Expense(trip_id=trip.id, activity_id=omakase.id, description="Omakase deposit",
                    amount=80.00, currency="USD", category="food", spend_date=date.today() - timedelta(days=1)),
            # budgeted (planned)
            Expense(trip_id=trip.id, activity_id=hotel.id, description="Hotel, 5 nights",
                    amount=780.00, currency="USD", category="lodging", spend_date=day(0), is_planned=True),
            Expense(trip_id=trip.id, activity_id=hakone.id, description="Hakone Free Pass",
                    amount=42.00, currency="USD", category="transport", spend_date=day(3), is_planned=True),
            Expense(trip_id=trip.id, description="Food budget (rest of trip)",
                    amount=400.00, currency="USD", category="food", spend_date=day(1), is_planned=True),
            Expense(trip_id=trip.id, description="Shopping — Nakano Broadway",
                    amount=200.00, currency="USD", category="shopping", spend_date=day(2), is_planned=True),
        ]
        session.add_all(expenses)

        reminders = [
            Reminder(trip_id=trip.id, message="Book Shinkansen seats for Hakone day",
                     remind_at=datetime.now() - timedelta(hours=1),  # already due -> demos the badge
                     type=ReminderType.task, activity_id=hakone.id),
            Reminder(trip_id=trip.id, message="Online check-in opens (24h before flight)",
                     remind_at=datetime.combine(day(0) - timedelta(days=1), time(10, 30)),
                     type=ReminderType.departure, activity_id=flight.id),
            Reminder(trip_id=trip.id, message="Reconfirm omakase reservation",
                     remind_at=datetime.combine(day(3), time(12, 0)),
                     type=ReminderType.task, activity_id=omakase.id),
            Reminder(trip_id=trip.id, message="Halfway checkpoint: review food budget",
                     remind_at=datetime.combine(day(2), time(20, 0)),
                     type=ReminderType.budget),
        ]
        session.add_all(reminders)
        session.commit()

        print(f'Seeded "{DEMO_TRIP}" (trip #{trip.id}): '
              f"{len(items)} stops, {len(expenses)} expenses, {len(reminders)} reminders.")
        print(f"Login: {DEMO_EMAIL} / {DEMO_PASSWORD}")


if __name__ == "__main__":
    seed()
