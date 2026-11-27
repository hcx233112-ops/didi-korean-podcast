export type DrillMode = 'off' | 'loop' | 'shadow'
export interface Span { start: number; end: number }

export const DRILL_LABEL: Record<DrillMode, string> = { off: '练习', loop: '单句循环', shadow: '逐句跟读' }
// Stop a hair early so the next sentence's first syllable never leaks through.
const EARLY = 0.06
const LOOP_GAP_MS = 600

/** Index of the last segment starting at or before `time`, or -1 before the first. */
export function segmentAt(segments: Span[], time: number) {
  if (!segments.length || time < segments[0].start) return -1
  let lo = 0, hi = segments.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segments[mid].start <= time) lo = mid; else hi = mid - 1 }
  return lo
}

/** The sentence to drill from `time`: a silent gap belongs to the sentence after it. */
export function drillAnchor(segments: Span[], time: number) {
  if (!segments.length) return -1
  const idx = segmentAt(segments, time)
  if (idx < 0) return 0
  return time > segments[idx].end && idx + 1 < segments.length ? idx + 1 : idx
}

/** How long to stay quiet so the listener can say the sentence back. */
export function shadowGapMs(seg: Span, scale: number) {
  return Math.round(Math.min(15_000, Math.max(1_200, (seg.end - seg.start) * scale * 1000 + 500)))
}

export type DrillStep =
  | { kind: 'none' }
  | { kind: 'anchor' }
  | { kind: 'pause'; waitMs: number; resumeAt: number | null; next: number }

/** What playback should do at `time` while drilling sentence `idx`. */
export function drillStep(mode: DrillMode, segments: Span[], idx: number, time: number, scale = 1.2): DrillStep {
  if (mode === 'off' || idx < 0 || idx >= segments.length) return { kind: 'none' }
  const seg = segments[idx]
  // Before the sentence is just the gap leading into it; seeks re-anchor through their own event.
  if (time > seg.end + 1.5) return { kind: 'anchor' }
  if (time < seg.end - EARLY) return { kind: 'none' }
  if (mode === 'loop') return { kind: 'pause', waitMs: LOOP_GAP_MS, resumeAt: seg.start, next: idx }
  return { kind: 'pause', waitMs: shadowGapMs(seg, scale), resumeAt: null, next: idx + 1 }
}

/** "Replay this sentence"; pressed right at a sentence start it steps back one, like a previous-track button. */
export function replayTarget(segments: Span[], time: number) {
  const idx = segmentAt(segments, time)
  if (idx < 0) return null
  return time - segments[idx].start < 0.8 && idx > 0 ? idx - 1 : idx
}

/** Words of a sentence, stripped of punctuation, for dictionary lookups. */
export function lookupWords(text: string) {
  const seen = new Set<string>()
  const words: string[] = []
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (word && !seen.has(word)) { seen.add(word); words.push(word) }
  }
  return words.slice(0, 24)
}

export function dictionaryUrl(word: string, lang?: string) {
  const q = encodeURIComponent(word)
  return lang === 'en' ? `https://dict.youdao.com/result?word=${q}&lang=en` : `https://korean.dict.naver.com/kozhdict/#/search?query=${q}`
}
