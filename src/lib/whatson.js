// "What's on" during a trip: public holidays (Nager.Date), sky events worked out
// here, and Ticketmaster listings. Pure functions, shared by the app and the Worker.
import { addDays, eachDay, isValidDate } from './time.js';
import { guessKind } from './events.js';

// ---------------------------------------------------------------- public holidays

export const holidaysUrl = (year, countryCode) => `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;

/** Calendar years a trip touches, so holidays spanning New Year are found. */
export function tripYears(start, end) {
  const a = +start.slice(0, 4), b = +end.slice(0, 4);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/**
 * Holidays inside the trip from Nager.Date responses.
 * Regional ones are marked, with their ISO region codes, since they may not apply at the destination.
 */
export function parseHolidays(lists, start, end) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const hd of list) {
      if (!isValidDate(hd?.date) || hd.date < start || hd.date > end) continue;
      const key = `${hd.date}|${hd.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const regions = Array.isArray(hd.counties) ? hd.counties.filter((c) => typeof c === 'string') : [];
      out.push({
        date: hd.date,
        name: String(hd.name || hd.localName || 'Public holiday'),
        localName: hd.localName && hd.localName !== hd.name ? String(hd.localName) : '',
        regional: hd.global === false || regions.length > 0,
        regions,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- sky events

const RAD = Math.PI / 180;
const sin = (d) => Math.sin(d * RAD), cos = (d) => Math.cos(d * RAD);

/** Julian Ephemeris Day of the full moon after new moon k (Meeus, Astronomical Algorithms ch. 49). */
function fullMoonJde(n) {
  const k = n + 0.5; // whole numbers are new moons, halves are full moons
  const T = k / 1236.85;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T * T - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T * T;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T ** 3;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T ** 3;
  const Om = 124.7746 - 1.56375588 * k + 0.0020672 * T * T;
  jde += -0.40614 * sin(Mp) + 0.17302 * E * sin(M) + 0.01614 * sin(2 * Mp) + 0.01043 * sin(2 * F)
    + 0.00734 * E * sin(Mp - M) - 0.00515 * E * sin(Mp + M) + 0.00209 * E * E * sin(2 * M)
    - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M)
    - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F)
    - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(Om) - 0.00007 * sin(Mp + 2 * M);
  return jde;
}

const jdeToDate = (jde) => new Date((jde - 2440587.5) * 86400000); // ignores ΔT (about a minute)

/** Full moons between two dates (UTC instants). */
export function fullMoons(from, to) {
  const yearFrac = (d) => d.getUTCFullYear() + (d.getUTCMonth() + d.getUTCDate() / 31) / 12;
  let k = Math.floor((yearFrac(from) - 2000) * 12.3685) - 1;
  const out = [];
  for (;;) {
    const at = jdeToDate(fullMoonJde(k));
    if (at > to) break;
    if (at >= from) out.push(at);
    k++;
  }
  return out;
}

/** Annual meteor showers: peak night (month, day), and which hemispheres see them well. */
export const METEOR_SHOWERS = [
  { name: 'Quadrantids', month: 1, day: 3, north: true, south: false },
  { name: 'Lyrids', month: 4, day: 22, north: true, south: true },
  { name: 'Eta Aquariids', month: 5, day: 6, north: true, south: true },
  { name: 'Southern Delta Aquariids', month: 7, day: 30, north: true, south: true },
  { name: 'Perseids', month: 8, day: 12, north: true, south: false },
  { name: 'Orionids', month: 10, day: 21, north: true, south: true },
  { name: 'Leonids', month: 11, day: 17, north: true, south: true },
  { name: 'Geminids', month: 12, day: 14, north: true, south: true },
  { name: 'Ursids', month: 12, day: 22, north: true, south: false },
];

const localDate = (instant, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
const localTime = (instant, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);

/**
 * Sky events during a trip: full moons and meteor shower peaks.
 * Times are suggestions for when to look, local to the destination.
 */
export function skyEvents({ start, end, lat, tz }) {
  const out = [];
  const from = new Date(`${addDays(start, -1)}T00:00:00Z`), to = new Date(`${addDays(end, 1)}T23:59:59Z`);
  for (const at of fullMoons(from, to)) {
    const date = localDate(at, tz);
    if (date < start || date > end) continue;
    out.push({ name: 'Full moon', date, time: '22:00', kind: 'sky', note: `Exactly full at ${localTime(at, tz)} local time` });
  }
  const days = new Set(eachDay(start, end));
  for (const s of METEOR_SHOWERS) {
    if (lat >= 0 ? !s.north : !s.south) continue;
    for (const y of tripYears(start, end)) {
      const date = `${y}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
      if (days.has(date)) out.push({ name: `${s.name} meteor shower`, date, time: '23:30', kind: 'sky', note: 'Peak night, give or take a day. Best after midnight, away from lights' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- Ticketmaster

/** Geohash of a point, which Ticketmaster takes for location searches. */
export function geohash(lat, lon, precision = 7) {
  const chars = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latR = [-90, 90], lonR = [-180, 180], bit = 0, ch = 0, even = true, out = '';
  while (out.length < precision) {
    const r = even ? lonR : latR, v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += chars[ch]; bit = 0; ch = 0; }
  }
  return out;
}

export const TM_RADIUS_KM = 30;

/** Ticketmaster event search near the destination, a day either side of the trip to allow for time zones. */
export function ticketmasterUrl({ lat, lon, start, end, apiKey }) {
  const q = new URLSearchParams({
    apikey: apiKey,
    geoPoint: geohash(lat, lon),
    radius: String(TM_RADIUS_KM), unit: 'km',
    startDateTime: `${addDays(start, -1)}T00:00:00Z`,
    endDateTime: `${addDays(end, 1)}T23:59:59Z`,
    sort: 'date,asc', size: '100',
  });
  return `https://app.ticketmaster.com/discovery/v2/events.json?${q}`;
}

const SEGMENT_KIND = { Music: 'concert', Sports: 'sport', 'Arts & Theatre': 'theatre', Film: 'theatre' };

/** Ticketmaster events on trip days, in our event shape. */
export function parseTicketmaster(json, start, end) {
  const list = json?._embedded?.events;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const s = e?.dates?.start || {};
    const date = s.localDate;
    if (!isValidDate(date) || s.dateTBA || date < start || date > end) continue;
    const name = String(e.name || '').trim();
    if (!name) continue;
    const key = `${name}|${date}`;
    if (seen.has(key)) continue; // the same show is often listed once per ticket type
    seen.add(key);
    const segment = e.classifications?.find((c) => c.primary)?.segment?.name || e.classifications?.[0]?.segment?.name || '';
    const guessed = guessKind(name);
    const time = !s.timeTBA && !s.noSpecificTime && /^\d{2}:\d{2}/.test(s.localTime || '') ? s.localTime.slice(0, 5) : '';
    out.push({
      name: name.slice(0, 80), date, time,
      kind: guessed === 'festival' ? 'festival' : SEGMENT_KIND[segment] || guessed,
      venue: String(e._embedded?.venues?.[0]?.name || '').slice(0, 120),
      url: /^https:\/\//.test(e.url || '') ? e.url : '',
      ref: String(e.id || '').slice(0, 80),
      source: 'ticketmaster',
    });
  }
  return out;
}

// ---------------------------------------------------------------- search the web

/** A web search for what's on, for anything the lists above don't know about. */
export function searchLink(place, start, end, fmt) {
  const q = `what's on in ${place} ${fmt(start, end)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
