# Sojourn

*Plan the days, mind the budget, never miss a departure.*

A travel itinerary + finance planner + reminders app, now multi-user. One **Trip** is the hub; itinerary stops, expenses, and reminders all hang off it, and every trip belongs to a **User**. The two optional links are the signature of the design: an expense can belong to a specific stop ("dinner owns its $52") and a reminder can be pinned to one too ("leave 2h before the flight").

**Stack:** FastAPI + SQLModel · MySQL (or SQLite for zero-config dev) · JWT auth (bcrypt + PyJWT) · React 19 + TypeScript · axios + TanStack Query · Recharts · Leaflet/OpenStreetMap **or** Google Maps.

```
frontend (Vite :5173)                        backend (uvicorn :8000)
┌───────────────────────────────┐            ┌─────────────────────────────────┐
│ React + TS                    │   /api/*   │ FastAPI                         │
│  axios ─ interceptors ────────┼──────────▶ │  auth: register/login/me (JWT)  │
│   · attach Bearer token       │  (proxy)   │  trips · itinerary · expenses   │
│   · normalize errors, 401s    │            │  reminders · config             │
│  TanStack Query cache         │            │  places: google | nominatim     │
│  maps: Leaflet OSM / Google   │            │ SQLModel ─▶ MySQL / SQLite      │
└───────────────────────────────┘            └─────────────────────────────────┘
```

## Quickstart

Two terminals.

**Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.seed          # demo user + Tokyo trip (prints the login)
uvicorn app.main:app --reload
```

**Frontend**

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173  (proxies /api → :8000)
```

Sign in with the seeded demo account — **demo@sojourn.app / wanderlust** — or register your own. The API self-documents at http://localhost:8000/docs (the Authorize button works against `/api/auth/login`).

> **Upgrading from the pre-auth version?** The schema changed (users + trip ownership). Delete `backend/sojourn.db` and re-run the seed.

## How auth works

Registration and login both return a signed JWT (7-day expiry) plus the user object. The token carries only the user id — it's signed, not encrypted; nobody can forge one without `SECRET_KEY` (set a real one: `openssl rand -hex 32`).

On the frontend, **axios interceptors** make auth invisible to the rest of the code: a request interceptor attaches `Authorization: Bearer <token>` from localStorage, and a response interceptor normalizes FastAPI's error shapes and — on a 401 from any protected route — clears the session and returns to `/login`. Components never touch tokens.

Authorization lives next to the data. Every router funnels through `get_owned_trip`, which answers **404 (not 403)** when a trip exists but belongs to someone else, so the API never reveals which ids exist. Child resources (stops, expenses, reminders) authorize by walking up to their owning trip, and `/api/reminders/due` only surfaces *your* reminders.

Tradeoff worth knowing: the token sits in localStorage — simple, survives refresh, but readable by any JS on the page (XSS). The hardened pattern is an httpOnly cookie + CSRF token; it's on the roadmap.

## Maps & geocoding — the provider pattern

Two independent provider choices, both defaulting to free-and-keyless. Same idea as a multi-provider LLM client: the app talks to one interface; swapping vendors is configuration, not code.

| Concern | Default (no keys) | With Google keys |
|---|---|---|
| **Map display** (browser) | Leaflet + OpenStreetMap tiles | Google Maps JS, when `GOOGLE_MAPS_BROWSER_KEY` is set |
| **Location search** (server) | Nominatim (OSM's free geocoder) | Google Places, when `GOOGLE_MAPS_API_KEY` is set (`GEOCODER=auto\|google\|nominatim`) |

The two Google keys are deliberately different creatures:

* `GOOGLE_MAPS_API_KEY` — **server-side**, used by `/api/places/search`. Never leaves the server. Restrict it by IP in Google Cloud.
* `GOOGLE_MAPS_BROWSER_KEY` — **browser-side**, served to the frontend via `/api/config`. Browser keys are public by nature; restrict this one by HTTP referrer.

The stop form's "Where" field is a debounced autocomplete against `/api/places/search`; picking a result stores `place_id`, `lat`, `lng` on the stop. The **Map tab** then draws every located stop as a category-colored station (same colors as the itinerary's metro line) connected by a route polyline — identically on both providers. Mapbox would slot in as a third provider the same way.

## Tests

```bash
cd backend
python -m pytest -q         # 21 tests against in-memory SQLite
```

