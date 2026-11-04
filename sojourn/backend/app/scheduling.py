"""Turning what a person said into the UTC moment the worker acts on.

Every write path that can change "when" funnels through `schedule()`:
creating or editing a reminder, moving its stop, fixing the trip's zone.
If the computed moment changes, the reminder is re-armed (its old delivery
rows are dropped and dispatched_at is cleared) so it fires again at the new
time instead of being treated as already sent.
"""

from datetime import timedelta

from sqlmodel import Session, select

from .models import ItineraryItem, Reminder, ReminderDelivery, Trip
from .timeutil import combine_wall, utc_to_wall, wall_to_utc


class ScheduleError(ValueError):
    """The inputs can't produce a time (e.g. the stop has no start time)."""


def stop_zone(stop: ItineraryItem, trip: Trip) -> str:
    return stop.timezone or trip.timezone


def stop_start_utc(stop: ItineraryItem, trip: Trip):
    """When a stop starts, as aware UTC — or None if it has no start time."""
    if stop.start_time is None:
        return None
    return wall_to_utc(combine_wall(stop.date, stop.start_time), stop_zone(stop, trip))


def effective_zone(reminder: Reminder, trip: Trip, stop: ItineraryItem | None = None) -> str:
    """The zone a reminder's wall-clock time is expressed in.

    absolute -> its own zone, else the trip's
    relative -> the stop's zone (so "2h before a 10:30 JFK departure" reads 8:30 New York)
    """
    if reminder.timezone:
        return reminder.timezone
    if reminder.offset_minutes is not None and stop is not None:
        return stop_zone(stop, trip)
    return trip.timezone


def _rearm(reminder: Reminder, session: Session) -> None:
    reminder.dispatched_at = None
    for delivery in session.exec(
        select(ReminderDelivery).where(ReminderDelivery.reminder_id == reminder.id)
    ).all():
        session.delete(delivery)


def schedule(reminder: Reminder, trip: Trip, session: Session) -> bool:
    """Recompute remind_at (and local_time) from the reminder's inputs.

    Expects reminder.local_time to hold the wall clock for absolute
    reminders. Returns True if the UTC moment changed (and re-arms it).
    """
    previous = reminder.remind_at if reminder.id is not None else None

    if reminder.offset_minutes is not None:
        stop = session.get(ItineraryItem, reminder.activity_id) if reminder.activity_id else None
        if stop is None or stop.trip_id != trip.id:
            raise ScheduleError("A 'before the stop' reminder needs a stop on this trip")
        start = stop_start_utc(stop, trip)
        if start is None:
            raise ScheduleError(f"'{stop.title}' has no start time, so there's nothing to count back from")
        reminder.remind_at = start - timedelta(minutes=reminder.offset_minutes)
        reminder.local_time = utc_to_wall(reminder.remind_at, effective_zone(reminder, trip, stop))
    else:
        reminder.remind_at = wall_to_utc(reminder.local_time, effective_zone(reminder, trip))

    changed = previous is not None and previous != reminder.remind_at
    if changed:
        _rearm(reminder, session)
    return changed


def reschedule_for_stop(stop: ItineraryItem, trip: Trip, session: Session) -> None:
    """A stop's date/time/zone changed: move the reminders that count back from it.

    If the stop lost its start time, its relative reminders keep their
    current moment and become ordinary absolute reminders.
    """
    linked = session.exec(
        select(Reminder).where(Reminder.activity_id == stop.id, Reminder.offset_minutes.is_not(None))  # type: ignore[union-attr]
    ).all()
    for reminder in linked:
        if stop.start_time is None:
            freeze(reminder, trip, stop)
        else:
            schedule(reminder, trip, session)
        session.add(reminder)


def reschedule_for_trip(trip: Trip, session: Session) -> None:
    """The trip's zone changed: every reminder that reads times in it moves."""
    for reminder in session.exec(select(Reminder).where(Reminder.trip_id == trip.id)).all():
        try:
            schedule(reminder, trip, session)
        except ScheduleError:
            continue  # a relative reminder whose stop lost its time: leave it be
        session.add(reminder)


def freeze(reminder: Reminder, trip: Trip, stop: ItineraryItem | None) -> None:
    """Turn a relative reminder into an absolute one at its current moment."""
    zone_name = effective_zone(reminder, trip, stop)
    reminder.timezone = zone_name
    reminder.offset_minutes = None
    reminder.local_time = utc_to_wall(reminder.remind_at, zone_name)
