// Trip countdown: app shell, views and wiring.
import { createApi, ApiError } from './lib/api.js';
import { tripStatus, describeCountdown, countdownTo } from './lib/countdown.js';
import { validateTrip, sortTrips, themeFor, flagEmoji, tripTitle } from './lib/trip.js';
import { todayIn, eachDay, daysBetween, addDays, formatRange, formatDate, deviceTimeZone, zonedToUtc } from './lib/time.js';
import * as W from './lib/weather.js';
import { decodeTopology, chooseView, renderMap } from './lib/geo.js';
import { historySeries, linePaths } from './lib/chart.js';

export const APP_VERSION = '0.1.0';

// Set this to the Worker's address once it's deployed, so nobody has to type it.
const DEFAULT_API_BASE = '';
const HOME_TZ = deviceTimeZone();
const LS = { key: 'tc.key', base: 'tc.base', trips: 'tc.trips', http: 'tc.http.' };
const TTL = { forecast: 3 * 3600e3, climate: 30 * 86400e3, seasonal: 12 * 3600e3, marine: 6 * 3600e3, marineHistory: 30 * 86400e3, geocode: 30 * 86400e3 };

// ---------------------------------------------------------------- state

const state = {
  trips: readJson(LS.trips) || [],
  synced: false,
  error: null,
  weather: new Map(),   // trip key → { status, data }
  snapshots: new Map(), // trip id → rows
  route: parseRoute(),
};

function readJson(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } }
const settings = () => ({ key: localStorage.getItem(LS.key) || '', base: localStorage.getItem(LS.base) || DEFAULT_API_BASE });
const api = () => createApi(settings());

