const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function worker(fetch) {
  const handlers = {}, entries = new Map(), removed = []
  const cache = {
    match: async request => entries.get(request.url || request)?.clone(),
    put: async (request, response) => { entries.set(request.url || request, response) },
    keys: async () => [...entries.keys()].map(url => new Request(url)),
    delete: async request => entries.delete(request.url || request),
  }
  vm.runInNewContext(fs.readFileSync('public/sw.js', 'utf8'), {
    self: { location: { origin: 'https://podcast.invalid' }, addEventListener: (event, fn) => { handlers[event] = fn }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => ['unrelated-app', 'didi-podcast-v1'], delete: async key => { removed.push(key) } },
    fetch, URL, Response, Request, AbortController, setTimeout, clearTimeout,
  })
  return { handlers, entries, removed }
}

test('video list returns fresh network data on the first visit with an old cache', async () => {
  const w = worker(async () => Response.json({ videos: ['new'] }))
  const request = new Request('https://podcast.invalid/data/videos/didi.json')
  w.entries.set(request.url, Response.json({ videos: ['old'] }))
  let response
  const waits = []
  w.handlers.fetch({ request, respondWith: p => { response = p }, waitUntil: p => waits.push(p) })
  assert.deepEqual(await (await response).json(), { videos: ['new'] })
  await Promise.all(waits)
})
test('uncached offline requests return a valid response rather than undefined', async () => {
  const w = worker(async () => { throw new Error('offline') })
  let response
  const waits = []
  w.handlers.fetch({ request: new Request('https://podcast.invalid/data/transcripts/abcdefghijk.json'), respondWith: p => { response = p }, waitUntil: p => waits.push(p) })
  assert.equal((await response).status, 503)
  await Promise.all(waits)
})
test('activation never deletes another application cache', async () => {
  const w = worker(async () => new Response())
  let finished
  w.handlers.activate({ waitUntil: p => { finished = p } })
  await finished
  assert.deepEqual(w.removed, ['didi-podcast-v1'])
})
