"""The three delivery channels behind one interface.

A channel's send() either returns normally (delivered) or raises:
    TransientError  -> try again later (network blip, SMTP 4xx, push 5xx/429)
    PermanentError  -> stop trying     (bad address, malformed subscription)
    NothingToDo     -> mark skipped    (e.g. the user removed every device)
That three-way split is what lets the worker retry sensibly instead of
either giving up on a timeout or hammering a dead address forever.
"""

import json
import logging
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

from sqlmodel import Session, select

from ..models import PushSubscription, User
from .settings import NotifySettings

log = logging.getLogger("onetrip.notify")


class DeliveryError(Exception):
    pass


class TransientError(DeliveryError):
    pass


class PermanentError(DeliveryError):
    pass


class NothingToDo(DeliveryError):
    pass


@dataclass(frozen=True)
class Message:
    """What every channel renders. Built once per reminder in delivery.py."""

    title: str        # the reminder text: "Leave for JFK"
    body: str         # "Tokyo, Off the Clock · Mon, Nov 9, 7:30 AM (New York time)"
    url: str          # deep link back into the trip
    tag: str          # stable per reminder; lets devices replace instead of stack


class Channel(Protocol):
    name: str

    def available(self) -> bool:
        """Configured on this server?"""

    def wants(self, user: User, session: Session) -> bool:
        """Should this user get reminders this way?"""

    def send(self, message: Message, user: User, session: Session) -> None: ...


# ---------------------------------------------------------------- console --


class ConsoleChannel:
    name = "console"

    def __init__(self, settings: NotifySettings):
        self.settings = settings

    def available(self) -> bool:
        return self.settings.console

    def wants(self, user: User, session: Session) -> bool:
        return True

    def send(self, message: Message, user: User, session: Session) -> None:
        log.warning("🔔 REMINDER for %s: %s — %s (%s)", user.email, message.title, message.body, message.url)


# ------------------------------------------------------------------ email --


class EmailChannel:
    name = "email"

    def __init__(self, settings: NotifySettings):
        self.s = settings

    def available(self) -> bool:
        return self.s.email_ready

    def wants(self, user: User, session: Session) -> bool:
        return user.email_notifications

    def build(self, message: Message, user: User) -> EmailMessage:
        mail = EmailMessage()
        mail["Subject"] = f"Reminder: {message.title}"
        mail["From"] = self.s.smtp_from or ""
        mail["To"] = user.email
        mail.set_content(f"{message.title}\n\n{message.body}\n\nOpen the trip: {message.url}\n")
        mail.add_alternative(
            f"""<div style="font-family:system-ui,sans-serif;color:#16233a">
<p style="font-size:18px;font-weight:700;margin:0 0 6px">{_esc(message.title)}</p>
<p style="color:#5e6878;margin:0 0 18px">{_esc(message.body)}</p>
<a href="{_esc(message.url)}" style="background:#16233a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the trip</a>
</div>""",
            subtype="html",
        )
        return mail

    def send(self, message: Message, user: User, session: Session) -> None:
        mail = self.build(message, user)
        try:
            if self.s.smtp_ssl:
                server: smtplib.SMTP = smtplib.SMTP_SSL(
                    self.s.smtp_host or "", self.s.smtp_port, timeout=15, context=ssl.create_default_context()
                )
            else:
                server = smtplib.SMTP(self.s.smtp_host or "", self.s.smtp_port, timeout=15)
            with server:
                if self.s.smtp_starttls and not self.s.smtp_ssl:
                    server.starttls(context=ssl.create_default_context())
                if self.s.smtp_user:
                    server.login(self.s.smtp_user, self.s.smtp_password or "")
                server.send_message(mail)
        except smtplib.SMTPRecipientsRefused as exc:
            raise PermanentError(f"Address refused: {exc.recipients}")
        except smtplib.SMTPAuthenticationError as exc:
            # Wrong credentials won't fix themselves, but an operator can fix
            # them — keep retrying within the budget so mail resumes.
            raise TransientError(f"SMTP login failed ({exc.smtp_code})")
        except smtplib.SMTPResponseException as exc:
            if 500 <= exc.smtp_code < 600:
                raise PermanentError(f"SMTP {exc.smtp_code}: {exc.smtp_error!r}")
            raise TransientError(f"SMTP {exc.smtp_code}: {exc.smtp_error!r}")
        except (smtplib.SMTPException, OSError) as exc:
            raise TransientError(f"SMTP unreachable: {exc}")


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# --------------------------------------------------------------- web push --


