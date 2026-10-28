import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/lib/weather.js';
import { eachDay, addDays } from '../src/lib/time.js';
import { dailyJson, hourlyJson } from './helpers/fixtures.js';

const params = (url) => Object.fromEntries(new URL(url).searchParams);

describe('request URLs', () => {
  test('forecast asks for 16 days of daily values in local time, wind in mph', () => {
    const p = params(W.forecastUrl(36.757812345, -3.874612345));
    assert.equal(p.latitude, '36.7578');
    assert.equal(p.longitude, '-3.8746');
    assert.equal(p.forecast_days, '16');
    assert.equal(p.timezone, 'auto');
    assert.equal(p.wind_speed_unit, 'mph');
    for (const v of ['temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max', 'wind_speed_10m_max', 'uv_index_max', 'weather_code']) assert.ok(p.daily.includes(v), v);
  });

  test('archive, marine, seasonal and cloud requests', () => {
    assert.equal(new URL(W.archiveUrl(1, 2, '2025-07-24', '2025-08-09')).host, 'archive-api.open-meteo.com');
    assert.equal(params(W.archiveUrl(1, 2, '2025-07-24', '2025-08-09')).start_date, '2025-07-24');
    assert.equal(params(W.marineUrl(1, 2)).forecast_days, String(W.MARINE_FORECAST_DAYS));
    assert.equal(params(W.marineUrl(1, 2, { start: '2025-07-27', end: '2025-08-06' })).forecast_days, undefined);
    assert.equal(params(W.marineUrl(1, 2)).hourly, 'sea_surface_temperature');
    assert.equal(new URL(W.seasonalUrl(1, 2)).host, 'seasonal-api.open-meteo.com');
    assert.equal(params(W.cloudArchiveUrl(1, 2, '2025-07-26', '2025-08-09')).hourly, 'cloud_cover');
    assert.ok(params(W.cloudForecastUrl(1, 2)).hourly.includes('cloud_cover_low'));
    assert.equal(params(W.geocodeUrl('Nerja')).name, 'Nerja');
  });
});

test('geocoding results become destinations', () => {
  const out = W.parseGeocode({ results: [{ name: 'Nerja', latitude: 36.75, longitude: -3.87, country: 'Spain', country_code: 'es', admin1: 'Andalusia', timezone: 'Europe/Madrid' }] });
  assert.deepEqual(out, [{ name: 'Nerja', admin1: 'Andalusia', country: 'Spain', countryCode: 'ES', lat: 36.75, lon: -3.87, timezone: 'Europe/Madrid' }]);
  assert.deepEqual(W.parseGeocode({}), []);
});

test('daily responses parse, converting sunshine seconds to hours and skipping empty days', () => {
  const j = dailyJson(['2027-07-27', '2027-07-28'], (d, i) => (i === 0
    ? { temperature_2m_max: 31.2, temperature_2m_min: 21, precipitation_sum: 0, precipitation_probability_max: 5, wind_speed_10m_max: 12, uv_index_max: 9.1, sunshine_duration: 43200, weather_code: 0 }
    : {}));
  const m = W.parseDaily(j);
  assert.equal(m.size, 1);
  assert.deepEqual(m.get('2027-07-27'), { tmax: 31.2, tmin: 21, precip: 0, rainChance: 5, wind: 12, uv: 9.1, sunHours: 12, code: 0 });
  assert.equal(W.parseDaily({}).size, 0);
});

