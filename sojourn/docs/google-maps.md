# Google Maps in One Trip

One Trip runs with no keys at all: OpenStreetMap draws the map, Nominatim finds places, and an offline lookup works out time zones. Adding Google gets you Google's place search and map, and Google's Time Zone API. This doc covers setup, what each piece does, what it costs, and the Google rules the code follows.

## Setup (about 10 minutes)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and attach a billing account. Billing is required even if you stay inside the free usage.
2. Under **APIs & Services → Library**, enable:
   - **Places API (New)** for search and place details. The *legacy* Places API can't be enabled on new projects, and One Trip doesn't use it.
   - **Maps JavaScript API** for the map tab.
   - **Time Zone API**, optional. Without it, time zones come from the offline lookup, which is just as accurate.
3. Under **APIs & Services → Credentials**, create **two** API keys:

   | Key | Restrict to APIs | Restrict to | Goes in |
   |---|---|---|---|
   | server | Places API (New), Time Zone API | your server's IP (once deployed) | `GOOGLE_MAPS_API_KEY` |
   | browser | Maps JavaScript API | websites: `http://localhost:5173/*` (+ your real domain later) | `GOOGLE_MAPS_BROWSER_KEY` |

   The server key never reaches the browser; the frontend only talks to `/api/places/*`. The browser key is public by nature, which is why it's locked to your site's addresses.
4. In `backend/.env`:
   ```dotenv
   GOOGLE_MAPS_API_KEY=...
   GOOGLE_MAPS_BROWSER_KEY=...
   # GEOCODER=auto   (default: Google when both keys are set)
   ```
5. Restart the API. `GET /api/config` should now say `"place_search": "google"`.
6. **Set guardrails.** In **APIs & Services → Places API (New) → Quotas**, cap requests per day (e.g. 500). Under **Billing → Budgets & alerts**, add a small budget with email alerts.

If something's wrong, the search box now says what Google said. For example, "Google Places 403: … (is Places API (New) enabled for this key?)". The old code turned these errors into an empty result.

## What Google feeds into the app

### Place search: Autocomplete (New) + session tokens

```
typing "jfk t…"  ──▶  POST places:autocomplete  {input, sessionToken: S}   (debounced, 350ms)
                 ◀──  suggestions: name + address + placeId, NO coordinates
pick a result    ──▶  GET places/{placeId}?sessionToken=S                    (fields: location,formattedAddress)
                 ◀──  lat/lng + full address
next search      ──▶  new token S2
```

The session token is the cost trick. Every keystroke request plus the one details call share a token, so Google bills the session as a single Place Details call instead of billing every keystroke. Google's billing page says these sessions are currently free. A session that ends without a pick bills each request as a plain Autocomplete request.

The details call asks for exactly `location,formattedAddress`. The field mask decides the price tier, and both fields are in the cheapest one (Essentials). A test fails if anyone adds a pricier field.

Code: `backend/app/geo/google.py`, `frontend/src/components/PlaceSearchInput.tsx`.

### Time zones: from the place you pick

- Picking a **destination** on the trip form sets the trip's time zone ("Time zone set to Tokyo time from Tokyo, Japan.").
- Picking a **stop's place** sets the stop's zone *if it differs from the trip's*: JFK Terminal 4 on a Tokyo trip becomes New York time, so "3 hours before the flight" reminders count back from the right moment.
- `GET /api/places/timezone?lat&lng` uses Google's Time Zone API when the server key is set, and the offline `timezonefinder` package otherwise, or when Google refuses (it logs a warning saying why). The result is an IANA name either way, which is what the reminder system already speaks.

Code: `backend/app/geo/timezones.py`.

### The map

`GOOGLE_MAPS_BROWSER_KEY` switches the map tab from Leaflet/OpenStreetMap to Google Maps.

## Google's rules, and how the code follows them

From the [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) and the [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies):

| Rule | What the code does |
|---|---|
| **Places content can't be used with a non-Google map.** | `GEOCODER=auto` only uses Google search when *both* keys are set (`app/geo/providers.py`). `GEOCODER=google` with the browser key missing is refused with an explanation. If the browser key is removed later, the OpenStreetMap view leaves out Google-sourced stops and says why (`TripMap.tsx`). |
| **Latitude/longitude from Places may be cached for up to 30 consecutive days, then must be deleted.** Place IDs may be kept. | Every stop records `coords_source` (google / nominatim / manual) and `coords_fetched_at`. The worker's hourly pass (`app/geo/refresh.py`) re-fetches Google coordinates from day 25. If that fails, it deletes them at day 30 and keeps the `place_id`, so a later pass can restore them. OpenStreetMap and hand-typed coordinates are never touched. |
| **Attribution** when Places data is shown outside a Google map. | Google results in the search dropdown carry the text **Google Maps**: untranslated, gray #5E5E5E, 12px, regular weight. That's the policy's text option for tight spaces. |
| **Server keys stay on the server.** | Only `/api/places/*` calls Google; the browser never sees `GOOGLE_MAPS_API_KEY`. All three endpoints require sign-in. |

## Cost

Google bills per "SKU" (one kind of call), and each SKU has free calls every month. Since March 2025 these caps replaced the old $200 monthly credit. They're typically 10,000 for Essentials, 5,000 for Pro and 1,000 for Enterprise. One Trip's calls:

| Call | When | Tier | Free / month | After that |
|---|---|---|---|---|
| Autocomplete (in a session that ends in a pick) | typing in a search box | session usage | free | — |
| Place Details, `location,formattedAddress` | each pick, and each 25-day refresh | Essentials | 10,000 | $5 / 1,000 |
| Autocomplete (session abandoned, no pick) | typing, then giving up | Essentials | 10,000 | $2.83 / 1,000 |
| Time Zone | each pick | Essentials | 10,000 | $5 / 1,000 |
| Dynamic Maps | each Map tab load | Essentials | 10,000 | $7 / 1,000 |

For a personal or portfolio app this rounds to **$0**. Even 100 picks a day is about 3,000 Place Details + 3,000 Time Zone calls a month, well inside the free caps. The quota cap from setup step 6 means a bug or a bot can't run up a bill. Prices are from Google's [pricing list](https://developers.google.com/maps/billing-and-pricing/pricing); check it before you rely on them.

## Testing without Google

- `python -m pytest tests/test_places.py`: 17 tests against a mocked Google (httpx `MockTransport`). They check the exact requests sent (session tokens, field masks, which key) and how Google's errors, time-zone fallbacks and the 30-day refresh are handled.
- `GOOGLE_PLACES_BASE` and `GOOGLE_MAPS_BASE` point the app at a stand-in server. That's how the full browser flow was tested end to end without real Google calls. Leave them unset in normal use.
- The test suite clears every Google variable before each test, so your real keys can never be called, or billed, by a test run.

## Ideas for later

- **Opening hours** (Place Details Enterprise, `regularOpeningHours`): warn when a stop is planned while the place is closed. It's the priciest tier, so fetch it once per stop, not per view.
- **Travel times** (Routes API, Compute Route Matrix, Essentials): the input for an "optimize my day" feature.
- **Photos** (Place Details Photos, Enterprise): nice on trip cards, but budget for it.
