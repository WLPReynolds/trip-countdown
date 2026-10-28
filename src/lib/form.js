// Trip form date defaults, kept pure so they can be tested.
// The flight and event dates follow the trip's dates until someone picks a
// date of their own, so the date pickers open in the right month and year.
import { addDays } from './time.js';

export const DEFAULT_TRIP_DAYS = 7;

/** Which trip date each dependent field follows. */
export const FOLLOWS = { outboundDate: 'start', returnDate: 'end', eventDate: 'start' };

/**
 * Work out new values after the trip dates change.
 *   values:  { startDate, endDate, outboundDate, returnDate, eventDate }
 *   prev:    the start and end dates before this change: { start, end }
 * A dependent field is updated when it's empty or still matches what it
 * followed, so a date someone chose stays put.
 * Returns only the fields that should change, plus the min/max limits.
 */
export function followTripDates(values, prev = {}) {
  const out = {};
  const start = values.startDate;
  let end = values.endDate;
  if (start && (!end || end < start)) { end = addDays(start, DEFAULT_TRIP_DAYS); out.endDate = end; }
  const now = { start, end };
  for (const [field, follows] of Object.entries(FOLLOWS)) {
    const v = values[field];
    const target = now[follows];
    if (!target) continue;
    if (!v || v === prev[follows] || v === prev.start || v === prev.end) {
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
