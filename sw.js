// Offline-Fähigkeit: App-Dateien „network first“ (Updates kommen sofort an), Bibliotheken „cache first“.
const CACHE = 'wz-v9';
const APP = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png',
  'js/app.js', 'js/store.js', 'js/dropbox.js', 'js/config.js', 'js/stats.js', 'js/weather.js', 'js/charts.js', 'js/forms.js', 'js/csv.js', 'js/ui.js', 'js/warnings.js',
];
const LIBS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([...APP.map(u => new Request(u, { cache: 'reload' })), ...LIBS])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return; // Dropbox, Open-Meteo: nie cachen
  e.respondWith(
    // cache: 'no-cache' = immer beim Server nachfragen, ob es eine neue Version gibt (GitHub erlaubt sonst 10 Min. alte Kopien)
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