describe('averages for far-off trips', () => {
  test('one archive window per past year, padded, and only once fully archived', () => {
    const w = W.climateWindows('2027-07-27', '2027-08-06', '2026-10-27');
    assert.equal(w.length, W.CLIMATE_YEARS);
    assert.deepEqual(w[0], { start: '2026-07-24', end: '2026-08-09', years: 1 });
    assert.deepEqual(w[9], { start: '2017-07-24', end: '2017-08-09', years: 10 });
    // A trip next month: last year's window is complete, so it's used.
    assert.equal(W.climateWindows('2026-11-20', '2026-11-25', '2026-10-27')[0].years, 1);
    // A trip more than a year away: last year's dates haven't happened yet, so they're skipped.
    const far = W.climateWindows('2027-11-01', '2027-11-03', '2026-10-27');
    assert.equal(far[0].years, 2);
    assert.equal(far.length, W.CLIMATE_YEARS);
  });

  test('averages each date across years and nearby days', () => {
    const windows = W.climateWindows('2027-07-27', '2027-07-28', '2026-10-27', { years: 2, pad: 1 });
    const dates = windows.flatMap((w) => eachDay(w.start, w.end));
    const archive = W.mergeDaily([dailyJson(dates, (d) => ({
      temperature_2m_max: d.startsWith('2026') ? 30 : 32,
      temperature_2m_min: 20,
      precipitation_sum: d.endsWith('-27') ? 4 : 0,
      wind_speed_10m_max: 10,
      sunshine_duration: 36000,
    }))]);
    const avg = W.climateAverages(archive, ['2027-07-27'], windows, 1);
    const day = avg.get('2027-07-27');
    assert.equal(day.samples, 6);         // 2 years × 3 days
    assert.equal(day.tmax, 31);
    assert.equal(day.tmin, 20);
    assert.equal(day.rainChance, 33);     // 2 wet days out of 6
    assert.equal(day.sunHours, 10);
  });
});

describe('which source each day uses', () => {
  const today = '2027-07-20';
  const forecast = new Map(eachDay(today, addDays(today, 15)).map((d) => [d, { tmax: 30, tmin: 20, rainChance: 0, code: 1 }]));
  const climate = new Map(eachDay('2027-07-27', '2027-08-06').map((d) => [d, { tmax: 29, tmin: 19, rainChance: 3, sunHours: 11 }]));

  test('forecast where it reaches, averages beyond: a partial handover', () => {
    const days = W.planDays({ start: '2027-07-27', end: '2027-08-06', today, forecast, climate });
    const src = days.map((d) => d.source);
    assert.equal(src.length, 11);
    assert.deepEqual(src.slice(0, 9), Array(9).fill('forecast')); // 27 Jul – 4 Aug is 7–15 days out
    assert.deepEqual(src.slice(9), ['average', 'average']);       // 16 and 17 days out
  });

  test('averages become an outlook when the seasonal model covers the month', () => {
    const seasonal = W.parseSeasonal({ monthly: { time: ['2027-07-01', '2027-08-01'], temperature_2m_anomaly: [1.4, -0.8], precipitation_anomaly: [0, 0] } });
    const days = W.planDays({ start: '2027-07-27', end: '2027-08-06', today: '2027-01-10', climate, seasonal });
    assert.equal(days[0].source, 'outlook');
    assert.equal(days[0].outlook.trend, 'warmer');
    assert.equal(days.at(-1).outlook.trend, 'cooler');
    assert.equal(days[0].tmax, 29, 'the outlook sits on top of the averages');
  });

  test('days with nothing yet say so', () => {
    const days = W.planDays({ start: '2027-07-27', end: '2027-07-27', today: '2026-10-27' });
    assert.equal(days[0].source, 'none');
  });

  test('a summary for the whole stay', () => {
    const s = W.summarise(W.planDays({ start: '2027-07-27', end: '2027-08-06', today, forecast, climate }));
    assert.ok(s.tmax > 29 && s.tmax < 30);
    assert.deepEqual(s.sources.sort(), ['average', 'forecast']);
    assert.equal(W.summarise([]), null);
  });
});

test('seasonal parsing tolerates model-suffixed keys and missing data', () => {
  const m = W.parseSeasonal({ monthly: { time: ['2027-07-01'], temperature_2m_anomaly_ecmwf_seas5: [0.2] } });
  assert.deepEqual(m.get('2027-07'), { temp: 0.2, precip: null });
  assert.equal(W.parseSeasonal({ monthly: { time: ['2027-07-01'], temperature_2m_mean: [25] } }).size, 0);
  assert.equal(W.parseSeasonal(null).size, 0);
  assert.equal(W.outlookWords({ temp: 0.2 }).trend, 'usual');
  assert.equal(W.outlookWords(null), null);
});

test('weather icons', () => {
  assert.equal(W.wmoIcon(0).label, 'Clear');
  assert.equal(W.wmoIcon(95).label, 'Thunderstorms');
  assert.equal(W.wmoIcon(1234).icon, '🌡️');
  assert.equal(W.climateIcon({ tmax: 30, rainChance: 2, sunHours: 11 }).label, 'Usually sunny');
  assert.equal(W.climateIcon({ tmax: 8, rainChance: 60, sunHours: 2 }).label, 'Often wet');
  assert.equal(W.climateIcon({ tmax: -2, rainChance: 50, sunHours: 2 }).label, 'Often snowy');
  assert.equal(W.dayIcon({ source: 'forecast', code: 3 }).label, 'Cloudy');
});

