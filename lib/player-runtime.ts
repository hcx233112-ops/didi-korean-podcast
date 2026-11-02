export function createProgressSaver(
  save: (id: string, position: number, duration: number) => void,
  now: () => number = Date.now,
) {
  let lastSavedAt = -Infinity
  let lastId: string | null = null
  return (audio: { currentTime: number; duration: number }, id: string, force = false) => {
    if (!Number.isFinite(audio.currentTime) || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    const time = now()
    if (!force && id === lastId && time - lastSavedAt < 5000) return
    save(id, Math.max(0, Math.min(audio.currentTime, audio.duration)), audio.duration)
    lastSavedAt = time
    lastId = id
  }
}

export function remainingTimerSeconds(deadline: number, now = Date.now()) {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function createPlaybackRequester(onError: (error: unknown) => void) {
  let sequence = 0
  return {
    async play(audio: { play(): Promise<void> }) {
      const request = ++sequence
      try { await audio.play(); return request === sequence }
      catch (error) {
        if (request !== sequence || (error instanceof Error && error.name === 'AbortError')) return false
        onError(error)
        return false
      }
    },
    cancel() { sequence++ },
  }
}

interface TranscriptResult {
  segments?: { start: number; end: number; ko: string; zh: string }[]
}

export function createTranscriptLoader(fetcher: typeof fetch = fetch) {
  let controller: AbortController | null = null
  let sequence = 0
  return {
    async load(id: string): Promise<TranscriptResult | null> {
      controller?.abort()
      controller = new AbortController()
      const request = ++sequence
      try {
        const response = await fetcher(`/data/transcripts/${encodeURIComponent(id)}.json`, { signal: controller.signal })
        if (!response.ok) throw new Error('字幕加载失败，请重试')
        const data = await response.json() as TranscriptResult
        return request === sequence ? data : null
      } catch (error) {
        if (request !== sequence || (error instanceof Error && error.name === 'AbortError')) return null
        throw error
      }
    },
    cancel() { sequence++; controller?.abort() },
  }
}
