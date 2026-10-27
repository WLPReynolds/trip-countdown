// Sample trips and Open-Meteo-shaped responses used across tests.
export const nerja = () => ({
  name: '',
  destination: { name: 'Nerja', admin1: 'Andalusia', country: 'Spain', countryCode: 'ES', lat: 36.7578, lon: -3.8746, timezone: 'Europe/Madrid' },
  startDate: '2027-07-27',
  endDate: '2027-08-06',
  outbound: { date: '2027-07-27', time: '06:10', tz: 'Europe/London' },
  return: { date: '2027-08-06', time: '19:45', tz: 'Europe/Madrid' },
  event: { name: 'Total solar eclipse', date: '2027-08-02', time: '10:48' },
});

export const fuengirola = () => ({
  name: '',
  destination: { name: 'Fuengirola', admin1: 'Andalusia', country: 'Spain', countryCode: 'ES', lat: 36.5398, lon: -4.6247, timezone: 'Europe/Madrid' },
  startDate: '2027-06-11',
  endDate: '2027-06-18',
  outbound: null,
  return: null,
  event: null,
});

/** A daily block in Open-Meteo's shape, one row per date with values from fn(date, i). */
export function dailyJson(dates, fn) {
  const keys = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max', 'uv_index_max', 'sunshine_duration', 'weather_code'];
  const daily = { time: dates };
  for (const k of keys) daily[k] = [];
  dates.forEach((d, i) => { const r = fn(d, i); for (const k of keys) daily[k].push(r[k] ?? null); });
  return { latitude: 36.75, longitude: -3.875, timezone: 'Europe/Madrid', daily };
}

export function hourlyJson(times, fields) {
  const hourly = { time: times };
  for (const [k, fn] of Object.entries(fields)) hourly[k] = times.map(fn);
  return { hourly };
}
