# Reliable reminders: how they work

One Trip's reminders used to exist only while the app was open: the browser asked `/api/reminders/due` once a minute and lit up the bell. They now reach you **with the app closed**, by email or a browser notification. The times are right wherever you are, and wherever the trip is.

This doc explains the design and the reasons behind each choice. It's written to be read once to understand the code and again before an interview.

- [Running it](#running-it)
- [The big picture](#the-big-picture)
- [Part 1 — Time zones](#part-1--time-zones)
- [Part 2 — The worker](#part-2--the-worker)
- [Part 3 — Channels](#part-3--channels)
- [What's tested](#whats-tested)
- [Limits and next steps](#limits-and-next-steps)

---

## Running it

The schema changed (new columns and two new tables), and the app still creates tables with `create_all` instead of migrations. **Delete `backend/sojourn.db` and re-seed** before running this version.

```fish
cd sojourn/backend
python -m venv .venv
source .venv/bin/activate.fish          # bash/zsh: source .venv/bin/activate
pip install -r requirements-dev.txt
rm -f sojourn.db; python -m app.seed
```

Then pick how you want to try it.

**1. Zero config (console).** With nothing configured, reminders are "delivered" to the worker's log, so you can watch it work.

```fish
uvicorn app.main:app --reload            # terminal 1: the API
python -m app.worker                     # terminal 2: the worker
```

The seed creates one reminder that's already due. Within ~20 seconds the worker prints `🔔 REMINDER for demo@sojourn.app: Book Shinkansen seats…`.

Prefer one terminal? Put `EMBEDDED_WORKER=true` in `.env` and the API runs the worker on a background thread.

**2. Real email, locally.** `aiosmtpd` (in `requirements-dev.txt`) is a tiny SMTP server that saves every message to a folder instead of sending it:

```fish
python -m aiosmtpd -n -l 127.0.0.1:8025 -c aiosmtpd.handlers.Mailbox ./maildir   # terminal 3
```

```dotenv
# backend/.env
SMTP_HOST=127.0.0.1
SMTP_PORT=8025
SMTP_STARTTLS=false
SMTP_FROM="One Trip <reminders@onetrip.local>"
```

Restart the worker. Each reminder becomes a file in `maildir/new/`.

**3. Real email, really.** Use any SMTP provider. Gmail works with an [app password](https://support.google.com/accounts/answer/185833) (`smtp.gmail.com`, port 587, your address as user and `SMTP_FROM`); Resend, Mailgun and Postmark work too.

**4. Browser notifications.** Generate keys once:

```fish
python -m app.notify.vapid               # prints three lines for .env
```

Restart the API and worker, open the bell → **Notification settings** → **This browser: Turn on**, then **Send test**. Push needs a secure origin: `http://localhost` counts, and anything else must be `https`.

`backend/.env.example` lists every setting with its default.

---

## The big picture

```
 browser                              backend                                     outside world
┌──────────────────────┐  /api/*  ┌──────────────────────────────┐
│ React app            │────────▶ │ API (uvicorn)                │
│  - reminder forms    │          │  stores INTENT:              │
│  - settings panel    │          │  "10:30 Tokyo" / "3h before" │
│  - service worker ◀──┼──────┐   │  derives UTC remind_at       │
└──────────────────────┘      │   └──────────────┬───────────────┘
                              │                  │ same database
                              │   ┌──────────────▼───────────────┐   SMTP   ┌──────────┐
                              │   │ worker (python -m app.worker)│────────▶ │ mail     │
                              │   │  every 20s:                  │          └──────────┘
                              │   │   1. fan out due reminders   │   HTTPS  ┌──────────┐
                              └───┼── 2. deliver, retry, record  │────────▶ │ push svc │──┐
                    push message  │                              │          │ (Google, │  │
                    wakes the SW  └──────────────────────────────┘          │ Mozilla) │  │
                                                                            └──────────┘  │
                              ◀───────────────────────────────────────────────────────────┘
```

Three ideas carry the whole feature:

1. **Store what the person meant; derive what the machine needs.** People type wall-clock times in a place's zone. The server schedules against UTC. (Part 1)
2. **A separate process does the sending,** and every step it takes is safe to repeat or to run twice at once. (Part 2)
3. **Every delivery channel has the same shape,** so adding SMS later doesn't touch the worker. (Part 3)

---

## Part 1 — Time zones

### Why the old version was wrong

The old code stored `remind_at` as a naive `datetime` (no zone) and compared it with `datetime.now()`, the *server's* local time. That's right only if the server, the browser and the trip are all in the same zone. Deploy to a UTC server and every reminder fires 4–5 hours off. A Tokyo trip planned from New Jersey makes every time ambiguous: is "10:30" 10:30 here or there?

It also broke on a fresh install. `requirements.txt` only had minimum versions, and SQLModel 0.0.48 started *rejecting* naive datetimes, so creating a reminder returned a 500 error.

### The rule

> **Moments the server acts on are aware UTC. What a person typed is a wall-clock time plus an IANA zone, and that pair is the source of truth.**

All of it lives in `app/timeutil.py`:

| Function | Does |
|---|---|
| `UTCDateTime` | A column type that refuses naive datetimes and always returns aware UTC. It stores naive UTC because SQLite and MySQL `DATETIME` have no offsets. It's ours, not the library's, so behaviour doesn't change between SQLModel versions (tests pass on 0.0.24 *and* 0.0.48). |
| `wall_to_utc(local, zone)` | "Nov 9 10:30" in Asia/Tokyo → `2026-11-09T01:30Z` |
| `utc_to_wall(moment, zone)` | The reverse, for display and for re-deriving |

### Three levels of zone

| Level | Field | Default | Example |
|---|---|---|---|
| Trip | `trip.timezone` | the creator's browser zone | `Asia/Tokyo` |
| Stop | `itineraryitem.timezone` | `null` = the trip's | flight out of JFK: `America/New_York` |
| Reminder | `reminder.timezone` | `null` = the trip's | "book seats" at home: `America/New_York` |

So "10:30" on the JFK flight means 10:30 in New York, while "17:00" check-in means 17:00 in Tokyo. They sit on the same itinerary, and the UI marks the exception with an `EST` badge.

### Why keep both the wall clock and the UTC moment?

The `reminder` table stores `local_time` (naive wall clock), `timezone` and `remind_at` (UTC, derived). Storing UTC alone would lose the intent. Here's the case that proves it:

> You create a trip and forget to set its zone, so it stays on UTC. You add "Halfway checkpoint, Nov 13 20:00". Later you fix the trip to Asia/Tokyo.

You meant 8 PM in Tokyo. Because `local_time = 20:00` is stored, changing the trip's zone re-derives `remind_at` (`reschedule_for_trip`). The wall clock stays 20:00 and the moment moves 9 hours. With only UTC stored, the reminder would silently become 5 AM Tokyo time. The trip form tells you this happens before you save.

### "Before a stop" reminders

`offset_minutes` + `activity_id` means "N minutes before that stop starts":

```
remind_at = wall_to_utc(stop.date + stop.start_time, stop's zone) − offset
```

It's recomputed whenever its inputs change (`app/scheduling.py`):

| Event | What happens |
|---|---|
| The stop's date, time or zone is edited | `reschedule_for_stop` moves its reminders. "Leave for dinner" follows dinner from 7:30 to 8:15. |
| The stop loses its start time | `freeze`: the reminder keeps its current moment and becomes an absolute reminder |
| The stop is deleted | Same `freeze`, then unlinked. Expenses already worked this way. |

### Re-arming

When the computed moment changes, `schedule()` clears `dispatched_at` and deletes the old delivery rows, so a sent reminder you move to tomorrow fires again tomorrow. Editing only the text doesn't re-send. There's a test for each case.

### DST and other edges

- **Ambiguous times** (1:30 AM happens twice when clocks go back) resolve to the first occurrence. **Non-existent times** (2:30 AM when clocks jump forward) shift forward by the gap. This is Python `zoneinfo` behaviour, the same as most calendar apps.
- US clocks change on Nov 1, 2026: Oct 31 10:30 New York is 14:30Z, Nov 2 is 15:30Z. There's a test for it.
- Zones are validated against the IANA database (`tzdata` is a dependency, so it works on Windows and slim containers too).

---

## Part 2 — The worker

### Why a separate process

The API's job is answering requests fast. It may run as several copies or scale to zero when idle, and sending email in the middle of a request makes that request slow and fragile. The worker is the one thing that's awake when nobody has the app open. It's a plain loop, `app/worker.py`. In production you'd run it as its own service: a Render/Railway "background worker", a systemd unit, or a second container.

### One tick = two phases (`app/delivery.py`)

**Phase 1: fan-out (`schedule_due`).** Find pending reminders with `remind_at <= now` and `dispatched_at IS NULL`. For each one:

```sql
UPDATE reminder SET dispatched_at = :now
 WHERE id = :id AND dispatched_at IS NULL      -- the claim
```

Only the process whose `UPDATE` changed a row (`rowcount == 1`) continues. That process writes one `ReminderDelivery` row per channel the user wants. A `UNIQUE (reminder_id, channel)` constraint backs this up: even if two workers got past the claim somehow, the database refuses a second email row.

**Phase 2: deliver (`deliver_pending`).** Find delivery rows that are `pending`, due for an attempt, and not leased. Lease one:

```sql
UPDATE reminderdelivery
   SET claimed_until = :now + 120s, attempts = attempts + 1
 WHERE id = :id AND status = 'pending'
   AND (claimed_until IS NULL OR claimed_until < :now)
```

Then send it and record the outcome.

### The lease, and why exactly-once is impossible

Picture the worst moment for a crash: the email has left, but we haven't yet written `status = sent`. After a restart, did it send? There's no way to know. Over a network you can't get *exactly-once* delivery; you choose between **at-most-once** (risk losing a reminder) and **at-least-once** (risk a rare duplicate).

For "leave for the airport", losing it is worse than seeing it twice, so the worker is **at-least-once**:

- `claimed_until` is a lease. A worker that dies mid-send holds the row for at most 120 seconds, then another worker retries it.
- The duplicate window is a single send, and only after a crash.
- Web Push gets a second guard: each push carries a `Topic` header. If a retry reaches the push service while the first copy is still queued, it *replaces* that copy. The service worker also uses the same notification `tag`, so a duplicate replaces the first notification instead of stacking.

### Retries

Channels report failures in three kinds (`app/notify/channels.py`):

| Raised | Meaning | Worker does |
|---|---|---|
| `TransientError` | network down, SMTP 4xx, push 429/5xx | retry after 1, 2, 4, 8… minutes (capped at 60), up to `DELIVERY_MAX_ATTEMPTS` (5), then `failed` |
| `PermanentError` | SMTP 5xx, address refused | `failed` immediately; retrying won't help |
| `NothingToDo` | e.g. every device unsubscribed | `skipped` |

Each channel retries on its own: email can keep retrying while push has already succeeded. The real run in development showed the whole path. The mail server was stopped, the reminder came due, the email went `pending` with "Connection refused", the mail server came back, and one minute later the email was sent on attempt 2, while the console copy wasn't held up at all.

### Other rules

- **Marked done or dismissed before sending** → the delivery is skipped with that reason.
- **Long overdue** (more than `REMINDER_STALE_HOURS`, default 12, past due when first seen, e.g. the worker was off overnight) → skipped with "Missed…". Getting "leave for the airport" two days late is worse than not getting it. It still shows in the in-app bell.
- **Channels are chosen when the reminder comes due.** A reminder that came due while nothing was set up stays in-app only. It isn't re-sent when you set up email later.
- **A bug in a channel can't kill the worker.** Unexpected exceptions are logged and retried like transient errors.

### Can two workers run at once?

Yes, safely, because every step is a conditional `UPDATE` and the second worker's claim simply affects zero rows. There's a test that runs two sessions against the same reminder. With SQLite, two processes can share the file in development (SQLite takes a short write lock). For real concurrency, use MySQL, which the app already supports.

The design is a **database-as-queue** with polling. It's simple, needs no extra infrastructure, and is plenty for this scale. The usual next steps are `SELECT … FOR UPDATE SKIP LOCKED` (MySQL 8 and Postgres) to claim batches without contention, or a real queue (Redis + RQ/Celery, SQS) once polling becomes the bottleneck.

---

## Part 3 — Channels

Every channel implements the same three methods:

```python
class Channel(Protocol):
    name: str
    def available(self) -> bool: ...                 # set up on this server?
    def wants(self, user, session) -> bool: ...      # does this user want it?
    def send(self, message, user, session) -> None:  # or raise Transient/Permanent/NothingToDo
```

This is the provider pattern again, the same idea as the maps and geocoders. The worker loops over `all_channels()` and never mentions email or push by name. SMS (Twilio) or Slack would be a new class plus one line in `all_channels()`.

| Channel | `available()` when | `wants()` when |
|---|---|---|
| console | `NOTIFY_CONSOLE` (on by default if nothing else is set up) | always |
| email | `SMTP_HOST` and `SMTP_FROM` are set | the user's **Email** switch is on (`PATCH /api/auth/me`) |
| push | VAPID keys are set | the user has at least one subscribed browser |

### How Web Push works

```
1. Settings → "Turn on"
   browser: Notification.requestPermission()
            serviceWorker.register('/sw.js')
            pushManager.subscribe({ applicationServerKey: VAPID public key })
          → { endpoint: "https://fcm.googleapis.com/…", keys: { p256dh, auth } }
   POST /api/notifications/push-subscriptions   (stored as a PushSubscription row)

2. Reminder due → worker → pywebpush:
   - encrypts the JSON payload with the browser's p256dh + auth (aes128gcm),
     so the push service in the middle can't read it
   - signs a VAPID JWT with our private key, so the push service knows it's really us
   - POSTs to the endpoint

3. Push service → wakes the browser → sw.js 'push' event → showNotification()
   Clicking it focuses or opens the trip ('notificationclick').
```

Things the code handles:

- **404/410 from the push service** means the subscription is dead (the user revoked permission or cleared site data). The worker deletes it.
- **Keys rotated on the server:** `enablePush()` notices that the browser's subscription was made with a different key and re-subscribes.
- **Signing out** unsubscribes that browser first, so the next person on it doesn't get your reminders.
- **One device succeeding counts as sent.** If another device failed, it's logged rather than retried, because a retry would re-send to the devices that already got it.

A test sends a real pywebpush request to a fake push service on localhost. It then verifies the VAPID signature with the public key and decrypts the payload with a "browser" key pair, which is exactly what Chrome's push service and the browser do. What can't be tested in CI is a real push service delivering to a real browser. Try that by hand with **Send test**.

---

## What's tested

`python -m pytest -q` runs **60 tests** in about 25 seconds. They cover:

- **Time zones:** trip zone, reminder's own zone, aware input, DST boundary, bad zones rejected, fixing the trip zone keeps wall clocks.
- **"Before a stop":** stop zone respected; reminder follows the stop; freezes when the stop loses its time or is deleted; validation; switching modes with PATCH.
- **Worker:** sends exactly once; future reminders wait; done-before-due never sends; done-between-phases is skipped; backoff timing then giving up; permanent failures; one channel failing doesn't block another; stale reminders skipped; **a crashed worker's lease expires and another retries**; **two workers fanning out create one row per channel**; rescheduling re-arms, but editing only the text doesn't.
- **Channels:** email content and error classification; the user's email switch; push outcomes for 201/404/410/429/503; the real Web Push wire format.
- **API:** config, subscription lifecycle and ownership (a device moves to whoever signs in on it), https-only endpoints, the test send, `PATCH /me`, auth required.

The worker tests call `tick(session, now=…, channels=[FakeChannel()])` directly: a fake clock and fake channels make them deterministic, with no sleeping. To check that the tests can actually fail, the lease check and the re-arm were each deliberately removed during development. Each time, the matching test failed.

---

## Limits and next steps

- **Migrations.** Schema changes still mean deleting the database. Alembic is the next upgrade, and it's essential once real data lives in MySQL.
- **iPhone push** works only after the user adds One Trip to their Home Screen (iOS 16.4+), which needs a web app manifest. Desktop browsers and Android work as-is.
- **Email deliverability.** Mail from your own domain needs SPF/DKIM records, or it lands in spam. Sending through a provider like Resend or Postmark handles that.
- **Quiet hours / digests** ("don't wake me at 3 AM; batch them") would fit naturally in `schedule_due`.
- **Scaling** past one worker loop: `SKIP LOCKED` batches, then a real queue (see Part 2).

### Interview talking points

- **"How do you avoid sending twice?"** Conditional `UPDATE` claims, a unique constraint, and leases give at-least-once delivery with a one-send duplicate window. Then the Topic header and notification tag collapse duplicates downstream. Exactly-once over a network isn't possible.
- **"How do you handle time zones?"** Store intent (wall clock + IANA zone) and derive UTC. Re-derive when the inputs change. Test DST.
- **"What if the worker is down?"** Reminders wait in the database. When the worker comes back it catches up, but skips anything stale so the user isn't flooded with old reminders.
- **"Why poll instead of a queue?"** The database already holds the schedule; polling every 20s is cheap at this scale and has nothing extra to run. The upgrade path is clear when needed.
