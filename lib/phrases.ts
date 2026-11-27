import { MAX_PHRASE_TEXT, type PhraseRecord } from './sync-data'

export interface Phrase { key: string; videoId: string; start: number; end: number; text: string; zh: string; savedAt: number }

export const phraseKey = (videoId: string, start: number) => `${videoId}@${Math.round(start * 100)}`

/** Saved sentences, newest first. */
export function phraseList(records: Record<string, PhraseRecord>): Phrase[] {
  return Object.entries(records)
    .filter(([, r]) => r.value && r.text)
    .map(([key, r]) => ({ key, videoId: key.slice(0, 11), start: r.start, end: r.end, text: r.text, zh: r.zh, savedAt: r.updatedAt }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

/** The stored form of a transcript sentence; a translation identical to the original is not kept. */
export function phraseRecord(seg: { start: number; end: number; ko: string; zh: string }) {
  // One malformed record would make the whole sync payload invalid, so clamp rather than trust the transcript.
  const start = Math.max(0, seg.start || 0)
  return { value: true, start, end: Math.max(start, seg.end || 0), text: seg.ko.trim().slice(0, MAX_PHRASE_TEXT), zh: !seg.zh || seg.zh === seg.ko ? '' : seg.zh.slice(0, MAX_PHRASE_TEXT) }
}
