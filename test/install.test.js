import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { iosInstallState, hintBannerDue, HINT_SNOOZE_DAYS } from '../src/lib/install.js';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36';

test('an iPhone browser that isn’t installed gets the guide', () => {
  assert.equal(iosInstallState({ userAgent: IPHONE_SAFARI }), 'needs-install');
  assert.equal(iosInstallState({ userAgent: IPHONE_CHROME }), 'needs-install');
});

test('the Home Screen app gets no guide', () => {
  assert.equal(iosInstallState({ userAgent: IPHONE_SAFARI, standalone: true }), 'installed');
  assert.equal(iosInstallState({ userAgent: IPHONE_SAFARI, displayModeStandalone: true }), 'installed');
});

test('an iPad asking for the desktop site still counts as iOS; a Mac does not', () => {
  assert.equal(iosInstallState({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 }), 'needs-install');
  assert.equal(iosInstallState({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 }), 'not-ios');
  assert.equal(iosInstallState({ userAgent: ANDROID }), 'not-ios');
  assert.equal(iosInstallState({}), 'not-ios');
});

test('"Not now" hides the banner for a week', () => {
  const now = Date.UTC(2026, 9, 27, 12), day = 86400000;
  assert.equal(hintBannerDue(null, now), true);
  assert.equal(hintBannerDue('garbage', now), true);
  assert.equal(hintBannerDue(String(now - day), now), false);
  assert.equal(hintBannerDue(String(now - HINT_SNOOZE_DAYS * day), now), true);
});

test('the page has the install dialog, and the app points at the live server', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  const cname = readFileSync(new URL('../CNAME', import.meta.url), 'utf8').trim();
  assert.match(html, /<dialog id="dlg-install"/);
  const base = app.match(/DEFAULT_API_BASE = '([^']+)'/)[1];
  assert.ok(toml.includes(`pattern = "${new URL(base).host}"`), 'the Worker’s custom domain matches the app’s server address');
  assert.ok(toml.includes(`ALLOWED_ORIGINS = "https://${cname}"`), 'the Worker allows the Pages domain');
});
