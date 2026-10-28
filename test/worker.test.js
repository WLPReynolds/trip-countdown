import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, safeEqual, allowedOrigin, tripsInForecastRange, snapshotForecasts } from '../worker/src/index.js';
import { createD1 } from './helpers/d1.js';
import { nerja, fuengirola, dailyJson } from './helpers/fixtures.js';
import { eachDay, addDays } from '../src/lib/time.js';

const KEY = 'correct-horse-battery-staple';
let env;
beforeEach(() => { env = { DB: createD1(), SETUP_KEY: KEY, ALLOWED_ORIGINS: 'https://trips.slightlygood.app' }; });

function req(method, path, { body, key = KEY, origin } = {}) {
  const headers = {};
  if (key) headers['X-Setup-Key'] = key;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}
const call = async (...a) => { const res = await handle(req(...a), env); return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() }; };

describe('security', () => {
  test('the health check needs no key', async () => {
    assert.deepEqual((await call('GET', '/api/health', { key: null })).body, { ok: true });
  });

  test('everything else needs the right setup key', async () => {
    assert.equal((await call('GET', '/api/trips', { key: null })).status, 401);
    assert.equal((await call('GET', '/api/trips', { key: 'wrong' })).status, 401);
    assert.equal((await call('GET', '/api/trips', { key: KEY + 'x' })).status, 401);
    assert.equal((await call('GET', '/api/trips')).status, 200);
  });

  test('refuses to run without a configured key', async () => {
    delete env.SETUP_KEY;
    assert.equal((await call('GET', '/api/trips', { key: '' })).status, 503);
  });

  test('key comparison', () => {
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
    assert.ok(!safeEqual('', 'a'));
  });

  test('only the app’s own address gets CORS headers', async () => {
    const pre = await handle(req('OPTIONS', '/api/trips', { key: null, origin: 'https://trips.slightlygood.app' }), env);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://trips.slightlygood.app');
    assert.ok(pre.headers.get('Access-Control-Allow-Headers').includes('X-Setup-Key'));
    const evil = await handle(req('GET', '/api/trips', { origin: 'https://evil.example' }), env);
    assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(allowedOrigin('http://localhost:8080', env), null);
    assert.equal(allowedOrigin('http://localhost:8080', { ...env, ALLOW_LOCALHOST: 'true' }), 'http://localhost:8080');
  });
});

