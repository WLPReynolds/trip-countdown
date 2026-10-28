// Bump the version everywhere it appears.
//   npm run bump            → next patch (0.1.0 → 0.1.1)
//   npm run bump -- 0.2.0   → that exact version
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const VERSION_FILES = {
  'package.json': /("version":\s*")(\d+\.\d+\.\d+)(")/,
  'src/app.js': /(APP_VERSION = ')(\d+\.\d+\.\d+)(')/,
  'sw.js': /(const VERSION = ')(\d+\.\d+\.\d+)(')/,
  'index.html': /(name="app-version" content=")(\d+\.\d+\.\d+)(")/,
};
const EXTRA = { 'index.html': /(src\/app\.js\?v=)(\d+\.\d+\.\d+)()/ };

export function nextPatch(v) {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

export function readVersions() {
  const out = {};
  for (const [f, re] of Object.entries(VERSION_FILES)) out[f] = readFileSync(root + f, 'utf8').match(re)?.[2] ?? null;
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = readVersions()['package.json'];
  const target = process.argv[2] || nextPatch(current);
  if (!/^\d+\.\d+\.\d+$/.test(target)) { console.error(`Not a version: ${target}`); process.exit(1); }
  for (const [f, re] of Object.entries(VERSION_FILES)) {
    let s = readFileSync(root + f, 'utf8').replace(re, `$1${target}$3`);
    if (EXTRA[f]) s = s.replace(EXTRA[f], `$1${target}$3`);
    writeFileSync(root + f, s);
  }
  console.log(`${current} → ${target}`);
}