// ---------------------------------------------------------------- utilities

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const deg = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)}°`);
const tzCity = (tz) => (tz || '').split('/').pop().replace(/_/g, ' ');

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
};

const POSTMARK = '<svg class="postmark" viewBox="0 0 100 60" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="30" cy="30" r="22"/><circle cx="30" cy="30" r="16" stroke-dasharray="3 4"/><path d="M56 16q8-5 16 0t16 0M56 26q8-5 16 0t16 0M56 36q8-5 16 0t16 0M56 46q8-5 16 0t16 0"/></svg>';

// ---------------------------------------------------------------- http cache for Open-Meteo

async function cachedJson(url, ttl) {
  const k = LS.http + url;
  const hit = readJson(k);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = await res.json();
    try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v })); }
    catch { pruneHttpCache(); }
    return v;
  } catch (e) {
    if (hit) return hit.v; // stale is better than nothing offline
    throw e;
  }
}

function pruneHttpCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(LS.http)) keys.push(k); }
  keys.forEach((k) => localStorage.removeItem(k));
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  const m = location.hash.match(/^#\/trip\/([\w-]+)/);
  return m ? { name: 'trip', id: m[1] } : { name: 'home' };
}
window.addEventListener('hashchange', () => { state.route = parseRoute(); render(); window.scrollTo(0, 0); });

// ---------------------------------------------------------------- sync

async function sync({ quiet = false } = {}) {
  const s = settings();
  if (!s.key || !s.base) { state.error = null; render(); return; }
  try {
    state.trips = await api().list();
    writeJson(LS.trips, state.trips);
    state.synced = true;
    state.error = null;
  } catch (e) {
    state.error = e;
  }
  if (!quiet || state.error) render(); else refreshLight();
}

// Redraw only if the list actually changed, so a background poll doesn't jolt the page.
let lastRendered = '';
function refreshLight() {
  const sig = JSON.stringify(state.trips.map((t) => [t.id, t.updatedAt]));
  if (sig !== lastRendered) render();
}

// ---------------------------------------------------------------- weather

const weatherKey = (t) => [t.id, t.startDate, t.endDate, t.destination.lat, t.destination.lon, t.event?.date, t.event?.time].join('|');

async function loadWeather(trip) {
  const { lat, lon, timezone } = trip.destination;
  const today = todayIn(timezone);
  const out = { today, days: [], summary: null, sea: null, event: null };
  if (trip.endDate < today) return out;
  const visibleStart = trip.startDate < today ? today : trip.startDate;
  const days = eachDay(visibleStart, trip.endDate);
  const forecastLast = addDays(today, W.FORECAST_DAYS - 1);

  const jobs = [];
  let forecast = new Map(), climate = new Map(), seasonal = new Map();

  if (visibleStart <= forecastLast) {
    jobs.push(cachedJson(W.forecastUrl(lat, lon), TTL.forecast).then((j) => { forecast = W.parseDaily(j); }).catch(() => {}));
  }
  if (trip.endDate > forecastLast) {
    const climStart = visibleStart > forecastLast ? visibleStart : addDays(forecastLast, 1);
    const windows = W.climateWindows(climStart, trip.endDate, today);
    jobs.push(Promise.all(windows.map((w) => cachedJson(W.archiveUrl(lat, lon, w.start, w.end), TTL.climate)))
      .then((js) => { climate = W.climateAverages(W.mergeDaily(js), eachDay(climStart, trip.endDate), windows); }).catch(() => {}));
    jobs.push(cachedJson(W.seasonalUrl(lat, lon), TTL.seasonal).then((j) => { seasonal = W.parseSeasonal(j); }).catch(() => {}));
  }

  // Sea temperature: forecast for the next week, otherwise the same dates in past years.
  jobs.push((async () => {
    try {
      if (daysBetween(today, visibleStart) < W.MARINE_FORECAST_DAYS) {
        const f = W.parseMarineDaily(await cachedJson(W.marineUrl(lat, lon), TTL.marine));
        out.sea = W.seaSummary({ days, forecast: f });
      } else {
        const windows = W.marineHistoryWindows(trip.startDate, trip.endDate, today);
        const js = await Promise.all(windows.map((w) => cachedJson(W.marineUrl(lat, lon, w), TTL.marineHistory)));
        const history = new Map();
        js.forEach((j) => { for (const [k, v] of W.parseMarineDaily(j)) history.set(k, v); });
        out.sea = W.seaSummary({ days: eachDay(trip.startDate, trip.endDate), history, windows });
      }
    } catch { out.sea = null; }
  })());

  // Special event: cloud cover at that hour.
  if (trip.event && trip.event.date >= today) {
    const ev = trip.event;
    jobs.push((async () => {
      try {
        if (W.useEventForecast(ev.date, today)) {
          out.event = W.cloudForecast(W.mergeHourly([await cachedJson(W.cloudForecastUrl(lat, lon), TTL.forecast)]), ev.date, ev.time);
        }
        if (!out.event) {
          const windows = W.cloudWindows(ev.date, today);
          const js = await Promise.all(windows.map((w) => cachedJson(W.cloudArchiveUrl(lat, lon, w.start, w.end), TTL.climate)));
          out.event = W.cloudOdds(W.mergeHourly(js), ev.date, ev.time, windows);
        }
      } catch { out.event = null; }
    })());
  }

  await Promise.all(jobs);
  out.days = W.planDays({ start: visibleStart, end: trip.endDate, today, forecast, climate, seasonal });
  out.summary = W.summarise(out.days);
  return out;
}

function weatherFor(trip) {
  const key = weatherKey(trip);
  let w = state.weather.get(key);
  if (!w) {
    w = { status: 'loading', data: null };
    state.weather.set(key, w);
    loadWeather(trip)
      .then((data) => { w.status = 'ready'; w.data = data; })
      .catch(() => { w.status = 'error'; })
      .finally(() => render());
  }
  return w;
}

// ---------------------------------------------------------------- maps

let featuresPromise = null;
function getFeatures() {
  featuresPromise ||= fetch('data/countries-10m.json').then((r) => r.json()).then((t) => decodeTopology(t, 'countries'));
  return featuresPromise;
}
const mapCache = new Map();

async function drawMaps(root = document) {
  const faces = root.querySelectorAll('[data-map]');
  if (!faces.length) return;
  let features;
  try { features = await getFeatures(); } catch { faces.forEach((f) => { f.querySelector('.loading')?.replaceChildren('Map unavailable'); }); return; }
  faces.forEach((face) => {
    const trip = state.trips.find((t) => t.id === face.dataset.map);
    if (!trip) return;
    const w = 200, hgt = 250;
    const key = `${trip.destination.lat},${trip.destination.lon}`;
    let m = mapCache.get(key);
    if (!m) {
      m = renderMap(features, chooseView(features, trip.destination.lon, trip.destination.lat, w / hgt), w, hgt);
      mapCache.set(key, m);
    }
    face.innerHTML = `<svg viewBox="0 0 ${w} ${hgt}" role="img" aria-label="Map of ${h(m.countryName || trip.destination.country)} with a pin on ${h(trip.destination.name)}">
      <path class="others" d="${m.others}"/><path class="target" d="${m.target}"/>
      <circle class="pin-ring" cx="${m.pin.x.toFixed(1)}" cy="${m.pin.y.toFixed(1)}" r="11"/>
      <circle class="pin-dot" cx="${m.pin.x.toFixed(1)}" cy="${m.pin.y.toFixed(1)}" r="5.5"/></svg>${face.closest('.stamp.big') ? POSTMARK : ''}`;
    const note = face.closest('.detail')?.querySelector('[data-map-note]');
    if (note) note.textContent = m.cropped ? `Showing about 1,000 km around ${trip.destination.name}` : '';
  });
}

function stamp(trip, big = false) {
  return `<div class="stamp${big ? ' big' : ''}" aria-hidden="${big ? 'false' : 'true'}"><div class="face" data-map="${h(trip.id)}"><span class="loading">Drawing map</span></div></div>`;
}

// ---------------------------------------------------------------- countdown pieces

function countHtml(c, extra = '') {
  const d = describeCountdown(c);
  return `<span class="big">${h(d.big)}</span><span class="unit">${h(d.unit)}</span><span class="small">${h(extra || d.small)}</span>`;
}

function statusCount(trip, now = new Date()) {
  const s = tripStatus(trip, now, HOME_TZ);
  if (s.status === 'upcoming') return countHtml(s.countdown, s.countdown.phase === 'days' ? '' : 'until departure');
  if (s.status === 'away') return `<span class="big">${s.dayOfTrip}</span><span class="unit">of ${s.totalDays} days</span><span class="small">Enjoy every minute</span>`;
  return `<span class="big">✓</span><span class="unit">Home again</span><span class="small"></span>`;
}

function eventCount(trip, now = new Date()) {
  const ev = trip.event;
  const at = zonedToUtc(ev.date, ev.time, trip.destination.timezone);
  if (now >= at) return `<span class="big">✓</span><span class="unit">Happened</span><span class="small"></span>`;
  return countHtml(countdownTo(at, now));
}

function tick() {
  const now = new Date();
  document.querySelectorAll('[data-count]').forEach((el) => {
    const trip = state.trips.find((t) => t.id === el.dataset.count);
    if (!trip) return;
    const html = el.dataset.kind === 'event' ? eventCount(trip, now) : statusCount(trip, now);
    if (el.innerHTML !== html) el.innerHTML = html;
  });
}
setInterval(tick, 1000);

// ---------------------------------------------------------------- views

function bar(html) { $('#bar').innerHTML = html; }

function banner() {
  const s = settings();
  const el = $('#banner');
  if (!s.key || !s.base) {
    el.innerHTML = `<p class="banner">To see your trips, add the setup key in Settings. <button class="btn secondary" data-action="settings">Open Settings</button></p>`;
  } else if (state.error instanceof ApiError) {
    const offline = state.error.kind === 'offline';
    el.innerHTML = `<p class="banner${offline ? '' : ' error'}">${h(offline ? 'You’re offline. Showing the trips saved on this phone.' : state.error.message)}${state.error.kind === 'unauthorised' ? ' <button class="btn secondary" data-action="settings">Open Settings</button>' : ''}</p>`;
  } else el.innerHTML = '';
  if (swWaiting) el.innerHTML += `<p class="banner">A new version is ready. <button class="btn secondary" data-action="update">Refresh</button></p>`;
}

function weatherLine(trip) {
  const w = weatherFor(trip);
  if (w.status !== 'ready' || !w.data.summary) return '';
  const s = w.data.summary;
  const word = s.sources.includes('forecast') ? (s.sources.length > 1 ? 'Forecast and averages' : 'Forecast') : 'Usually';
  return `<span class="wx">${word} ${deg(s.tmax)} / ${deg(s.tmin)}${s.rainChance !== null ? `, ${Math.round(s.rainChance)}% chance of rain` : ''}</span>`;
}

function eventLine(trip) {
  const ev = trip.event;
  if (!ev) return '';
  const at = zonedToUtc(ev.date, ev.time, trip.destination.timezone);
  const now = new Date();
  if (now >= at) return '';
  const c = countdownTo(at, now);
  const when = c.phase === 'days' ? `in ${c.days} ${c.days === 1 ? 'day' : 'days'}` : 'today';
  return `<span>${/eclipse/i.test(ev.name) ? '🌑' : '✨'} ${h(ev.name)} ${when}</span>`;
}

function tripCard(trip, lead) {
  const s = tripStatus(trip, new Date(), HOME_TZ);
  const d = trip.destination;
  const where = [d.admin1, d.country].filter(Boolean).join(', ');
  return `<a class="card-link ${lead ? '' : 'compact'} ${s.status === 'done' ? 'done' : ''}" href="#/trip/${h(trip.id)}">
    <article class="envelope t-${themeFor(trip)}">
      <div class="card">
        <div class="place"><span class="flag" aria-hidden="true">${flagEmoji(d.countryCode)}</span><h2>${h(tripTitle(trip))}</h2></div>
        <p class="where">${h(trip.name ? `${d.name}, ${d.country}` : where)}</p>
        <div class="count" data-count="${h(trip.id)}">${statusCount(trip)}</div>
        <div class="meta"><span>${h(formatRange(trip.startDate, trip.endDate))}</span>${weatherLine(trip)}${eventLine(trip)}</div>
        ${stamp(trip)}
      </div>
    </article></a>`;
}

function renderHome() {
  bar(`<h1>Trips</h1>
    <button class="icon-btn" data-action="settings" aria-label="Settings">${ICONS.gear}</button>
    <button class="icon-btn add" data-action="add" aria-label="Add a trip">${ICONS.plus}</button>`);
  const trips = sortTrips(state.trips, new Date(), HOME_TZ);
  if (!trips.length) {
    const ready = settings().key && settings().base;
    $('#main').innerHTML = `<section class="empty">
      <div class="envelope t-tropical"><div class="card" aria-hidden="true">✈️</div></div>
      <h2>Where to next?</h2>
      <p>${ready ? 'Add a trip and it’ll appear on both phones, with a countdown, a map and the weather.' : 'Once the setup key is in Settings, your shared trips will appear here.'}</p>
      ${ready ? '<button class="btn" data-action="add">Add a trip</button>' : '<button class="btn" data-action="settings">Open Settings</button>'}
    </section>`;
    return;
  }
  $('#main').innerHTML = trips.map((t, i) => tripCard(t, i === 0)).join('');
  drawMaps();
}

function flightLine(label, f) {
  if (!f) return '';
  return `<li>${label} ${h(formatDate(f.date, { withWeekday: true }))} at ${h(f.time)} ${h(tzCity(f.tz))} time</li>`;
}

function dayTile(d) {
  const ic = W.dayIcon(d);
  const label = { forecast: 'Forecast', outlook: 'Outlook', average: 'Average', none: 'No data yet' }[d.source];
  const extra = d.source === 'forecast'
    ? [d.uv !== null ? `UV ${Math.round(d.uv)}` : '', d.wind !== null ? `${Math.round(d.wind)} mph wind` : ''].filter(Boolean).map(h).join('<br>')
    : d.sunHours !== null && d.sunHours !== undefined ? `${Math.round(d.sunHours)} hrs sun` : '';
  return `<li class="day" title="${h(d.outlook?.text || ic.label)}">
    <div class="dname">${h(formatDate(d.date, { withWeekday: true }).replace(/ \w+$/, ''))}</div>
    <div class="icon" role="img" aria-label="${h(ic.label)}">${ic.icon}</div>
    <div class="temps">${deg(d.tmax)} <span class="lo">${deg(d.tmin)}</span></div>
    <div class="rain">${d.rainChance !== null && d.rainChance !== undefined ? `${Math.round(d.rainChance)}% rain` : '&nbsp;'}</div>
    <div class="extra">${extra || '&nbsp;'}</div>
    <span class="badge ${d.source}">${label}</span></li>`;
}

function weatherSection(trip) {
  const w = weatherFor(trip);
  if (w.status === 'loading') return `<section class="section"><h3>Weather</h3><p class="lede">Fetching the weather…</p></section>`;
  if (w.status === 'error' || !w.data) return `<section class="section"><h3>Weather</h3><p class="lede">The weather couldn’t be loaded. It’ll try again next time you open this trip.</p></section>`;
  const data = w.data;
  if (!data.days.length) return '';
  const sources = new Set(data.days.map((d) => d.source));
  const outlook = data.days.find((d) => d.outlook)?.outlook;
  const lede = sources.has('forecast')
    ? sources.size > 1 ? 'The forecast covers the first days; the rest are averages until the forecast reaches them.' : 'The latest forecast for every day of the stay.'
    : `What this time of year is usually like, from the last ${W.CLIMATE_YEARS} years. The forecast takes over ${W.FORECAST_DAYS} days before each day.`;
  return `<section class="section">
    <h3>Weather</h3>
    <p class="lede">${h(lede)}${outlook ? ` Seasonal outlook: ${h(outlook.text.toLowerCase())}.` : ''}</p>
    <div class="legend">${[...sources].filter((s) => s !== 'none').map((s) => `<span><span class="badge ${s}">${{ forecast: 'Forecast', outlook: 'Outlook', average: 'Average' }[s]}</span>${{ forecast: 'weather forecast', outlook: 'average plus seasonal trend', average: 'typical for the date' }[s]}</span>`).join('')}</div>
    <ul class="days" role="list">${data.days.map(dayTile).join('')}</ul>
    ${seaTile(data.sea)}
  </section>`;
}

function seaTile(sea) {
  if (!sea) return '';
  return `<div class="tiles"><div class="tile"><div class="k">Sea temperature</div><div class="v">${deg(sea.temp)}</div>
    <div class="s">${sea.source === 'forecast' ? 'Forecast for your days' : 'Typical for these dates'}</div></div></div>`;
}

function orb(name) {
  if (/eclipse/i.test(name)) {
    return `<svg class="orb" viewBox="0 0 80 80" aria-hidden="true"><defs><radialGradient id="corona"><stop offset="55%" stop-color="#FFE9A8"/><stop offset="100%" stop-color="#FFE9A8" stop-opacity="0"/></radialGradient></defs>
      <circle cx="40" cy="40" r="38" fill="url(#corona)"/><circle cx="40" cy="40" r="21" fill="#FFF7D6"/><circle cx="41.5" cy="39" r="21" fill="#120D33"/></svg>`;
  }
  return `<svg class="orb" viewBox="0 0 80 80" aria-hidden="true"><path d="M40 6l7 25 25 9-25 9-7 25-7-25-25-9 25-9z" fill="#FFE27A"/></svg>`;
}

function donut(pct) {
  const r = 26, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="8"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="#FFE27A" stroke-width="8" stroke-linecap="round" stroke-dasharray="${((pct / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/></svg>`;
}

