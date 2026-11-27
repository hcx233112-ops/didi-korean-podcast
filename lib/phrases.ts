export interface Phrase { key: string; videoId: string; start: number; end: number; text: string; zh: string; savedAt: number }

export const PHRASES_KEY = 'podcast-phrases-v1'
const MAX_PHRASES = 1000
const MAX_TEXT = 600

export const phraseKey = (videoId: string, start: number) => `${videoId}@${Math.round(start * 100)}`

function valid(item: unknown): item is Phrase {
  if (!item || typeof item !== 'object') return false
  const p = item as Record<string, unknown>
  return typeof p.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(p.videoId)
    && typeof p.start === 'number' && typeof p.end === 'number' && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start >= 0 && p.end >= p.start
    && typeof p.text === 'string' && p.text.length > 0 && p.text.length <= MAX_TEXT
    && typeof p.zh === 'string' && p.zh.length <= MAX_TEXT
    && typeof p.savedAt === 'number' && Number.isFinite(p.savedAt)
}

/** Saved sentences, newest first; anything malformed is dropped rather than breaking the page. */
export function readPhrases(storage: Pick<Storage, 'getItem'>): Phrase[] {
  try {
    const raw = JSON.parse(storage.getItem(PHRASES_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const list: Phrase[] = []
    for (const item of raw) {
      if (!valid(item)) continue
      const key = phraseKey(item.videoId, item.start)
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ key, videoId: item.videoId, start: item.start, end: item.end, text: item.text, zh: item.zh, savedAt: item.savedAt })
    }
    return list.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_PHRASES)
  } catch { return [] }
}

export function togglePhrase(list: Phrase[], videoId: string, seg: { start: number; end: number; ko: string; zh: string }, now = Date.now()): Phrase[] {
  const key = phraseKey(videoId, seg.start)
  if (list.some(p => p.key === key)) return list.filter(p => p.key !== key)
  const phrase: Phrase = { key, videoId, start: seg.start, end: seg.end, text: seg.ko.slice(0, MAX_TEXT), zh: seg.zh === seg.ko ? '' : seg.zh.slice(0, MAX_TEXT), savedAt: now }
  return [phrase, ...list].slice(0, MAX_PHRASES)
}
