/* Офлайн-режим: страница и все её файлы сохраняются на телефоне при первом открытии. */
const CACHE = 'rybalka-phone-v2';
const ASSETS = ['./', './index.html', './app.js', './phone.css', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png', './Lora-Italic.ttf'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    // если есть интернет — обновляем сохранённую копию в фоне (применится при следующем запуске)
    const fresh = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    const res = await fresh;
    return res || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  }));
});
