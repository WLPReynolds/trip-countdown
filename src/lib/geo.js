// Country map: decode Natural Earth TopoJSON, find the country under the pin,
// decide what area to show, and turn it into simplified SVG paths.

export const KM_PER_DEG = 111.32;

export const MAP_DEFAULTS = {
  joinKm: 500,      // parts of a country further than this from the pin's part are dropped (e.g. the Canaries from mainland Spain)
  largeKm: 2200,    // countries wider or taller than this are cropped around the pin
  cropKm: 1000,     // half-width of the cropped window: about 1,000 km each way from the pin
  fallbackKm: 400,  // half-width when the pin isn't in any country (small islands, at sea)
  snapKm: 50,       // a pin just off the coast snaps to a country within this distance
  pad: 0.08,        // breathing room around a whole-country view
  minPx: 0.6,       // simplification tolerance in pixels
};

// ---------------------------------------------------------------- TopoJSON

function decodeArcs(topology) {
  const t = topology.transform;
  return topology.arcs.map((arc) => {
    if (!t) return arc.map((p) => [p[0], p[1]]);
    let x = 0, y = 0;
    return arc.map((p) => {
      x += p[0]; y += p[1];
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]];
    });
  });
}

function ringFromArcs(indexes, arcs) {
  const ring = [];
  indexes.forEach((i, n) => {
    const pts = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    for (let k = n === 0 ? 0 : 1; k < pts.length; k++) ring.push(pts[k]);
  });
  return ring;
}

function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Decode a TopoJSON object into features:
 * { id, name, parts: [{ rings: [[ [lon,lat], ... ] ...], bbox: [lon0,lat0,lon1,lat1] }] }
 * Each part is one polygon (outer ring then holes).
 */
export function decodeTopology(topology, objectName = 'countries') {
  const arcs = decodeArcs(topology);
  const obj = topology.objects[objectName];
  const geoms = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
  return geoms.filter((g) => g.type === 'Polygon' || g.type === 'MultiPolygon').map((g) => {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    const parts = polys.map((rings) => {
      let rr = rings.map((r) => ringFromArcs(r, arcs));
      let bbox = bboxOf(rr[0]);
      // Parts cut at 180° (eastern Russia, Fiji) wrap round the world in raw
      // longitudes; shift their western half by 360° so they're continuous.
      if (bbox[2] - bbox[0] > 180) {
        const shifted = rr.map((ring) => ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]));
        const b2 = bboxOf(shifted[0]);
        if (b2[2] - b2[0] < 180) { rr = shifted; bbox = b2; }
      }
      return { rings: rr, bbox };
    });
    return { id: g.id ?? null, name: g.properties?.name ?? '', parts };
  });
}

// ---------------------------------------------------------------- geometry

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and not in any hole. */
export function pointInPart(pt, part) {
  if (part.bbox[2] > 180 && pt[0] < 0) pt = [pt[0] + 360, pt[1]];
  const [x, y] = pt, b = part.bbox;
  if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
  if (!pointInRing(pt, part.rings[0])) return false;
  for (let h = 1; h < part.rings.length; h++) if (pointInRing(pt, part.rings[h])) return false;
  return true;
}

