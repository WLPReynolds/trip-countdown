import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historySeries, linePaths } from '../src/lib/chart.js';

test('snapshots group into one point per morning, in date order', () => {
  const rows = [
    { takenOn: '2027-07-13', targetDate: '2027-07-27', tmax: 30, tmin: 20, rainChance: 0 },
    { takenOn: '2027-07-12', targetDate: '2027-07-27', tmax: 28, tmin: 18, rainChance: 10 },
    { takenOn: '2027-07-13', targetDate: '2027-07-28', tmax: 32, tmin: 22, rainChance: null },
  ];
  assert.deepEqual(historySeries(rows), [
    { takenOn: '2027-07-12', days: 1, tmax: 28, tmin: 18, rainChance: 10 },
    { takenOn: '2027-07-13', days: 2, tmax: 31, tmin: 21, rainChance: 0 },
  ]);
  assert.deepEqual(historySeries([]), []);
});

test('lines scale into the box and skip gaps', () => {
  const pts = [{ a: 10 }, { a: null }, { a: 20 }, { a: 15 }];
  const p = linePaths(pts, ['a'], 100, 50, 0);
  assert.equal(p.min, 10);
  assert.equal(p.max, 20);
  assert.equal(p.lines.a, 'M0.0 50.0M66.7 0.0L100.0 25.0');
  assert.equal(linePaths([{ a: 1 }], ['a'], 100, 50), null);
});

test('a flat forecast still gets a readable scale', () => {
  const p = linePaths([{ a: 25 }, { a: 25 }], ['a'], 100, 50);
  assert.ok(p.max - p.min >= 4);
});
