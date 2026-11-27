'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { phraseList } from '@/lib/phrases'
import { type PhraseRecord, type SyncData, emptySyncData, mergeSyncData, validateSyncData } from '@/lib/sync-data'

const DATA_KEY = 'podcast-sync-v2'
const SECRET_KEY = 'podcast-sync-secret'

const sorted = <T,>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
function serialize(data: SyncData) {
  return JSON.stringify({ version: 2, favorites: sorted(data.favorites), progress: sorted(data.progress), phrases: sorted(data.phrases) })
}

export function readLocalSync(storage: Pick<Storage, 'getItem' | 'key' | 'length'>): SyncData {
  const data = emptySyncData()
  try {
    let oldFavorites: unknown = []
    try { oldFavorites = JSON.parse(storage.getItem('podcast-favorites') || '[]') } catch {}
    if (Array.isArray(oldFavorites)) for (const id of oldFavorites) {
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id)) data.favorites[id] = { value: true, updatedAt: 0 }
    }
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key?.startsWith('podcast-pos-')) continue
      try {
        const value = JSON.parse(storage.getItem(key) || '{}')
        const id = key.slice('podcast-pos-'.length)
        if (/^[A-Za-z0-9_-]{11}$/.test(id) && Number.isFinite(value.pos) && Number.isFinite(value.dur) && value.dur > 0 && value.dur <= 604800) {
          data.progress[id] = { pos: Math.min(value.dur, Math.max(0, value.pos)), dur: value.dur, updatedAt: 0 }
        }
      } catch {}
    }
    try {
      const stored = JSON.parse(storage.getItem(DATA_KEY) || 'null')
      return stored?.version === 2 ? mergeSyncData(data, validateSyncData(stored)) : data
    } catch { return data }
  } catch { return data }
}

function writeLocalSync(data: SyncData) {
  const set = (key: string, value: string) => { if (localStorage.getItem(key) !== value) localStorage.setItem(key, value) }
  set(DATA_KEY, serialize(data))
  set('podcast-favorites', JSON.stringify(Object.entries(data.favorites).filter(([, item]) => item.value).map(([id]) => id)))
  for (const [id, item] of Object.entries(data.progress)) {
    if (item.deleted) localStorage.removeItem(`podcast-pos-${id}`)
    else set(`podcast-pos-${id}`, JSON.stringify({ pos: item.pos, dur: item.dur }))
  }
}