export const wrapLon = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Local equirectangular projection centred on (lon0, lat0), in km. */
export function makeProjection(lon0, lat0) {
  const k = Math.cos((lat0 * Math.PI) / 180) * KM_PER_DEG;
  return {
    lon0, lat0,
    project: ([lon, lat]) => [wrapLon(lon - lon0) * k, (lat - lat0) * KM_PER_DEG],
    lonSpan: (km) => km / Math.max(k, 1e-6),
    latSpan: (km) => km / KM_PER_DEG,
  };
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Which country (and which of its parts) the pin falls in.
 * Returns { feature, partIndex, snappedKm } or null.
 */
export function findCountry(features, lon, lat, opts = {}) {
  const { snapKm } = { ...MAP_DEFAULTS, ...opts };
  const pt = [lon, lat];
  for (const f of features) {
    for (let i = 0; i < f.parts.length; i++) if (pointInPart(pt, f.parts[i])) return { feature: f, partIndex: i, snappedKm: 0 };
  }
  // Not inside anything: try the nearest coastline within snapKm.
  const proj = makeProjection(lon, lat);
  const margin = snapKm / KM_PER_DEG / Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
  let best = null;
  for (const f of features) {
    f.parts.forEach((part, i) => {
      const b = part.bbox;
      const x = b[2] > 180 && lon < 0 ? lon + 360 : lon;
      if (x < b[0] - margin || x > b[2] + margin || lat < b[1] - margin || lat > b[3] + margin) return;
      const ring = part.rings[0].map(proj.project);
      for (let k = 1; k < ring.length; k++) {
        const d = distToSegment([0, 0], ring[k - 1], ring[k]);
        if (d <= snapKm && (!best || d < best.snappedKm)) best = { feature: f, partIndex: i, snappedKm: d };
      }
    });
  }
  return best;
}

function bboxGap(a, b) {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/**
 * The parts of a country that belong with the pin's part: everything linked to
 * it by gaps of joinKm or less. Returns indexes and their combined km bbox.
 */
export function clusterParts(feature, partIndex, proj, joinKm = MAP_DEFAULTS.joinKm) {
  const boxes = feature.parts.map((p) => bboxOf(p.rings[0].map(proj.project)));
  const inCluster = new Set([partIndex]);
  const frontier = [partIndex];
  while (frontier.length) {
    const i = frontier.pop();
    boxes.forEach((b, j) => {
      if (!inCluster.has(j) && bboxGap(boxes[i], b) <= joinKm) { inCluster.add(j); frontier.push(j); }
    });
  }
  let box = null;
  for (const i of inCluster) box = box ? unionBox(box, boxes[i]) : boxes[i];
  return { indexes: [...inCluster].sort((a, b) => a - b), bbox: box };
}

/** Grow a [x0,y0,x1,y1] box about its centre to the given width/height ratio. */
export function fitAspect(box, ratio) {
  let [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (w / h > ratio) { const nh = w / ratio; y0 = cy - nh / 2; y1 = cy + nh / 2; }
  else { const nw = h * ratio; x0 = cx - nw / 2; x1 = cx + nw / 2; }
  return [x0, y0, x1, y1];
}

/**
 * Decide what to draw. Returns
 * { proj, box (km, relative to pin), country, cropped, mode: 'country'|'crop'|'nearby' }
 */
export function chooseView(features, lon, lat, ratio = 1, opts = {}) {
  const o = { ...MAP_DEFAULTS, ...opts };
  const hit = findCountry(features, lon, lat, o);
  const proj = makeProjection(lon, lat);
  if (!hit) {
    const r = o.fallbackKm;
    return { proj, box: fitAspect([-r, -r, r, r], ratio), country: null, cropped: true, mode: 'nearby' };
  }
  const cluster = clusterParts(hit.feature, hit.partIndex, proj, o.joinKm);
  const [x0, y0, x1, y1] = cluster.bbox;
  const w = x1 - x0, h = y1 - y0;
  if (Math.max(w, h) > o.largeKm) {
    const r = o.cropKm;
    return { proj, box: fitAspect([-r, -r, r, r], ratio), country: hit.feature, parts: cluster.indexes, cropped: true, mode: 'crop' };
  }
  const p = Math.max(w, h) * o.pad + 10;
  return { proj, box: fitAspect([x0 - p, y0 - p, x1 + p, y1 + p], ratio), country: hit.feature, parts: cluster.indexes, cropped: false, mode: 'country' };
}

// ---------------------------------------------------------------- rendering

/** Sutherland–Hodgman clip of a closed ring to a rectangle [x0,y0,x1,y1]. */
export function clipRing(ring, [x0, y0, x1, y1]) {
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cut = [
    (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
  ];
  let out = ring;
  for (let e = 0; e < 4 && out.length; e++) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const ci = edges[e](cur), pi = edges[e](prev);
      if (ci) { if (!pi) out.push(cut[e](prev, cur)); out.push(cur); }
      else if (pi) out.push(cut[e](prev, cur));
    }
  }
  return out;
}

/** Drop points closer than tol to the last kept point. */
export function simplifyRing(ring, tol) {
  if (ring.length < 4) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const last = out[out.length - 1];
    if (Math.abs(ring[i][0] - last[0]) >= tol || Math.abs(ring[i][1] - last[1]) >= tol) out.push(ring[i]);
  }
  return out;
}

function ringPath(ring) {
  return 'M' + ring.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z';
}

function lonOverlap(a0, a1, b0, b1) {
  for (const s of [-360, 0, 360]) if (a0 + s <= b1 && a1 + s >= b0) return true;
  return false;
}

/**
 * Build SVG path data for a view at width × height pixels.
 * Returns { width, height, target: 'path', others: 'path', pin: {x, y}, mode, cropped, countryName }
 */
export function renderMap(features, view, width, height, opts = {}) {
  const { minPx } = { ...MAP_DEFAULTS, ...opts };
  const [bx0, by0, bx1, by1] = view.box;
  const scale = width / (bx1 - bx0);
  const toPx = ([x, y]) => [(x - bx0) * scale, (by1 - y) * scale];
  const marginPx = 4;
  const clip = [-marginPx, -marginPx, width + marginPx, height + marginPx];

  // Degree box of the view, to skip parts that can't be visible.
  const { proj } = view;
  const lonA = proj.lon0 + proj.lonSpan(bx0) - 1, lonB = proj.lon0 + proj.lonSpan(bx1) + 1;
  const latA = proj.lat0 + proj.latSpan(by0) - 1, latB = proj.lat0 + proj.latSpan(by1) + 1;
  const wide = lonB - lonA >= 360;

  const target = [], others = [];
  const keep = view.country ? new Set(view.parts) : null;
  for (const f of features) {
    f.parts.forEach((part, i) => {
      const b = part.bbox;
      if (b[3] < latA || b[1] > latB) return;
      if (!wide && !lonOverlap(b[0], b[2], lonA, lonB)) return;
      const isTarget = f === view.country && (view.cropped || keep.has(i));
      const d = part.rings.map((ring) => {
        const px = simplifyRing(ring.map((p) => toPx(proj.project(p))), minPx);
        const clipped = clipRing(px, clip);
        return clipped.length >= 3 ? ringPath(clipped) : '';
      }).join('');
      if (d) (isTarget ? target : others).push(d);
    });
  }
  return {
    width, height,
    target: target.join(''),
    others: others.join(''),
    pin: { x: -bx0 * scale, y: by1 * scale },
    mode: view.mode, cropped: view.cropped,
    countryName: view.country?.name || '',
  };
}
