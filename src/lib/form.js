// Trip form date defaults, kept pure so they can be tested.
// The event date fills itself in from the first day. Flight dates stay empty
// until someone taps into the flight, then start from the trip's first or
// last day, so the picker opens in the right month and year. Once filled,
// both follow the trip dates until someone picks a date of their own.
import { addDays } from './time.js';

export const DEFAULT_TRIP_DAYS = 7;

/** Which trip date each dependent field follows, and whether it fills itself in while empty. */
export const FOLLOWS = {
  outboundDate: { follows: 'start', fillEmpty: false },
  returnDate: { follows: 'end', fillEmpty: false },
  eventDate: { follows: 'start', fillEmpty: true },
};

/**
 * Work out new values after the trip dates change.
 *   values:  { startDate, endDate, outboundDate, returnDate, eventDate }
 *   prev:    the start and end dates before this change: { start, end }
 * A filled-in dependent field is updated while it still matches a previous
 * trip date, so a date someone chose stays put. Empty flight dates stay empty.
 * Returns only the fields that should change, plus the min/max limits.
 */
export function followTripDates(values, prev = {}) {
  const out = {};
  const start = values.startDate;
  let end = values.endDate;
  if (start && (!end || end < start)) { end = addDays(start, DEFAULT_TRIP_DAYS); out.endDate = end; }
  const now = { start, end };
  for (const [field, { follows, fillEmpty }] of Object.entries(FOLLOWS)) {
    const v = values[field];
    const target = now[follows];
    if (!target) continue;
    if (!v ? fillEmpty : v === prev.start || v === prev.end) {
      if (v !== target) out[field] = target;
    }
  }
  return {
    values: out,
    limits: start ? { endDate: { min: start }, eventDate: { min: start, max: end || '' } } : {},
  };
}

/**
 * A flight from the form, or null. A date on its own doesn't count, because
 * the date fills itself in from the trip; it's the time that says there's a flight.
 */
export function flightFromForm(date, time, tz) {
  if (!time) return null;
  return { date, time, tz: (tz || '').trim() };
}

/** The date a flight field starts from when someone taps into it: '' if it already has one. */
export function flightDateOnTap(field, values) {
  if (values[field]) return '';
  const end = values.endDate && values.endDate >= values.startDate ? values.endDate : '';
  return (FOLLOWS[field]?.follows === 'end' ? end || values.startDate : values.startDate) || '';
}