function eventSection(trip) {
  const ev = trip.event;
  if (!ev) return '';
  const w = weatherFor(trip);
  const cloud = w.data?.event;
  let odds = '';
  if (w.status === 'loading') odds = '<div class="odds">Checking the sky…</div>';
  else if (cloud?.source === 'history') {
    odds = `<div class="odds">${donut(cloud.clearPct)}<div><b>${cloud.clearPct}% chance of clear sky</b><br>
      At ${h(W.eventHour(ev.time))} on these dates over the last ${W.CLIMATE_YEARS} years, cloud averaged ${cloud.meanCover}%. The forecast takes over ${W.EVENT_FORECAST_DAYS} days before.</div></div>`;
  } else if (cloud?.source === 'forecast') {
    const layers = [['low', cloud.low], ['mid', cloud.mid], ['high', cloud.high]].filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}%`).join(', ');
    odds = `<div class="odds">${donut(100 - cloud.cover)}<div><b>Forecast: ${cloud.cover}% cloud</b><br>At ${h(W.eventHour(ev.time))}${layers ? `, ${h(layers)}` : ''}.</div></div>`;
  }
  return `<section class="section">
    <div class="event">${orb(ev.name)}
      <h4>${h(ev.name)}</h4>
      <p class="when">${h(formatDate(ev.date, { withWeekday: true, withYear: true }))} at ${h(ev.time)} ${h(tzCity(trip.destination.timezone))} time</p>
      <div class="count" data-count="${h(trip.id)}" data-kind="event">${eventCount(trip)}</div>
      ${odds}
    </div></section>`;
}

function historySection(trip) {
  const rows = state.snapshots.get(trip.id);
  if (rows === undefined) {
    state.snapshots.set(trip.id, null);
    api().snapshots(trip.id).then((r) => { state.snapshots.set(trip.id, r); render(); }).catch(() => state.snapshots.set(trip.id, []));
    return '';
  }
  const series = historySeries(rows || []);
  if (series.length < 2) {
    const s = tripStatus(trip, new Date(), HOME_TZ);
    if (s.status === 'done') return '';
    return `<section class="section"><h3>How the forecast has changed</h3><p class="lede">${series.length ? 'One forecast saved so far. The chart appears after the second day.' : `A copy of the forecast is saved every morning once the trip is within ${W.FORECAST_DAYS} days.`}</p></section>`;
  }
  const W_ = 320, H_ = 150;
  const p = linePaths(series, ['tmax', 'tmin'], W_, H_, 14);
  const first = series[0].takenOn, last = series[series.length - 1].takenOn;
  return `<section class="section"><h3>How the forecast has changed</h3>
    <p class="lede">Average high and low for your days, as forecast each morning.</p>
    <div class="chart"><svg viewBox="0 0 ${W_} ${H_ + 16}" role="img" aria-label="Forecast highs and lows from ${h(formatDate(first))} to ${h(formatDate(last))}">
      <line class="grid" x1="14" x2="${W_ - 14}" y1="${p.y(p.max)}" y2="${p.y(p.max)}"/><line class="grid" x1="14" x2="${W_ - 14}" y1="${p.y(p.min)}" y2="${p.y(p.min)}"/>
      <text class="axis" x="${W_ - 14}" y="${p.y(p.max) - 3}" text-anchor="end">${p.max}°</text><text class="axis" x="${W_ - 14}" y="${p.y(p.min) - 3}" text-anchor="end">${p.min}°</text>
      <path class="hi" d="${p.lines.tmax}" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <path class="lo" d="${p.lines.tmin}" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text class="axis" x="14" y="${H_ + 12}">${h(formatDate(first))}</text><text class="axis" x="${W_ - 14}" y="${H_ + 12}" text-anchor="end">${h(formatDate(last))}</text>
    </svg><div class="chart-key"><span><i style="background:var(--air-red)"></i>High</span><span><i style="background:var(--air-blue)"></i>Low</span></div></div></section>`;
}

function renderTrip(id) {
  const trip = state.trips.find((t) => t.id === id);
  bar(`<a class="icon-btn" href="#/" aria-label="Back to all trips">${ICONS.back}</a><h1></h1>
    ${trip ? `<button class="icon-btn" data-action="edit" data-id="${h(id)}" aria-label="Edit trip">${ICONS.edit}</button>` : ''}`);
  if (!trip) { $('#main').innerHTML = `<section class="empty"><h2>This trip has gone</h2><p>It may have been deleted on the other phone.</p><a class="btn" href="#/">See all trips</a></section>`; return; }
  const d = trip.destination;
  $('#main').innerHTML = `<div class="detail">
    <article class="envelope t-${themeFor(trip)}"><div class="card">
      <div class="place"><span class="flag" aria-hidden="true">${flagEmoji(d.countryCode)}</span><h2>${h(tripTitle(trip))}</h2></div>
      <p class="where">${h([trip.name ? d.name : d.admin1, d.country].filter(Boolean).join(', '))}</p>
      <div class="count" data-count="${h(trip.id)}">${statusCount(trip)}</div>
      <div class="meta"><span>${h(formatRange(trip.startDate, trip.endDate))}</span></div>
      <ul class="flights">${flightLine('Flying out', trip.outbound)}${flightLine('Flying home', trip.return)}</ul>
      ${stamp(trip, true)}
      <p class="map-note" data-map-note></p>
    </div></article>
    ${eventSection(trip)}
    ${weatherSection(trip)}
    ${historySection(trip)}
    <div class="danger-zone"><button class="text-btn danger" data-action="delete" data-id="${h(id)}">Delete this trip</button></div>
  </div>`;
  drawMaps($('#main'));
}

function render() {
  lastRendered = JSON.stringify(state.trips.map((t) => [t.id, t.updatedAt]));
  banner();
  if (state.route.name === 'trip') renderTrip(state.route.id); else renderHome();
}

// ---------------------------------------------------------------- trip form

let chosenPlace = null;

function tripForm(trip) {
  const t = trip || { startDate: '', endDate: '', outbound: null, return: null, event: null, name: '' };
  chosenPlace = trip ? trip.destination : null;
  const today = todayIn(HOME_TZ);
  const dlg = $('#dlg-trip');
  dlg.innerHTML = `<form class="sheet" method="dialog" novalidate>
    <h2 id="trip-title">${trip ? 'Edit trip' : 'New trip'}</h2>
    <fieldset><legend>Where</legend>
      <div data-place>${placeHtml()}</div>
      <label>Nickname <span class="hint">(optional, shown instead of the place name)</span><input name="name" maxlength="80" value="${h(t.name)}" autocomplete="off"></label>
    </fieldset>
    <fieldset><legend>When</legend>
      <div class="row">
        <label>First day<input type="date" name="startDate" required value="${h(t.startDate)}" min="${trip ? '' : today}"></label>
        <label>Last day<input type="date" name="endDate" required value="${h(t.endDate)}"></label>
      </div>
    </fieldset>
    <fieldset><legend>Flights <span class="hint">(optional)</span></legend>
      ${flightFields('outbound', 'Flight out departs', t.outbound, HOME_TZ)}
      ${flightFields('return', 'Flight home departs', t.return, t.destination?.timezone || '')}
    </fieldset>
    <fieldset><legend>Special event <span class="hint">(optional)</span></legend>
      <label class="toggle"><input type="checkbox" name="hasEvent" ${t.event ? 'checked' : ''}> Count down to something during the trip</label>
      <div data-event ${t.event ? '' : 'hidden'}>
        <label>What is it<input name="eventName" maxlength="80" placeholder="Total solar eclipse" value="${h(t.event?.name)}"></label>
        <div class="row"><label>Date<input type="date" name="eventDate" value="${h(t.event?.date)}"></label>
        <label>Local time<input type="time" name="eventTime" value="${h(t.event?.time)}"></label></div>
        <p class="hint" style="margin:0;font-size:14px">The time is local to the destination. Cloud cover is shown for that hour.</p>
      </div>
    </fieldset>
    <ul class="errors" data-errors></ul>
    <div class="actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn" type="submit">${trip ? 'Save changes' : 'Add trip'}</button></div>
  </form>`;
  wireTripForm(dlg, trip);
  dlg.showModal();
}

function flightFields(key, label, f, defaultTz) {
  return `<div class="row3">
    <label>${label}<input type="date" name="${key}Date" value="${h(f?.date)}"></label>
    <label>Time<input type="time" name="${key}Time" value="${h(f?.time)}"></label>
    <label>Departure time zone <span class="hint">(the airport you leave from)</span><input name="${key}Tz" list="tz-list" value="${h(f?.tz || defaultTz)}" autocomplete="off" spellcheck="false"></label>
  </div>`;
}

function placeHtml() {
  if (chosenPlace) {
    return `<div class="chosen"><span class="flag">${flagEmoji(chosenPlace.countryCode)}</span><div><b>${h(chosenPlace.name)}</b><br><small>${h([chosenPlace.admin1, chosenPlace.country].filter(Boolean).join(', '))}</small></div>
      <button type="button" class="text-btn" data-change-place>Change</button></div>`;
  }
  return `<label>Destination<input name="q" placeholder="Town or city" autocomplete="off" enterkeyhint="search"></label><ul class="results" data-results></ul>`;
}

function wireTripForm(dlg, trip) {
  const form = dlg.querySelector('form');
  const placeBox = form.querySelector('[data-place]');
  let timer = null, seq = 0, results = [];

  function bindPlace() {
    const q = placeBox.querySelector('[name=q]');
    placeBox.querySelector('[data-change-place]')?.addEventListener('click', () => { chosenPlace = null; placeBox.innerHTML = placeHtml(); bindPlace(); placeBox.querySelector('[name=q]').focus(); });
    if (!q) return;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      const term = q.value.trim();
      const list = placeBox.querySelector('[data-results]');
      if (term.length < 2) { list.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          results = W.parseGeocode(await cachedJson(W.geocodeUrl(term), TTL.geocode));
          if (mine !== seq) return;
          list.innerHTML = results.length
            ? results.map((r, i) => `<li><button type="button" data-pick="${i}">${flagEmoji(r.countryCode)} <b>${h(r.name)}</b> <small>${h([r.admin1, r.country].filter(Boolean).join(', '))}</small></button></li>`).join('')
            : '<li><button type="button" disabled>No places found. Try a nearby town.</button></li>';
        } catch { list.innerHTML = '<li><button type="button" disabled>Search isn’t available offline.</button></li>'; }
      }, 300);
    });
    placeBox.querySelector('[data-results]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      chosenPlace = results[+b.dataset.pick];
      placeBox.innerHTML = placeHtml();
      bindPlace();
      const rtz = form.elements.returnTz;
      if (!rtz.value) rtz.value = chosenPlace.timezone;
    });
  }
  bindPlace();

  const start = form.elements.startDate, end = form.elements.endDate;
  start.addEventListener('change', () => {
    end.min = start.value;
    if (!end.value || end.value < start.value) end.value = addDays(start.value, 7);
    if (!form.elements.eventDate.value) form.elements.eventDate.value = start.value;
  });
  form.elements.hasEvent.addEventListener('change', (e) => { form.querySelector('[data-event]').hidden = !e.target.checked; });
  form.querySelector('[data-close]').addEventListener('click', () => dlg.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const flight = (k) => (f[`${k}Date`].value || f[`${k}Time`].value ? { date: f[`${k}Date`].value, time: f[`${k}Time`].value, tz: f[`${k}Tz`].value.trim() } : null);
    const input = {
      name: f.name.value,
      destination: chosenPlace || {},
      startDate: start.value, endDate: end.value,
      outbound: flight('outbound'), return: flight('return'),
      event: f.hasEvent.checked ? { name: f.eventName.value, date: f.eventDate.value, time: f.eventTime.value } : null,
    };
    const v = validateTrip(input);
    const errs = form.querySelector('[data-errors]');
    if (!chosenPlace) v.errors.unshift('Choose a destination from the search results');
    if (v.errors.length) { errs.innerHTML = v.errors.map((x) => `<li>${h(x)}</li>`).join(''); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const saved = trip ? await api().update(trip.id, v.trip) : await api().create(v.trip);
      state.trips = [...state.trips.filter((t) => t.id !== saved.id), saved];
      writeJson(LS.trips, state.trips);
      state.snapshots.delete(saved.id);
      dlg.close();
      if (!trip) location.hash = `#/trip/${saved.id}`; else render();
    } catch (err) {
      errs.innerHTML = [err.message, ...(err.details || [])].map((x) => `<li>${h(x)}</li>`).join('');
    } finally { btn.disabled = false; }
  });
}

