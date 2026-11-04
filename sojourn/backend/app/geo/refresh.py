"""The 30-day rule for coordinates that came from Google.

Google's Places terms: latitude/longitude from the Places API may be cached
for up to 30 consecutive days, then must be deleted. Place IDs may be kept.
So for every stop whose coordinates came from Google we record when they
were fetched, and the worker:

    from day 25   re-fetches them with Place Details (Essentials tier)
    at day 30     deletes them if re-fetching failed (place_id stays, so a
                  later refresh can restore them)

OpenStreetMap (Nominatim) data and coordinates typed in by hand have no such
limit and are never touched.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import or_
from sqlmodel import Session, select

from ..models import ItineraryItem
from . import GeoError, google
from .providers import server_key

log = logging.getLogger("onetrip.geo")

REFRESH_AFTER = timedelta(days=25)
DELETE_AFTER = timedelta(days=30)
BATCH = 50


def coords_source_for(place_id: str | None) -> str:
    """Where coordinates attached to this place_id came from."""
    if place_id and place_id.startswith("osm:"):
        return "nominatim"
    if place_id:
        return "google"
    return "manual"


def stamp_coords(item: ItineraryItem, now: datetime, previous: tuple | None = None) -> None:
    """Record provenance whenever a stop's coordinates are set or change.

    `previous` is (lat, lng, place_id) before the edit; None for a new stop.
    """
    if item.lat is None or item.lng is None:
        item.coords_source = coords_source_for(item.place_id) if item.place_id else None
        item.coords_fetched_at = None
        return
    if previous is not None and previous == (item.lat, item.lng, item.place_id):
        return  # untouched: keep the original fetch time
    item.coords_source = coords_source_for(item.place_id)
    item.coords_fetched_at = now


@dataclass
class RefreshResult:
    refreshed: int = 0
    deleted: int = 0
    failed: int = 0

    def __bool__(self) -> bool:
        return any((self.refreshed, self.deleted, self.failed))


def refresh_google_coords(session: Session, now: datetime) -> RefreshResult:
    result = RefreshResult()
    can_refresh = bool(server_key())
    due = session.exec(
        select(ItineraryItem)
        .where(
            ItineraryItem.coords_source == "google",
            or_(
                ItineraryItem.coords_fetched_at.is_(None),  # type: ignore[union-attr]
                ItineraryItem.coords_fetched_at <= now - REFRESH_AFTER,  # type: ignore[operator]
            ),
        )
        .limit(BATCH)
    ).all()

    for item in due:
        has_coords = item.lat is not None and item.lng is not None
        expired = item.coords_fetched_at is None or item.coords_fetched_at <= now - DELETE_AFTER
        if not has_coords and not can_refresh:
            continue  # already deleted, nothing to restore it with

        if can_refresh and item.place_id:
            try:
                fresh = google.details(item.place_id)
                item.lat, item.lng = fresh["lat"], fresh["lng"]
                item.coords_fetched_at = now
                result.refreshed += 1
                session.add(item)
                continue
            except GeoError as exc:
                log.warning("couldn't refresh coordinates for stop %s: %s", item.id, exc)
                if exc.status == 404:
                    expired = True  # the place no longer exists at Google
                else:
                    result.failed += 1

        if expired and has_coords:
            item.lat = item.lng = None
            item.coords_fetched_at = None
            result.deleted += 1
            session.add(item)

    session.commit()
    return result
