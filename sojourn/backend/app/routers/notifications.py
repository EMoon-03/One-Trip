"""Notification settings for the signed-in user.

    GET    /api/notifications/config              what's set up + what's on
    POST   /api/notifications/push-subscriptions  this browser: "notify me"
    DELETE /api/notifications/push-subscriptions?endpoint=…   this browser: stop
    POST   /api/notifications/test                send a test through every channel now
"""

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlmodel import Session, SQLModel, select

from ..auth import get_current_user
from ..database import get_session
from ..models import PushSubscription, PushSubscriptionCreate, User
from ..notify.channels import (
    EmailChannel,
    Message,
    NothingToDo,
    PermanentError,
    TransientError,
    all_channels,
)
from ..notify.settings import get_settings

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class EmailConfig(SQLModel):
    available: bool   # SMTP configured on the server
    enabled: bool     # the user's preference
    address: str


class PushConfig(SQLModel):
    available: bool
    public_key: str | None
    devices: int


class NotificationConfig(SQLModel):
    email: EmailConfig
    push: PushConfig
    console: bool


class TestResult(SQLModel):
    channel: str
    ok: bool
    detail: str


@router.get("/config", response_model=NotificationConfig)
def config(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    s = get_settings()
    devices = len(session.exec(select(PushSubscription.id).where(PushSubscription.user_id == user.id)).all())
    return NotificationConfig(
        email=EmailConfig(available=s.email_ready, enabled=user.email_notifications, address=user.email),
        push=PushConfig(available=s.push_ready, public_key=s.vapid_public_key if s.push_ready else None, devices=devices),
        console=s.console,
    )


@router.post("/push-subscriptions", status_code=201)
def subscribe(
    payload: PushSubscriptionCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    user_agent: str | None = Header(default=None),
):
    if not get_settings().push_ready:
        raise HTTPException(status_code=503, detail="Browser notifications aren't set up on this server")
    existing = session.exec(select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)).first()
    if existing:
        # Same browser, maybe a different account signed in now: the newest
        # sign-in owns it, so the previous user stops getting pushes here.
        existing.user_id = user.id  # type: ignore[assignment]
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
        session.add(existing)
    else:
        session.add(
            PushSubscription(
                user_id=user.id,  # type: ignore[arg-type]
                endpoint=payload.endpoint,
                p256dh=payload.keys.p256dh,
                auth=payload.keys.auth,
                user_agent=(user_agent or "")[:300] or None,
            )
        )
    session.commit()
    return {"ok": True}


@router.delete("/push-subscriptions", status_code=204)
def unsubscribe(
    endpoint: str = Query(..., max_length=700),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    sub = session.exec(
        select(PushSubscription).where(PushSubscription.endpoint == endpoint, PushSubscription.user_id == user.id)
    ).first()
    if sub:  # deleting something that isn't there is still "it's gone"
        session.delete(sub)
        session.commit()


@router.post("/test", response_model=list[TestResult])
def send_test(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Send a test right now, bypassing the worker, so setup problems show up
    immediately instead of at reminder time."""
    s = get_settings()
    message = Message(
        title="Test notification from One Trip",
        body="If you can read this, reminders will reach you here.",
        url=f"{s.app_url}/",
        tag="onetrip-test",
    )
    results: list[TestResult] = []
    for channel in all_channels(s):
        if not channel.available():
            continue
        if isinstance(channel, EmailChannel) and not user.email_notifications:
            results.append(TestResult(channel="email", ok=False, detail="Email reminders are switched off"))
            continue
        if not channel.wants(user, session):
            continue  # e.g. no browser has push switched on: nothing to test, not a failure
        try:
            channel.send(message, user, session)
            detail = {"email": f"Sent to {user.email}", "push": "Sent to your devices", "console": "Printed in the server log"}
            results.append(TestResult(channel=channel.name, ok=True, detail=detail.get(channel.name, "Sent")))
        except NothingToDo as exc:
            results.append(TestResult(channel=channel.name, ok=False, detail=str(exc)))
        except (TransientError, PermanentError) as exc:
            results.append(TestResult(channel=channel.name, ok=False, detail=str(exc)))
    return results
