export interface FavoriteRecord { value: boolean; updatedAt: number }
export interface ProgressRecord { pos: number; dur: number; updatedAt: number; deleted?: boolean }
/** A saved sentence; a removal keeps the key and timestamp but drops the text. */
export interface PhraseRecord { value: boolean; updatedAt: number; start: number; end: number; text: string; zh: string }
export interface SyncData {
  version: 2
  favorites: Record<string, FavoriteRecord>
  progress: Record<string, ProgressRecord>
  phrases: Record<string, PhraseRecord>
}

export function emptySyncData(): SyncData {
  return { version: 2, favorites: {}, progress: {}, phrases: {} }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
export const PHRASE_ID = /^[A-Za-z0-9_-]{11}@\d{1,9}$/
export const MAX_PHRASE_TEXT = 600
const MAX_RECORDS = 2000
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateSyncData(value: unknown, now = Date.now()): SyncData {
  // Phrases arrived later, so data from older clients and stored states may lack them.
  if (!record(value) || value.version !== 2 || !record(value.favorites) || !record(value.progress)
    || (value.phrases !== undefined && !record(value.phrases))) throw new Error('Invalid sync data')
  const output = emptySyncData()
  const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= now + 300_000
  for (const kind of ['favorites', 'progress'] as const) {
    const entries = Object.entries(value[kind] as Record<string, unknown>)
    if (entries.length > MAX_RECORDS) throw new Error('Too many sync records')
    for (const [id, item] of entries) {
      if (!VIDEO_ID.test(id) || !record(item) || !timestamp(item.updatedAt)) throw new Error('Invalid sync record')
      if (kind === 'favorites') {
        if (typeof item.value !== 'boolean') throw new Error('Invalid favorite')
        output.favorites[id] = { value: item.value, updatedAt: item.updatedAt }
      } else {
        if (typeof item.pos !== 'number' || typeof item.dur !== 'number' || !Number.isFinite(item.pos) || !Number.isFinite(item.dur)
          || item.pos < 0 || item.dur < 0 || item.dur > 604_800 || item.pos > item.dur
          || (item.deleted !== undefined && typeof item.deleted !== 'boolean') || (item.deleted && item.pos !== 0)) throw new Error('Invalid progress')
        output.progress[id] = { pos: item.pos, dur: item.dur, updatedAt: item.updatedAt, ...(item.deleted ? { deleted: true } : {}) }
      }
    }
  }
  const phrases = Object.entries((value.phrases ?? {}) as Record<string, unknown>)
  if (phrases.length > MAX_RECORDS) throw new Error('Too many sync records')
  for (const [id, item] of phrases) {
    if (!PHRASE_ID.test(id) || !record(item) || !timestamp(item.updatedAt) || typeof item.value !== 'boolean'
      || typeof item.start !== 'number' || typeof item.end !== 'number' || !Number.isFinite(item.start) || !Number.isFinite(item.end)
      || item.start < 0 || item.end < item.start || item.end > 604_800
      || typeof item.text !== 'string' || typeof item.zh !== 'string' || item.text.length > MAX_PHRASE_TEXT || item.zh.length > MAX_PHRASE_TEXT
      || (item.value && !item.text)) throw new Error('Invalid phrase')
    output.phrases[id] = { value: item.value, updatedAt: item.updatedAt, start: item.start, end: item.end, text: item.text, zh: item.zh }
  }
  return output
}

export function mergeSyncData(first: SyncData, second: SyncData): SyncData {
  const result: SyncData = { version: 2, favorites: { ...first.favorites }, progress: { ...first.progress }, phrases: { ...first.phrases } }
  for (const [id, item] of Object.entries(second.favorites)) {
    const old = result.favorites[id]
    if (!old || item.updatedAt > old.updatedAt || (item.updatedAt === old.updatedAt && !item.value)) result.favorites[id] = item
  }
  for (const [id, item] of Object.entries(second.progress)) {
    const old = result.progress[id]
    if (!old || item.updatedAt > old.updatedAt || (item.updatedAt === old.updatedAt
      && (item.deleted || (!old.deleted && (item.pos < old.pos || (item.pos === old.pos && item.dur < old.dur)))))) result.progress[id] = item
  }
  for (const [id, item] of Object.entries(second.phrases ?? {})) {
    const old = result.phrases[id]
    if (!old || item.updatedAt > old.updatedAt || (item.updatedAt === old.updatedAt && !item.value)) result.phrases[id] = item
  }
  return result
}
