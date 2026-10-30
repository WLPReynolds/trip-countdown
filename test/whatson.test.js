import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripYears, parseHolidays, fullMoons, skyEvents, geohash, ticketmasterUrl, parseTicketmaster, searchLink, holidaysUrl } from '../src/lib/whatson.js';

test('holidays: trips across New Year look at both years', () => {
  assert.deepEqual(tripYears('2027-12-28', '2028-01-04'), [2027, 2028]);
  assert.deepEqual(tripYears('2027-06-11', '2027-06-18'), [2027]);
  assert.equal(holidaysUrl(2027, 'AT'), 'https://date.nager.at/api/v3/PublicHolidays/2027/AT');
});

test('holidays inside the trip are kept, and regional ones marked', () => {
  const nager = [
    { date: '2027-06-10', localName: 'Antes', name: 'Before', global: true, counties: null },
    { date: '2027-06-12', localName: 'Fiesta', name: 'Fiesta', global: true, counties: null },
    { date: '2027-06-15', localName: 'Día de la Región', name: 'Regional Day', global: false, counties: ['ES-AN', 'ES-MC'] },
    { date: '2027-06-15', localName: 'Día de la Región', name: 'Regional Day', global: false, counties: ['ES-AN'] },
  ];
  const r = parseHolidays([nager, null], '2027-06-11', '2027-06-18');
  assert.deepEqual(r.map((x) => x.name), ['Fiesta', 'Regional Day']);
  assert.equal(r[0].regional, false);
  assert.equal(r[0].localName, '', 'no repeat when the local name is the same');
  assert.equal(r[1].regional, true);
  assert.deepEqual(r[1].regions, ['ES-AN', 'ES-MC']);
  assert.equal(r[1].localName, 'Día de la Región');
});

test('full moons land within a few minutes of the published times', () => {
  const near = (iso, list) => list.some((d) => Math.abs(d - new Date(iso)) < 5 * 60e3);
  assert.ok(near('2024-08-19T18:26Z', fullMoons(new Date('2024-08-01Z'), new Date('2024-08-31Z'))));
  assert.ok(near('2025-12-04T23:14Z', fullMoons(new Date('2025-12-01Z'), new Date('2025-12-31Z'))));
  assert.equal(fullMoons(new Date('2027-01-01Z'), new Date('2027-12-31T23:59Z')).length, 12);
});

test('sky events for Nerja: a meteor shower and a full moon, but not the new moon of the eclipse', () => {
  const r = skyEvents({ start: '2027-07-27', end: '2027-08-20', lat: 36.76, tz: 'Europe/Madrid' });
  assert.deepEqual(r.map((e) => [e.name, e.date]), [
    ['Southern Delta Aquariids meteor shower', '2027-07-30'],
    ['Perseids meteor shower', '2027-08-12'],
    ['Full moon', '2027-08-17'],
  ]);
  assert.ok(r.every((e) => e.kind === 'sky' && /^\d\d:\d\d$/.test(e.time)));
});

test('showers poorly placed for the hemisphere are left out', () => {
  const south = skyEvents({ start: '2027-08-10', end: '2027-08-14', lat: -33.9, tz: 'Australia/Sydney' });
  assert.ok(!south.some((e) => /Perseids/.test(e.name)));
});

test('geohash matches the reference example', () => {
  assert.equal(geohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
});

test('Ticketmaster search: near the place, a day either side of the trip', () => {
  const u = new URL(ticketmasterUrl({ lat: 48.2082, lon: 16.3738, start: '2027-05-03', end: '2027-05-07', apiKey: 'k' }));
  assert.equal(u.host, 'app.ticketmaster.com');
  assert.equal(u.searchParams.get('apikey'), 'k');
  assert.equal(u.searchParams.get('geoPoint').length, 7);
  assert.equal(u.searchParams.get('unit'), 'km');
  assert.equal(u.searchParams.get('startDateTime'), '2027-05-02T00:00:00Z');
  assert.equal(u.searchParams.get('endDateTime'), '2027-05-08T23:59:59Z');
});

test('Ticketmaster results become events, trip days only, without repeats', () => {
  const ev = (id, name, localDate, extra = {}, segment = 'Music') => ({
    id, name, url: `https://www.ticketmaster.at/event/${id}`,
    dates: { start: { localDate, localTime: '19:30:00', ...extra } },
    classifications: [{ primary: true, segment: { name: segment } }],
    _embedded: { venues: [{ name: 'Wiener Stadthalle' }] },
  });
  const json = { _embedded: { events: [
    ev('1', 'Band A', '2027-05-04'),
    ev('2', 'Band A', '2027-05-04'),
    ev('3', 'Rapid v Austria', '2027-05-05', {}, 'Sports'),
    ev('4', 'Opera night', '2027-05-06', { timeTBA: true }, 'Arts & Theatre'),
    ev('5', 'Donauinselfest festival', '2027-05-07'),
    ev('6', 'Too early', '2027-05-02'),
    ev('7', 'Date to come', '2027-05-05', { dateTBA: true }),
  ] } };
  const r = parseTicketmaster(json, '2027-05-03', '2027-05-07');
  assert.deepEqual(r.map((e) => [e.name, e.kind, e.time]), [
    ['Band A', 'concert', '19:30'],
    ['Rapid v Austria', 'sport', '19:30'],
    ['Opera night', 'theatre', ''],
    ['Donauinselfest festival', 'festival', '19:30'],
  ]);
  assert.equal(r[0].venue, 'Wiener Stadthalle');
  assert.equal(r[0].source, 'ticketmaster');
  assert.equal(r[0].ref, '1');
  assert.deepEqual(parseTicketmaster({}, '2027-05-03', '2027-05-07'), []);
});

test('the search link names the place and dates', () => {
  const u = new URL(searchLink('Vienna', '2027-05-03', '2027-05-07', () => '3–7 May 2027'));
  assert.equal(u.searchParams.get('q'), 'what’s on in Vienna 3–7 May 2027'.replace('’', "'"));
});
