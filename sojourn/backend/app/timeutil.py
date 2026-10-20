"""Time handling, in one place.

The rule the whole app follows:

    * A moment that the SERVER acts on (when to send a reminder, when a
      delivery was attempted) is stored as an aware UTC datetime.
    * What a PERSON typed ("10:30 on Nov 9, Tokyo time") is stored as a
      wall-clock time plus the IANA zone it belongs to. That pair is the
      source of truth; the UTC moment is derived from it.

Why keep both? Because the intent is the wall clock. If you fix a trip's
time zone after the fact (it was left on UTC by mistake), "10:30 in Tokyo"
should stay 10:30 in Tokyo and the UTC moment should move — not the other
way round.
"""

from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import types


class UTCDateTime(types.TypeDecorator):
    """A DateTime column that only accepts aware datetimes and always hands
    back aware UTC datetimes.

    It stores naive UTC, because SQLite and MySQL DATETIME columns have no
    concept of an offset. Newer SQLModel releases ship a similar type; this
    one is ours so behaviour doesn't change with the library version.
    """

    impl = types.DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.utcoffset() is None:
            raise ValueError("UTCDateTime needs an aware datetime (got a naive one)")
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc)

    def coerce_compared_value(self, op, value):
        # Comparisons (remind_at <= now) go through the same conversion.
        return self


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def zone(name: str) -> ZoneInfo:
    """ZoneInfo for an IANA name, or ValueError with a readable message."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValueError(f"Unknown time zone '{name}'. Use an IANA name like 'Asia/Tokyo'.")


def is_valid_zone(name: str) -> bool:
    try:
        zone(name)
        return True
    except ValueError:
        return False


def wall_to_utc(local: datetime, tz_name: str) -> datetime:
    """Naive wall-clock time in `tz_name` -> aware UTC.

    DST edges: an ambiguous time (clocks go back, 1:30 happens twice) resolves
    to the first occurrence; a non-existent time (clocks jump forward, 2:30
    never happens) is shifted by the gap, like most calendar apps do.
    """
    if local.tzinfo is not None:
        raise ValueError("wall_to_utc expects a naive wall-clock datetime")
    return local.replace(tzinfo=zone(tz_name)).astimezone(timezone.utc)


def utc_to_wall(moment: datetime, tz_name: str) -> datetime:
    """Aware moment -> naive wall-clock time in `tz_name`."""
    return moment.astimezone(zone(tz_name)).replace(tzinfo=None)


def to_wall(value: datetime, tz_name: str) -> datetime:
    """Accept either input style from the API.

    naive  '2026-11-09T10:30'        -> already wall-clock in tz_name
    aware  '2026-11-09T01:30:00Z'    -> converted into tz_name's wall clock
    Seconds are dropped: reminders are minute-precision.
    """
    wall = value if value.tzinfo is None else utc_to_wall(value, tz_name)
    return wall.replace(second=0, microsecond=0)


def combine_wall(day: date, at: time) -> datetime:
    return datetime.combine(day, at.replace(tzinfo=None))