class PushChannel:
    """Web Push (RFC 8030) with VAPID. The browser vendor runs the push
    service; we POST an encrypted payload to each subscription's endpoint and
    the browser wakes our service worker (frontend/public/sw.js) to show it —
    even when no One Trip tab is open."""

    name = "push"

    def __init__(self, settings: NotifySettings, sender=None):
        self.s = settings
        self._sender = sender  # injectable for tests; defaults to pywebpush

    def available(self) -> bool:
        return self.s.push_ready

    def wants(self, user: User, session: Session) -> bool:
        return self._subs(user, session) != []

    def _subs(self, user: User, session: Session) -> list[PushSubscription]:
        return list(session.exec(select(PushSubscription).where(PushSubscription.user_id == user.id)).all())

    def send(self, message: Message, user: User, session: Session) -> None:
        subs = self._subs(user, session)
        if not subs:
            raise NothingToDo("No devices have notifications switched on")

        payload = json.dumps({"title": message.title, "body": message.body, "url": message.url, "tag": message.tag})
        delivered, transient = 0, []
        for sub in subs:
            try:
                self._send_one(sub, payload, message.tag)
                delivered += 1
            except _Gone:
                # The browser unsubscribed or the user cleared site data:
                # this endpoint will never work again, so forget it.
                log.info("push endpoint gone, removing subscription %s", sub.id)
                session.delete(sub)
            except TransientError as exc:
                transient.append(str(exc))
        session.commit()

        if delivered:
            return  # at least one device got it — good enough; see docs/reminders.md
        if transient:
            raise TransientError("; ".join(transient)[:450])
        raise NothingToDo("Every device had unsubscribed")

    def _send_one(self, sub: PushSubscription, payload: str, tag: str) -> None:
        sender = self._sender or _pywebpush_sender
        info = {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}
        try:
            status = sender(
                info,
                payload,
                private_key=self.s.vapid_private_key,
                subject=self.s.vapid_subject,
                # Topic: if a retry arrives while the first copy is still
                # queued at the push service, it REPLACES it — a duplicate
                # guard on the far side of the network.
                headers={"Topic": tag[:32], "Urgency": "high"},
            )
        except OSError as exc:
            raise TransientError(f"push service unreachable: {exc}")
        if status in (404, 410):
            raise _Gone()
        if status == 429 or status >= 500:
            raise TransientError(f"push service returned {status}")
        if status >= 400:
            # 400/403/413: our request is wrong for this endpoint — retrying won't help,
            # but it's per-device, so treat like gone.
            log.warning("push rejected with %s for subscription %s", status, sub.id)
            raise _Gone()


class _Gone(Exception):
    pass


def _pywebpush_sender(info: dict, payload: str, *, private_key, subject, headers) -> int:
    """Send one push; return the HTTP status (never raise on 4xx/5xx)."""
    from pywebpush import WebPushException, webpush  # imported lazily: optional at import time

    try:
        resp = webpush(
            subscription_info=info,
            data=payload,
            vapid_private_key=private_key,
            vapid_claims={"sub": subject},
            ttl=6 * 3600,  # a reminder older than 6h at the push service is noise
            headers=headers,
            timeout=15,
        )
        return getattr(resp, "status_code", 201)
    except WebPushException as exc:
        if exc.response is not None:
            return exc.response.status_code
        raise OSError(str(exc))


def all_channels(settings: NotifySettings) -> list[Channel]:
    return [ConsoleChannel(settings), EmailChannel(settings), PushChannel(settings)]
