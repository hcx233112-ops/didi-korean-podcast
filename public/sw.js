const PREFIX = 'didi-podcast-'
const CACHE = PREFIX + 'v2'
const MAX_ENTRIES = 320

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()))
})

async function remember(cache, request, response) {
  if (!response.ok) return
  try {
    await cache.put(request, response.clone())
    const keys = await cache.keys()
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map(key => cache.delete(key)))
  } catch { /* A full/disabled cache must not break playback. */ }
}

async function network(request) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try { return await fetch(request, { signal: controller.signal }) }
  finally { clearTimeout(timeout) }
}

function offline() {
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const isData = url.pathname.startsWith('/data/')
  const isStatic = url.pathname.startsWith('/_next/static/')
  if (!isData && !isStatic) return
  // A network-first video list is fresh even on the first visit after publication.
  // Transcript revalidation is covered by waitUntil, including the cache write.
  const cachePromise = caches.open(CACHE).catch(() => null)
  const fresh = isData ? network(request).then(async response => {
    const cache = await cachePromise
    if (cache) await remember(cache, request, response)
    return response
  }).catch(() => null) : null
  if (fresh) event.waitUntil(fresh.then(() => undefined))
  event.respondWith((async () => {
    const cache = await cachePromise
    const cached = cache ? await cache.match(request).catch(() => undefined) : undefined
    if (url.pathname.startsWith('/data/videos/')) {
      const response = await fresh
      return response?.ok ? response : cached || response || offline()
    }
    if (cached) return cached
    if (fresh) return await fresh || offline()
    try {
      const response = await network(request)
      if (cache) await remember(cache, request, response)
      return response
    } catch { return offline() }
  })())
})
