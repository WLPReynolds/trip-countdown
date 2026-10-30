// Events during a trip: the model, the kinds (each has its own artwork) and ordering.
// Shared by the app and the Worker, so it must stay dependency-free.
import { isValidDate, isValidTime, zonedToUtc } from './time.js';

export const MAX_EVENTS = 30;
export const NAME_MAX = 80;

/** Kinds of event, in the order the picker shows them. */
export const KINDS = ['eclipse', 'sky', 'concert', 'festival', 'sport', 'theatre', 'food', 'holiday', 'other'];
export const KIND_LABELS = {
  eclipse: 'Eclipse', sky: 'Night sky', concert: 'Music', festival: 'Festival', sport: 'Sport',
  theatre: 'Show', food: 'Food & drink', holiday: 'Holiday', other: 'Other',
};

// Sky events default to showing the cloud odds; the rest don't.
export const CLOUD_BY_DEFAULT = new Set(['eclipse', 'sky']);

export const SOURCES = ['manual', 'holiday', 'sky', 'ticketmaster'];

const GUESSES = [
  ['eclipse', /eclipse/i],
  ['sky', /meteor|moon|aurora|comet|planet|star ?gaz|night sky|perseid|geminid|leonid|lyrid|orionid|quadrantid|aquariid/i],
  ['concert', /concert|gig|tour|band|orchestra|opera|jazz|music|dj\b|live\b/i],
  ['festival', /festival|fiesta|feria|fair|carnival|parade|firework|fuegos|san juan|verbena|romer[ií]a|procession/i],
  ['sport', /match|game|race|grand prix|\bgp\b|football|f[uú]tbol|tennis|golf|cup|final|marathon|derby|stadium|vs\.?\s|versus/i],
  ['theatre', /theatre|theater|show|musical|ballet|flamenco|comedy|circus|play\b|cinema|film/i],
  ['food', /food|tapas|wine|beer|tasting|restaurant|dinner|lunch|brunch|market|paella|gastro/i],
  ['holiday', /holiday|bank|d[ií]a de|national day|independence/i],
];

/** Best guess at an event's kind from its name. */
export function guessKind(name) {
  const n = String(name || '');
  for (const [kind, re] of GUESSES) if (re.test(n)) return kind;
  return 'other';
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);

/**
 * Validate one event. Time is optional: an event without one lasts all day.
 * Returns { event, errors }.
 */
export function cleanEvent(e, n = 1) {
  const errors = [];
  const label = `Event ${n}`;
  if (!e || typeof e !== 'object') return { event: null, errors: [`${label} must be an object`] };
  const name = str(e.name, NAME_MAX), date = str(e.date, 10), time = str(e.time, 5);
  if (!name) errors.push(`${label} needs a name`);
  if (!isValidDate(date)) errors.push(`${name || label}: the date is not a valid date`);
  if (time && !isValidTime(time)) errors.push(`${name || label}: the time must be HH:MM`);
  const kind = KINDS.includes(e.kind) ? e.kind : guessKind(name);
  const event = {
    id: /^[\w-]{1,40}$/.test(e.id || '') ? e.id : newId(),
    name, date, time, kind,
    // Cloud odds need an hour to look at.
    cloud: time ? (typeof e.cloud === 'boolean' ? e.cloud : CLOUD_BY_DEFAULT.has(kind)) : false,
    source: SOURCES.includes(e.source) ? e.source : 'manual',
  };
  const url = str(e.url, 500);
  if (url && /^https:\/\//.test(url)) event.url = url;
  const venue = str(e.venue, 120);
  if (venue) event.venue = venue;
  const ref = str(e.ref, 80);
  if (ref) event.ref = ref;
  return { event, errors };
}

/**
 * Validate a trip's events. Accepts the list, or the single `event` older versions stored.
 * Returns { events, errors }.
 */
export function cleanEvents(input) {
  let list = input.events;
  if (!Array.isArray(list)) {
    const legacy = input.event;
    // Older versions always showed cloud odds for their one event.
    list = legacy && typeof legacy === 'object' && (legacy.name || legacy.date || legacy.time) ? [{ cloud: true, ...legacy }] : [];
  }
  const errors = [];
  if (list.length > MAX_EVENTS) errors.push(`A trip can have at most ${MAX_EVENTS} events`);
  const events = [];
  const seen = new Set();
  list.slice(0, MAX_EVENTS).forEach((e, i) => {
    const r = cleanEvent(e, i + 1);
    errors.push(...r.errors);
    if (!r.event) return;
    while (seen.has(r.event.id)) r.event.id = newId();
    seen.add(r.event.id);
    events.push(r.event);
  });
  return { events, errors };
}

/** A trip's events, reading the older single-event shape too. */
export function tripEvents(trip) {
  if (Array.isArray(trip?.events)) return trip.events;
  if (!trip?.event) return [];
  return cleanEvents({ event: trip.event }).events.map((e) => ({ ...e, id: 'e0' }));
}

/** When an event starts, as a Date. All-day events start at midnight local time. */
export function eventStart(ev, tz) {
  return zonedToUtc(ev.date, ev.time || '00:00', tz);
}

/** When an event is over: its start for timed events, the end of the day for all-day ones. */
export function eventOver(ev, tz, now = new Date()) {
  if (ev.time) return now >= eventStart(ev, tz);
  return now >= new Date(eventStart(ev, tz).getTime() + 86400000);
}

/** Upcoming events soonest first, then the ones that have happened, most recent first. */
export function sortEvents(events, tz, now = new Date()) {
  return events
    .map((ev) => ({ ev, at: eventStart(ev, tz).getTime(), over: eventOver(ev, tz, now) }))
    .sort((a, b) => (a.over !== b.over ? (a.over ? 1 : -1) : a.over ? b.at - a.at : a.at - b.at))
    .map((x) => x.ev);
}

/** The next event still to come, and how many others are still to come. */
export function nextEvent(events, tz, now = new Date()) {
  const ahead = sortEvents(events, tz, now).filter((ev) => !eventOver(ev, tz, now));
  return { next: ahead[0] || null, more: Math.max(0, ahead.length - 1) };
}