export function usePodcastSync() {
  const [data, setData] = useState<SyncData>(emptySyncData)
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState('本地模式：收藏、进度和句子本保存在此设备')
  const dataRef = useRef(data)
  const secretRef = useRef('')
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const generationRef = useRef(0)
  const readyRef = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const keepaliveRef = useRef(false)

  const apply = useCallback((next: SyncData, dirty: boolean) => {
    dataRef.current = next
    setData(next)
    if (dirty) dirtyRef.current = true
    try { writeLocalSync(next) } catch { setStatus('本地存储失败，请检查浏览器存储空间或权限') }
  }, [])

  const synchronize = useCallback(async (keepalive = false, force = false) => {
    const credential = secretRef.current
    if (!readyRef.current || !credential || busyRef.current || (!dirtyRef.current && !force)) return
    const generation = generationRef.current
    const controller = new AbortController()
    requestRef.current = controller
    keepaliveRef.current = keepalive
    busyRef.current = true
    setStatus('正在同步…')
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15_000)
    try {
      const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }
      if (!keepalive) {
        const remoteResponse = await fetch('/api/sync', { headers, cache: 'no-store', signal: controller.signal })
        if (!remoteResponse.ok) throw new Error(remoteResponse.status === 401 ? '同步口令不正确，请重新输入' : remoteResponse.status === 429 ? '尝试次数过多，请 10 分钟后再试' : remoteResponse.status === 503 ? '云同步服务尚未配置，数据仍保存在本地' : `读取失败（${remoteResponse.status}），请重试`)
        const remoteValue = await remoteResponse.json()
        const remote = remoteValue ? validateSyncData(remoteValue) : null
        if (generation !== generationRef.current) return
        if (remote) apply(mergeSyncData(dataRef.current, remote), false)
        if (!dirtyRef.current && remote) { setStatus('已同步'); return }
      }
      if (generation !== generationRef.current) return
      const sent = dataRef.current
      const response = await fetch('/api/sync', {
        method: 'POST', headers, body: JSON.stringify(sent), keepalive,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(response.status === 401 ? '同步口令不正确，请重新输入' : response.status === 429 ? '尝试次数过多，请 10 分钟后再试' : response.status === 503 ? '云同步服务尚未配置，数据仍保存在本地' : `保存失败（${response.status}），请重试`)
      const result = await response.json() as { ok: boolean; data: SyncData }
      if (!result.ok || !result.data) throw new Error('同步响应无效，请重试')
      if (generation !== generationRef.current) return
      dirtyRef.current = serialize(dataRef.current) !== serialize(sent)
      apply(mergeSyncData(dataRef.current, validateSyncData(result.data)), false)
      setStatus(dirtyRef.current ? '本地有新变化，等待同步' : '已同步')
    } catch (error) {
      if (generation === generationRef.current && (timedOut || !(error instanceof Error && error.name === 'AbortError'))) {
        setStatus(timedOut ? '同步超时，数据已保存在本地，请重试' : error instanceof Error ? error.message : '网络异常，数据已保存在本地，请重试')
      }
    } finally {
      clearTimeout(timeout)
      if (generation === generationRef.current) { busyRef.current = false; requestRef.current = null }
    }
  }, [apply])

  useEffect(() => {
    let initial = emptySyncData()
    try { initial = readLocalSync(localStorage) } catch {}
    apply(initial, true)
    try {
      const saved = localStorage.getItem(SECRET_KEY) || ''
      if (saved.length >= 4) { secretRef.current = saved; setSecret(saved) }
    } catch {}
    readyRef.current = true
    void synchronize(false, true)
    const interval = setInterval(() => { void synchronize() }, 45_000)
    const onOnline = () => { void synchronize(false, true) }
    const onStorage = (event: StorageEvent) => {
      if (event.key === DATA_KEY && event.newValue) {
        try {
          const next = mergeSyncData(dataRef.current, validateSyncData(JSON.parse(event.newValue)))
          if (serialize(next) !== serialize(dataRef.current)) apply(next, true)
        } catch {}
      }
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('storage', onStorage)
    return () => {
      readyRef.current = false
      generationRef.current++
      busyRef.current = false
      clearInterval(interval)
      if (!keepaliveRef.current) requestRef.current?.abort()
      window.removeEventListener('online', onOnline); window.removeEventListener('storage', onStorage)
    }
  }, [apply, synchronize])

  const configureSecret = useCallback((value: string) => {
    const trimmed = value.trim()
    if (trimmed && trimmed.length < 4) { setStatus('同步口令至少需要 4 位'); return false }
    generationRef.current++
    requestRef.current?.abort()
    busyRef.current = false
    secretRef.current = trimmed
    setSecret(trimmed)
    try { trimmed ? localStorage.setItem(SECRET_KEY, trimmed) : localStorage.removeItem(SECRET_KEY) } catch {}
    if (!trimmed) setStatus('本地模式：收藏、进度和句子本保存在此设备')
    else { dirtyRef.current = true; void synchronize(false, true) }
    return true
  }, [synchronize])

  // Strictly after every known record, so a device with a slow clock still records the latest change as latest.
  const timestamp = () => {
    let latest = Date.now()
    for (const kind of [dataRef.current.favorites, dataRef.current.progress, dataRef.current.phrases]) {
      for (const item of Object.values(kind)) if (item.updatedAt >= latest) latest = item.updatedAt + 1
    }
    return latest
  }

  const toggleFavorite = useCallback((id: string) => {
    const next = dataRef.current
    apply({ ...next, favorites: { ...next.favorites, [id]: { value: !next.favorites[id]?.value, updatedAt: timestamp() } } }, true)
  }, [apply])

  const saveProgress = useCallback((id: string, position: number, duration: number) => {
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return
    const pos = Math.floor(Math.max(0, Math.min(position, duration))), dur = Math.floor(duration)
    const existing = dataRef.current.progress[id]
    if (existing && !existing.deleted && existing.pos === pos && existing.dur === dur) return
    const next = dataRef.current
    apply({ ...next, progress: { ...next.progress, [id]: { pos, dur, updatedAt: timestamp() } } }, true)
  }, [apply])

  const resetProgress = useCallback((id: string) => {
    const next = dataRef.current
    apply({ ...next, progress: { ...next.progress, [id]: { pos: 0, dur: next.progress[id]?.dur || 0, deleted: true, updatedAt: timestamp() } } }, true)
  }, [apply])

  /** Saves (value) or removes a sentence; a removal keeps only a tombstone so older devices cannot revive it. */
  const setPhrase = useCallback((key: string, record: Omit<PhraseRecord, 'updatedAt'>) => {
    const next = dataRef.current
    const item = record.value ? record : { ...record, text: '', zh: '' }
    apply({ ...next, phrases: { ...next.phrases, [key]: { ...item, updatedAt: timestamp() } } }, true)
  }, [apply])

  const phrases = useMemo(() => phraseList(data.phrases), [data.phrases])
  const favorites = useMemo(() => new Set(Object.entries(data.favorites).filter(([, item]) => item.value).map(([id]) => id)), [data.favorites])
  // Unchanged records keep their identity, so memoized rows skip re-rendering on each save.
  const detailCache = useRef(new WeakMap<object, { pos: number; dur: number; updatedAt: number }>())
  const videoDetails = useMemo(() => Object.fromEntries(Object.entries(data.progress).filter(([, item]) => !item.deleted && item.dur > 0).map(([id, item]) => {
    let detail = detailCache.current.get(item)
    if (!detail) { detail = { pos: item.pos, dur: item.dur, updatedAt: item.updatedAt }; detailCache.current.set(item, detail) }
    return [id, detail]
  })), [data.progress])
  const videoProgress = useMemo(() => Object.fromEntries(Object.entries(videoDetails).map(([id, item]) => [id, item.pos / item.dur])), [videoDetails])
  const getProgress = useCallback((id: string) => { const item = dataRef.current.progress[id]; return item && !item.deleted ? { pos: item.pos, dur: item.dur, updatedAt: item.updatedAt } : null }, [])

  return { phrases, setPhrase, favorites, videoDetails, videoProgress, saveProgress, resetProgress, toggleFavorite, getProgress, secret, status, configureSecret, syncNow: synchronize }
}
