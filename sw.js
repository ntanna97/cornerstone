/* Cornerstone service worker.
   - The game's own files: network first (so a new deploy shows up straight away), falling back to the
     saved copy when offline. Playing on one device works with no internet at all.
   - The pinned Supabase library and Google Fonts: saved on first use (they never change at a given URL).
   Online play itself uses a live websocket, which a service worker doesn't touch. */
const CACHE = 'cornerstone-v1';
const CORE = ['./', 'index.html', 'styles.css', 'engine.js', 'net.js', 'supabase-transport.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const SUPABASE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/dist/umd/supabase.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(CORE);
    try { await c.add(new Request(SUPABASE, { mode: 'cors' })); } catch (err) { /* online play still loads it later */ }
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const pinned = url.href === SUPABASE || url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com';
  if (pinned) { // saved copy first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => { // latest version first, saved copy when offline
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))));
});
