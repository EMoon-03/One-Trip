"""The reminder worker — a long-running process separate from the API.

    python -m app.worker            # run forever, checking every WORKER_POLL_SECONDS
    python -m app.worker --once     # one pass, then exit (cron, debugging)

Why a separate process? The API exists to answer requests quickly; it
shouldn't be sending email in the middle of one, and it may run as several
copies (or scale to zero). The worker is the one thing that is awake when
nobody has the app open. Because every claim in app/delivery.py is a
conditional UPDATE, running two workers by accident is safe — they split
the work instead of doubling it.

For local development you can also set EMBEDDED_WORKER=true and the API
starts the same loop on a background thread (see app/main.py).
"""

import argparse
import logging
import signal
import threading
import time

from sqlmodel import Session

from .database import engine, init_db
from .delivery import tick
from .geo.refresh import refresh_google_coords
from .notify.settings import get_settings
from .timeutil import utcnow

log = logging.getLogger("onetrip.worker")


# Housekeeping that doesn't need to run every 20 seconds.
PLACE_REFRESH_EVERY = 3600  # seconds
# None = never ran, so the first pass after start-up always runs. (Starting
# from 0.0 would wait up to an hour on a machine booted less than an hour
# ago, because time.monotonic() counts from boot.)
_last_place_refresh: float | None = None


def refresh_places_if_due(force: bool = False) -> None:
    """Google's 30-day coordinate rule (app/geo/refresh.py), at most hourly."""
    global _last_place_refresh
    if not force and _last_place_refresh is not None and time.monotonic() - _last_place_refresh < PLACE_REFRESH_EVERY:
        return
    _last_place_refresh = time.monotonic()
    with Session(engine) as session:
        result = refresh_google_coords(session, utcnow())
    if result:
        log.info("place coordinates: refreshed=%d deleted=%d failed=%d", result.refreshed, result.deleted, result.failed)


def run_once() -> None:
    refresh_places_if_due()
    with Session(engine) as session:
        result = tick(session)
    if result:
        log.info(
            "tick: dispatched=%d sent=%d retried=%d failed=%d skipped=%d",
            result.dispatched, result.sent, result.retried, result.failed, result.skipped,
        )
    for err in result.errors:
        log.warning("delivery problem: %s", err)


def run_forever(stop: threading.Event, interval: int | None = None) -> None:
    settings = get_settings()
    interval = interval or settings.poll_seconds
    channels = [
        name
        for name, on in (("console", settings.console), ("email", settings.email_ready), ("push", settings.push_ready))
        if on
    ]
    log.info("reminder worker started: every %ss, channels: %s", interval, ", ".join(channels) or "none (in-app only)")
    while not stop.is_set():
        try:
            run_once()
        except Exception:  # keep the loop alive through DB hiccups etc.
            log.exception("worker tick failed; will retry next interval")
        stop.wait(interval)
    log.info("reminder worker stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="One Trip reminder worker")
    parser.add_argument("--once", action="store_true", help="run a single pass and exit")
    parser.add_argument("--interval", type=int, default=None, help="seconds between passes")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()

    if args.once:
        run_once()
        return

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())  # docker stop / systemd
    signal.signal(signal.SIGINT, lambda *_: stop.set())   # Ctrl+C
    run_forever(stop, args.interval)


if __name__ == "__main__":
    main()
