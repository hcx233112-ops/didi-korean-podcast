export interface Video { id: string; title: string; published: string; thumbnail: string; duration?: number; channel?: string }
export interface ProgressDetail { pos: number; dur: number; updatedAt: number }

export const DONE_THRESHOLD = 0.9
const DAY = 86_400_000

export function progressOf(detail?: ProgressDetail) {
  return detail && detail.dur > 0 ? detail.pos / detail.dur : 0
}

export function greeting(hour: number) {
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function inProgressEntries(videos: Video[], details: Record<string, ProgressDetail>) {
  return videos
    .filter(v => { const p = progressOf(details[v.id]); return p > 0 && p < DONE_THRESHOLD })
    .sort((a, b) => details[b.id].updatedAt - details[a.id].updatedAt)
}

/** The most recently touched unfinished episode, else the newest unstarted one. */
export function pickContinue(videos: Video[], details: Record<string, ProgressDetail>): { video: Video; resume: boolean } | null {
  const recent = inProgressEntries(videos, details)[0]
  if (recent) return { video: recent, resume: true }
  const fresh = videos.find(v => !details[v.id])
  return fresh ? { video: fresh, resume: false } : null
}

export function inProgress(videos: Video[], details: Record<string, ProgressDetail>, excludeId?: string, limit = 10) {
  return inProgressEntries(videos, details).filter(v => v.id !== excludeId).slice(0, limit)
}

/** Recent episodes that have never been played, newest first. */
export function newEpisodes(videos: Video[], details: Record<string, ProgressDetail>, now: number, excludeId?: string, limit = 3) {
  return videos.filter(v => {
    const published = Date.parse(v.published)
    return v.id !== excludeId && !details[v.id] && Number.isFinite(published) && now - published <= 14 * DAY
  }).slice(0, limit)
}

/** All channels as one list, newest first, each episode tagged with its channel. */
export function mergeChannels(byChannel: Record<string, Video[]>) {
  const seen = new Set<string>()
  const all: Video[] = []
  for (const [channel, list] of Object.entries(byChannel)) {
    for (const video of list) if (!seen.has(video.id)) { seen.add(video.id); all.push({ ...video, channel }) }
  }
  return all.sort((a, b) => b.published.localeCompare(a.published))
}

function hash(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** A stable per-day suggestion from the unplayed back catalogue. */
export function dailyPick(videos: Video[], details: Record<string, ProgressDetail>, day: string, exclude: string[] = []) {
  const pool = videos.slice(3).filter(v => !details[v.id] && !exclude.includes(v.id))
  return pool.length ? pool[hash(day) % pool.length] : null
}

export function groupByMonth(videos: Video[]) {
  const groups: { key: string; label: string; videos: Video[] }[] = []
  for (const video of videos) {
    const key = video.published.slice(0, 7)
    let group = groups[groups.length - 1]
    if (!group || group.key !== key) {
      const [year, month] = key.split('-')
      group = { key, label: `${year}年${Number(month)}月`, videos: [] }
      groups.push(group)
    }
    group.videos.push(video)
  }
  return groups
}

/** Step back a little on resume so the sentence is heard again; more after a long break. */
export function resumePosition(pos: number, dur: number, updatedAt: number, now: number) {
  if (!(pos > 0) || !(dur > 0) || pos >= dur - 5) return 0
  const rewind = now - updatedAt > DAY ? 10 : 3
  return Math.max(0, pos - rewind)
}

export function formatTime(seconds: number) {
  if (!seconds || !Number.isFinite(seconds)) return '0:00'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function formatDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60), m = minutes % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}
