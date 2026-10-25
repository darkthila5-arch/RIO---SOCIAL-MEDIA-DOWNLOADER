/* RIO x SOCIAL MEDIA DOWNLOADER - service worker (app shell cache).
   Downloads, lookups and the counter are never cached: they always go to the server. */
const VERSION = 'rio-{{ v }}';
const SHELL = [
  '/',
  '/static/style.css?v={{ v }}',
  '/static/app.js?v={{ v }}',
  '/static/popup.js?v={{ v }}',
  '/static/e2e.js?v={{ v }}',
  '/static/report.js?v={{ v }}',
  '/static/ghost.png?v={{ v }}',
  '/static/favicon.png?v={{ v }}',
  '/static/icons/icon-192.png',
  '/static/icons/apple-touch-icon.png'
];
const LIVE = ['/api/', '/dl/', '/file/', '/admin', '/healthz', '/sw.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // fonts etc. stay with the browser
  if (LIVE.some((p) => url.pathname.startsWith(p))) return;        // never cache live data or downloads
  if (req.headers.has('range')) return;

  // Pages: network first so a new deploy shows up at once, cached copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname === '/') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('/', copy)); }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
    );
    return;
  }

  // Static files: cache first (their URLs carry the version).
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});

// Update / news notifications sent from the admin page
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  // The page (browser tab or installed app) is told too, so a visitor who has it open sees the popup at once.
  // The two are independent: a blocked notification permission must not stop the popup.
  const notify = self.registration.showNotification(d.title || 'RIO Downloader', {
    body: d.body || '',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/favicon-32.png',
    data: { url: d.url || '/' }
  }).catch(() => {});
  const tell = self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((wins) => wins.forEach((w) => w.postMessage({ type: d.report ? 'rio-report' : 'rio-news' }))).catch(() => {});
  event.waitUntil(Promise.all([notify, tell]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    // an open page (browser tab or installed app) is told to show the popup / go to the link, so nothing is reloaded
    for (const w of wins) { if ('focus' in w) { w.postMessage({ type: 'rio-open', url: target }); return w.focus(); } }
    return self.clients.openWindow(target);
  }));
});
