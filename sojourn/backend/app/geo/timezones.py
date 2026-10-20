"""Coordinates -> IANA time zone, used to fill in trip and stop zones.

Google's Time Zone API when the server key is set (and the API is enabled
for it); otherwise an offline lookup (timezonefinder: boundary data shipped
with the package, no network, no key). Either way the answer is a zone
name like 'America/New_York' that the rest of the app already understands.
"""

import logging
from functools import lru_cache

from ..timeutil import is_valid_zone
from . import GeoError, google
from .providers import server_key

log = logging.getLogger("onetrip.geo")


@lru_cache(maxsize=1)
def _finder():
    from timezonefinder import TimezoneFinder  # loads ~1 MB of boundary data once

    return TimezoneFinder()


def offline_zone(lat: float, lng: float) -> str | None:
    return _finder().timezone_at(lat=lat, lng=lng)


def zone_for(lat: float, lng: float) -> tuple[str, str]:
    """Return (zone, source) where source is 'google' or 'offline'."""
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise GeoError("lat/lng out of range", 422)
    if server_key():
        try:
            zone_name = google.timezone_at(lat, lng)
            if is_valid_zone(zone_name):
                return zone_name, "google"
        except GeoError as exc:
            if exc.status == 404:
                raise
            # Google refused or is unreachable: the offline answer is just as good,
            # but say so — usually it means the Time Zone API isn't enabled.
            log.warning("time zone via Google failed, using offline lookup: %s", exc)
    zone_name = offline_zone(lat, lng)
    if not zone_name or not is_valid_zone(zone_name):
        raise GeoError("No time zone found for that spot", 404)
    return zone_name, "offline"
