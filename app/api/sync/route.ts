import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { validateSyncData } from '../../../lib/sync-data'

export const runtime = 'nodejs'
const MAX_BYTES = 512 * 1024
const MIN_SECRET = 4
// A short passcode is safe only because wrong guesses are throttled globally (single-user site).
const FAILURE_KEY = 'podcast-sync:failures'
const MAX_FAILURES = 10
const FAILURE_WINDOW_SECONDS = 600
const JSON_HEADERS = { 'Cache-Control': 'private, no-store' }
class SyncCapacityError extends Error {}

// The read/merge/write runs atomically in Redis, across concurrent devices.
const MERGE_SCRIPT = `
local old = redis.call('GET', KEYS[1])
local state = old and cjson.decode(old) or {version=2, favorites={}, progress={}, phrases={}}
state.phrases = state.phrases or {}
local incoming = cjson.decode(ARGV[1])
for id, item in pairs(incoming.favorites) do
  local prev = state.favorites[id]
  if not prev or item.updatedAt > prev.updatedAt or (item.updatedAt == prev.updatedAt and not item.value) then state.favorites[id] = item end
end
for id, item in pairs(incoming.progress) do
  local prev = state.progress[id]
  if not prev or item.updatedAt > prev.updatedAt or (item.updatedAt == prev.updatedAt and (item.deleted or (not prev.deleted and (item.pos < prev.pos or (item.pos == prev.pos and item.dur < prev.dur))))) then state.progress[id] = item end
end
for id, item in pairs(incoming.phrases or {}) do
  local prev = state.phrases[id]
  if not prev or item.updatedAt > prev.updatedAt or (item.updatedAt == prev.updatedAt and not item.value) then state.phrases[id] = item end
end
local encoded = cjson.encode(state)
encoded = string.gsub(encoded, '"favorites":%[%]', '"favorites":{}')
encoded = string.gsub(encoded, '"progress":%[%]', '"progress":{}')
encoded = string.gsub(encoded, '"phrases":%[%]', '"phrases":{}')
for _, kind in ipairs({'favorites', 'progress', 'phrases'}) do
  local count = 0
  for _ in pairs(state[kind]) do count = count + 1 end
  if count > 2000 then return redis.error_reply('SYNC_CAPACITY records') end
end
if string.len(encoded) > 524288 then return redis.error_reply('SYNC_CAPACITY bytes') end
redis.call('SET', KEYS[1], encoded)
return encoded
`

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: JSON_HEADERS })
}

async function config(req: Request) {
  const secret = process.env.PODCAST_SYNC_SECRET
  const base = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!secret || secret.length < MIN_SECRET || !base || !token) return { error: response({ error: '云同步尚未配置，本地数据已保留' }, 503) }
  const supplied = Buffer.from(req.headers.get('authorization') || '')
  const expected = Buffer.from(`Bearer ${secret}`)
  const locked = (count: unknown) => Number(count) > MAX_FAILURES
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    let failures: unknown = 0
    try {
      failures = await redis(base, token, ['INCR', FAILURE_KEY])
      if (Number(failures) === 1) await redis(base, token, ['EXPIRE', FAILURE_KEY, FAILURE_WINDOW_SECONDS])
    } catch {}
    return { error: locked(failures) ? response({ error: '尝试次数过多，请 10 分钟后再试' }, 429) : response({ error: '同步口令不正确' }, 401) }
  }
  // A correct guess during a lockout is still refused, so the lockout really bounds guessing.
  try { if (locked(await redis(base, token, ['GET', FAILURE_KEY]))) return { error: response({ error: '尝试次数过多，请 10 分钟后再试' }, 429) } } catch {}
  const namespace = createHash('sha256').update(secret).digest('hex').slice(0, 32)
  return { base, token, key: `podcast-sync:v2:${namespace}` }
}

async function redis(base: string, token: string, command: unknown[]) {
  const result = await fetch(base, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (!result.ok) throw new Error('Cloud storage unavailable')
  const data = await result.json()
  if (typeof data.error === 'string' && data.error.includes('SYNC_CAPACITY')) throw new SyncCapacityError()
  if (data.error || !Object.hasOwn(data, 'result')) throw new Error('Cloud storage command failed')
  return data.result
}

async function readBoundedJson(req: Request) {
  if (Number(req.headers.get('content-length')) > MAX_BYTES) throw new RangeError('Request too large')
  if (!req.body) throw new SyntaxError('Empty request')
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) { await reader.cancel(); throw new RangeError('Request too large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function GET(req: Request) {
  const connection = await config(req)
  if (connection.error) return connection.error
  try {
    const raw = await redis(connection.base!, connection.token!, ['GET', connection.key!])
    return response(raw === null ? null : validateSyncData(typeof raw === 'string' ? JSON.parse(raw) : raw))
  } catch { return response({ error: '读取云端失败，请稍后重试' }, 502) }
}

export async function POST(req: Request) {
  const connection = await config(req)
  if (connection.error) return connection.error
  let payload
  try { payload = validateSyncData(await readBoundedJson(req)) }
  catch (error) { return response({ error: error instanceof RangeError ? '同步数据过大' : '同步数据格式不正确' }, error instanceof RangeError ? 413 : 400) }
  try {
    const raw = await redis(connection.base!, connection.token!, ['EVAL', MERGE_SCRIPT, 1, connection.key!, JSON.stringify(payload)])
    const data = validateSyncData(typeof raw === 'string' ? JSON.parse(raw) : raw)
    return response({ ok: true, data })
  } catch (error) {
    return error instanceof SyncCapacityError
      ? response({ error: '云同步容量已满，本地数据已保留' }, 413)
      : response({ error: '保存云端失败，本地数据已保留' }, 502)
  }
}
