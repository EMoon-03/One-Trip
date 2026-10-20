"""Which service answers place searches — and the rule that pairs Google keys.

Google's terms forbid showing Places API content (names, addresses,
coordinates) on a non-Google map. The map tab uses Google Maps only when
GOOGLE_MAPS_BROWSER_KEY is set, so Google search is only allowed when BOTH
keys are present:

    GEOCODER=auto       google if both keys are set, else nominatim
    GEOCODER=google     google; refuses (503) if a key is missing
    GEOCODER=nominatim  nominatim (fine on either map)
"""

import os

from . import GeoError


def server_key() -> str | None:
    return os.getenv("GOOGLE_MAPS_API_KEY") or None


def browser_key() -> str | None:
    return os.getenv("GOOGLE_MAPS_BROWSER_KEY") or None


def google_ready() -> bool:
    return bool(server_key() and browser_key())


def search_provider() -> str:
    mode = (os.getenv("GEOCODER") or "auto").lower()
    if mode == "nominatim":
        return "nominatim"
    if mode == "google":
        if not server_key():
            raise GeoError("GEOCODER=google but GOOGLE_MAPS_API_KEY is not set in backend/.env", 503)
        if not browser_key():
            raise GeoError(
                "GEOCODER=google needs GOOGLE_MAPS_BROWSER_KEY too: Google's terms require Google place "
                "data to be shown on a Google map. Set both keys, or use GEOCODER=nominatim.",
                503,
            )
        return "google"
    return "google" if google_ready() else "nominatim"
