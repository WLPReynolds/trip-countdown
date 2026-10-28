import { test } from 'node:test';
import assert from 'node:assert/strict';
import { departureInstant, returnInstant, countdownTo, describeCountdown, tripStatus, tickInterval } from '../src/lib/countdown.js';
import { nerja, fuengirola } from './helpers/fixtures.js';

const at = (iso) => new Date(iso);

test('counts down to the outbound flight when there is one', () => {
  assert.equal(departureInstant(nerja(), 'Europe/London').toISOString(), '2027-07-27T05:10:00.000Z');
  assert.equal(returnInstant(nerja(), 'Europe/London').toISOString(), '2027-08-06T17:45:00.000Z');
});

test('without flights, counts to midnight at home on the first day and ends after the last day', () => {
  assert.equal(departureInstant(fuengirola(), 'Europe/London').toISOString(), '2027-06-10T23:00:00.000Z');
  assert.equal(returnInstant(fuengirola(), 'Europe/London').toISOString(), '2027-06-18T22:00:00.000Z'); // midnight Madrid after 18 Jun
});

test('days while far off, then hours and minutes, then seconds', () => {
  const target = at('2027-07-27T05:10:00Z');
  assert.equal(countdownTo(target, at('2026-10-27T17:00:00Z')).phase, 'days');
  assert.equal(countdownTo(target, at('2026-10-27T17:00:00Z')).days, 272);
  assert.equal(countdownTo(target, at('2027-07-25T05:10:00Z')).phase, 'days');       // exactly 48 h
  assert.equal(countdownTo(target, at('2027-07-25T05:10:01Z')).phase, 'hours');      // just under 48 h
  assert.equal(countdownTo(target, at('2027-07-27T04:10:00Z')).phase, 'hours');      // exactly 1 h
  assert.equal(countdownTo(target, at('2027-07-27T04:10:01Z')).phase, 'seconds');
  assert.equal(countdownTo(target, at('2027-07-27T05:10:00Z')).phase, 'now');
  assert.equal(countdownTo(target, at('2027-07-28T00:00:00Z')).phase, 'now');
});

test('countdown wording', () => {
  const t = at('2027-07-27T05:10:00Z');
  assert.deepEqual(describeCountdown(countdownTo(t, at('2027-07-20T02:10:00Z'))), { big: '7', unit: 'days', small: 'and 3 hours' });
  assert.deepEqual(describeCountdown(countdownTo(t, at('2027-07-26T05:10:00Z'))).big, '24:00');
  assert.equal(describeCountdown(countdownTo(t, at('2027-07-25T05:30:00Z'))).big, '47:40');
  assert.deepEqual(describeCountdown(countdownTo(t, at('2027-07-27T04:55:30Z'))), { big: '14:30', unit: 'minutes', small: '' });
  assert.equal(describeCountdown(countdownTo(t, at('2027-07-24T05:10:00Z'))).small, '');
  assert.equal(describeCountdown(countdownTo(t, at('2027-07-24T04:10:00Z'))).small, 'and 1 hour');
  assert.equal(describeCountdown({ phase: 'days', days: 1, hours: 0 }).unit, 'day');
});

test('trip status moves from upcoming to away to done', () => {
  const trip = nerja();
  assert.equal(tripStatus(trip, at('2026-10-27T17:00:00Z')).status, 'upcoming');
  const away = tripStatus(trip, at('2027-08-02T09:00:00Z'));
  assert.equal(away.status, 'away');
  assert.equal(away.dayOfTrip, 7);
  assert.equal(away.totalDays, 11);
  assert.equal(tripStatus(trip, at('2027-07-27T06:00:00Z')).dayOfTrip, 1);
  assert.equal(tripStatus(trip, at('2027-08-06T18:00:00Z')).status, 'done');
});

test('refresh every second only when it matters', () => {
  assert.equal(tickInterval({ phase: 'days' }), 60000);
  assert.equal(tickInterval({ phase: 'hours' }), 1000);
  assert.equal(tickInterval({ phase: 'seconds' }), 1000);
});
