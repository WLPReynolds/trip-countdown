import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTrip, sortTrips, seasonFor, themeFor, flagEmoji, tripTitle, midDate } from '../src/lib/trip.js';
import { nerja, fuengirola } from './helpers/fixtures.js';

test('a complete trip is valid and comes back normalised', () => {
  const input = nerja();
  input.destination.countryCode = 'es';
  input.destination.name = '  Nerja  ';
  input.somethingElse = 'dropped';
  const { ok, errors, trip } = validateTrip(input);
  assert.deepEqual(errors, []);
  assert.ok(ok);
  assert.equal(trip.destination.name, 'Nerja');
  assert.equal(trip.destination.countryCode, 'ES');
  assert.equal(trip.somethingElse, undefined);
  // The fixture uses the older single-event shape; it comes back as a list.
  assert.equal(trip.event, undefined);
  assert.equal(trip.events.length, 1);
  const [ev] = trip.events;
  assert.deepEqual({ ...ev, id: undefined }, { id: undefined, name: 'Total solar eclipse', date: '2027-08-02', time: '10:48', kind: 'eclipse', cloud: true, source: 'manual' });
  assert.match(ev.id, /^[\w-]+$/);
});

test('flights and events are optional', () => {
  const { ok, trip } = validateTrip(fuengirola());
  assert.ok(ok);
  assert.equal(trip.outbound, null);
  assert.equal(trip.return, null);
  assert.deepEqual(trip.events, []);
  // An empty flight object from the form counts as no flight.
  assert.equal(validateTrip({ ...fuengirola(), outbound: { date: '', time: '', tz: 'Europe/London' } }).trip.outbound, null);
});

test('bad input is rejected with readable reasons', () => {
  const t = nerja();
  t.endDate = '2027-07-20';
  t.destination.lat = 95;
  t.destination.timezone = 'Nowhere/Land';
  t.outbound = { date: '2027-07-27', time: '6am', tz: 'Europe/London' };
  t.event = undefined;
  t.events = [{ name: '', date: '2027-08-02', time: '10:48' }, { name: 'Gig', date: 'soon', time: '9pm' }];
  const { ok, errors } = validateTrip(t);
  assert.ok(!ok);
  assert.ok(errors.includes('End date is before the start date'));
  assert.ok(errors.includes('Destination latitude is out of range'));
  assert.ok(errors.includes('Destination time zone is not recognised'));
  assert.ok(errors.includes('Outbound flight time must be HH:MM'));
  assert.ok(errors.includes('Event 1 needs a name'));
  assert.ok(errors.includes('Gig: the date is not a valid date'));
  assert.ok(errors.includes('Gig: the time must be HH:MM'));
  assert.ok(!validateTrip(null).ok);
  assert.ok(!validateTrip({ ...fuengirola(), startDate: '2027-01-01', endDate: '2028-06-01' }).ok);
});

test('trips are ordered: away first, then soonest, then finished', () => {
  const now = new Date('2027-07-30T12:00:00Z');
  const done = { ...fuengirola(), id: 'done' };
  const away = { ...nerja(), id: 'away' };
  const later = { ...fuengirola(), id: 'later', startDate: '2027-12-20', endDate: '2027-12-27' };
  const soon = { ...fuengirola(), id: 'soon', startDate: '2027-09-01', endDate: '2027-09-05' };
  assert.deepEqual(sortTrips([later, done, soon, away], now).map((t) => t.id), ['away', 'soon', 'later', 'done']);
});

test('season follows the destination hemisphere', () => {
  assert.equal(seasonFor(36.7, '2027-08-01'), 'summer');
  assert.equal(seasonFor(36.7, '2027-01-15'), 'winter');
  assert.equal(seasonFor(36.7, '2027-04-15'), 'spring');
  assert.equal(seasonFor(36.7, '2027-10-15'), 'autumn');
  assert.equal(seasonFor(-33.9, '2027-07-15'), 'winter');   // Sydney in July
  assert.equal(seasonFor(-33.9, '2027-01-15'), 'summer');
  assert.equal(seasonFor(-8.6, '2027-07-15'), 'tropical');  // Bali
  assert.equal(themeFor(nerja()), 'summer');
  assert.equal(midDate('2027-07-27', '2027-08-06'), '2027-08-01');
});

test('flags and titles', () => {
  assert.equal(flagEmoji('ES'), '🇪🇸');
  assert.equal(flagEmoji('gb'), '🇬🇧');
  assert.equal(flagEmoji(''), '');
  assert.equal(tripTitle(nerja()), 'Nerja');
  assert.equal(tripTitle({ ...nerja(), name: 'Eclipse trip' }), 'Eclipse trip');
});
