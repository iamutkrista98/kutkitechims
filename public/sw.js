// sw.js — minimal service worker whose only real job is to make the app
// installable (Chrome/Edge require an active service worker with a fetch
// handler before showing an install prompt) and let the static app shell
// (HTML/CSS/JS/icons) open a little faster on repeat visits.
//
// Deliberately does NOT cache anything under /api/ — this app's data
// (inventory, sessions, approvals) is per-user and changes constantly, so
// serving a stale cached response would be actively wrong, not just an
// inconvenience. Every API request always goes straight to the network.
// If the network is unavailable, those requests fail normally and the
// app's own error handling (see api() in common.js) takes over — this
// service worker does not attempt offline data access.

const CACHE_NAME = 'assettrack-shell-v1';

const SHELL_ASSETS = [
  '/index.html',
  '/dashboard.html',
  '/css/style.css',
  '/js/common.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API calls, uploaded images/bills, or the manifest itself
  // (the manifest is generated per-request server-side and can change
  // whenever branding does).
  if (url.pathname.startsWith('/api/') || url.pathname === '/manifest.json') return;

  // App shell: try the network first so a deployed update is picked up
  // immediately, falling back to the cached copy only if the network is
  // unreachable (e.g. briefly offline).
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
