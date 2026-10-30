// Trip countdown: app shell, views and wiring.
import { createApi, ApiError } from './lib/api.js';
import { tripStatus, describeCountdown, countdownTo } from './lib/countdown.js';
import { validateTrip, sortTrips, themeFor, flagEmoji, tripTitle } from './lib/trip.js';
import { todayIn, eachDay, daysBetween, addDays, formatRange, formatDate, deviceTimeZone } from './lib/time.js';
import * as W from './lib/weather.js';
import { decodeTopology, chooseView, renderMap } from './lib/geo.js';
import { historySeries, linePaths } from './lib/chart.js';
import { iosInstallState, hintBannerDue } from './lib/install.js';
import { followTripDates, flightFromForm, flightDateOnTap } from './lib/form.js';
import { skyEvents, searchLink } from './lib/whatson.js';
import { KINDS, KIND_LABELS, CLOUD_BY_DEFAULT, guessKind, cleanEvent, tripEvents, sortEvents, nextEvent, eventStart, eventOver } from './lib/events.js';

export const APP_VERSION = '0.1.6';

// The Worker's address (a Cloudflare custom domain, see worker/wrangler.toml).
const DEFAULT_API_BASE = 'https://trips-api.slightlygood.app';
const HOME_TZ = deviceTimeZone();
const LS = { key: 'tc.key', base: 'tc.base', trips: 'tc.trips', http: 'tc.http.', installHint: 'tc.installHintDismissed' };
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

const weatherKey = (t) => [t.id, t.startDate, t.endDate, t.destination.lat, t.destination.lon,
  ...tripEvents(t).filter((e) => e.cloud).map((e) => `${e.date}T${e.time}`).sort()].join('|');

