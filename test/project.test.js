// Checks on the project as a whole: versions agree, and everything the app
// and service worker reference actually exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readVersions, nextPatch } from '../scripts/bump-version.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const exists = (p) => existsSync(new URL(p, root));

test('the version is the same everywhere it appears', () => {
  const v = readVersions();
  const versions = new Set(Object.values(v));
  assert.equal(versions.size, 1, JSON.stringify(v));
  const [only] = versions;
  assert.match(only, /^\d+\.\d+\.\d+$/);
  assert.ok(read('index.html').includes(`src/app.js?v=${only}`), 'the script tag cache-buster matches');
});

test('patch bumps', () => {
  assert.equal(nextPatch('0.1.0'), '0.1.1');
  assert.equal(nextPatch('1.9.9'), '1.9.10');
});

test('everything the service worker precaches exists, and every module is precached', () => {
  const sw = read('sw.js');
  const list = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((p) => p !== './');
  assert.ok(list.length > 10);
  for (const p of list) assert.ok(exists(p), `missing ${p}`);
  for (const f of readdirSync(new URL('src/lib/', root))) assert.ok(list.includes(`src/lib/${f}`), `src/lib/${f} is not precached`);
});

test('files referenced by the page and manifest exist', () => {
  const html = read('index.html');
  for (const [, p] of html.matchAll(/(?:href|src)="(?!https?:)([^"?#]+)/g)) assert.ok(exists(p), `index.html refers to missing ${p}`);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(exists(icon.src), `missing ${icon.src}`);
});

test('the app’s imports resolve', () => {
  for (const file of ['src/app.js', 'worker/src/index.js']) {
    const src = read(file);
    for (const [, p] of src.matchAll(/from '(\.[^']+)'/g)) assert.ok(exists(new URL(p, new URL(file, root)).href.slice(root.href.length)), `${file} imports missing ${p}`);
  }
});

test('the Worker config has the D1 binding and a daily cron', () => {
  const toml = read('worker/wrangler.toml');
  assert.match(toml, /binding = "DB"/);
  assert.match(toml, /crons = \["\d+ \d+ \* \* \*"\]/);
  assert.match(toml, /migrations_dir = "migrations"/);
});

test('no trips are hard-coded in the app', () => {
  const app = read('src/app.js');
  assert.ok(!/Nerja|Fuengirola/.test(app));
});
