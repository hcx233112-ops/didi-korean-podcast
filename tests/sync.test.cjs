require('./register-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { emptySyncData, mergeSyncData, validateSyncData } = require('../lib/sync-data.ts')

const id = 'abcdefghijk'
test('deleting a favorite and resetting progress survive an older device', () => {
  const older = emptySyncData()
  older.favorites[id] = { value: true, updatedAt: 10 }
  older.progress[id] = { pos: 1800, dur: 2000, updatedAt: 10 }
  const newer = emptySyncData()
  newer.favorites[id] = { value: false, updatedAt: 20 }
  newer.progress[id] = { pos: 0, dur: 2000, deleted: true, updatedAt: 20 }
  assert.deepEqual(mergeSyncData(newer, older), newer)
  assert.deepEqual(mergeSyncData(older, newer), newer)
})
test('validation rejects arbitrary bodies, excessive maps and invalid numbers', () => {
  assert.throws(() => validateSyncData({ notSyncData: 'overwrite' }))
  for (const pos of [NaN, Infinity, -1, 2001]) {
    const data = emptySyncData()
    data.progress[id] = { pos, dur: 2000, updatedAt: 10 }
    assert.throws(() => validateSyncData(data))
  }
  const data = emptySyncData()
  data.favorites[id] = { value: true, updatedAt: Date.now() + 600_000 }
  assert.throws(() => validateSyncData(data))
})

test('API rejects unauthenticated and malformed writes and reports storage failures', async () => {
  process.env.PODCAST_SYNC_SECRET = 'a'.repeat(32)
  process.env.KV_REST_API_URL = 'https://mock.invalid'
  process.env.KV_REST_API_TOKEN = 'mock'
  const { GET, POST } = require('../app/api/sync/route.ts')
  const make = (body, authorized = true) => new Request('http://localhost/api/sync', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${'a'.repeat(32)}` } : {}) },
    body: JSON.stringify(body),
  })
  const originalFetch = global.fetch
  const commands = []
  global.fetch = async (_url, options) => {
    commands.push(JSON.parse(options.body))
    return Response.json({ error: 'mock unavailable' }, { status: 500 })
  }
  try {
    assert.equal((await POST(make(emptySyncData(), false))).status, 401)
    assert.equal((await POST(make({ arbitrary: 'overwrite' }))).status, 400)
    assert.equal((await POST(make(emptySyncData()))).status, 502)
    assert.equal(commands[0][0], 'EVAL', 'server must merge atomically, not GET then SET')
    assert.equal((await GET(new Request('http://localhost/api/sync', { headers: { authorization: `Bearer ${'a'.repeat(32)}` } }))).status, 502)
    delete process.env.KV_REST_API_URL
    assert.equal((await POST(make(emptySyncData()))).status, 503)
  } finally { global.fetch = originalFetch }
})

test('API accepts only bounded bodies and returns merged cloud state', async () => {
  process.env.PODCAST_SYNC_SECRET = 'a'.repeat(32)
  process.env.KV_REST_API_URL = 'https://mock.invalid'
  process.env.KV_REST_API_TOKEN = 'mock'
  const { POST } = require('../app/api/sync/route.ts')
  const originalFetch = global.fetch
  const data = emptySyncData()
  data.favorites[id] = { value: false, updatedAt: 10 }
  global.fetch = async () => Response.json({ result: JSON.stringify(data) })
  const headers = { authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json' }
  try {
    const response = await POST(new Request('http://localhost/api/sync', { method: 'POST', headers, body: JSON.stringify(data) }))
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, data)
    const tooLarge = await POST(new Request('http://localhost/api/sync', { method: 'POST', headers, body: ' '.repeat(131073) }))
    assert.equal(tooLarge.status, 413)
  } finally { global.fetch = originalFetch }
})

test('merged capacity exhaustion is explicit and never reported as a successful save', async () => {
  process.env.PODCAST_SYNC_SECRET = 'a'.repeat(32)
  process.env.KV_REST_API_URL = 'https://mock.invalid'
  process.env.KV_REST_API_TOKEN = 'mock'
  const { POST } = require('../app/api/sync/route.ts')
  const originalFetch = global.fetch
  global.fetch = async () => Response.json({ error: 'SYNC_CAPACITY bytes' })
  try {
    const response = await POST(new Request('http://localhost/api/sync', { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(32)}` }, body: JSON.stringify(emptySyncData()) }))
    assert.equal(response.status, 413)
  } finally { global.fetch = originalFetch }
})
