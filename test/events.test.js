import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessKind, cleanEvent, cleanEvents, tripEvents, sortEvents, nextEvent, eventOver, MAX_EVENTS, KINDS } from '../src/lib/events.js';

const TZ = 'Europe/Madrid';
const ev = (name, date, time = '', extra = {}) => ({ id: name.replace(/\W/g, ''), name, date, time, ...extra });

test('the kind is guessed from the name', () => {
  assert.equal(guessKind('Total solar eclipse'), 'eclipse');
  assert.equal(guessKind('Perseids meteor shower'), 'sky');
  assert.equal(guessKind('Full moon'), 'sky');
  assert.equal(guessKind('Take That concert'), 'concert');
  assert.equal(guessKind('Feria de Fuengirola'), 'festival');
  assert.equal(guessKind('Noche de San Juan'), 'festival');
  assert.equal(guessKind('Málaga v Sevilla match'), 'sport');
  assert.equal(guessKind('Flamenco night'), 'theatre');
  assert.equal(guessKind('Wine tasting'), 'food');
  assert.equal(guessKind('Bank holiday'), 'holiday');
  assert.equal(guessKind('Boat trip'), 'other');
});

test('an event with no time lasts all day and has no cloud odds', () => {
  const { event, errors } = cleanEvent({ name: 'Feria', date: '2027-06-12', cloud: true });
  assert.deepEqual(errors, []);
  assert.equal(event.time, '');
  assert.equal(event.cloud, false);
  assert.equal(event.kind, 'festival');
});

test('cloud odds default on for sky events only, and the choice is kept', () => {
  assert.equal(cleanEvent({ name: 'Eclipse', date: '2027-08-02', time: '10:48' }).event.cloud, true);
  assert.equal(cleanEvent({ name: 'Concert', date: '2027-08-02', time: '21:00' }).event.cloud, false);
  assert.equal(cleanEvent({ name: 'Concert', date: '2027-08-02', time: '21:00', cloud: true }).event.cloud, true);
  assert.equal(cleanEvent({ name: 'Eclipse', date: '2027-08-02', time: '10:48', cloud: false }).event.cloud, false);
});

test('a chosen kind wins over the guess; unknown kinds fall back to the guess', () => {
  assert.equal(cleanEvent({ name: 'Eclipse party', date: '2027-08-02', kind: 'food' }).event.kind, 'food');
  assert.equal(cleanEvent({ name: 'Eclipse party', date: '2027-08-02', kind: 'nonsense' }).event.kind, 'eclipse');
  assert.ok(KINDS.includes('other'));
});

test('links must be https; extra details are trimmed and kept', () => {
  const ok = cleanEvent({ name: 'Gig', date: '2027-06-12', url: 'https://example.com/t', venue: ' Castle ', source: 'ticketmaster', ref: 'G5v' }).event;
  assert.equal(ok.url, 'https://example.com/t');
  assert.equal(ok.venue, 'Castle');
  assert.equal(ok.source, 'ticketmaster');
  assert.equal(ok.ref, 'G5v');
  const bad = cleanEvent({ name: 'Gig', date: '2027-06-12', url: 'javascript:alert(1)', source: 'who' }).event;
  assert.equal(bad.url, undefined);
  assert.equal(bad.source, 'manual');
});

test('the older single event becomes a list, with cloud odds as before', () => {
  const { events } = cleanEvents({ event: { name: 'Picnic', date: '2027-08-02', time: '12:00' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].cloud, true);
  assert.deepEqual(cleanEvents({ event: null }).events, []);
  assert.deepEqual(cleanEvents({}).events, []);
  // A list wins over the old field.
  assert.equal(cleanEvents({ event: { name: 'Old', date: '2027-08-02' }, events: [] }).events.length, 0);
});

test('ids are kept, and duplicates or bad ones replaced', () => {
  const { events } = cleanEvents({ events: [ev('A', '2027-06-12'), { ...ev('B', '2027-06-13'), id: 'A' }, { ...ev('C', '2027-06-14'), id: '<x>' }] });
  assert.equal(events[0].id, 'A');
  assert.equal(new Set(events.map((e) => e.id)).size, 3);
  assert.match(events[2].id, /^[\w-]+$/);
});

test('there is a limit on events per trip', () => {
  const many = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ev(`E${i}`, '2027-06-12'));
  const r = cleanEvents({ events: many });
  assert.ok(r.errors.some((e) => /at most/.test(e)));
  assert.equal(r.events.length, MAX_EVENTS);
});

test('trips stored the old way still show their event', () => {
  const list = tripEvents({ event: { name: 'Total solar eclipse', date: '2027-08-02', time: '10:48' } });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'e0');
  assert.equal(list[0].kind, 'eclipse');
  assert.deepEqual(tripEvents({ events: [] }), []);
  assert.deepEqual(tripEvents({}), []);
});

test('all-day events last until midnight; timed ones are over once they start', () => {
  const allDay = ev('Feria', '2027-06-12');
  assert.ok(!eventOver(allDay, TZ, new Date('2027-06-12T20:00:00Z')));
  assert.ok(eventOver(allDay, TZ, new Date('2027-06-12T22:30:00Z'))); // after midnight in Madrid
  const timed = ev('Eclipse', '2027-08-02', '10:48');
  assert.ok(!eventOver(timed, TZ, new Date('2027-08-02T08:47:00Z')));
  assert.ok(eventOver(timed, TZ, new Date('2027-08-02T08:48:00Z')));
});

test('upcoming events come first, soonest first; past ones go to the end', () => {
  const now = new Date('2027-08-01T12:00:00Z');
  const list = [ev('Late', '2027-08-05', '21:00'), ev('Past', '2027-07-28'), ev('Eclipse', '2027-08-02', '10:48'), ev('Older', '2027-07-27')];
  assert.deepEqual(sortEvents(list, TZ, now).map((e) => e.name), ['Eclipse', 'Late', 'Past', 'Older']);
  assert.deepEqual(nextEvent(list, TZ, now), { next: list[2], more: 1 });
  assert.deepEqual(nextEvent([], TZ, now), { next: null, more: 0 });
});