// ---------------------------------------------------------------- confirm delete

function confirmDelete(id) {
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) return;
  const dlg = $('#dlg-confirm');
  dlg.innerHTML = `<form class="sheet confirm" method="dialog">
    <h2 id="confirm-title">Delete ${h(tripTitle(trip))}?</h2>
    <p>Are you sure? This removes the trip from both phones, along with its saved forecasts. It can’t be undone.</p>
    <p class="errors" data-errors></p>
    <div class="actions"><button class="btn secondary" value="cancel" autofocus>Keep trip</button><button class="btn danger" type="button" data-yes>Delete trip</button></div>
  </form>`;
  dlg.querySelector('[data-yes]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api().remove(id);
    } catch (err) {
      if (err.kind !== 'not-found') { dlg.querySelector('[data-errors]').textContent = err.message; e.target.disabled = false; return; }
    }
    state.trips = state.trips.filter((t) => t.id !== id);
    writeJson(LS.trips, state.trips);
    dlg.close();
    location.hash = '#/';
    render();
  });
  dlg.showModal();
}

// ---------------------------------------------------------------- settings

function openSettings() {
  const s = settings();
  const dlg = $('#dlg-settings');
  dlg.innerHTML = `<form class="sheet" method="dialog">
    <h2 id="settings-title">Settings</h2>
    <label for="key">Setup key <span class="hint">(the shared key; paste it once on each phone)</span></label>
    <textarea id="key" name="key" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste setup key">${h(s.key)}</textarea>
    <p style="margin:-2px 0 14px"><button type="button" class="btn secondary" data-paste>Paste from clipboard</button></p>
    <label>Server address<input name="base" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://trip-countdown-api.example.workers.dev" value="${h(s.base)}"></label>
    <p class="errors" data-msg role="status"></p>
    <div class="actions"><button type="button" class="btn secondary" data-close>Close</button><button class="btn" type="submit">Save and connect</button></div>
    <p class="version">Version ${APP_VERSION}</p>
  </form>`;
  const form = dlg.querySelector('form');
  form.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  form.querySelector('[data-paste]').addEventListener('click', async () => {
    try { form.elements.key.value = (await navigator.clipboard.readText()).trim(); }
    catch { form.querySelector('[data-msg]').textContent = 'This phone didn’t allow pasting from here. Press and hold in the box, then choose Paste.'; }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = form.elements.key.value.trim(), base = form.elements.base.value.trim();
    const msg = form.querySelector('[data-msg]');
    try {
      const trips = await createApi({ key, base }).list();
      localStorage.setItem(LS.key, key);
      localStorage.setItem(LS.base, base);
      state.trips = trips; writeJson(LS.trips, trips); state.error = null; state.synced = true;
      dlg.close(); render();
    } catch (err) { msg.textContent = err.message; }
  });
  dlg.showModal();
}

// ---------------------------------------------------------------- events

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'add') tripForm(null);
  else if (act === 'settings') openSettings();
  else if (act === 'edit') tripForm(state.trips.find((t) => t.id === a.dataset.id));
  else if (act === 'delete') confirmDelete(a.dataset.id);
  else if (act === 'update' && swWaiting) swWaiting.postMessage('skip-waiting');
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync({ quiet: true }); });
setInterval(() => { if (document.visibilityState === 'visible') sync({ quiet: true }); }, 60000);

// Time zone suggestions for the flight fields.
try { $('#tz-list').innerHTML = Intl.supportedValuesOf('timeZone').map((z) => `<option value="${z}">`).join(''); } catch { /* older browsers */ }

// ---------------------------------------------------------------- service worker

let swWaiting = null;
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const watch = (w) => w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { swWaiting = w; banner(); } });
    if (reg.waiting && navigator.serviceWorker.controller) { swWaiting = reg.waiting; banner(); }
    reg.addEventListener('updatefound', () => watch(reg.installing));
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

render();
sync();

