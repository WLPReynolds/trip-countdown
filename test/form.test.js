import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followTripDates, flightFromForm, flightDateOnTap } from '../src/lib/form.js';

const blank = { startDate: '', endDate: '', outboundDate: '', returnDate: '' };

test('choosing the first day fills in the last day, but leaves flights empty', () => {
  const r = followTripDates({ ...blank, startDate: '2027-07-27' }, {});
  assert.deepEqual(r.values, { endDate: '2027-08-03' });
  assert.deepEqual(r.limits, { endDate: { min: '2027-07-27' } });
});

test('changing the last day moves the flight home with it', () => {
  const values = { startDate: '2027-07-27', endDate: '2027-08-06', outboundDate: '2027-07-27', returnDate: '2027-08-03' };
  const r = followTripDates(values, { start: '2027-07-27', end: '2027-08-03' });
  assert.deepEqual(r.values, { returnDate: '2027-08-06' });
});

test('changing the first day moves the dates that were following it', () => {
  const values = { startDate: '2027-07-28', endDate: '2027-08-06', outboundDate: '2027-07-27', returnDate: '2027-08-06' };
  const r = followTripDates(values, { start: '2027-07-27', end: '2027-08-06' });
  assert.deepEqual(r.values, { outboundDate: '2027-07-28' });
});

test('dates someone chose themselves stay put', () => {
  // An overnight flight the day before.
  const values = { startDate: '2027-07-28', endDate: '2027-08-06', outboundDate: '2027-07-26', returnDate: '2027-08-06' };
  const r = followTripDates(values, { start: '2027-07-27', end: '2027-08-06' });
  assert.deepEqual(r.values, {});
});

test('a last day before the first day is reset to a week later', () => {
  const r = followTripDates({ ...blank, startDate: '2027-06-11', endDate: '2027-06-01' }, {});
  assert.equal(r.values.endDate, '2027-06-18');
});

test('nothing happens until there is a first day', () => {
  assert.deepEqual(followTripDates(blank, {}), { values: {}, limits: {} });
});

test('a flight needs a time; a date on its own is just the default', () => {
  assert.equal(flightFromForm('2027-07-27', '', 'Europe/London'), null);
  assert.deepEqual(flightFromForm('2027-07-27', '06:10', ' Europe/London '), { date: '2027-07-27', time: '06:10', tz: 'Europe/London' });
});

test('flight dates stay empty when the trip dates change', () => {
  const values = { startDate: '2027-07-28', endDate: '2027-08-06', outboundDate: '', returnDate: '' };
  assert.deepEqual(followTripDates(values, { start: '2027-07-27', end: '2027-08-06' }).values, {});
});

test('tapping a flight starts it from the first or last day of the trip', () => {
  const trip = { startDate: '2027-07-27', endDate: '2027-08-06' };
  assert.equal(flightDateOnTap('outboundDate', { ...trip, outboundDate: '' }), '2027-07-27');
  assert.equal(flightDateOnTap('returnDate', { ...trip, returnDate: '' }), '2027-08-06');
  assert.equal(flightDateOnTap('outboundDate', { ...trip, outboundDate: '2027-07-26' }), '', 'an existing date is kept');
  assert.equal(flightDateOnTap('outboundDate', { startDate: '', endDate: '' }), '', 'nothing to start from yet');
  assert.equal(flightDateOnTap('returnDate', { startDate: '2027-07-27', endDate: '' }), '2027-07-27');
});
