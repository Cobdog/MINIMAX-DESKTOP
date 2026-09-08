/* global self, caches, URL, fetch */
const CACHE = 'minimax-mobile-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && !url.searchParams.has('token')) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()))
    return response
  }).catch(async () => {
    const cached = await caches.match(event.request)
    return cached || caches.match('/')
  }))
})
