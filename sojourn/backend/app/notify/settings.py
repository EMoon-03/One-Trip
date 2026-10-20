"""Notification + worker settings, read from the environment (backend/.env).

Read on every call rather than cached so tests can flip them with
monkeypatch.setenv. They're a handful of os.getenv calls; that's cheap.
"""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    return int(raw) if raw not in (None, "") else default


@dataclass(frozen=True)
class NotifySettings:
    app_url: str
    # email
    smtp_host: str | None
    smtp_port: int
    smtp_user: str | None
    smtp_password: str | None
    smtp_from: str | None
    smtp_starttls: bool
    smtp_ssl: bool
    # web push
    vapid_public_key: str | None
    vapid_private_key: str | None
    vapid_subject: str
    # console
    console: bool
    # worker
    poll_seconds: int
    stale_after_hours: int
    max_attempts: int
    lease_seconds: int
    embedded_worker: bool

    @property
    def email_ready(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

    @property
    def push_ready(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)


def get_settings() -> NotifySettings:
    smtp_host = os.getenv("SMTP_HOST") or None
    vapid_pub = os.getenv("VAPID_PUBLIC_KEY") or None
    vapid_priv = os.getenv("VAPID_PRIVATE_KEY") or None
    # Console defaults ON only when nothing real is configured, so a fresh
    # checkout still "delivers" somewhere visible.
    console_default = not smtp_host and not (vapid_pub and vapid_priv)
    return NotifySettings(
        app_url=os.getenv("APP_URL", "http://localhost:5173").rstrip("/"),
        smtp_host=smtp_host,
        smtp_port=_int("SMTP_PORT", 587),
        smtp_user=os.getenv("SMTP_USER") or None,
        smtp_password=os.getenv("SMTP_PASSWORD") or None,
        smtp_from=os.getenv("SMTP_FROM") or None,
        smtp_starttls=_bool("SMTP_STARTTLS", True),
        smtp_ssl=_bool("SMTP_SSL", False),
        vapid_public_key=vapid_pub,
        vapid_private_key=vapid_priv,
        vapid_subject=os.getenv("VAPID_SUBJECT", "mailto:admin@localhost"),
        console=_bool("NOTIFY_CONSOLE", console_default),
        poll_seconds=_int("WORKER_POLL_SECONDS", 20),
        stale_after_hours=_int("REMINDER_STALE_HOURS", 12),
        max_attempts=_int("DELIVERY_MAX_ATTEMPTS", 5),
        lease_seconds=_int("DELIVERY_LEASE_SECONDS", 120),
        embedded_worker=_bool("EMBEDDED_WORKER", False),
    )