Covered: register/login/me flow, duplicate email and wrong-password rejection, password length validation, 401s on every protected route, **cross-user isolation** (user B cannot list, read, edit, or attach expenses to user A's trips), per-user due-reminder scoping, plus all v1 behavior — CRUD + validation, itinerary ordering, coordinate storage, currency fallback, cross-trip link rejection, stop-deletion unlinking (not deleting) its expenses, the summary math, zero-budget guard, and trip cascade delete.

## API reference

`/api/auth/*` and `/api/config` are public; **everything else requires `Authorization: Bearer <token>`**.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | create account → token + user |
| POST | `/api/auth/login` | OAuth2 form (username = email) → token + user |
| GET | `/api/auth/me` | current user |
| GET | `/api/config` | runtime config (browser map key, if any) |
| GET/POST | `/api/trips` | list / create *your* trips |
| GET/PATCH/DELETE | `/api/trips/{id}` | one trip (delete cascades) |
| GET | `/api/trips/{id}/summary` | budget math: totals, per-category, daily burn |
| GET/POST | `/api/trips/{id}/itinerary` | stops, sorted by date + time |
| PATCH/DELETE | `/api/itinerary/{id}` | edit / remove a stop (unlinks its expenses & reminders) |
| GET/POST | `/api/trips/{id}/expenses` | expenses (currency defaults to trip's) |
| PATCH/DELETE | `/api/expenses/{id}` | edit / remove an expense |
| GET/POST | `/api/trips/{id}/reminders` | reminders for a trip |
| PATCH/DELETE | `/api/reminders/{id}` | edit (incl. status) / remove |
| GET | `/api/reminders/due` | pending & past-due across *your* trips — feeds the badge |
| GET | `/api/places/search?q=` | geocode via the configured provider |

## Switching to MySQL

```bash
cd backend
docker compose up -d        # MySQL 8.4 with a sojourn/sojourn user
cp .env.example .env        # then uncomment the MySQL DATABASE_URL line
```

Models, queries, and tests are identical on both engines. Once the schema stops churning, move table creation from `create_all` to Alembic migrations.

## How reminders work (v1)

Deliberately zero-infrastructure: the frontend polls `GET /api/reminders/due` once a minute and shows an inbox badge. Nothing runs in the background. That makes the **scheduled worker the first real upgrade** — the endpoint and status model (`pending / done / dismissed`) are already shaped for it.

## Roadmap (ordered as a learning path)

1. **Background scheduler** — an APScheduler (or Celery beat) job that wakes periodically, finds newly-due reminders, and *delivers* them (email via SMTP, or web push). This is the piece that teaches something genuinely new: long-running processes, delivery guarantees, idempotency.
2. **Harden auth** — refresh tokens, httpOnly-cookie storage + CSRF protection, email verification, rate limiting on `/api/auth/*`.
3. **Alembic migrations** — replace startup `create_all`; required for safe MySQL schema evolution.
4. **Money as integers** — amounts are floats for v1 simplicity. Migrate to integer cents (or DECIMAL columns) before treating the numbers as authoritative.
5. **FX rates** — expenses already store their own currency; add a rates API so mixed-currency trips sum correctly.
6. **Deploy + code-split** — backend + MySQL on Render/Railway, frontend on Netlify/Vercel; lazy-load Recharts and the map libraries per tab (the bundle warning is real).

## Project layout

```
backend/
  app/
    main.py          FastAPI app, CORS, lifespan table creation, /api/config
    database.py      engine from DATABASE_URL (the SQLite/MySQL switch)
    auth.py          bcrypt hashing, JWT issue/verify, get_current_user
    models.py        SQLModel: User + Trip/Item/Expense/Reminder hierarchies
    seed.py          demo user + Tokyo trip with coordinates
    routers/         auth · trips · itinerary · expenses · reminders · places
  tests/test_api.py  21 tests, in-memory SQLite
  docker-compose.yml MySQL 8.4 for local prod-parity
frontend/
  src/
    api/             types.ts · client.ts (axios + interceptors) · hooks.ts
    auth/            AuthContext (session state, login/register/logout)
    pages/           Login · Register · Trips · TripDetail
    components/      ItineraryTab · BudgetTab · RemindersTab · TripMap · PlaceSearchInput
    styles.css       transit-map design system
```
