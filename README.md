# One Trip

*Plan the days, mind the budget, never miss a departure.*

A travel itinerary + finance planner + reminders app, multi-user. One **Trip** is the hub; itinerary stops, expenses and reminders all hang off it, and every trip belongs to a **User**. The two optional links are the signature of the design: an expense can belong to a specific stop ("dinner owns its $52"), and a reminder can count back from one ("leave 3h before the flight"), following it if the flight moves.

**Saved places** keep a list of places worth the trip, before there's a trip: tag them, rate them, mark them visited, group them into collections ("Tokyo eats"). One click drops a saved place onto a day of a trip, location and time zone included; any stop can be bookmarked back; and a trip's itinerary suggests saved places near its stops.

The UI shows each trip as a route: a day strip on the home page and trip page, every day on the itinerary (planned or not), with dark mode, undo for deletes, and a bottom tab bar on phones.

Reminders reach you **with the app closed**, by email or browser notification. They're sent by a background worker in the right time zone: the trip's, the stop's, or yours. The design is explained in [`sojourn/docs/reminders.md`](sojourn/docs/reminders.md).

> The code lives in `sojourn/`, the project's original name.

**Stack:** FastAPI + SQLModel · MySQL (or SQLite for zero-config dev) · JWT auth (bcrypt + PyJWT) · background worker (email via SMTP, Web Push via VAPID) · React 19 + TypeScript · axios + TanStack Query · Recharts · Leaflet/OpenStreetMap **or** Google Maps.

```
frontend (Vite :5173)               backend (uvicorn :8000)                worker (python -m app.worker)
┌──────────────────────────┐ /api/* ┌───────────────────────────────┐      ┌────────────────────────────┐
│ React + TS               │──────▶ │ FastAPI                       │      │ every 20s:                 │
│  axios + interceptors    │ (proxy)│  auth · trips · itinerary     │      │  fan out due reminders     │
│  TanStack Query cache    │        │  expenses · reminders         │      │  deliver · retry · record  │
│  maps: Leaflet / Google  │        │  notifications · places       │      │  channels: console, email, │
│  service worker (push) ◀─┼────┐   │ SQLModel ─▶ MySQL / SQLite ◀──┼──────┼─ web push                  │
└──────────────────────────┘    │   └───────────────────────────────┘      └─────────────┬──────────────┘
                                └──────────── push service (Google / Mozilla / Apple) ◀───┘
```

## Quickstart

Three terminals. Commands are for fish; in bash/zsh use `source .venv/bin/activate`.

**Backend + worker**

```fish
cd sojourn/backend
python -m venv .venv
source .venv/bin/activate.fish
pip install -r requirements-dev.txt
cp .env.example .env               # optional: everything has a default
python -m app.seed                 # demo user + Tokyo trip (prints the login)
uvicorn app.main:app --reload      # terminal 1: the API
python -m app.worker               # terminal 2: the reminder worker
```

**Frontend**

```fish
cd sojourn/frontend
npm install
npm run dev                        # terminal 3: http://localhost:5173 (proxies /api → :8000)
```

Sign in with **demo@sojourn.app / wanderlust**, or register your own account. The API documents itself at http://localhost:8000/docs.

With no `.env`, reminders are "delivered" to the worker's log. To get real email or browser notifications, see [Running it](sojourn/docs/reminders.md#running-it). For one terminal fewer in development, `EMBEDDED_WORKER=true` runs the worker inside the API.

> **Upgrading from an earlier version?** The schema changed (time zones, delivery tables, saved places). Delete `backend/sojourn.db` and re-run the seed.

## How reminders work

The short version (the long one is in [`docs/reminders.md`](sojourn/docs/reminders.md)):

- **Time zones.** Every trip has an IANA zone (`Asia/Tokyo`), and a stop or reminder can override it: a flight out of JFK runs on New York time. The server stores what you typed (wall clock + zone) and derives the UTC moment from it. Fixing a trip's zone later therefore keeps "8:00 PM" at 8:00 PM there, and the UI shows your own time beside it.
- **"Before a stop."** "3 hours before the flight" is recomputed whenever the flight's date, time or zone changes.
- **The worker** claims due reminders and deliveries with conditional `UPDATE`s and leases. Running two workers is safe, and a crash mid-send gets retried, not lost (at-least-once). Transient failures back off 1, 2, 4… minutes; permanent ones stop; anything more than 12h overdue is skipped rather than sent late.
- **Channels** share one interface (`available` / `wants` / `send`): console for dev, email over any SMTP provider, Web Push to every browser you switch on. The bell's **Notification settings** has the switches and a **Send test** button.

## How saved places work