describe('sea temperature', () => {
  const hours = (date, temps) => temps.map((_, i) => `${date}T${String(i * 6).padStart(2, '0')}:00`);
  const marine = (date, temps) => hourlyJson(hours(date, temps), { sea_surface_temperature: (_, i) => temps[i] });

  test('hourly readings average into a daily value', () => {
    const m = W.parseMarineDaily(marine('2027-07-27', [22, 23, 24, null]));
    assert.equal(m.get('2027-07-27'), 23);
  });

  test('forecast when the trip is close, otherwise typical for the dates', () => {
    const f = new Map([['2027-07-27', 23.4]]);
    assert.deepEqual(W.seaSummary({ days: ['2027-07-27', '2027-07-28'], forecast: f }), { source: 'forecast', temp: 23.4, days: 1 });
    const windows = W.marineHistoryWindows('2027-07-27', '2027-07-28', '2026-10-27');
    assert.deepEqual(windows.map((w) => w.years), [1, 2, 3]);
    const history = new Map([['2026-07-27', 22], ['2025-07-27', 24], ['2024-07-28', 23]]);
    assert.deepEqual(W.seaSummary({ days: ['2027-07-27', '2027-07-28'], history, windows }), { source: 'typical', temp: 23, samples: 3 });
    assert.equal(W.seaSummary({ days: ['2027-07-27'] }), null);
  });

  test('history stops at the start of the marine archive', () => {
    const w = W.marineHistoryWindows('2024-03-01', '2024-03-05', '2024-01-10');
    assert.deepEqual(w.map((x) => x.years), [1, 2]); // 2023 and 2022; 2021 is before the archive
    assert.equal(W.marineHistoryWindows('2022-12-01', '2022-12-02', '2022-06-01').length, 0);
  });
});

describe('special event cloud cover', () => {
  test('event time rounds to the nearest hour', () => {
    assert.equal(W.eventHour('10:48'), '11:00');
    assert.equal(W.eventHour('10:29'), '10:00');
    assert.equal(W.eventHour('23:45'), '23:00');
  });

  test('historical odds of a clear sky at that hour', () => {
    const windows = W.cloudWindows('2027-08-02', '2026-10-27', { years: 2, pad: 1 });
    assert.equal(windows.length, 2);
    const times = windows.flatMap((w) => eachDay(w.start, w.end)).flatMap((d) => [`${d}T10:00`, `${d}T11:00`]);
    // Clear at 11:00 except on 2 Aug each year; 10:00 always overcast, and must be ignored.
    const hourly = W.mergeHourly([hourlyJson(times, { cloud_cover: (t) => (t.endsWith('T10:00') ? 100 : t.includes('-08-02') ? 80 : 0) })]);
    const odds = W.cloudOdds(hourly, '2027-08-02', '10:48', windows, 1);
    assert.equal(odds.samples, 6);
    assert.equal(odds.clearPct, 67);
    assert.equal(odds.meanCover, 27);
    assert.equal(W.cloudOdds(new Map(), '2027-08-02', '10:48', windows, 1), null);
  });

  test('forecast in the final fortnight', () => {
    assert.ok(!W.useEventForecast('2027-08-02', '2027-07-19')); // 14 days out
    assert.ok(W.useEventForecast('2027-08-02', '2027-07-20'));  // 13 days out
    assert.ok(W.useEventForecast('2027-08-02', '2027-08-02'));
    assert.ok(!W.useEventForecast('2027-08-02', '2027-08-03'));
    const hourly = W.mergeHourly([hourlyJson(['2027-08-02T11:00'], { cloud_cover: () => 12, cloud_cover_low: () => 0, cloud_cover_mid: () => 2, cloud_cover_high: () => 10 })]);
    assert.deepEqual(W.cloudForecast(hourly, '2027-08-02', '10:48'), { source: 'forecast', cover: 12, low: 0, mid: 2, high: 10 });
    assert.equal(W.cloudForecast(hourly, '2027-08-03', '10:48'), null);
  });
});
