import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError, KEY_HEADER } from '../src/lib/api.js';

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  f.calls = calls;
  return f;
}
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

test('the setup key travels in a header, never in the URL', async () => {
  const f = fakeFetch(() => reply(200, { trips: [] }));
  await createApi({ base: 'https://api.example/', key: 's3cret', fetchImpl: f }).list();
  assert.equal(f.calls[0].url, 'https://api.example/api/trips');
  assert.equal(f.calls[0].init.headers[KEY_HEADER], 's3cret');
  assert.ok(!f.calls[0].url.includes('s3cret'));
});

test('create, update and delete send the right requests', async () => {
  const f = fakeFetch((url, init) => (init.method === 'DELETE' ? reply(204) : reply(init.method === 'POST' ? 201 : 200, { trip: { id: 'a' } })));
  const api = createApi({ base: 'https://api.example', key: 'k', fetchImpl: f });
  assert.deepEqual(await api.create({ x: 1 }), { id: 'a' });
  assert.deepEqual(await api.update('a b', { x: 2 }), { id: 'a' });
  assert.equal(await api.remove('a'), null);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(f.calls[1].url, 'https://api.example/api/trips/a%20b');
  assert.equal(f.calls[2].init.method, 'DELETE');
});

test('errors are explained', async () => {
  const kind = async (handler, opts = {}) => {
    try { await createApi({ base: 'https://x', key: 'k', fetchImpl: fakeFetch(handler), ...opts }).list(); }
    catch (e) { assert.ok(e instanceof ApiError); return e.kind; }
    return 'no error';
  };
  assert.equal(await kind(() => reply(401, { error: 'nope' })), 'unauthorised');
  assert.equal(await kind(() => reply(404, {})), 'not-found');
  assert.equal(await kind(() => reply(500, {})), 'server');
  assert.equal(await kind(() => { throw new TypeError('Failed to fetch'); }), 'offline');
  assert.equal(await kind(() => reply(200, { trips: [] }), { key: '' }), 'no-key');
  assert.equal(await kind(() => reply(200, { trips: [] }), { base: '' }), 'no-server');
  try {
    await createApi({ base: 'https://x', key: 'k', fetchImpl: fakeFetch(() => reply(400, { error: 'Fix it', details: ['Start date is not a valid date'] })) }).create({});
  } catch (e) { assert.deepEqual(e.details, ['Start date is not a valid date']); }
});