- **A saved place belongs to you, not to a trip.** Name (your label), where (searched like a stop, so it gets coordinates), type, notes, tags, a 1–5 rating, and a status: *want to go* or *been there*. Collections are named groups; a place can be in several, and deleting a collection keeps its places.
- **Saved place → trip.** "Add to trip" makes a stop on the day you pick, with the coordinates, category and, if the place is in another zone than the trip, its own time zone. The stop remembers where it came from (`saved_place_id`), so the place card lists every trip it's on and the stop shows a bookmark.
- **Trip → saved place.** The bookmark on a stop saves it; saving the same place twice (same place id) returns the first save instead of a duplicate.
- **Nearby.** `GET /api/trips/{id}/saved-places/nearby` returns your want-to-go places within 30 km (haversine) of any stop on the trip, closest first, minus the ones already on it. The itinerary shows them under the route.
- **After the trip.** A want-to-go place whose stop date has passed asks "You were there on … Mark visited and rate it", and sorts first until you do.
- **Google's 30-day rule applies here too.** A saved place's coordinates *and* address from Google are refreshed by the worker from day 25 and deleted at day 30 if they can't be; copying a place into a trip copies its fetch date rather than restarting the clock, and a Google address isn't copied into the stop.

## How auth works

Registration and login both return a signed JWT (7-day expiry) plus the user object. The token carries only the user id. It's signed, not encrypted; nobody can forge one without `SECRET_KEY` (set a real one: `openssl rand -hex 32`).

On the frontend, **axios interceptors** keep auth out of the components. A request interceptor attaches `Authorization: Bearer <token>` from localStorage. A response interceptor normalizes FastAPI's error shapes, and on a 401 from any protected route it clears the session and returns to `/login`. Signing out also unsubscribes that browser from push notifications.

Authorization lives next to the data. Every router funnels through `get_owned_trip`, which answers **404 (not 403)** when a trip exists but belongs to someone else, so the API never reveals which ids exist. Child resources authorize by walking up to their trip.

Tradeoff worth knowing: the token sits in localStorage, which is simple and survives a refresh, but any JS on the page can read it (XSS). The hardened pattern is an httpOnly cookie + CSRF token; it's on the roadmap.

## Maps, places & time zones — the provider pattern

Each piece has a free, keyless default and a Google option. The app talks to one interface; swapping vendors is configuration, not code. Setup, costs and Google's rules are covered in [`docs/google-maps.md`](sojourn/docs/google-maps.md).

| Concern | Default (no keys) | With Google keys |
|---|---|---|
| **Map** (browser) | Leaflet + OpenStreetMap | Google Maps JS (`GOOGLE_MAPS_BROWSER_KEY`) |
| **Place search** (server) | Nominatim | Places API (New): Autocomplete with session tokens + Place Details, used only when **both** keys are set, as Google's terms require |
| **Time zone of a place** (server) | offline lookup (`timezonefinder`) | Time Zone API (`GOOGLE_MAPS_API_KEY`), falling back to offline |

Picking a place fills in coordinates *and* a time zone: a trip's destination sets the trip's zone, and a stop at JFK on a Tokyo trip gets New York time. Google coordinates are refreshed by the worker before Google's 30-day storage limit runs out, or deleted if they can't be refreshed.

## Tests

```fish
cd sojourn/backend
python -m pytest -q        # 104 tests, in-memory SQLite, ~35s
```

Covered: the register/login/me flow and validation, 401s on every protected route, **cross-user isolation**, CRUD + validation, itinerary ordering, cross-trip link rejection, stop deletion unlinking (not deleting), summary math, and cascade delete. For reminders: time-zone conversion including DST, "before a stop" rescheduling, and the worker's guarantees (exactly-once on the happy path, backoff, lease expiry after a crash, two concurrent workers, stale skips, re-arming). Also email and push error handling, the real Web Push wire format (VAPID signature checked, payload decrypted), and the Google integration against a mocked Google (session tokens, field-mask cost tiers, error messages, the key-pairing rule, the 30-day coordinate refresh). For saved places: tag cleanup, filters, duplicate detection, collections (counts, unique names, delete keeps places), isolation between users, add-to-trip (zones, date range, the 30-day clock), bookmarking a stop, nearby distances, and the 30-day rule for saved places' coordinates and address.

## API reference

