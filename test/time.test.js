import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtc, todayIn, tzOffsetMinutes, addDays, daysBetween, eachDay, shiftYears,
  isValidDate, isValidTime, isValidTimeZone, formatRange, formatDate,
} from '../src/lib/time.js';

test('local flight times convert to the right UTC instant', () => {
  assert.equal(zonedToUtc('2027-07-27', '06:10', 'Europe/London').toISOString(), '2027-07-27T05:10:00.000Z'); // BST
  assert.equal(zonedToUtc('2026-12-01', '06:10', 'Europe/London').toISOString(), '2026-12-01T06:10:00.000Z'); // GMT
  assert.equal(zonedToUtc('2027-08-06', '19:45', 'Europe/Madrid').toISOString(), '2027-08-06T17:45:00.000Z'); // CEST
  assert.equal(zonedToUtc('2027-01-10', '09:00', 'Australia/Sydney').toISOString(), '2027-01-09T22:00:00.000Z'); // AEDT, previous UTC day
  assert.equal(zonedToUtc('2027-07-04', '20:30', 'America/New_York').toISOString(), '2027-07-05T00:30:00.000Z');
});

test('times either side of a clock change are handled', () => {
  // UK clocks go forward at 01:00 on 28 March 2027.
  assert.equal(zonedToUtc('2027-03-28', '00:30', 'Europe/London').toISOString(), '2027-03-28T00:30:00.000Z');
  assert.equal(zonedToUtc('2027-03-28', '03:00', 'Europe/London').toISOString(), '2027-03-28T02:00:00.000Z');
  // A time that doesn't exist still produces a real instant, not NaN.
  assert.ok(!Number.isNaN(zonedToUtc('2027-03-28', '01:30', 'Europe/London').getTime()));
});

test('time-zone offsets', () => {
  assert.equal(tzOffsetMinutes(new Date('2027-07-01T12:00:00Z'), 'Europe/London'), 60);
  assert.equal(tzOffsetMinutes(new Date('2027-01-01T12:00:00Z'), 'Europe/London'), 0);
  assert.equal(tzOffsetMinutes(new Date('2027-01-01T12:00:00Z'), 'Asia/Kolkata'), 330);
});

test('today depends on the time zone', () => {
  const lateEvening = new Date('2026-10-27T23:30:00Z');
  assert.equal(todayIn('Europe/London', lateEvening), '2026-10-27');
  assert.equal(todayIn('Europe/Madrid', lateEvening), '2026-10-28');
  assert.equal(todayIn('America/Los_Angeles', lateEvening), '2026-10-27');
});

test('date arithmetic', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-03-01', -1), '2027-02-28');
  assert.equal(daysBetween('2026-10-27', '2027-07-27'), 273);
  assert.equal(daysBetween('2027-07-27', '2026-10-27'), -273);
  assert.deepEqual(eachDay('2027-06-11', '2027-06-14'), ['2027-06-11', '2027-06-12', '2027-06-13', '2027-06-14']);
  assert.deepEqual(eachDay('2027-06-11', '2027-06-11'), ['2027-06-11']);
});

test('shifting by years keeps the calendar date, mapping 29 Feb to 28 Feb', () => {
  assert.equal(shiftYears('2027-08-02', -3), '2024-08-02');
  assert.equal(shiftYears('2028-02-29', -1), '2027-02-28');
  assert.equal(shiftYears('2028-02-29', -4), '2024-02-29');
});

test('validators', () => {
  assert.ok(isValidDate('2027-07-27'));
  assert.ok(!isValidDate('2027-02-29'));
  assert.ok(!isValidDate('27/07/2027'));
  assert.ok(!isValidDate(undefined));
  assert.ok(isValidTime('00:00') && isValidTime('23:59'));
  assert.ok(!isValidTime('24:00') && !isValidTime('6:10'));
  assert.ok(isValidTimeZone('Europe/Madrid'));
  assert.ok(!isValidTimeZone('Mars/Olympus') && !isValidTimeZone(''));
});

test('date ranges read naturally', () => {
  assert.equal(formatRange('2027-06-11', '2027-06-18'), '11–18 Jun 2027');
  assert.equal(formatRange('2027-07-27', '2027-08-06'), '27 Jul – 6 Aug 2027');
  assert.equal(formatRange('2026-12-28', '2027-01-04'), '28 Dec 2026 – 4 Jan 2027');
  assert.equal(formatRange('2027-05-01', '2027-05-01'), '1 May 2027');
  assert.equal(formatDate('2027-08-02', { withWeekday: true, withYear: true }), 'Mon 2 Aug 2027');
});
