// Forecast history: how the forecast for the trip changed, one point per daily snapshot.

/**
 * Snapshot rows ({ takenOn, targetDate, tmax, tmin, rainChance }) → one point per takenOn
 * with the average across trip days forecast that day. Sorted by date.
 */
export function historySeries(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.takenOn)) by.set(r.takenOn, []);
    by.get(r.takenOn).push(r);
  }
  const avg = (xs, k) => {
    const v = xs.map((x) => x[k]).filter((x) => typeof x === 'number');
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([takenOn, xs]) => ({ takenOn, days: xs.length, tmax: avg(xs, 'tmax'), tmin: avg(xs, 'tmin'), rainChance: avg(xs, 'rainChance') }));
}

/** Scale points into a width × height box. Returns { lines: { key: 'M…' }, min, max }. */
export function linePaths(points, keys, width, height, pad = 6) {
  const vals = points.flatMap((p) => keys.map((k) => p[k])).filter((v) => typeof v === 'number');
  if (points.length < 2 || !vals.length) return null;
  let min = Math.floor(Math.min(...vals)), max = Math.ceil(Math.max(...vals));
  if (max - min < 4) { const mid = (max + min) / 2; min = Math.floor(mid - 2); max = Math.ceil(mid + 2); }
  const x = (i) => pad + (i * (width - 2 * pad)) / (points.length - 1);
  const y = (v) => pad + ((max - v) * (height - 2 * pad)) / (max - min);
  const lines = {};
  for (const k of keys) {
    let d = '', pen = false;
    points.forEach((p, i) => {
      if (typeof p[k] !== 'number') { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`;
      pen = true;
    });
    lines[k] = d;
  }
  return { lines, min, max, x, y };
}
