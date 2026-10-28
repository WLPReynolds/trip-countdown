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

## Going live

The app is at `https://trips.slightlygood.app` (GitHub Pages, see `CNAME`) and the API at `https://trips-api.slightlygood.app` (a Worker custom domain, see `worker/wrangler.toml`).

### GitHub Pages

1. Repo Settings, Pages: deploy from branch `main`, folder `/ (root)`.
2. Custom domain: `trips.slightlygood.app`.
3. Cloudflare DNS: `CNAME trips → wlpreynolds.github.io`, **DNS only** (grey cloud), so GitHub can issue the certificate.
4. Once the certificate is issued, tick **Enforce HTTPS**.

### Worker, database and setup key: in the Cloudflare dashboard

1. Storage & Databases, D1: the `trip-countdown` database is already created and its ID is in `worker/wrangler.toml`.
2. In the database's **Console** tab, paste and run `worker/migrations/0001_init.sql`.
3. Workers & Pages: create a Worker by importing this GitHub repository. Worker name `trip-countdown-api`, root directory `worker`, deploy command `npx wrangler deploy`. It redeploys whenever `main` changes.
4. Worker Settings, Variables and Secrets: add `SETUP_KEY` as a **Secret**, using a long random key from a password manager.
5. Open `https://trips-api.slightlygood.app/api/health`; it should show `{"ok":true}`.

### Worker, database and setup key: from the command line instead

```sh
cd worker
npx wrangler login
npx wrangler d1 create trip-countdown                      # paste the database_id it prints into wrangler.toml
npx wrangler d1 migrations apply trip-countdown --remote   # creates the tables
openssl rand -base64 32                                    # makes a setup key; keep it somewhere safe
npx wrangler secret put SETUP_KEY                          # paste the key when asked
npx wrangler deploy                                        # also creates the trips-api DNS record
```

Check it with `curl https://trips-api.slightlygood.app/api/health`.

The setup key is the only thing that protects the trip list. It's stored as an encrypted Worker secret, never in the repo, and phones send it in a request header. To change it, run `wrangler secret put SETUP_KEY` again and paste the new key on each phone.

## Setting up a phone

On iPhone, open the app in Safari and add it to the Home Screen first (the app shows how). Then open it from the Home Screen, tap Settings, and paste the setup key. The Home Screen app keeps its own settings, separate from Safari.