`/api/auth/register`, `/api/auth/login` and `/api/config` are public; **everything else requires `Authorization: Bearer <token>`**.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | create account → token + user |
| POST | `/api/auth/login` | OAuth2 form (username = email) → token + user |
| GET/PATCH | `/api/auth/me` | current user · update name / email-reminder preference |
| GET | `/api/config` | runtime config (browser map key, if any) |
| GET/POST | `/api/trips` | list / create *your* trips |
| GET/PATCH/DELETE | `/api/trips/{id}` | one trip (changing `timezone` reschedules its reminders; delete cascades) |
| GET | `/api/trips/{id}/summary` | budget math: totals, per-category, daily burn |
| GET/POST | `/api/trips/{id}/itinerary` | stops, sorted by date + time |
| PATCH/DELETE | `/api/itinerary/{id}` | edit (moves linked reminders) / remove a stop |
| GET/POST | `/api/trips/{id}/expenses` | expenses (currency defaults to the trip's) |
| PATCH/DELETE | `/api/expenses/{id}` | edit / remove an expense |
| GET/POST | `/api/trips/{id}/reminders` | reminders: `remind_at` (+ `timezone`) **or** `offset_minutes` + `activity_id` |
| PATCH/DELETE | `/api/reminders/{id}` | edit (incl. status) / remove |
| GET | `/api/reminders/due` | pending & past-due across *your* trips; feeds the bell |
| GET | `/api/notifications/config` | which channels are set up, and your settings |
| POST/DELETE | `/api/notifications/push-subscriptions` | this browser: start / stop push |
| POST | `/api/notifications/test` | send a test through every channel you have on |
| GET | `/api/places/search?q=&session=` | place search via the configured provider |
| GET | `/api/places/details?place_id=&session=` | coordinates for a picked Google result (closes the billing session) |
| GET | `/api/places/timezone?lat=&lng=` | IANA time zone for a point |
| GET/POST | `/api/saved-places` | your saved places (`?status=&tag=&collection_id=&q=`) / save one |
| GET | `/api/saved-places/tags` | your tags, with counts |
| GET/PATCH/DELETE | `/api/saved-places/{id}` | one saved place (delete keeps the stops made from it) |
| POST | `/api/saved-places/{id}/add-to-trip` | `{trip_id, date, start_time?}` → a new stop |
| POST | `/api/itinerary/{id}/save` | bookmark a stop (201 new, 200 if already saved) |
| GET | `/api/trips/{id}/saved-places/nearby` | want-to-go places within 30 km of the trip's stops |
| GET/POST | `/api/collections` | your collections, with place counts / create |
| PATCH/DELETE | `/api/collections/{id}` | rename / delete (its places stay saved) |

## Switching to MySQL

```fish
cd sojourn/backend
docker compose up -d        # MySQL 8.4 with a sojourn/sojourn user
# then in .env: DATABASE_URL=mysql+pymysql://sojourn:sojourn@localhost:3306/sojourn
```

Models, queries and tests are identical on both engines. Use MySQL when running more than one worker.

## Roadmap (ordered as a learning path)

1. ~~**Background reminder delivery**~~ — done: worker, email + Web Push, time zones. See [`docs/reminders.md`](sojourn/docs/reminders.md).
2. **Alembic migrations.** Replace startup `create_all`; needed before real data lives in MySQL.
3. **Harden auth.** httpOnly-cookie storage + CSRF protection, refresh tokens, email verification, rate limiting on `/api/auth/*`.
4. **Money as integers.** Amounts are floats; move to integer cents (or DECIMAL) before treating the numbers as authoritative.
5. **FX rates.** Expenses already store their own currency; add a rates API so mixed-currency trips sum correctly.
6. **Deploy + code-split.** Backend, worker and MySQL on Render/Railway; frontend on Netlify/Vercel; lazy-load Recharts and the map libraries per tab.

## Project layout

```
sojourn/
  backend/
    app/
      main.py          FastAPI app, CORS, lifespan (tables, optional embedded worker)
      database.py      engine from DATABASE_URL (the SQLite/MySQL switch)
      auth.py          bcrypt hashing, JWT issue/verify, get_current_user
      models.py        SQLModel tables + API shapes
      timeutil.py      UTC column type, wall-clock ⇄ UTC conversion
      scheduling.py    reminder intent → UTC moment; rescheduling when stops/trips change
      delivery.py      the worker's tick: fan-out, leases, retries
      worker.py        python -m app.worker
      notify/          channels (console, email, push), settings, VAPID key generator
      geo/             Google Places (New) + Time Zone, Nominatim, provider rules, 30-day refresh
      seed.py          demo user + Tokyo trip + saved places
      routers/         auth · trips · itinerary · expenses · reminders · notifications · places · saved_places
    tests/             conftest + test_api · test_reminders · test_places · test_saved_places (104 tests)
    requirements*.txt  bounded ranges; requirements.lock = the exact tested set
    .env.example       every setting, with defaults
  frontend/
    public/sw.js       service worker: shows push notifications, opens the trip on click
    src/
      api/             types · client (axios + interceptors) · hooks
      auth/            AuthContext
      pages/           Login · Register · Trips · TripDetail · Saved
      components/      tabs, forms, DayStrip, Toast (undo), ConfirmDialog, SavedPlaceForm, AddToTripDialog, NearbySaved, …
      theme.ts         light / dark / system (applied before first paint by index.html)
      pendingDeletes.ts  the 5-second undo window behind every delete
      push.ts          subscribe/unsubscribe this browser
      time.ts          formatting in a zone, zone labels
  docs/
    reminders.md       how reminders work, in depth
    google-maps.md     Google setup, costs, and the terms the code follows
```
