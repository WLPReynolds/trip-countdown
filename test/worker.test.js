import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, whatsOn, safeEqual, allowedOrigin, tripsInForecastRange, snapshotForecasts } from '../worker/src/index.js';
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

  test('trips hold a list of events, and an older phone saving a trip keeps them', async () => {
    const { body: { trip } } = await call('POST', '/api/trips', { body: nerja() });
    assert.equal(trip.event, undefined);
    assert.deepEqual(trip.events.map((e) => e.name), ['Total solar eclipse']);

    const events = [...trip.events, { name: 'Feria', date: '2027-07-30' }];
    const two = (await call('PUT', `/api/trips/${trip.id}`, { body: { ...nerja(), event: undefined, events } })).body.trip;
    assert.deepEqual(two.events.map((e) => e.name), ['Total solar eclipse', 'Feria']);
    assert.equal(two.events[0].id, trip.events[0].id, 'event ids survive a save');

    // The old app sends its one event and no list.
    const old = (await call('PUT', `/api/trips/${trip.id}`, { body: { ...nerja(), name: 'Renamed' } })).body.trip;
    assert.equal(old.name, 'Renamed');
    assert.deepEqual(old.events.map((e) => e.name), ['Total solar eclipse', 'Feria']);
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

describe('what’s on', () => {
  const q = (o) => new URL(`https://api.test/api/whats-on?${new URLSearchParams({ lat: '36.54', lon: '-4.62', cc: 'ES', start: '2027-06-11', end: '2027-06-18', ...o })}`);
  const fake = (routes) => async (u) => {
    for (const [match, res] of routes) if (String(u).includes(match)) return typeof res === 'function' ? res(u) : res;
    throw new Error(`unexpected fetch ${u}`);
  };
  const ok = (data) => new Response(JSON.stringify(data), { status: 200 });

  test('needs the setup key like everything else', async () => {
    assert.equal((await call('GET', '/api/whats-on', { key: null })).status, 401);
  });

  test('holidays come back; Ticketmaster is off until its key is set', async () => {
    const f = fake([['date.nager.at', ok([{ date: '2027-06-12', name: 'Fiesta', localName: 'Fiesta', global: true, counties: null }])]]);
    const r = await whatsOn(q(), env, f);
    assert.deepEqual(r.holidays.map((x) => x.name), ['Fiesta']);
    assert.deepEqual(r.ticketmaster, { enabled: false, events: [] });
  });

  test('with the key, Ticketmaster events come back and the key stays on the server', async () => {
    env.TICKETMASTER_API_KEY = 'tm-secret';
    let asked = '';
    const f = fake([
      ['date.nager.at', ok([])],
      ['ticketmaster.com', (u) => { asked = String(u); return ok({ _embedded: { events: [{ id: 'x', name: 'Gig', url: 'https://t.example/x', dates: { start: { localDate: '2027-06-12', localTime: '21:00:00' } }, classifications: [{ segment: { name: 'Music' } }] }] } }); }],
    ]);
    const res = await handle(req('GET', q().pathname + q().search), env, f);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.ticketmaster.events.map((e) => e.name), ['Gig']);
    assert.match(asked, /apikey=tm-secret/);
    assert.ok(!JSON.stringify(body).includes('tm-secret'));
  });

  test('one source failing doesn’t take the other with it', async () => {
    env.TICKETMASTER_API_KEY = 'bad';
    const r = await whatsOn(q(), env, fake([['date.nager.at', new Response('', { status: 500 })], ['ticketmaster.com', new Response('', { status: 401 })]]));
    assert.equal(r.holidays, null);
    assert.equal(r.ticketmaster.enabled, true);
    assert.match(r.ticketmaster.error, /key/);
  });

  test('countries Nager.Date doesn’t cover give no holidays rather than an error', async () => {
    const r = await whatsOn(q({ cc: 'AQ' }), env, fake([['date.nager.at', new Response(null, { status: 404 })]]));
    assert.deepEqual(r.holidays, []);
  });

  test('bad requests are refused', async () => {
    assert.ok((await whatsOn(q({ lat: 'x' }), env, fake([]))).error);
    assert.ok((await whatsOn(q({ end: '2027-06-01' }), env, fake([]))).error);
    assert.ok((await whatsOn(q({ end: '2029-06-01' }), env, fake([]))).error);
    assert.equal((await call('GET', '/api/whats-on?lat=x')).status, 400);
  });
});
