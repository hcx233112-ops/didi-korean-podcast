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
    assert.ok(commands.some(c => c[0] === 'EVAL') && !commands.some(c => c[0] === 'SET'), 'server must merge atomically, not GET then SET')
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
    const tooLarge = await POST(new Request('http://localhost/api/sync', { method: 'POST', headers, body: ' '.repeat(512 * 1024 + 1) }))
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

test('a short passcode is protected by a global lockout on repeated wrong guesses', async () => {
  process.env.PODCAST_SYNC_SECRET = '2580'
  process.env.KV_REST_API_URL = 'https://mock.invalid'
  process.env.KV_REST_API_TOKEN = 'mock'
  const { GET } = require('../app/api/sync/route.ts')
  const originalFetch = global.fetch
  let failures = 0
  global.fetch = async (_url, options) => {
    const [command, key] = JSON.parse(options.body)
    if (command === 'INCR') return Response.json({ result: ++failures })
    if (command === 'EXPIRE') return Response.json({ result: 1 })
    if (command === 'GET' && key === 'podcast-sync:failures') return Response.json({ result: failures ? String(failures) : null })
    return Response.json({ result: null })
  }
  const get = code => GET(new Request('http://localhost/api/sync', { headers: { authorization: `Bearer ${code}` } }))
  try {
    assert.equal((await get('2580')).status, 200)
    for (let i = 0; i < 10; i++) assert.equal((await get(String(1000 + i))).status, 401)
    assert.equal((await get('9999')).status, 429)
    assert.equal((await get('2580')).status, 429, 'the right code must not slip through during a lockout')
    failures = 0
    assert.equal((await get('2580')).status, 200)
  } finally { global.fetch = originalFetch }
})

test('saved sentences sync like favorites: newest wins and a removal beats an older save', () => {
  const key = `${id}@1050`
  const saved = { value: true, start: 10.5, end: 12, text: '안녕하세요', zh: '你好', updatedAt: 10 }
  const removed = { value: false, start: 10.5, end: 12, text: '', zh: '', updatedAt: 20 }
  const older = { ...emptySyncData(), phrases: { [key]: saved } }
  const newer = { ...emptySyncData(), phrases: { [key]: removed } }
  assert.deepEqual(mergeSyncData(older, newer).phrases[key], removed)
  assert.deepEqual(mergeSyncData(newer, older).phrases[key], removed)
  const tie = { ...emptySyncData(), phrases: { [key]: { ...removed, updatedAt: 10 } } }
  assert.equal(mergeSyncData(older, tie).phrases[key].value, false)
  assert.deepEqual(validateSyncData(older), older)
})

test('data from clients without sentences stays valid, and malformed sentences are rejected', () => {
  const legacy = { version: 2, favorites: {}, progress: {} }
  assert.deepEqual(validateSyncData(legacy), emptySyncData())
  assert.deepEqual(mergeSyncData(emptySyncData(), legacy).phrases, {})
  const good = { value: true, start: 1, end: 2, text: 'x', zh: '', updatedAt: 10 }
  for (const [key, item] of [
    ['bad', good], [`${id}@1`, { ...good, value: 'yes' }], [`${id}@1`, { ...good, end: 0.5 }], [`${id}@1`, { ...good, text: '' }],
    [`${id}@1`, { ...good, text: 'x'.repeat(601) }], [`${id}@1`, { ...good, start: NaN }],
  ]) assert.throws(() => validateSyncData({ ...emptySyncData(), phrases: { [key]: item } }), undefined, key)
  assert.throws(() => validateSyncData({ ...emptySyncData(), phrases: [] }))
})

test('more records than the cloud allows are refused as too large, but stay readable on the device', async () => {
  const data = emptySyncData()
  for (let i = 0; i < 2001; i++) data.phrases[`${id}@${i}`] = { value: false, updatedAt: 10, start: 0, end: 0, text: '', zh: '' }
  assert.throws(() => validateSyncData(data), RangeError)
  assert.equal(Object.keys(validateSyncData(data, Date.now(), { limits: false }).phrases).length, 2001)
  process.env.PODCAST_SYNC_SECRET = 'a'.repeat(32)
  process.env.KV_REST_API_URL = 'https://mock.invalid'
  process.env.KV_REST_API_TOKEN = 'mock'
  const { POST } = require('../app/api/sync/route.ts')
  const headers = { authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json' }
  const response = await POST(new Request('http://localhost/api/sync', { method: 'POST', headers, body: JSON.stringify(data) }))
  assert.equal(response.status, 413)
})
