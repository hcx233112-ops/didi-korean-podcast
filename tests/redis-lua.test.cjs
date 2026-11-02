require('./register-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari')
const { emptySyncData } = require('../lib/sync-data.ts')

function push(L, value) {
  if (value === null || value === undefined) lua.lua_pushnil(L)
  else if (typeof value === 'string') lua.lua_pushstring(L, to_luastring(value))
  else if (typeof value === 'number') lua.lua_pushnumber(L, value)
  else if (typeof value === 'boolean') lua.lua_pushboolean(L, value)
  else {
    lua.lua_newtable(L)
    for (const [key, item] of Object.entries(value)) { push(L, key); push(L, item); lua.lua_settable(L, -3) }
  }
}
function read(L, index) {
  const kind = lua.lua_type(L, index)
  if (kind === lua.LUA_TNIL) return null
  if (kind === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index))
  if (kind === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index)
  if (kind === lua.LUA_TBOOLEAN) return Boolean(lua.lua_toboolean(L, index))
  const output = {}, absolute = lua.lua_absindex(L, index)
  lua.lua_pushnil(L)
  while (lua.lua_next(L, absolute)) { output[read(L, -2)] = read(L, -1); lua.lua_pop(L, 1) }
  return output
}
function execute(script, stored, incoming) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L)
  let saved = stored
  lua.lua_newtable(L)
  lua.lua_pushjsfunction(L, L => { push(L, JSON.parse(read(L, 1))); return 1 }); lua.lua_setfield(L, -2, to_luastring('decode'))
  lua.lua_pushjsfunction(L, L => { push(L, JSON.stringify(read(L, 1))); return 1 }); lua.lua_setfield(L, -2, to_luastring('encode'))
  lua.lua_setglobal(L, to_luastring('cjson'))
  lua.lua_newtable(L)
  lua.lua_pushjsfunction(L, L => {
    const command = read(L, 1)
    if (command === 'GET') push(L, stored ? JSON.stringify(stored) : null)
    else { saved = JSON.parse(read(L, 3)); push(L, 'OK') }
    return 1
  }); lua.lua_setfield(L, -2, to_luastring('call'))
  lua.lua_pushjsfunction(L, L => { push(L, { error: read(L, 1) }); return 1 }); lua.lua_setfield(L, -2, to_luastring('error_reply'))
  lua.lua_setglobal(L, to_luastring('redis'))
  for (const [name, values] of [['KEYS', ['test']], ['ARGV', [JSON.stringify(incoming)]]]) {
    lua.lua_newtable(L); values.forEach((value, i) => { push(L, value); lua.lua_rawseti(L, -2, i + 1) }); lua.lua_setglobal(L, to_luastring(name))
  }
  assert.equal(lauxlib.luaL_loadstring(L, to_luastring(script)), lua.LUA_OK)
  const status = lua.lua_pcall(L, 0, 1, 0)
  assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : read(L, -1))
  const result = read(L, -1)
  lua.lua_close(L)
  return { saved, result }
}

test('actual Lua preserves newer deletions and rejects oversized merged states before SET', async () => {
  process.env.PODCAST_SYNC_SECRET = 'a'.repeat(32)
  process.env.KV_REST_API_URL = 'https://mock.invalid'
  process.env.KV_REST_API_TOKEN = 'mock'
  const { POST } = require('../app/api/sync/route.ts')
  const originalFetch = global.fetch
  let script
  global.fetch = async (_url, options) => { script = JSON.parse(options.body)[1]; return Response.json({ result: JSON.stringify(emptySyncData()) }) }
  try {
    await POST(new Request('http://localhost/api/sync', { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(32)}` }, body: JSON.stringify(emptySyncData()) }))
  } finally { global.fetch = originalFetch }
  const first = emptySyncData(), second = emptySyncData()
  first.favorites.abcdefghijk = { value: false, updatedAt: 20 }
  second.favorites.abcdefghijk = { value: true, updatedAt: 10 }
  first.progress.abcdefghijk = { pos: 0, dur: 2000, updatedAt: 20, deleted: true }
  second.progress.abcdefghijk = { pos: 1000, dur: 2000, updatedAt: 10 }
  assert.deepEqual(execute(script, first, second).saved, first)
  assert.deepEqual(execute(script, null, emptySyncData()).saved, emptySyncData())
  const old = emptySyncData(), added = emptySyncData()
  for (let i = 0; i < 2000; i++) old.favorites[String(i).padStart(11, '0')] = { value: true, updatedAt: 10 }
  added.favorites.abcdefghijk = { value: true, updatedAt: 20 }
  const full = execute(script, old, added)
  assert.deepEqual(full.saved, old)
  assert.match(full.result.error, /SYNC_CAPACITY/)
  const largeOld = emptySyncData(), largeAdded = emptySyncData()
  for (let i = 0; i < 1200; i++) {
    const destination = i < 600 ? largeOld : largeAdded
    destination.progress[String(i).padStart(11, '0')] = { pos: 100, dur: 2000, updatedAt: 1_000_000_000_000 + i }
    destination.favorites[String(i).padStart(11, '0')] = { value: true, updatedAt: 1_000_000_000_000 + i }
  }
  const bytesFull = execute(script, largeOld, largeAdded)
  assert.deepEqual(bytesFull.saved, largeOld)
  assert.match(bytesFull.result.error, /SYNC_CAPACITY/)
})