async function loadWeather(trip) {
  const { lat, lon, timezone } = trip.destination;
  const today = todayIn(timezone);
  const out = { today, days: [], summary: null, sea: null, events: {} }; // events: event id → cloud cover
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

  // Events with cloud odds: cloud cover at that hour.
  for (const ev of tripEvents(trip).filter((e) => e.cloud && e.time && e.date >= today)) {
    jobs.push((async () => {
      try {
        let cloud = null;
        if (W.useEventForecast(ev.date, today)) {
          cloud = W.cloudForecast(W.mergeHourly([await cachedJson(W.cloudForecastUrl(lat, lon), TTL.forecast)]), ev.date, ev.time);
        }
        if (!cloud) {
          const windows = W.cloudWindows(ev.date, today);
          const js = await Promise.all(windows.map((w) => cachedJson(W.cloudArchiveUrl(lat, lon, w.start, w.end), TTL.climate)));
          cloud = W.cloudOdds(W.mergeHourly(js), ev.date, ev.time, windows);
        }
        if (cloud) out.events[ev.id] = cloud;
      } catch { /* no odds for this one */ }
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

function eventCount(trip, ev, now = new Date()) {
  const tz = trip.destination.timezone;
  if (eventOver(ev, tz, now)) return `<span class="big">✓</span><span class="unit">Happened</span><span class="small"></span>`;
  const at = eventStart(ev, tz);
  if (!ev.time && now >= at) return `<span class="big">Today</span><span class="unit"></span><span class="small">All day</span>`;
  return countHtml(countdownTo(at, now), ev.time ? '' : 'until the day starts');
}

function tick() {
  const now = new Date();
  document.querySelectorAll('[data-count]').forEach((el) => {
    const trip = state.trips.find((t) => t.id === el.dataset.count);
    if (!trip) return;
    let html;
    if (el.dataset.kind === 'event') {
      const ev = tripEvents(trip).find((e) => e.id === el.dataset.event);
      if (!ev) return;
      html = eventCount(trip, ev, now);
    } else html = statusCount(trip, now);
    if (el.innerHTML !== html) el.innerHTML = html;
  });
}
setInterval(tick, 1000);

// ---------------------------------------------------------------- views

function bar(html) { $('#bar').innerHTML = html; }

function banner() {
  const s = settings();
  const el = $('#banner');
  const installFirst = iosNeedsInstall();
  if (installFirst && (!s.key || hintBannerDue(localStorage.getItem(LS.installHint)))) {
    el.innerHTML = `<div class="banner install">${!s.key
      ? 'Add Trips to your Home Screen first, then paste the setup key in the Home Screen app. It keeps its own settings, separate from Safari.'
      : 'Add Trips to your Home Screen to keep it handy. It keeps its own settings, so you’ll paste the setup key there once more.'}
      <span class="banner-actions"><button class="btn" data-action="install-help">Show me how</button>${s.key ? '<button class="btn secondary" data-action="install-later">Not now</button>' : ''}</span></div>`;
  } else if (!s.key || !s.base) {
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
  const now = new Date();
  const { next, more } = nextEvent(tripEvents(trip), trip.destination.timezone, now);
  if (!next) return '';
  const at = eventStart(next, trip.destination.timezone);
  const c = countdownTo(at, now);
  const when = now >= at ? 'today' : c.phase === 'days' ? `in ${c.days} ${c.days === 1 ? 'day' : 'days'}` : 'today';
  return `<span>${KIND_EMOJI[next.kind] || '✨'} ${h(next.name)} ${when}${more ? ` · +${more} more` : ''}</span>`;
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
    ${installPrompt ? '<button class="btn secondary" data-action="install">Install</button>' : ''}
    <button class="icon-btn" data-action="settings" aria-label="Settings">${ICONS.gear}</button>
    <button class="icon-btn add" data-action="add" aria-label="Add a trip">${ICONS.plus}</button>`);
  const trips = sortTrips(state.trips, new Date(), HOME_TZ);
  if (!trips.length) {
    const ready = settings().key && settings().base;
    $('#main').innerHTML = `<section class="empty">
      <div class="envelope t-tropical"><div class="card" aria-hidden="true">✈️</div></div>
      <h2>Where to next?</h2>
      <p>${ready ? 'Add a trip and it’ll appear on both phones, with a countdown, a map and the weather.' : 'Once the setup key is in Settings, your shared trips will appear here.'}</p>
      ${ready ? '<button class="btn" data-action="add">Add a trip</button>' : iosNeedsInstall() ? '<button class="btn" data-action="install-help">Show me how to install</button>' : '<button class="btn" data-action="settings">Open Settings</button>'}
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

// Artwork for each kind of event, drawn to sit on the dark event card.
const ART = {
  eclipse: '<defs><radialGradient id="corona"><stop offset="55%" stop-color="#FFE9A8"/><stop offset="100%" stop-color="#FFE9A8" stop-opacity="0"/></radialGradient></defs><circle cx="40" cy="40" r="38" fill="url(#corona)"/><circle cx="40" cy="40" r="21" fill="#FFF7D6"/><circle cx="41.5" cy="39" r="21" fill="#120D33"/>',
  sky: '<mask id="crescent"><rect width="80" height="80" fill="#fff"/><circle cx="48" cy="34" r="21" fill="#000"/></mask><circle cx="36" cy="42" r="24" fill="#FFF7D6" mask="url(#crescent)"/><path d="M62 10l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" fill="#FFE27A"/><circle cx="66" cy="50" r="2.2" fill="#FFE27A"/><circle cx="16" cy="14" r="1.8" fill="#FFE27A"/>',
  concert: '<path d="M30 56V20l32-7v36" fill="none" stroke="#FFE27A" stroke-width="5" stroke-linejoin="round"/><path d="M30 26l32-7" stroke="#FFE27A" stroke-width="9"/><ellipse cx="23" cy="57" rx="9" ry="7" fill="#FFE27A" transform="rotate(-18 23 57)"/><ellipse cx="55" cy="50" rx="9" ry="7" fill="#FFE27A" transform="rotate(-18 55 50)"/>',
  festival: '<g stroke-linecap="round" stroke-width="4"><path d="M40 40l0-26M40 40l18-18M40 40l26 0M40 40l18 18M40 40l0 26M40 40l-18 18M40 40l-26 0M40 40l-18-18" stroke="#FFE27A" stroke-dasharray="3 6"/></g><circle cx="40" cy="10" r="3.5" fill="#FF8FB1"/><circle cx="61" cy="19" r="3.5" fill="#8FD3FF"/><circle cx="70" cy="40" r="3.5" fill="#FF8FB1"/><circle cx="61" cy="61" r="3.5" fill="#8FD3FF"/><circle cx="40" cy="70" r="3.5" fill="#FF8FB1"/><circle cx="19" cy="61" r="3.5" fill="#8FD3FF"/><circle cx="10" cy="40" r="3.5" fill="#FF8FB1"/><circle cx="19" cy="19" r="3.5" fill="#8FD3FF"/><circle cx="40" cy="40" r="5" fill="#FFF7D6"/>',
  sport: '<circle cx="40" cy="40" r="28" fill="#FFF7D6"/><path d="M40 29l10.5 7.6-4 12.4H33.5l-4-12.4z" fill="#120D33"/><path d="M40 29V12M50.5 36.6l15-5M46.5 49l9 13M33.5 49l-9 13M29.5 36.6l-15-5" stroke="#120D33" stroke-width="3"/>',
  theatre: '<path d="M12 26h56v8a6 6 0 0 0 0 12v8H12v-8a6 6 0 0 0 0-12z" fill="#FFE27A" transform="rotate(-10 40 40)"/><path d="M52 23v34" stroke="#120D33" stroke-width="2.5" stroke-dasharray="4 4" transform="rotate(-10 40 40)"/><path d="M28 34l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#120D33" transform="rotate(-10 40 40)"/>',
  food: '<path d="M24 12h32c0 18-6 28-16 28S24 30 24 12z" fill="#FF8FB1"/><path d="M26 22h28" stroke="#FFF7D6" stroke-width="2.5" opacity=".7"/><path d="M40 40v22M28 66h24" stroke="#FFF7D6" stroke-width="4.5" stroke-linecap="round"/>',
  holiday: '<path d="M6 20q34 22 68 0" fill="none" stroke="#FFF7D6" stroke-width="2.5"/><path d="M12 24l6 20 7-17z" fill="#FF8FB1"/><path d="M29 30l5 20 8-19z" fill="#FFE27A"/><path d="M46 31l4 19 8-20z" fill="#8FD3FF"/><path d="M62 27l3 18 7-21z" fill="#FF8FB1"/>',
  other: '<path d="M40 6l7 25 25 9-25 9-7 25-7-25-25-9 25-9z" fill="#FFE27A"/>',
};
const KIND_EMOJI = { eclipse: '🌑', sky: '🌙', concert: '🎵', festival: '🎆', sport: '⚽', theatre: '🎭', food: '🍷', holiday: '🎉', other: '✨' };

function orb(kind, cls = 'orb') {
  return `<svg class="${cls}" viewBox="0 0 80 80" aria-hidden="true">${ART[kind] || ART.other}</svg>`;
}

function donut(pct) {
  const r = 26, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="8"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="#FFE27A" stroke-width="8" stroke-linecap="round" stroke-dasharray="${((pct / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/></svg>`;
}

function eventOdds(ev, w) {
  if (!ev.cloud || !ev.time) return '';
  const cloud = w.data?.events?.[ev.id];
  if (w.status === 'loading') return '<div class="odds">Checking the sky…</div>';
  if (cloud?.source === 'history') {
    return `<div class="odds">${donut(cloud.clearPct)}<div><b>${cloud.clearPct}% chance of clear sky</b><br>
      At ${h(W.eventHour(ev.time))} on these dates over the last ${W.CLIMATE_YEARS} years, cloud averaged ${cloud.meanCover}%. The forecast takes over ${W.EVENT_FORECAST_DAYS} days before.</div></div>`;
  }
  if (cloud?.source === 'forecast') {
    const layers = [['low', cloud.low], ['mid', cloud.mid], ['high', cloud.high]].filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}%`).join(', ');
    return `<div class="odds">${donut(100 - cloud.cover)}<div><b>Forecast: ${cloud.cover}% cloud</b><br>At ${h(W.eventHour(ev.time))}${layers ? `, ${h(layers)}` : ''}.</div></div>`;
  }
  return '';
}

function eventSlide(trip, ev, w, now) {
  const tz = trip.destination.timezone;
  const over = eventOver(ev, tz, now);
  const when = `${formatDate(ev.date, { withWeekday: true, withYear: true })}${ev.time ? ` at ${ev.time} ${tzCity(tz)} time` : ', all day'}`;
  return `<div class="event slide${over ? ' over' : ''}" role="group" aria-roledescription="event" aria-label="${h(ev.name)}">${orb(ev.kind)}
    <h4>${h(ev.name)}</h4>
    <p class="when">${h(when)}${ev.venue ? `<br>${h(ev.venue)}` : ''}</p>
    <div class="count" data-count="${h(trip.id)}" data-kind="event" data-event="${h(ev.id)}">${eventCount(trip, ev, now)}</div>
    ${over ? '' : eventOdds(ev, w)}
    <div class="slide-actions">${ev.url ? `<a class="text-btn light" href="${h(ev.url)}" target="_blank" rel="noopener">${ev.source === 'ticketmaster' ? 'Tickets on Ticketmaster' : 'More details'}</a>` : ''}
      <button class="text-btn light" data-action="edit-event" data-id="${h(trip.id)}" data-event="${h(ev.id)}">Edit</button></div>
  </div>`;
}

function eventSection(trip) {
  const now = new Date();
  const events = sortEvents(tripEvents(trip), trip.destination.timezone, now);
  const add = `<span class="head-actions"><button class="btn secondary small" data-action="whats-on" data-id="${h(trip.id)}">What’s on</button><button class="btn secondary small" data-action="add-event" data-id="${h(trip.id)}" aria-label="Add event">${ICONS.plus}<span class="wide-only">Add</span></button></span>`;
  if (!events.length) {
    return `<section class="section"><div class="section-head"><h3>Events</h3>${add}</div>
      <p class="lede">Count down to something during the trip, like a concert, a fiesta or an eclipse. “What’s on” finds holidays, sky events and listings for these dates.</p></section>`;
  }
  const w = weatherFor(trip);
  const dots = events.length > 1
    ? `<div class="dots" role="tablist">${events.map((ev, i) => `<button role="tab" aria-label="${h(ev.name)}" aria-selected="${i === 0}" data-dot="${i}"></button>`).join('')}</div>` : '';
  return `<section class="section"><div class="section-head"><h3>${events.length === 1 ? 'Event' : `Events <span class="hint">(${events.length})</span>`}</h3>${add}</div>
    <div class="carousel" data-carousel tabindex="0" aria-label="Events, swipe for more">${events.map((ev) => eventSlide(trip, ev, w, now)).join('')}</div>
    ${dots}</section>`;
}

// Keep the dots in step with the swipe, and let a dot jump to its slide.
function wireCarousels(root = document) {
  root.querySelectorAll('[data-carousel]').forEach((track) => {
    const dots = track.parentElement.querySelectorAll('[data-dot]');
    if (!dots.length) return;
    const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const sync = () => { const i = current(); dots.forEach((d, j) => d.setAttribute('aria-selected', String(i === j))); };
    track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
    dots.forEach((d) => d.addEventListener('click', () => track.scrollTo({ left: +d.dataset.dot * track.clientWidth, behavior: 'smooth' })));
  });
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
  const keepScroll = $('#main [data-carousel]')?.scrollLeft || 0;
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
  const track = $('#main [data-carousel]');
  if (track) { track.scrollLeft = keepScroll; wireCarousels($('#main')); track.dispatchEvent(new Event('scroll')); }
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
  const t = trip || { startDate: '', endDate: '', outbound: null, return: null, name: '' };
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
    <fieldset><legend>Flights <span class="hint">(optional; a flight needs a time)</span></legend>
      ${flightFields('outbound', 'Flight out departs', t.outbound, HOME_TZ)}
      ${flightFields('return', 'Flight home departs', t.return, t.destination?.timezone || '')}
    </fieldset>
    ${trip ? '' : '<p class="hint-text">You can add events, like a concert or an eclipse, once the trip is saved.</p>'}
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
  // Flight dates fill in when tapped, then follow the trip dates (lib/form.js).
  let prev = { start: start.value, end: end.value };
  const follow = () => {
    const f = form.elements;
    const r = followTripDates({
      startDate: start.value, endDate: end.value,
      outboundDate: f.outboundDate.value, returnDate: f.returnDate.value,
    }, prev);
    for (const [k, v] of Object.entries(r.values)) f[k].value = v;
    for (const [k, lim] of Object.entries(r.limits)) Object.assign(f[k], lim);
    prev = { start: start.value, end: end.value };
  };
  start.addEventListener('change', follow);
  end.addEventListener('change', follow);
  follow();
  // Tapping a flight's date or time starts its date from the trip, before the picker opens.
  for (const [key, field] of [['outbound', 'outboundDate'], ['return', 'returnDate']]) {
    const fill = () => {
      const d = flightDateOnTap(field, { startDate: start.value, endDate: end.value, [field]: form.elements[field].value });
      if (d) form.elements[field].value = d;
    };
    for (const name of [`${key}Date`, `${key}Time`]) {
      form.elements[name].addEventListener('pointerdown', fill);
      form.elements[name].addEventListener('focus', fill);
    }
  }
  form.querySelector('[data-close]').addEventListener('click', () => dlg.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const flight = (k) => flightFromForm(f[`${k}Date`].value, f[`${k}Time`].value, f[`${k}Tz`].value);
    const input = {
      name: f.name.value,
      destination: chosenPlace || {},
      startDate: start.value, endDate: end.value,
      outbound: flight('outbound'), return: flight('return'),
      events: trip ? tripEvents(trip) : [],
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

// ---------------------------------------------------------------- event form

async function saveEvents(trip, events) {
  const v = validateTrip({ ...trip, event: undefined, events });
  if (!v.ok) throw Object.assign(new Error('Some details need fixing'), { details: v.errors });
  const saved = await api().update(trip.id, v.trip);
  state.trips = [...state.trips.filter((t) => t.id !== saved.id), saved];
  writeJson(LS.trips, state.trips);
  return saved;
}

function eventForm(trip, ev) {
  const dlg = $('#dlg-event');
  const e = ev || { name: '', date: trip.startDate, time: '', kind: '', cloud: null };
  let kind = ev?.kind || '';      // '' means follow the name
  let cloudTouched = !!ev;
  dlg.innerHTML = `<form class="sheet" method="dialog" novalidate>
    <h2 id="event-title">${ev ? 'Edit event' : 'New event'}</h2>
    <label>What is it<input name="name" maxlength="80" placeholder="Total solar eclipse" value="${h(e.name)}" autocomplete="off"></label>
    <div class="row"><label>Date<input type="date" name="date" value="${h(e.date)}" min="${h(trip.startDate)}" max="${h(trip.endDate)}"></label>
    <label>Local time <span class="hint">(optional)</span><input type="time" name="time" value="${h(e.time)}"></label></div>
    <p class="hint-text">The time is local to ${h(trip.destination.name)}. Leave it empty for something that lasts all day.</p>
    <fieldset class="kinds"><legend>Picture</legend>
      <div class="kind-grid">${KINDS.map((k) => `<label class="kind" title="${h(KIND_LABELS[k])}"><input type="radio" name="kind" value="${k}">${orb(k, 'kind-art')}<span>${h(KIND_LABELS[k])}</span></label>`).join('')}</div>
    </fieldset>
    <label class="toggle"><input type="checkbox" name="cloud"> Show the chance of a clear sky</label>
    <p class="hint-text" data-cloud-hint></p>
    <ul class="errors" data-errors></ul>
    <div class="actions">${ev ? '<button type="button" class="text-btn danger" data-remove>Delete</button>' : ''}<button type="button" class="btn secondary" data-close>Cancel</button><button class="btn" type="submit">${ev ? 'Save' : 'Add event'}</button></div>
  </form>`;
  const form = dlg.querySelector('form');
  const f = form.elements;
  const showKind = () => { const k = kind || guessKind(f.name.value); form.querySelectorAll('[name=kind]').forEach((r) => { r.checked = r.value === k; }); return k; };
  const showCloud = () => {
    const k = showKind();
    const timed = !!f.time.value;
    f.cloud.disabled = !timed;
    if (!timed) f.cloud.checked = false;
    else if (!cloudTouched) f.cloud.checked = CLOUD_BY_DEFAULT.has(k);
    form.querySelector('[data-cloud-hint]').textContent = timed ? 'From past years at that hour, then the forecast in the final fortnight.' : 'Needs a time.';
  };
  if (ev) f.cloud.checked = !!ev.cloud;
  showCloud();
  f.name.addEventListener('input', showCloud);
  f.time.addEventListener('input', showCloud);
  form.querySelectorAll('[name=kind]').forEach((r) => r.addEventListener('change', () => { kind = r.value; showCloud(); }));
  f.cloud.addEventListener('change', () => { cloudTouched = true; });
  form.querySelector('[data-close]').addEventListener('click', () => dlg.close());

  const errs = form.querySelector('[data-errors]');
  const run = async (btn, events) => {
    btn.disabled = true;
    try { await saveEvents(trip, events); dlg.close(); render(); }
    catch (err) { errs.innerHTML = [err.message, ...(err.details || [])].map((x) => `<li>${h(x)}</li>`).join(''); }
    finally { btn.disabled = false; }
  };
  form.querySelector('[data-remove]')?.addEventListener('click', (x) => {
    if (!confirm(`Delete ${ev.name}? This removes it from both phones.`)) return;
    run(x.target, tripEvents(trip).filter((o) => o.id !== ev.id));
  });
  form.addEventListener('submit', (x) => {
    x.preventDefault();
    const input = { ...(ev || {}), name: f.name.value, date: f.date.value, time: f.time.value, kind: showKind(), cloud: f.cloud.checked };
    const r = cleanEvent(input);
    if (r.errors.length) { errs.innerHTML = r.errors.map((m) => `<li>${h(m.replace(/^Event 1/, 'The event'))}</li>`).join(''); return; }
    const list = tripEvents(trip);
    run(form.querySelector('[type=submit]'), ev ? list.map((o) => (o.id === ev.id ? r.event : o)) : [...list, r.event]);
  });
  dlg.showModal();
}

// ---------------------------------------------------------------- what's on

const whatsOnCache = new Map(); // trip place + dates → server answer

/** Has this suggestion already been added to the trip? */
function alreadyAdded(trip, s) {
  return tripEvents(trip).some((e) => (s.ref && e.ref === s.ref) || (e.date === s.date && e.name.toLowerCase() === s.name.toLowerCase()));
}

function suggestionRow(trip, s, i, detail) {
  const added = alreadyAdded(trip, s);
  const when = `${formatDate(s.date, { withWeekday: true })}${s.time ? `, ${s.time}` : ''}`;
  return `<li class="suggestion">${orb(s.kind, 'kind-art')}
    <div><b>${h(s.name)}</b><br><small>${h(when)}${detail ? ` · ${h(detail)}` : ''}</small>${s.url ? `<br><a href="${h(s.url)}" target="_blank" rel="noopener">Details</a>` : ''}</div>
    <button type="button" class="btn small${added ? ' secondary' : ''}" data-suggest="${i}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button></li>`;
}

function openWhatsOn(tripId) {
  const dlg = $('#dlg-whats-on');
  const d = () => state.trips.find((t) => t.id === tripId);
  const trip = d();
  if (!trip) return;
  const place = trip.destination;
  const cacheKey = [place.lat, place.lon, place.countryCode, trip.startDate, trip.endDate].join('|');
  const sky = skyEvents({ start: trip.startDate, end: trip.endDate, lat: place.lat, tz: place.timezone }).map((x) => ({ ...x, source: 'sky' }));
  let suggestions = [];

  const draw = (server, loading) => {
    const t = d() || trip;
    suggestions = [];
    const group = (title, items, detail, empty) => {
      if (!items) return '';
      const rows = items.map((s) => { suggestions.push(s); return suggestionRow(t, s, suggestions.length - 1, detail(s)); }).join('');
      return `<h3>${h(title)}</h3>${rows ? `<ul class="suggestions">${rows}</ul>` : `<p class="hint-text">${h(empty)}</p>`}`;
    };
    const holidays = server?.holidays?.map((x) => ({ name: x.name, date: x.date, time: '', kind: 'holiday', source: 'holiday', regional: x.regional, localName: x.localName, regions: x.regions }));
    const tm = server?.ticketmaster;
    dlg.innerHTML = `<form class="sheet" method="dialog">
      <h2 id="whats-on-title">What’s on in ${h(place.name)}</h2>
      <p class="hint-text">${h(formatRange(t.startDate, t.endDate))}. Tap Add to put something in the trip’s events, on both phones.</p>
      ${loading ? '<p class="hint-text">Looking for holidays and listings…</p>' : ''}
      ${server?.failed ? '<p class="hint-text">Holidays and listings couldn’t be loaded. Check you’re online and try again.</p>' : ''}
      ${group('Public holidays', holidays, (x) => [x.localName, x.regional ? `regional${x.regions.length ? ` (${x.regions.map((r) => r.split('-').pop()).join(', ')})` : ''}, may not apply here` : ''].filter(Boolean).join(' · '), 'No public holidays on these dates.')}
      ${group('In the sky', sky, (x) => x.note, 'No full moon or meteor shower peak on these dates.')}
      ${tm?.enabled ? group('Ticketmaster', tm.events, (x) => x.venue, tm.error || 'Nothing listed within 30 km yet. Big events are often announced a few months ahead.') : ''}
      ${tm && !tm.enabled ? '<p class="hint-text spaced">Ticketmaster listings will appear here once its key is added to the server.</p>' : ''}
      <h3>Anything else</h3>
      <p class="hint-text">Local fiestas and smaller events often aren’t listed anywhere central. <a href="${h(searchLink(place.name, t.startDate, t.endDate, formatRange))}" target="_blank" rel="noopener">Search the web for what’s on</a>, then add anything you find with Add event.</p>
      ${tm?.enabled && tm.events?.length ? '<p class="attribution">Event listings from Ticketmaster.</p>' : ''}
      <div class="actions"><button class="btn">Done</button></div>
    </form>`;
  };

  dlg.onclick = async (e) => {
    const b = e.target.closest('[data-suggest]');
    if (!b) return;
    const s = suggestions[+b.dataset.suggest];
    const t = d();
    if (!s || !t || alreadyAdded(t, s)) return;
    b.disabled = true; b.textContent = 'Adding…';
    const r = cleanEvent({ name: s.name, date: s.date, time: s.time, kind: s.kind, source: s.source, url: s.url, venue: s.venue, ref: s.ref });
    try { await saveEvents(t, [...tripEvents(t), r.event]); render(); draw(whatsOnCache.get(cacheKey)); }
    catch (err) { b.disabled = false; b.textContent = 'Try again'; toastMsg(err.message); }
  };

  const hit = whatsOnCache.get(cacheKey);
  draw(hit, !hit);
  dlg.showModal();
  if (hit) return;
  api().whatsOn({ lat: place.lat, lon: place.lon, cc: place.countryCode, start: trip.startDate, end: trip.endDate })
    .then((r) => { whatsOnCache.set(cacheKey, r); return r; })
    .catch(() => ({ failed: true }))
    .then((r) => { if (dlg.open) draw(r); });
}

function toastMsg(text) {
  const el = $('#dlg-whats-on [data-toast]') || $('#dlg-whats-on form');
  el?.insertAdjacentHTML('afterbegin', `<p class="errors" role="status">${h(text)}</p>`);
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
    <details class="advanced"${s.base && s.base !== DEFAULT_API_BASE ? ' open' : ''}><summary>Server address</summary>
      <label><span class="sr-only">Server address</span><input name="base" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="${h(DEFAULT_API_BASE)}" value="${h(s.base)}"></label></details>
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
  else if (act === 'whats-on') openWhatsOn(a.dataset.id);
  else if (act === 'add-event' || act === 'edit-event') {
    const trip = state.trips.find((t) => t.id === a.dataset.id);
    if (trip) eventForm(trip, act === 'edit-event' ? tripEvents(trip).find((e) => e.id === a.dataset.event) : null);
  }
  else if (act === 'update' && swWaiting) swWaiting.postMessage('skip-waiting');
  else if (act === 'install-help') openInstallHelp();
  else if (act === 'install-later') { localStorage.setItem(LS.installHint, String(Date.now())); banner(); }
  else if (act === 'install' && installPrompt) { const p = installPrompt; installPrompt = null; p.prompt(); p.userChoice.finally(render); }
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync({ quiet: true }); });
setInterval(() => { if (document.visibilityState === 'visible') sync({ quiet: true }); }, 60000);

// Time zone suggestions for the flight fields.
try { $('#tz-list').innerHTML = Intl.supportedValuesOf('timeZone').map((z) => `<option value="${z}">`).join(''); } catch { /* older browsers */ }

// ---------------------------------------------------------------- installing

function iosNeedsInstall() {
  return iosInstallState({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: navigator.standalone,
    displayModeStandalone: matchMedia('(display-mode: standalone)').matches,
  }) === 'needs-install';
}

const SHARE_ICON = '<svg class="share-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

function openInstallHelp() {
  const dlg = $('#dlg-install');
  dlg.innerHTML = `<form class="sheet" method="dialog">
    <h2 id="install-title">Install on your iPhone</h2>
    <ol class="install-steps">
      <li><span class="n">1</span><span>Tap the <b>Share</b> button ${SHARE_ICON} at the bottom of Safari. Can’t see it? Tap <b>⋯</b> or the <b>three lines (≡)</b> in the address bar, then <b>Share</b>.</span></li>
      <li><span class="n">2</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
      <li><span class="n">3</span><span>Tap <b>Add</b>, then open <b>Trips</b> from your Home Screen.</span></li>
      <li><span class="n">4</span><span>In the Home Screen app, tap Settings ${ICONS.gear.replace('<svg', '<svg class="share-icon" width="18" height="18" aria-hidden="true"')} and paste the setup key.</span></li>
    </ol>
    <p class="hint-text">Use the Home Screen app from then on. It keeps its own settings, separate from Safari, and the iPhone won’t clear them the way it can clear websites you haven’t visited for a while.</p>
    <p class="hint-text">No Share button? The link may have opened inside another app. Open it in Safari first.</p>
    <div class="actions"><button class="btn">Got it</button></div>
  </form>`;
  dlg.showModal();
}

// Android and desktop Chrome offer their own install prompt.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; render(); });

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