describe('shared trip list', () => {
  test('add, list, edit and delete a trip', async () => {
    const created = await call('POST', '/api/trips', { body: nerja() });
    assert.equal(created.status, 201);
    const id = created.body.trip.id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(created.body.trip.destination.name, 'Nerja');
    assert.ok(created.body.trip.updatedAt);

    await call('POST', '/api/trips', { body: fuengirola() });
    const list = await call('GET', '/api/trips');
    assert.deepEqual(list.body.trips.map((t) => t.destination.name).sort(), ['Fuengirola', 'Nerja']);

    const edited = await call('PUT', `/api/trips/${id}`, { body: { ...nerja(), name: 'Eclipse trip' } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.trip.name, 'Eclipse trip');
    assert.equal(edited.body.trip.createdAt, created.body.trip.createdAt);

    assert.equal((await call('DELETE', `/api/trips/${id}`)).status, 204);
    assert.equal((await call('GET', '/api/trips')).body.trips.length, 1);
    assert.equal((await call('DELETE', `/api/trips/${id}`)).status, 404);
  });

  test('ids in the body are ignored; the server owns them', async () => {
    const { body } = await call('POST', '/api/trips', { body: { ...nerja(), id: 'chosen-by-client' } });
    assert.notEqual(body.trip.id, 'chosen-by-client');
  });

  test('invalid trips are rejected with reasons', async () => {
    const bad = await call('POST', '/api/trips', { body: { ...nerja(), endDate: '2027-01-01' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.includes('End date is before the start date'));
    assert.equal((await call('POST', '/api/trips', { body: '{not json' })).status, 400);
    assert.equal((await call('POST', '/api/trips', { body: JSON.stringify({ ...nerja(), name: 'x'.repeat(40000) }) })).status, 400);
  });

  test('editing a trip that has gone is a 404', async () => {
    assert.equal((await call('PUT', '/api/trips/missing', { body: nerja() })).status, 404);
    assert.equal((await call('GET', '/api/trips/missing/snapshots')).status, 404);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
  });
});

describe('daily forecast snapshots', () => {
  const forecastFrom = (today, tmax) => dailyJson(eachDay(today, addDays(today, 15)), () => ({
    temperature_2m_max: tmax, temperature_2m_min: 20, precipitation_sum: 0, precipitation_probability_max: 10, wind_speed_10m_max: 9, uv_index_max: 8, weather_code: 1,
  }));
  const fetchReturning = (json) => { const f = async () => new Response(JSON.stringify(json)); f.count = 0; const w = async (...a) => { w.count++; return f(...a); }; w.count = 0; return w; };

  test('only trips the forecast reaches, and not finished ones', () => {
    const trips = [
      { startDate: '2027-07-27', endDate: '2027-08-06' },
      { startDate: '2027-07-01', endDate: '2027-07-10' },
      { startDate: '2027-07-30', endDate: '2027-08-10' },
    ];
    assert.deepEqual(tripsInForecastRange(trips, '2027-07-15').map((t) => t.startDate), ['2027-07-27', '2027-07-30']);
    assert.deepEqual(tripsInForecastRange(trips, '2027-07-12').map((t) => t.startDate), ['2027-07-27']);
    assert.deepEqual(tripsInForecastRange(trips, '2026-10-27'), []);
  });

  test('saves one row per covered trip day, fetching each place once', async () => {
    const a = (await call('POST', '/api/trips', { body: nerja() })).body.trip.id;
    await call('POST', '/api/trips', { body: { ...nerja(), name: 'Same place again' } });
    const f = fetchReturning(forecastFrom('2027-07-20', 31));
    const r = await snapshotForecasts(env, new Date('2027-07-20T05:17:00Z'), f);
    assert.equal(r.trips, 2);
    assert.equal(r.saved, 18);  // 27 Jul – 4 Aug is covered: 9 days × 2 trips
    assert.equal(f.count, 1);

    const snaps = (await call('GET', `/api/trips/${a}/snapshots`)).body.snapshots;
    assert.equal(snaps.length, 9);
    assert.deepEqual(snaps[0], { takenOn: '2027-07-20', targetDate: '2027-07-27', tmax: 31, tmin: 20, precip: 0, rainChance: 10, wind: 9, uv: 8, code: 1 });
  });

  test('running twice in a day updates rather than duplicating; the next day adds more', async () => {
    const id = (await call('POST', '/api/trips', { body: nerja() })).body.trip.id;
    await snapshotForecasts(env, new Date('2027-07-20T05:17:00Z'), fetchReturning(forecastFrom('2027-07-20', 30)));
    await snapshotForecasts(env, new Date('2027-07-20T09:00:00Z'), fetchReturning(forecastFrom('2027-07-20', 33)));
    await snapshotForecasts(env, new Date('2027-07-21T05:17:00Z'), fetchReturning(forecastFrom('2027-07-21', 29)));
    const snaps = (await call('GET', `/api/trips/${id}/snapshots`)).body.snapshots;
    assert.equal(snaps.filter((s) => s.takenOn === '2027-07-20').length, 9);
    assert.equal(snaps.find((s) => s.takenOn === '2027-07-20').tmax, 33);
    assert.equal(snaps.filter((s) => s.takenOn === '2027-07-21').length, 10);
  });

  test('deleting a trip removes its snapshots', async () => {
    const id = (await call('POST', '/api/trips', { body: nerja() })).body.trip.id;
    await snapshotForecasts(env, new Date('2027-07-20T05:17:00Z'), fetchReturning(forecastFrom('2027-07-20', 30)));
    await call('DELETE', `/api/trips/${id}`);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM forecast_snapshots').get().n, 0);
  });

  test('a failed forecast is recorded and doesn’t stop other trips', async () => {
    await call('POST', '/api/trips', { body: nerja() });
    const r = await snapshotForecasts(env, new Date('2027-07-20T05:17:00Z'), async () => new Response('busy', { status: 503 }));
    assert.equal(r.saved, 0);
    assert.equal(r.failures.length, 1);
  });

  test('the cron entry point hands the work to waitUntil', async () => {
    let waited = null;
    worker.scheduled({ scheduledTime: Date.parse('2026-10-27T05:17:00Z') }, env, { waitUntil: (p) => { waited = p; } });
    assert.ok(waited instanceof Promise);
    assert.deepEqual(await waited, { trips: 0, saved: 0, failures: [] });
  });
});
