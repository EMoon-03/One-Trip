"""Places, coordinates and time zones from outside services.

    providers.py   which service answers, and the Google pairing rule
    google.py      Places API (New): Autocomplete + Place Details; Time Zone API
    nominatim.py   OpenStreetMap's free geocoder
    timezones.py   coordinates -> IANA zone (Google, or offline)
    refresh.py     the 30-day rule for Google coordinates (run by the worker)

See docs/google-maps.md for setup, costs and the terms these follow.
"""


class GeoError(Exception):
    """An outside service failed. `status` is the HTTP code to answer with."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status
