# Trip countdown

A shared holiday countdown for two phones. Every trip has a countdown, a map of the country with a pin, and the weather for each day of the stay. Trips can also have a special event, such as the 2 August 2027 total solar eclipse.

- **App:** static PWA (`index.html`, `src/`, `sw.js`) served by GitHub Pages.
- **API:** Cloudflare Worker (`worker/`) with D1, plus a daily cron that saves forecasts.
- **Data:** Open-Meteo (geocoding, forecast, archive, seasonal, marine) and Natural Earth 1:10m countries via [world-atlas](https://github.com/topojson/world-atlas) (`data/`).

## How it works

| Piece | Where |
| --- | --- |
| Countdown: days, then hours and minutes inside 48 hours, then minutes and seconds in the final hour | `src/lib/countdown.js` |
| Flight times stored as local time plus IANA time zone | `src/lib/time.js` |
| Map: whole country, or about 1,000 km around the pin for big countries; remote islands left out | `src/lib/geo.js` |
| Weather per day: Forecast within 16 days, otherwise Average (10 years, ±3 days), shown as Outlook when the seasonal model covers that month | `src/lib/weather.js` |
| Sea temperature: forecast within 8 days, otherwise typical for the same dates since 2022 | `src/lib/weather.js` |
| Event cloud cover: odds of clear sky at that hour from 10 years of history, forecast in the final 14 days | `src/lib/weather.js` |
| Card colours follow the season at the destination (southern hemisphere flipped, tropics their own) | `src/lib/trip.js` |
| Shared list, setup key check, forecast snapshots | `worker/src/index.js` |

## Tests

```sh
npm test
```

No dependencies to install; tests use Node's built-in test runner (Node 22.13 or later). Worker tests run real SQL against the D1 migration using Node's built-in SQLite.

## Versioning

The version appears in `package.json`, `src/app.js`, `sw.js` and `index.html` (twice). Bump them together:

```sh
npm run bump          # next patch
npm run bump -- 0.2.0 # a specific version
```

A test fails if they ever disagree.

## Deploying the Worker

```sh
cd worker
npx wrangler d1 create trip-countdown          # copy the database_id into wrangler.toml
npx wrangler d1 migrations apply trip-countdown --remote
npx wrangler secret put SETUP_KEY              # paste a long random key
npx wrangler deploy
```

Set `ALLOWED_ORIGINS` in `wrangler.toml` to the app's address. Then put the Worker's address in `DEFAULT_API_BASE` in `src/app.js`, so phones only need the setup key.

## Setting up a phone

Open the app, then Settings. Paste the setup key and save. On iPhone, open it in Safari and use Share, Add to Home Screen.
