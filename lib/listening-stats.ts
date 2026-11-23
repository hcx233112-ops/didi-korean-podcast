import { dayKey } from './library'

export interface ListeningStats { days: Record<string, number> }

export const STATS_KEY = 'podcast-stats-v1'
const KEEP_DAYS = 120
const STREAK_MIN_SECONDS = 60

function shift(date: Date, days: number) {
  const copy = new Date(date)
  copy.setDate(copy.getDate() + days)
  return copy
}

export function addListening(stats: ListeningStats, date: Date, seconds: number): ListeningStats {
  if (!(seconds > 0)) return stats
  const key = dayKey(date)
  const cutoff = dayKey(shift(date, -KEEP_DAYS))
  const days: Record<string, number> = {}
  for (const [day, value] of Object.entries(stats.days)) if (day >= cutoff) days[day] = value
  days[key] = (days[key] || 0) + seconds
  return { days }
}

export function weekSeconds(stats: ListeningStats, today: Date) {
  let total = 0
  for (let i = 0; i < 7; i++) total += stats.days[dayKey(shift(today, -i))] || 0
  return total
}

/** Consecutive listening days ending today, or yesterday when today has not started yet. */
export function streak(stats: ListeningStats, today: Date) {
  const listened = (d: Date) => (stats.days[dayKey(d)] || 0) >= STREAK_MIN_SECONDS
  let cursor = listened(today) ? today : shift(today, -1)
  let count = 0
  while (listened(cursor)) { count++; cursor = shift(cursor, -1) }
  return count
}

export function readStats(storage: Pick<Storage, 'getItem'>): ListeningStats {
  try {
    const value = JSON.parse(storage.getItem(STATS_KEY) || 'null')
    if (value && typeof value.days === 'object' && value.days) {
      const days: Record<string, number> = {}
      for (const [day, seconds] of Object.entries(value.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && seconds > 0 && seconds < 86_400) days[day] = seconds
      }
      return { days }
    }
  } catch {}
  return { days: {} }
}
