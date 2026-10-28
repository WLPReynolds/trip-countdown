// Trip model: validation, sorting and per-trip theming.
// Shared by the app and the Worker, so it must stay dependency-free.
import { isValidDate, isValidTime, isValidTimeZone, daysBetween } from './time.js';
import { tripStatus } from './countdown.js';

export const LIMITS = { name: 80, place: 120, maxTripDays: 366 };

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanFlight(f, label, errors) {
  if (f == null || f === '') return null;
  if (typeof f !== 'object') { errors.push(`${label} must be an object`); return null; }
  const date = str(f.date, 10), time = str(f.time, 5), tz = str(f.tz, 64);
  if (!date && !time) return null;
  if (!isValidDate(date)) errors.push(`${label} date is not a valid date`);
  if (!isValidTime(time)) errors.push(`${label} time must be HH:MM`);
  if (!isValidTimeZone(tz)) errors.push(`${label} time zone is not recognised`);
  return { date, time, tz };
}

/**
 * Validate and normalise a trip. Returns { ok, errors, trip }.
 * The id and updatedAt fields are left to the caller (the Worker owns them).
 */
export function validateTrip(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['Trip must be an object'], trip: null };

  const d = input.destination || {};
  const destination = {
    name: str(d.name, LIMITS.place),
    admin1: str(d.admin1, LIMITS.place),
    country: str(d.country, LIMITS.place),
    countryCode: str(d.countryCode, 2).toUpperCase(),
    lat: Number(d.lat),
    lon: Number(d.lon),
    timezone: str(d.timezone, 64),
  };
  if (!destination.name) errors.push('Destination needs a name');
  if (!Number.isFinite(destination.lat) || Math.abs(destination.lat) > 90) errors.push('Destination latitude is out of range');
  if (!Number.isFinite(destination.lon) || Math.abs(destination.lon) > 180) errors.push('Destination longitude is out of range');
  if (!isValidTimeZone(destination.timezone)) errors.push('Destination time zone is not recognised');
  if (destination.countryCode && !/^[A-Z]{2}$/.test(destination.countryCode)) errors.push('Country code must be two letters');

  const startDate = str(input.startDate, 10);
  const endDate = str(input.endDate, 10);
  if (!isValidDate(startDate)) errors.push('Start date is not a valid date');
  if (!isValidDate(endDate)) errors.push('End date is not a valid date');
  if (isValidDate(startDate) && isValidDate(endDate)) {
    const len = daysBetween(startDate, endDate);
    if (len < 0) errors.push('End date is before the start date');
    else if (len >= LIMITS.maxTripDays) errors.push('Trips can be at most a year long');
  }

  const outbound = cleanFlight(input.outbound, 'Outbound flight', errors);
  const ret = cleanFlight(input.return, 'Return flight', errors);

  let event = null;
  const e = input.event;
  if (e && typeof e === 'object' && (e.name || e.date || e.time)) {
    event = { name: str(e.name, LIMITS.name), date: str(e.date, 10), time: str(e.time, 5) };
    if (!event.name) errors.push('Special event needs a name');
    if (!isValidDate(event.date)) errors.push('Special event date is not a valid date');
    if (!isValidTime(event.time)) errors.push('Special event time must be HH:MM');
  }

  const trip = { name: str(input.name, LIMITS.name), destination, startDate, endDate, outbound, return: ret, event };
  return { ok: errors.length === 0, errors, trip };
}

/** Away trips first, then upcoming soonest first, then finished trips most recent first. */
export function sortTrips(trips, now = new Date(), homeTz = 'Europe/London') {
  const rank = { away: 0, upcoming: 1, done: 2 };
  return trips
    .map((t) => ({ t, s: tripStatus(t, now, homeTz) }))
    .sort((a, b) => {
      if (rank[a.s.status] !== rank[b.s.status]) return rank[a.s.status] - rank[b.s.status];
      const diff = a.s.departure - b.s.departure;
      return a.s.status === 'done' ? -diff : diff;
    })
    .map(({ t }) => t);
}

/** Season at the destination for the middle of the trip. Southern hemisphere is flipped; tropics get their own. */
export function seasonFor(lat, date) {
  if (Math.abs(lat) < 23.5) return 'tropical';
  const m = +date.slice(5, 7);
  const north = m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
  if (lat >= 0) return north;
  return { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' }[north];
}

export function midDate(start, end) {
  const a = Date.parse(start + 'T00:00:00Z'), b = Date.parse(end + 'T00:00:00Z');
  return new Date(a + Math.floor((b - a) / 86400000 / 2) * 86400000).toISOString().slice(0, 10);
}

export function themeFor(trip) {
  return seasonFor(trip.destination.lat, midDate(trip.startDate, trip.endDate));
}

/** Flag emoji from an ISO 3166 alpha-2 code ('ES' → 🇪🇸). */
export function flagEmoji(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...code.toUpperCase().split('').map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

/** Short title for a trip: the nickname if given, else the place name. */
export function tripTitle(trip) {
  return trip.name || trip.destination.name;
}
