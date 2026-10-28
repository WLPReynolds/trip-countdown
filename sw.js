// Service worker: keeps the app shell and map data available offline.
// API and weather requests always go to the network; the app caches those itself.
const VERSION = '0.1.4';
const SHELL = `trips-shell-${VERSION}`;
const FONTS = 'trips-fonts';

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/app.js',
  'src/lib/api.js',
  'src/lib/chart.js',
  'src/lib/countdown.js',
  'src/lib/form.js',
  'src/lib/geo.js',
  'src/lib/install.js',
  'src/lib/time.js',
  'src/lib/trip.js',
  'src/lib/weather.js',
  'data/countries-10m.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('trips-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: serve from cache, refresh in the background.
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Page navigations: the cached shell, whatever the hash.
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((hit) => hit || fetch(req)));
    return;
  }

  // Shell files: cache first, ignoring the ?v= cache-buster.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
