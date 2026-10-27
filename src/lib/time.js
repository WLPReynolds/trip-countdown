// Date and time-zone helpers. Dates are plain 'YYYY-MM-DD' strings and times
// 'HH:MM' strings; instants are JS Date objects. Everything here is pure so it
// can be tested in Node and reused by the Worker.

const DAY_MS = 86400000;
const dtfCache = new Map();

function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { dtf(tz); return true; } catch { return false; }
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(instant, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(instant)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
  };
}

/** Offset of tz from UTC at an instant, in minutes (BST = +60). */
export function tzOffsetMinutes(instant, tz) {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Convert a local wall time in an IANA zone to a UTC instant. */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

/** Today's date ('YYYY-MM-DD') in a time zone. */
export function todayIn(tz, now = new Date()) {
  const p = zonedParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/** Every date from start to end inclusive. */
export function eachDay(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Same calendar date shifted by whole years; 29 Feb becomes 28 Feb. */
export function shiftYears(date, years) {
  const y = +date.slice(0, 4) + years;
  let md = date.slice(5);
  if (md === '02-29') {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!leap) md = '02-28';
  }
  return `${y}-${md}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekday(date) {
  return WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
}

export function formatDate(date, { withYear = false, withWeekday = false } = {}) {
  const [y, m, d] = date.split('-').map(Number);
  let s = `${d} ${MONTHS[m - 1]}`;
  if (withYear) s += ` ${y}`;
  if (withWeekday) s = `${weekday(date)} ${s}`;
  return s;
}

/** '11–18 Jun 2027', '27 Jul – 6 Aug 2027', '28 Dec 2026 – 4 Jan 2027'. */
export function formatRange(start, end) {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  if (ys !== ye) return `${formatDate(start, { withYear: true })} – ${formatDate(end, { withYear: true })}`;
  if (ms !== me) return `${ds} ${MONTHS[ms - 1]} – ${de} ${MONTHS[me - 1]} ${ye}`;
  if (ds === de) return `${ds} ${MONTHS[ms - 1]} ${ys}`;
  return `${ds}–${de} ${MONTHS[ms - 1]} ${ys}`;
}

export function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London'; }
  catch { return 'Europe/London'; }
}
