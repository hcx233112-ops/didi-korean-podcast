const CACHE = 'didi-podcast-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return // 音频走跨域 CDN，不拦截

  // 数据文件（视频列表 / 字幕）：stale-while-revalidate
  if (url.pathname.startsWith('/data/')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request)
        const network = fetch(e.request)
          .then((res) => {
            if (res.ok) cache.put(e.request, res.clone())
            return res
          })
          .catch(() => cached)
        return cached || network
      })
    )
    return
  }

  // 静态资源：cache-first
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request)
        if (cached) return cached
        const res = await fetch(e.request)
        if (res.ok) cache.put(e.request, res.clone())
        return res
      })
    )
  }
})
