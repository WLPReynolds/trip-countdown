// Open-Meteo request builders and response parsers, plus the logic that decides
// what each day of a trip shows: Forecast, Outlook (seasonal) or Average.
import { addDays, daysBetween, eachDay, shiftYears } from './time.js';

export const FORECAST_DAYS = 16;     // Open-Meteo forecast covers today + 15 days
export const EVENT_FORECAST_DAYS = 14; // special-event cloud switches to forecast in the final fortnight
export const CLIMATE_YEARS = 10;
export const CLIMATE_PAD = 3;        // average ±3 days around each date to smooth noise
export const ARCHIVE_LAG_DAYS = 6;   // the archive runs a few days behind today
export const MARINE_FORECAST_DAYS = 8;
export const MARINE_HISTORY_FROM = '2022-01-01';
export const CLEAR_SKY_MAX = 25;     // cloud cover (%) at or below this counts as clear

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ---------------------------------------------------------------- URLs

export function geocodeUrl(name) {
  return `https://geocoding-api.open-meteo.com/v1/search?${q({ name, count: 8, language: 'en', format: 'json' })}`;
}

const FORECAST_DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunshine_duration';
const ARCHIVE_DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunshine_duration';

export function forecastUrl(lat, lon) {
  return `https://api.open-meteo.com/v1/forecast?${q({ latitude: r4(lat), longitude: r4(lon), daily: FORECAST_DAILY, timezone: 'auto', forecast_days: FORECAST_DAYS, wind_speed_unit: 'mph' })}`;
}

export function archiveUrl(lat, lon, start, end) {
  return `https://archive-api.open-meteo.com/v1/archive?${q({ latitude: r4(lat), longitude: r4(lon), start_date: start, end_date: end, daily: ARCHIVE_DAILY, timezone: 'auto', wind_speed_unit: 'mph' })}`;
}

// The seasonal API's monthly anomaly variable names are not confirmed; the
// parser below looks for any temperature/precipitation anomaly keys.
export function seasonalUrl(lat, lon) {
  return `https://seasonal-api.open-meteo.com/v1/seasonal?${q({ latitude: r4(lat), longitude: r4(lon), monthly: 'temperature_2m_anomaly,precipitation_anomaly', models: 'ecmwf_seas5_ensemble_mean', timezone: 'auto' })}`;
}

export function marineUrl(lat, lon, range) {
  const base = { latitude: r4(lat), longitude: r4(lon), hourly: 'sea_surface_temperature', timezone: 'auto' };
  return `https://marine-api.open-meteo.com/v1/marine?${q(range ? { ...base, start_date: range.start, end_date: range.end } : { ...base, forecast_days: MARINE_FORECAST_DAYS })}`;
}

export function cloudArchiveUrl(lat, lon, start, end) {
  return `https://archive-api.open-meteo.com/v1/archive?${q({ latitude: r4(lat), longitude: r4(lon), start_date: start, end_date: end, hourly: 'cloud_cover', timezone: 'auto' })}`;
}

export function cloudForecastUrl(lat, lon) {
  return `https://api.open-meteo.com/v1/forecast?${q({ latitude: r4(lat), longitude: r4(lon), hourly: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high', timezone: 'auto', forecast_days: FORECAST_DAYS })}`;
}

// ---------------------------------------------------------------- parsers

