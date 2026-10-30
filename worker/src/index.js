// Trip countdown API: one shared trip list in D1, protected by a setup key.
// Also runs the daily cron that snapshots forecasts for trips in range.
import { validateTrip } from '../../src/lib/trip.js';
import { forecastUrl, parseDaily, FORECAST_DAYS } from '../../src/lib/weather.js';
import { addDays, eachDay } from '../../src/lib/time.js';

const KEY_HEADER = 'X-Setup-Key';
const MAX_BODY = 32 * 1024;

// ---------------------------------------------------------------- helpers

/** Compare two strings without leaking where they differ. */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && env.ALLOW_LOCALHOST === 'true') return origin;
  return null;
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request.headers.get('Origin'), env);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, ${KEY_HEADER}`,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, cors) {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { ...(data === null ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store', ...cors },
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: 'Request is too large' };
  try { return { value: JSON.parse(text) }; } catch { return { error: 'Request body must be JSON' }; }
}

const rowToTrip = (row) => ({ ...JSON.parse(row.data), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at });

// ---------------------------------------------------------------- routes

async function listTrips(env) {
  const { results } = await env.DB.prepare('SELECT id, data, created_at, updated_at FROM trips ORDER BY created_at').all();
  return results.map(rowToTrip);
}

async function getTrip(env, id) {
  const row = await env.DB.prepare('SELECT id, data, created_at, updated_at FROM trips WHERE id = ?').bind(id).first();
  return row ? rowToTrip(row) : null;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/api/health') return json({ ok: true }, 200, cors);
  if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404, cors);

  if (!env.SETUP_KEY) return json({ error: 'The server has no setup key configured' }, 503, cors);
  if (!safeEqual(request.headers.get(KEY_HEADER) || '', env.SETUP_KEY)) return json({ error: 'Setup key not accepted' }, 401, cors);

  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(2); // ['trips', id?, 'snapshots'?]
  if (parts[0] !== 'trips' || parts.length > 3) return json({ error: 'Not found' }, 404, cors);
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  const now = new Date().toISOString();

  if (!id && request.method === 'GET') return json({ trips: await listTrips(env) }, 200, cors);

  if (!id && request.method === 'POST') {
    const body = await readBody(request);
    if (body.error) return json({ error: body.error }, 400, cors);
    const v = validateTrip(body.value);
    if (!v.ok) return json({ error: 'Some trip details need fixing', details: v.errors }, 400, cors);
    const newId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO trips (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(newId, JSON.stringify(v.trip), now, now).run();
    return json({ trip: await getTrip(env, newId) }, 201, cors);
  }

  if (id && parts.length === 2 && request.method === 'PUT') {
    const body = await readBody(request);
    if (body.error) return json({ error: body.error }, 400, cors);
    // A phone still on an older version sends one `event` and no list. Keep the
    // stored list rather than shrinking it to the one event that phone can see.
    if (body.value && typeof body.value === 'object' && !Array.isArray(body.value.events)) {
      const stored = await getTrip(env, id);
      if (Array.isArray(stored?.events)) { body.value.events = stored.events; delete body.value.event; }
    }
    const v = validateTrip(body.value);
    if (!v.ok) return json({ error: 'Some trip details need fixing', details: v.errors }, 400, cors);
    const res = await env.DB.prepare('UPDATE trips SET data = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(v.trip), now, id).run();
    if (!res.meta?.changes) return json({ error: 'Trip not found' }, 404, cors);
    return json({ trip: await getTrip(env, id) }, 200, cors);
  }

  if (id && parts.length === 2 && request.method === 'DELETE') {
    const [del] = await env.DB.batch([
      env.DB.prepare('DELETE FROM trips WHERE id = ?').bind(id),
      env.DB.prepare('DELETE FROM forecast_snapshots WHERE trip_id = ?').bind(id),
    ]);
    if (!del.meta?.changes) return json({ error: 'Trip not found' }, 404, cors);
    return json(null, 204, cors);
  }

  if (id && parts[2] === 'snapshots' && request.method === 'GET') {
    if (!(await getTrip(env, id))) return json({ error: 'Trip not found' }, 404, cors);
    const { results } = await env.DB.prepare(
      'SELECT taken_on, target_date, tmax, tmin, precip, rain_chance, wind, uv, code FROM forecast_snapshots WHERE trip_id = ? ORDER BY taken_on, target_date',
    ).bind(id).all();
    const snapshots = results.map((r) => ({
      takenOn: r.taken_on, targetDate: r.target_date, tmax: r.tmax, tmin: r.tmin,
      precip: r.precip, rainChance: r.rain_chance, wind: r.wind, uv: r.uv, code: r.code,
    }));
    return json({ snapshots }, 200, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

// ---------------------------------------------------------------- cron

/** Trips with at least one day inside the forecast window that haven't finished. */
export function tripsInForecastRange(trips, today) {
  const last = addDays(today, FORECAST_DAYS - 1);
  return trips.filter((t) => t.endDate >= today && t.startDate <= last);
}

/**
 * Save today's forecast for every trip day the forecast covers.
 * Locations are fetched once even if several trips share them.
 */
export async function snapshotForecasts(env, now = new Date(), fetchImpl = fetch) {
  const today = now.toISOString().slice(0, 10);
  const trips = tripsInForecastRange(await listTrips(env), today);
  const cache = new Map();
  let saved = 0;
  const failures = [];
  for (const t of trips) {
    const url = forecastUrl(t.destination.lat, t.destination.lon);
    try {
      if (!cache.has(url)) {
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`forecast ${res.status}`);
        cache.set(url, parseDaily(await res.json()));
      }
      const forecast = cache.get(url);
      const stmts = eachDay(t.startDate, t.endDate).filter((d) => forecast.has(d)).map((d) => {
        const f = forecast.get(d);
        return env.DB.prepare(
          `INSERT INTO forecast_snapshots (trip_id, taken_on, target_date, tmax, tmin, precip, rain_chance, wind, uv, code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (trip_id, taken_on, target_date) DO UPDATE SET
             tmax = excluded.tmax, tmin = excluded.tmin, precip = excluded.precip, rain_chance = excluded.rain_chance,
             wind = excluded.wind, uv = excluded.uv, code = excluded.code`,
        ).bind(t.id, today, d, f.tmax, f.tmin, f.precip, f.rainChance, f.wind, f.uv, f.code);
      });
      if (stmts.length) { await env.DB.batch(stmts); saved += stmts.length; }
    } catch (e) {
      failures.push({ id: t.id, error: String(e.message || e) });
    }
  }
  return { trips: trips.length, saved, failures };
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(snapshotForecasts(env, new Date(event.scheduledTime))),
};
