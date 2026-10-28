// Countdown logic: which moment a trip counts down to, and how to show it.
import { zonedToUtc, addDays, daysBetween, todayIn } from './time.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** Thresholds: days until 48 hours out, then hours/minutes, then seconds in the final hour. */
export const HOURS_FROM_MS = 48 * HOUR;
export const SECONDS_FROM_MS = HOUR;

/**
 * The instant the trip starts. The outbound flight time if there is one,
 * otherwise midnight at the start of the start date in the home time zone.
 */
export function departureInstant(trip, homeTz) {
  const f = trip.outbound;
  if (f && f.date && f.time && f.tz) return zonedToUtc(f.date, f.time, f.tz);
  return zonedToUtc(trip.startDate, '00:00', homeTz);
}

/** The instant the trip ends: the return flight, or the end of the end date. */
export function returnInstant(trip, homeTz) {
  const f = trip.return;
  if (f && f.date && f.time && f.tz) return zonedToUtc(f.date, f.time, f.tz);
  const tz = trip.destination?.timezone || homeTz;
  return zonedToUtc(addDays(trip.endDate, 1), '00:00', tz);
}

/** Split a positive millisecond span into whole units. */
export function splitDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

/**
 * Countdown to a target instant.
 * phase: 'days' | 'hours' | 'seconds' | 'now'
 */
export function countdownTo(target, now = new Date()) {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return { phase: 'now', ms: 0, ...splitDuration(0) };
  const phase = ms >= HOURS_FROM_MS ? 'days' : ms >= SECONDS_FROM_MS ? 'hours' : 'seconds';
  return { phase, ms, ...splitDuration(ms) };
}

/**
 * Overall trip state.
 * status: 'upcoming' (with countdown) | 'away' (dayOfTrip/totalDays) | 'done'
 */
export function tripStatus(trip, now = new Date(), homeTz = 'Europe/London') {
  const dep = departureInstant(trip, homeTz);
  const ret = returnInstant(trip, homeTz);
  const totalDays = daysBetween(trip.startDate, trip.endDate) + 1;
  if (now < dep) return { status: 'upcoming', departure: dep, returns: ret, totalDays, countdown: countdownTo(dep, now) };
  if (now < ret) {
    const today = todayIn(trip.destination?.timezone || homeTz, now);
    const day = Math.min(totalDays, Math.max(1, daysBetween(trip.startDate, today) + 1));
    return { status: 'away', departure: dep, returns: ret, totalDays, dayOfTrip: day, countdown: countdownTo(ret, now) };
  }
  return { status: 'done', departure: dep, returns: ret, totalDays };
}

const pad = (n) => String(n).padStart(2, '0');

/** Display pieces for a countdown: a big figure, a unit and a smaller line. */
export function describeCountdown(c) {
  switch (c.phase) {
    case 'days': {
      const big = String(c.days);
      const unit = c.days === 1 ? 'day' : 'days';
      const small = c.hours === 0 ? '' : `and ${c.hours} ${c.hours === 1 ? 'hour' : 'hours'}`;
      return { big, unit, small };
    }
    case 'hours': {
      const h = c.days * 24 + c.hours;
      return { big: `${h}:${pad(c.minutes)}`, unit: 'hours', small: `${c.seconds}s` };
    }
    case 'seconds':
      return { big: `${c.minutes}:${pad(c.seconds)}`, unit: 'minutes', small: '' };
    default:
      return { big: '0', unit: 'now', small: '' };
  }
}

/** How often the display needs refreshing for this countdown, in ms. */
export function tickInterval(c) {
  if (!c || c.phase === 'now') return 60000;
  return c.phase === 'days' ? 60000 : 1000;
}

export { DAY };
