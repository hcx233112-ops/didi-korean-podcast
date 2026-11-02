export interface FavoriteRecord { value: boolean; updatedAt: number }
export interface ProgressRecord { pos: number; dur: number; updatedAt: number; deleted?: boolean }
export interface SyncData {
  version: 2
  favorites: Record<string, FavoriteRecord>
  progress: Record<string, ProgressRecord>
}

export function emptySyncData(): SyncData {
  return { version: 2, favorites: {}, progress: {} }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const MAX_RECORDS = 2000
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateSyncData(value: unknown, now = Date.now()): SyncData {
  if (!record(value) || value.version !== 2 || !record(value.favorites) || !record(value.progress)) throw new Error('Invalid sync data')
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
  return output
}

export function mergeSyncData(first: SyncData, second: SyncData): SyncData {
  const result: SyncData = { version: 2, favorites: { ...first.favorites }, progress: { ...first.progress } }
  for (const [id, item] of Object.entries(second.favorites)) {
    const old = result.favorites[id]
    if (!old || item.updatedAt > old.updatedAt || (item.updatedAt === old.updatedAt && !item.value)) result.favorites[id] = item
  }
  for (const [id, item] of Object.entries(second.progress)) {
    const old = result.progress[id]
    if (!old || item.updatedAt > old.updatedAt || (item.updatedAt === old.updatedAt
      && (item.deleted || (!old.deleted && (item.pos < old.pos || (item.pos === old.pos && item.dur < old.dur)))))) result.progress[id] = item
  }
  return result
}