export function parseGeocode(json) {
  return (json?.results || []).map((r) => ({
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    countryCode: (r.country_code || '').toUpperCase(),
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone || 'UTC',
  }));
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Daily block → Map(date → row). Rows with no temperature at all are skipped. */
export function parseDaily(json) {
  const d = json?.daily;
  const out = new Map();
  if (!d?.time) return out;
  d.time.forEach((date, i) => {
    const row = {
      tmax: num(d.temperature_2m_max?.[i]),
      tmin: num(d.temperature_2m_min?.[i]),
      precip: num(d.precipitation_sum?.[i]),
      rainChance: num(d.precipitation_probability_max?.[i]),
      wind: num(d.wind_speed_10m_max?.[i]),
      uv: num(d.uv_index_max?.[i]),
      sunHours: d.sunshine_duration?.[i] == null ? null : Math.round((d.sunshine_duration[i] / 3600) * 10) / 10,
      code: num(d.weather_code?.[i]),
    };
    if (row.tmax !== null || row.tmin !== null) out.set(date, row);
  });
  return out;
}

/** Hourly block → Map('YYYY-MM-DDTHH:MM' → { key: value }). */
export function parseHourly(json) {
  const h = json?.hourly;
  const out = new Map();
  if (!h?.time) return out;
  const keys = Object.keys(h).filter((k) => k !== 'time');
  h.time.forEach((t, i) => {
    const row = {};
    for (const k of keys) row[k] = num(h[k][i]);
    out.set(t, row);
  });
  return out;
}

// ---------------------------------------------------------------- climate averages

/**
 * One archive window per past year covering the trip (±pad), skipping any
 * window that isn't fully in the archive yet. Returns [{ start, end, years }].
 */
export function climateWindows(start, end, today, { years = CLIMATE_YEARS, pad = CLIMATE_PAD } = {}) {
  const lastArchived = addDays(today, -ARCHIVE_LAG_DAYS);
  const out = [];
  for (let y = 1; out.length < years && y <= years + 3; y++) {
    const s = addDays(shiftYears(start, -y), -pad);
    const e = addDays(shiftYears(end, -y), pad);
    if (e <= lastArchived) out.push({ start: s, end: e, years: y });
  }
  return out;
}

const mean = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * Average conditions for each trip day from merged archive rows.
 * rainChance = share of sampled days with ≥ 1 mm of rain.
 */
export function climateAverages(archive, days, windows, pad = CLIMATE_PAD) {
  const out = new Map();
  for (const day of days) {
    const samples = [];
    for (const w of windows) {
      const base = shiftYears(day, -w.years);
      for (let k = -pad; k <= pad; k++) { const r = archive.get(addDays(base, k)); if (r) samples.push(r); }
    }
    if (!samples.length) continue;
    const wet = samples.filter((s) => s.precip !== null);
    out.set(day, {
      tmax: round1(mean(samples.map((s) => s.tmax))),
      tmin: round1(mean(samples.map((s) => s.tmin))),
      precip: round1(mean(samples.map((s) => s.precip))),
      rainChance: wet.length ? Math.round((wet.filter((s) => s.precip >= 1).length / wet.length) * 100) : null,
      wind: round1(mean(samples.map((s) => s.wind))),
      sunHours: round1(mean(samples.map((s) => s.sunHours))),
      samples: samples.length,
    });
  }
  return out;
}

/** Merge several archive responses into one date → row map. */
export function mergeDaily(jsons) {
  const m = new Map();
  for (const j of jsons) for (const [k, v] of parseDaily(j)) m.set(k, v);
  return m;
}

// ---------------------------------------------------------------- seasonal outlook

/** Monthly anomalies → Map('YYYY-MM' → { temp, precip }). Tolerant of key names. */
export function parseSeasonal(json) {
  const m = json?.monthly;
  const out = new Map();
  if (!m?.time) return out;
  const keys = Object.keys(m);
  const tKey = keys.find((k) => /^temperature_2m.*anomaly/.test(k));
  const pKey = keys.find((k) => /^precipitation.*anomaly/.test(k));
  if (!tKey && !pKey) return out;
  m.time.forEach((t, i) => {
    const temp = tKey ? num(m[tKey][i]) : null;
    const precip = pKey ? num(m[pKey][i]) : null;
    if (temp !== null || precip !== null) out.set(String(t).slice(0, 7), { temp, precip });
  });
  return out;
}

export function outlookWords(o) {
  if (!o || o.temp === null) return null;
  const a = Math.round(o.temp * 10) / 10;
  if (a >= 0.5) return { trend: 'warmer', text: `Warmer than usual, about +${a.toFixed(1)}°` };
  if (a <= -0.5) return { trend: 'cooler', text: `Cooler than usual, about ${a.toFixed(1)}°` };
  return { trend: 'usual', text: 'Close to usual' };
}

// ---------------------------------------------------------------- per-day plan

/**
 * What to show for each trip day.
 * Each item: { date, daysOut, source: 'forecast'|'outlook'|'average'|'none', ...values, outlook? }
 * Days within the forecast window use the forecast; others use averages,
 * upgraded to 'outlook' when the seasonal model covers that month.
 */
export function planDays({ start, end, today, forecast = new Map(), climate = new Map(), seasonal = new Map() }) {
  return eachDay(start, end).map((date) => {
    const daysOut = daysBetween(today, date);
    const f = daysOut < FORECAST_DAYS ? forecast.get(date) : null;
    if (f) return { date, daysOut, source: 'forecast', ...f };
    const c = climate.get(date);
    const o = outlookWords(seasonal.get(date.slice(0, 7)));
    if (!c) return { date, daysOut, source: o ? 'outlook' : 'none', outlook: o };
    return { date, daysOut, source: o ? 'outlook' : 'average', ...c, outlook: o };
  });
}

/** One headline for the whole stay. */
export function summarise(days) {
  const v = days.filter((d) => d.source !== 'none');
  if (!v.length) return null;
  const m = (k) => round1(mean(v.map((d) => d[k] ?? null)));
  const sources = new Set(v.map((d) => d.source));
  return { tmax: m('tmax'), tmin: m('tmin'), rainChance: m('rainChance'), sources: [...sources] };
}

// ---------------------------------------------------------------- icons

const WMO = [
  [[0], '☀️', 'Clear'], [[1], '🌤️', 'Mostly clear'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Fog'], [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 66, 80, 81], '🌧️', 'Rain'],
  [[65, 67, 82], '🌧️', 'Heavy rain'], [[71, 73, 75, 77, 85, 86], '❄️', 'Snow'], [[95, 96, 99], '⛈️', 'Thunderstorms'],
];

export function wmoIcon(code) {
  const hit = WMO.find(([codes]) => codes.includes(code));
  return hit ? { icon: hit[1], label: hit[2] } : { icon: '🌡️', label: 'Weather' };
}

/** An icon for an average day, from how wet and sunny that date usually is. */
export function climateIcon(d) {
  if (d.tmax !== null && d.tmax <= 1 && (d.rainChance ?? 0) >= 40) return { icon: '❄️', label: 'Often snowy' };
  if ((d.rainChance ?? 0) >= 55) return { icon: '🌧️', label: 'Often wet' };
  if ((d.rainChance ?? 0) >= 35) return { icon: '🌦️', label: 'Some showers' };
  if ((d.sunHours ?? 0) >= 9) return { icon: '☀️', label: 'Usually sunny' };
  if ((d.sunHours ?? 0) >= 5) return { icon: '🌤️', label: 'Sunny spells' };
  return { icon: '⛅', label: 'Mixed' };
}

export function dayIcon(d) {
  if (d.source === 'forecast' && d.code !== null && d.code !== undefined) return wmoIcon(d.code);
  if (d.source === 'none') return { icon: '·', label: 'No data yet' };
  return climateIcon(d);
}

// ---------------------------------------------------------------- sea temperature

/** Hourly SST → Map(date → daily mean). */
export function parseMarineDaily(json) {
  const h = parseHourly(json);
  const byDay = new Map();
  for (const [t, row] of h) {
    const v = row.sea_surface_temperature;
    if (v === null || v === undefined) continue;
    const d = t.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(v);
  }
  const out = new Map();
  for (const [d, vs] of byDay) out.set(d, round1(mean(vs)));
  return out;
}

/** Past-year windows for sea temperature history (the marine archive starts in 2022). */
export function marineHistoryWindows(start, end, today, maxYears = 3) {
  const last = addDays(today, -2);
  const out = [];
  for (let y = 1; y <= maxYears + 1 && out.length < maxYears; y++) {
    const s = shiftYears(start, -y), e = shiftYears(end, -y);
    if (s < MARINE_HISTORY_FROM) break;
    if (e <= last) out.push({ start: s, end: e, years: y });
  }
  return out;
}

/**
 * Sea temperature for the stay: forecast if any trip day is covered,
 * otherwise the typical value for the same dates in past years.
 */
export function seaSummary({ days, forecast = new Map(), history = new Map(), windows = [] }) {
  const f = days.map((d) => forecast.get(d)).filter((v) => v !== undefined && v !== null);
  if (f.length) return { source: 'forecast', temp: round1(mean(f)), days: f.length };
  const h = [];
  for (const w of windows) for (const d of days) { const v = history.get(shiftYears(d, -w.years)); if (v !== undefined && v !== null) h.push(v); }
  if (h.length) return { source: 'typical', temp: round1(mean(h)), samples: h.length };
  return null;
}

// ---------------------------------------------------------------- special event cloud

/** Round a local 'HH:MM' to the nearest whole hour, as 'HH:00' (23:40 stays 23:00). */
export function eventHour(time) {
  const [h, m] = time.split(':').map(Number);
  return `${String(Math.min(23, m >= 30 ? h + 1 : h)).padStart(2, '0')}:00`;
}

export function cloudWindows(date, today, { years = CLIMATE_YEARS, pad = 7 } = {}) {
  return climateWindows(date, date, today, { years, pad });
}

/** Historical odds of a clear sky at the event hour, from merged hourly archive rows. */
export function cloudOdds(hourly, date, time, windows, pad = 7) {
  const hh = eventHour(time);
  const covers = [];
  for (const w of windows) {
    const base = shiftYears(date, -w.years);
    for (let k = -pad; k <= pad; k++) {
      const v = hourly.get(`${addDays(base, k)}T${hh}`)?.cloud_cover;
      if (v !== null && v !== undefined) covers.push(v);
    }
  }
  if (!covers.length) return null;
  return {
    source: 'history',
    clearPct: Math.round((covers.filter((c) => c <= CLEAR_SKY_MAX).length / covers.length) * 100),
    meanCover: Math.round(mean(covers)),
    samples: covers.length,
  };
}

/** Forecast cloud at the event hour, if the forecast reaches it. */
export function cloudForecast(hourly, date, time) {
  const row = hourly.get(`${date}T${eventHour(time)}`);
  if (!row || row.cloud_cover === null || row.cloud_cover === undefined) return null;
  return { source: 'forecast', cover: row.cloud_cover, low: row.cloud_cover_low ?? null, mid: row.cloud_cover_mid ?? null, high: row.cloud_cover_high ?? null };
}

export function useEventForecast(date, today) {
  const d = daysBetween(today, date);
  return d >= 0 && d < EVENT_FORECAST_DAYS;
}

export function mergeHourly(jsons) {
  const m = new Map();
  for (const j of jsons) for (const [k, v] of parseHourly(j)) m.set(k, v);
  return m;
}
