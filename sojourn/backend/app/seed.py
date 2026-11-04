"""Seed a demo user + trip so the UI has something to show on first run.

    python -m app.seed

Prints the demo login. Dates are relative to *today* so the trip is always
upcoming and one reminder is always already due (to demo the bell and the
worker). Stops carry real coordinates so the Map tab has pins with zero
configuration. The trip runs on Tokyo time, the outbound flight on New York
time, and two reminders count back from that flight — the time-zone
features in one example. Safe to re-run.
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
from .geo.refresh import stamp_coords
from .scheduling import schedule
from .timeutil import utc_to_wall, utcnow

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
            end_date=start + timedelta(days=6),
            base_currency="USD",
            total_budget=3000.0,
            notes="First solo trip. Gym clothes packed — hotel has a rack.",
            timezone="Asia/Tokyo",
        )
        session.add(trip)
        session.commit()
        session.refresh(trip)

        def day(n: int) -> date:
            return start + timedelta(days=n)

        items = [
            # Departs on New York time; lands next afternoon Tokyo time.
            ItineraryItem(trip_id=trip.id, date=day(0), start_time=time(10, 30),
                          title="Flight JFK → HND", category="flight", location_name="JFK Terminal 1",
                          lat=40.6413, lng=-73.7781, timezone="America/New_York",
                          notes="Lands at Haneda 2:20 PM the next day."),
            ItineraryItem(trip_id=trip.id, date=day(1), start_time=time(17, 0),
                          title="Check in — Shibuya Stream Excel", category="lodging", location_name="Shibuya",
                          lat=35.6572, lng=139.7020),
            ItineraryItem(trip_id=trip.id, date=day(2), start_time=time(7, 30),
                          title="Breakfast at Tsukiji Outer Market", category="food", location_name="Tsukiji",
                          lat=35.6655, lng=139.7708),
            ItineraryItem(trip_id=trip.id, date=day(2), start_time=time(10, 0), end_time=time(13, 0),
                          title="teamLab Planets", category="activity", location_name="Toyosu",
                          lat=35.6491, lng=139.7897),
            ItineraryItem(trip_id=trip.id, date=day(3), start_time=time(9, 0),
                          title="Meiji Shrine + Harajuku walk", category="activity", location_name="Shibuya",
                          lat=35.6764, lng=139.6993),
            ItineraryItem(trip_id=trip.id, date=day(4), start_time=time(8, 15), end_time=time(19, 0),
                          title="Day trip: Hakone loop", category="transport", location_name="Hakone",
                          lat=35.2323, lng=139.1069,
                          notes="Buy the Hakone Free Pass at Shinjuku."),
            ItineraryItem(trip_id=trip.id, date=day(5), start_time=time(19, 30),
                          title="Omakase dinner (booked)", category="food", location_name="Ginza",
                          lat=35.6717, lng=139.7650),
        ]
        for item in items:
            stamp_coords(item, utcnow())  # hand-entered coordinates: 'manual', no expiry
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

        # Wall-clock intent; scheduling.schedule() derives the UTC moment.
        home = "America/New_York"
        due_soon = utc_to_wall(utcnow() - timedelta(minutes=5), home)  # already due -> demos bell + worker
        reminders = [
            Reminder(trip_id=trip.id, message="Book Shinkansen seats for the Hakone day",
                     type=ReminderType.task, activity_id=hakone.id,
                     timezone=home, local_time=due_soon),
            Reminder(trip_id=trip.id, message="Online check-in opens",
                     type=ReminderType.departure, activity_id=flight.id,
                     offset_minutes=24 * 60),                      # 24h before the flight, New York time
            Reminder(trip_id=trip.id, message="Leave for JFK",
                     type=ReminderType.departure, activity_id=flight.id,
                     offset_minutes=3 * 60),                       # 3h before the flight
            Reminder(trip_id=trip.id, message="Reconfirm omakase reservation",
                     type=ReminderType.task, activity_id=omakase.id,
                     local_time=datetime.combine(day(4), time(12, 0))),   # Tokyo time (trip zone)
            Reminder(trip_id=trip.id, message="Halfway checkpoint: review food budget",
                     type=ReminderType.budget,
                     local_time=datetime.combine(day(3), time(20, 0))),
        ]
        for reminder in reminders:
            if reminder.offset_minutes is not None:
                reminder.local_time = datetime.min  # placeholder; schedule() fills it in
            schedule(reminder, trip, session)
        session.add_all(reminders)
        session.commit()

        _seed_past_trip(session, user)

        print(f'Seeded "{DEMO_TRIP}" (trip #{trip.id}): '
              f"{len(items)} stops, {len(expenses)} expenses, {len(reminders)} reminders, "
              "plus a past trip.")
        print(f"Login: {DEMO_EMAIL} / {DEMO_PASSWORD}")


def _seed_past_trip(session: Session, user: User) -> None:
    """A finished weekend, so the home page shows past trips too."""
    start = date.today() - timedelta(days=62)
    trip = Trip(
        user_id=user.id,
        name="Seoul, Long Weekend",
        destination="Seoul, South Korea",
        start_date=start,
        end_date=start + timedelta(days=3),
        base_currency="USD",
        total_budget=1200.0,
        timezone="Asia/Seoul",
    )
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stops = [
        ItineraryItem(trip_id=trip.id, date=start, start_time=time(14, 0), title="Check in — Myeongdong",
                      category="lodging", location_name="Myeongdong", lat=37.5636, lng=126.9827),
        ItineraryItem(trip_id=trip.id, date=start + timedelta(days=1), start_time=time(10, 0),
                      title="Gyeongbokgung Palace", category="activity", location_name="Jongno",
                      lat=37.5796, lng=126.9770),
        ItineraryItem(trip_id=trip.id, date=start + timedelta(days=1), start_time=time(19, 0),
                      title="Gwangjang Market dinner", category="food", location_name="Jongno",
                      lat=37.5700, lng=126.9996),
        ItineraryItem(trip_id=trip.id, date=start + timedelta(days=2), start_time=time(9, 30),
                      title="Bukhansan hike", category="activity", location_name="Bukhansan",
                      lat=37.6587, lng=126.9779),
    ]
    for item in stops:
        stamp_coords(item, utcnow())
    session.add_all(stops)
    session.add_all([
        Expense(trip_id=trip.id, description="Hotel, 3 nights", amount=420.0, currency="USD",
                category="lodging", spend_date=start),
        Expense(trip_id=trip.id, description="Market + meals", amount=186.4, currency="USD",
                category="food", spend_date=start + timedelta(days=1)),
    ])
    session.commit()


if __name__ == "__main__":
    seed()
