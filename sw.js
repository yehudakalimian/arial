// Service worker: offline-first app shell, cached fonts + supabase-js, network-only for the Supabase API.
const VERSION = 'ariel-v1.0.1';
const SHELL = [
  './', './index.html', './styles.css', './manifest.json',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
  './js/app.js', './js/config.js', './js/util.js', './js/idb.js', './js/store.js', './js/actions.js', './js/seed.js', './js/sync.js',
  './js/data/who-lms.js',
  './js/logic/timers.js', './js/logic/stash.js', './js/logic/sweetspot.js', './js/logic/meds.js', './js/logic/who.js', './js/logic/clinical.js',
  './js/views/icons.js', './js/views/common.js', './js/views/charts.js', './js/views/track.js', './js/views/sheets.js',
  './js/views/stash.js', './js/views/journal.js', './js/views/report.js',
];
const RUNTIME = `${VERSION}-runtime`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase REST/Realtime/Auth/Functions — never cache.
  if (/\.supabase\.(co|in)$/.test(url.hostname) || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return;

  // Fonts & pinned CDN modules: stale-while-revalidate.
  if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'].includes(url.hostname)) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // Navigations (incl. ?quick_action=…): serve the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { caches.open(VERSION).then((c) => c.put('./index.html', r.clone())); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }

  // Same-origin assets: cache-first, refresh in background.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put(req, r.clone())); return r; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const c = list.find((w) => 'focus' in w);
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});
