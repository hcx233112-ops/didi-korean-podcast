require('./register-ts.cjs')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const sync = require('../lib/sync-data.ts')
const source = ts.transpileModule(fs.readFileSync(require.resolve('../hooks/use-podcast-sync.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function moduleWithReact(react) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => name === 'react' ? react : name === '@/lib/sync-data' ? sync : require(name), module, module.exports)
  return module.exports
}
function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return { get length() { return values.size }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}
const { readLocalSync } = moduleWithReact({})
const id = 'abcdefghijk'
test('legacy favorites and listening positions migrate without overwriting remote timestamps', () => {
  const local=readLocalSync(storage({ 'podcast-favorites': JSON.stringify([id]), [`podcast-pos-${id}`]: JSON.stringify({pos:1800,dur:3600}) }))
  assert.equal(local.favorites[id].updatedAt,0)
  const merged=sync.mergeSyncData(local,{version:2,favorites:{[id]:{value:false,updatedAt:1}},progress:{[id]:{pos:600,dur:3600,updatedAt:1}}})
  assert.equal(merged.favorites[id].value,false)
  assert.equal(merged.progress[id].pos,600)
})
test('corrupt legacy favorites do not discard intact v2 progress and deletion records', () => {
  const saved={version:2,favorites:{[id]:{value:false,updatedAt:100}},progress:{[id]:{pos:0,dur:3600,deleted:true,updatedAt:100}}}
  const local=readLocalSync(storage({'podcast-favorites':'broken','podcast-sync-v2':JSON.stringify(saved)}))
  assert.deepEqual(local,saved)
})

function harness() {
  let slots=[], cursor=0, effects=[], cleanups=[], effectFns=[]
  const react={
    useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=typeof initial==='function'?initial():initial; return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}] },
    useRef(initial) { const i=cursor++; return slots[i] ||= {current:initial} },
    useCallback(fn) {cursor++;return fn}, useMemo(fn) {cursor++;return fn()},
    useEffect(fn) { const i=cursor++;if(!(i in slots)){slots[i]=true;effects.push(fn);effectFns.push(fn)} },
  }
  const {usePodcastSync}=moduleWithReact(react)
  return {render(){cursor=0;const api=usePodcastSync();for(const fn of effects.splice(0)){const cleanup=fn();if(cleanup)cleanups.push(cleanup)}return api},strictRefresh(){cleanups.splice(0).forEach(fn=>fn());for(const fn of effectFns){const cleanup=fn();if(cleanup)cleanups.push(cleanup)}},cleanup(){cleanups.splice(0).forEach(fn=>fn())}}
}
test('local mode makes no cloud requests and explicit edits preserve deletion tombstones', async () => {
  const original={localStorage:global.localStorage,window:global.window,fetch:global.fetch}
  global.localStorage=storage();global.window={addEventListener(){},removeEventListener(){}}
  let requests=0;global.fetch=async()=>{requests++;throw Error('unexpected request')}
  const app=harness()
  try{
    let api=app.render();api.toggleFavorite(id);api.toggleFavorite(id);api.saveProgress(id,1800,3600);api.resetProgress(id)
    await new Promise(resolve=>setImmediate(resolve));api=app.render()
    assert.equal(requests,0);assert.equal(api.favorites.has(id),false);assert.equal(api.getProgress(id),0)
    const saved=JSON.parse(localStorage.getItem('podcast-sync-v2'))
    assert.equal(saved.favorites[id].value,false);assert.equal(saved.progress[id].deleted,true)
  }finally{app.cleanup();Object.assign(global,original)}
})

test('cloud sync authenticates, merges newer remote progress, and preserves an intentional rewind', async () => {
  const original={localStorage:global.localStorage,window:global.window,fetch:global.fetch}
  global.localStorage=storage({[`podcast-pos-${id}`]:JSON.stringify({pos:1800,dur:3600})})
  global.window={addEventListener(){},removeEventListener(){}}
  const credential='a'.repeat(32),calls=[]
  let cloud={version:2,favorites:{},progress:{[id]:{pos:600,dur:3600,updatedAt:1}}}
  global.fetch=async(url,options)=>{
    calls.push(options)
    assert.equal(options.headers.Authorization,`Bearer ${credential}`)
    if(options.method==='POST'){cloud=sync.mergeSyncData(cloud,JSON.parse(options.body));return{ok:true,json:async()=>({ok:true,data:cloud})}}
    return {ok:true,json:async()=>cloud}
  }
  const app=harness()
  try{
    let api=app.render();api.configureSecret(credential)
    await new Promise(resolve=>setImmediate(resolve));api=app.render()
    assert.equal(api.getProgress(id),600)
    api.saveProgress(id,300,3600);await api.syncNow()
    assert.equal(cloud.progress[id].pos,300)
    api.resetProgress(id);await api.syncNow()
    assert.equal(cloud.progress[id].deleted,true)
    const writes=calls.filter(call=>call.method==='POST').length
    await api.syncNow();assert.equal(calls.filter(call=>call.method==='POST').length,writes)
  }finally{app.cleanup();Object.assign(global,original)}
})

test('a request already in flight cannot start a competing write', async () => {
  const original={localStorage:global.localStorage,window:global.window,fetch:global.fetch}
  global.localStorage=storage();global.window={addEventListener(){},removeEventListener(){}}
  let requests=0,resolveGet
  global.fetch=async(url,options)=>{
    requests++
    if(options.method==='POST')return{ok:true,json:async()=>({ok:true,data:JSON.parse(options.body)})}
    return new Promise(resolve=>{resolveGet=resolve})
  }
  const app=harness()
  try{
    const api=app.render();api.configureSecret('a'.repeat(32));await api.syncNow(false,true);assert.equal(requests,1)
    resolveGet({ok:true,json:async()=>null});await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,2)
  }finally{app.cleanup();Object.assign(global,original)}
})

test('authentication failures remain visible and do not claim successful synchronization', async () => {
  const original={localStorage:global.localStorage,window:global.window,fetch:global.fetch}
  global.localStorage=storage();global.window={addEventListener(){},removeEventListener(){}}
  global.fetch=async()=>({ok:false,status:401})
  const app=harness()
  try{
    const api=app.render();api.configureSecret('a'.repeat(32));await new Promise(resolve=>setImmediate(resolve))
    assert.match(app.render().status,/密钥不正确/)
    assert.equal(JSON.parse(localStorage.getItem('podcast-sync-v2')).version,2)
  }finally{app.cleanup();Object.assign(global,original)}
})

test('StrictMode effect cleanup does not leave the next mount stuck behind an aborted request', async () => {
  const original={localStorage:global.localStorage,window:global.window,fetch:global.fetch}
  global.localStorage=storage({'podcast-sync-secret':'a'.repeat(32)})
  global.window={addEventListener(){},removeEventListener(){}}
  let reads=0
  global.fetch=async(url,options)=>{
    if(options.method==='POST')return{ok:true,json:async()=>({ok:true,data:JSON.parse(options.body)})}
    reads++
    if(reads===1)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))
    return{ok:true,json:async()=>null}
  }
  const app=harness()
  try{
    app.render();app.strictRefresh();await new Promise(resolve=>setImmediate(resolve))
    assert.equal(reads,2)
    assert.equal(app.render().status,'已同步')
  }finally{app.cleanup();Object.assign(global,original)}
})
