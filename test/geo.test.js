import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeTopology, pointInPart, findCountry, chooseView, renderMap, clipRing, simplifyRing,
  fitAspect, wrapLon, makeProjection, MAP_DEFAULTS,
} from '../src/lib/geo.js';

// A tiny hand-made topology: a 10°×10° square with a 2°×2° hole, and a separate small island.
const tinyTopo = {
  type: 'Topology',
  arcs: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]],
    [[20, 0], [21, 0], [21, 1], [20, 1], [20, 0]],
  ],
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', id: '1', properties: { name: 'Squareland' }, arcs: [[0], [1]] },
        { type: 'MultiPolygon', id: '2', properties: { name: 'Isle' }, arcs: [[[2]]] },
      ],
    },
  },
};

describe('TopoJSON decoding and geometry', () => {
  const features = decodeTopology(tinyTopo);

  test('features, parts, rings and bounding boxes', () => {
    assert.equal(features.length, 2);
    assert.equal(features[0].name, 'Squareland');
    assert.equal(features[0].parts[0].rings.length, 2);
    assert.deepEqual(features[0].parts[0].bbox, [0, 0, 10, 10]);
  });

  test('quantised, delta-encoded arcs are decoded with the transform', () => {
    const q = {
      transform: { scale: [0.5, 0.5], translate: [-10, -10] },
      arcs: [[[0, 0], [4, 0], [0, 4], [-4, 0], [0, -4]]],
      objects: { countries: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0]] }] } },
    };
    assert.deepEqual(decodeTopology(q)[0].parts[0].rings[0], [[-10, -10], [-8, -10], [-8, -8], [-10, -8], [-10, -10]]);
  });

  test('reversed arcs (negative indexes) are walked backwards', () => {
    const t = { arcs: [[[0, 0], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 1]]], objects: { countries: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0, ~1]] }] } } };
    assert.deepEqual(decodeTopology(t)[0].parts[0].rings[0], [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  });

  test('points in holes are outside', () => {
    const part = features[0].parts[0];
    assert.ok(pointInPart([2, 2], part));
    assert.ok(!pointInPart([5, 5], part));
    assert.ok(!pointInPart([11, 5], part));
  });

  test('a pin just offshore snaps to the nearest country', () => {
    assert.equal(findCountry(features, 2, 2).snappedKm, 0);
    assert.equal(findCountry(features, 10.2, 5).feature.name, 'Squareland');
    assert.equal(findCountry(features, 15, 5), null);
  });

  test('clipping keeps what is inside the frame', () => {
    const sq = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const c = clipRing(sq, [0, 0, 10, 10]);
    assert.deepEqual(c.map((p) => p.map(Math.round)).sort(), [[0, 0], [0, 5], [5, 0], [5, 5]].sort());
    assert.deepEqual(clipRing([[20, 20], [30, 20], [30, 30]], [0, 0, 10, 10]), []);
  });

  test('simplification drops points that are too close together', () => {
    const ring = [[0, 0], [0.1, 0], [0.2, 0], [5, 0], [5, 5], [0, 5]];
    assert.deepEqual(simplifyRing(ring, 1), [[0, 0], [5, 0], [5, 5], [0, 5]]);
  });

  test('aspect fitting grows the short side only', () => {
    assert.deepEqual(fitAspect([0, 0, 100, 50], 1), [0, -25, 100, 75]);
    assert.deepEqual(fitAspect([0, 0, 50, 100], 1), [-25, 0, 75, 100]);
  });

  test('longitudes wrap across the antimeridian', () => {
    assert.equal(wrapLon(190), -170);
    assert.equal(wrapLon(-190), 170);
    const p = makeProjection(179, 0).project([-179, 0]);
    assert.ok(p[0] > 0 && p[0] < 250, 'two degrees east of 179°E is close by, not 39,000 km away');
  });
});

describe('real Natural Earth data', () => {
  let world;
  before(() => { world = decodeTopology(JSON.parse(readFileSync(new URL('../data/countries-10m.json', import.meta.url))), 'countries'); });

  const view = (lon, lat) => chooseView(world, lon, lat, 200 / 250);

  test('Nerja shows the whole of mainland Spain, without the Canaries', () => {
    const v = view(-3.8746, 36.7578);
    assert.equal(v.country.name, 'Spain');
    assert.equal(v.mode, 'country');
    assert.ok(!v.cropped);
    const southmost = Math.min(...v.parts.map((i) => v.country.parts[i].bbox[1]));
    assert.ok(southmost > 34, 'the Canaries (about 28°N) are left out');
    assert.ok(v.box[1] > -700, 'and do not stretch the view south');
    assert.ok(v.box[3] > 700, 'the north coast of Spain is in view');
  });

  test('a pin on Tenerife shows the Canaries, not the mainland', () => {
    const v = view(-16.6, 28.3);
    assert.equal(v.country.name, 'Spain');
    assert.ok(v.box[2] - v.box[0] < 1000);
  });

  test('large countries are cropped to about 1,000 km around the pin', () => {
    for (const [lon, lat, name] of [[-81.38, 28.54, 'United States of America'], [151.21, -33.87, 'Australia']]) {
      const v = view(lon, lat);
      assert.equal(v.country.name, name);
      assert.equal(v.mode, 'crop');
      assert.ok(v.cropped);
      const halfH = (v.box[3] - v.box[1]) / 2;
      assert.ok(Math.abs(halfH - MAP_DEFAULTS.cropKm) < 1 || (v.box[2] - v.box[0]) / 2 === MAP_DEFAULTS.cropKm);
    }
  });

  test('normal countries are shown whole', () => {
    assert.equal(view(-2.24, 53.48).mode, 'country');       // Manchester
    const fr = view(2.35, 48.85);                           // Paris: not stretched to French Guiana
    assert.equal(fr.country.name, 'France');
    assert.equal(fr.mode, 'country');
    assert.ok(fr.box[2] - fr.box[0] < 2200);
  });

  test('Russia, which wraps past 180°, doesn’t swallow its neighbours', () => {
    assert.equal(view(25.73, 66.5).country.name, 'Finland');   // Rovaniemi
    assert.equal(view(24.94, 60.17).country.name, 'Finland');  // Helsinki
    assert.equal(view(-175, 66).country.name, 'Russia');       // Chukotka, west of 180°
    assert.equal(view(37.6, 55.75).country.name, 'Russia');    // Moscow
  });

  test('a pin on the beach just off the coastline still finds Spain', () => {
    assert.equal(findCountry(world, -3.8746, 36.745).feature.name, 'Spain');
  });

  test('a pin in open sea shows the area around it', () => {
    const v = view(-30, 40);
    assert.equal(v.mode, 'nearby');
    assert.equal(v.country, null);
  });

  test('rendered maps have the country, faint neighbours and the pin inside the frame', () => {
    const m = renderMap(world, view(-3.8746, 36.7578), 200, 250);
    assert.ok(m.target.startsWith('M'));
    assert.ok(m.others.length > 0, 'Portugal and Morocco are drawn faintly');
    assert.ok(m.pin.x > 0 && m.pin.x < 200 && m.pin.y > 0 && m.pin.y < 250);
    assert.equal(m.countryName, 'Spain');
    assert.ok(m.target.length + m.others.length < 120000, 'paths stay small enough for a phone');
  });

  test('Fiji, which straddles 180°, renders around the pin', () => {
    const m = renderMap(world, view(178.44, -18.14), 200, 250);
    assert.equal(m.countryName, 'Fiji');
    assert.ok(m.target.length > 0);
  });
});
