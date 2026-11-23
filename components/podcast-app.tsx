'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import channelsData from '@/data/channels.json'
import { usePodcastSync } from '@/hooks/use-podcast-sync'
import { coverColor } from '@/lib/cover-color'
import { DONE_THRESHOLD, type Video, formatTime, resumePosition } from '@/lib/library'
import { STATS_KEY, type ListeningStats, addListening, readStats, streak, weekSeconds } from '@/lib/listening-stats'
import { createPlaybackRequester, createProgressSaver, createTranscriptLoader, remainingTimerSeconds } from '@/lib/player-runtime'
import { type Channel, HomeView } from './home-view'
import { FullPlayer, MiniPlayer, Sheet, TimerOptions, type TranscriptSegment } from './player-view'

const channels: Channel[] = channelsData
const SPEEDS = [0.8, 1, 1.2, 1.5, 2]
const RAW_AUDIO_BASE = process.env.NEXT_PUBLIC_AUDIO_BASE || '/audio/'
const AUDIO_BASE = RAW_AUDIO_BASE.endsWith('/') ? RAW_AUDIO_BASE : RAW_AUDIO_BASE + '/'
const DEFAULT_TINT = '60 42 96'
// .mp4 is cached at the CDN edge (the file is the same m4a); bump v to invalidate every cached episode.
const AUDIO_VERSION = '1'
const audioUrl = (id: string) => AUDIO_BASE + encodeURIComponent(id) + (AUDIO_BASE.startsWith('http') ? `.mp4?v=${AUDIO_VERSION}` : '.m4a')

/** Asking the edge for one byte makes it fetch and cache the whole episode. */
function warmEpisode(id: string) {
  if (!AUDIO_BASE.startsWith('http')) return
  fetch(audioUrl(id), { headers: { Range: 'bytes=0-1' }, mode: 'cors', cache: 'no-store' }).catch(() => {})
}

type SheetName = 'timer' | 'note' | 'settings'

export default function PodcastApp({ initialVideos }: { initialVideos: Record<string, Video[]> }) {
  const channel = channels[0]
  const [videos, setVideos] = useState<Video[]>(initialVideos[channel.id] ?? [])
  const [listError, setListError] = useState<string | null>(null)
  const [listRetry, setListRetry] = useState(0)
  const [hydrated, setHydrated] = useState(false)

  const [current, setCurrent] = useState<Video | null>(null)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  const [player, setPlayer] = useState<{ page: 0 | 1 } | null>(null)
  const [closingPlayer, setClosingPlayer] = useState(false)
  const [sheet, setSheet] = useState<SheetName | null>(null)
  const [closingSheet, setClosingSheet] = useState(false)
  const [tint, setTint] = useState(DEFAULT_TINT)
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null)

  const [timerMinutes, setTimerMinutes] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [stopAfterCurrent, setStopAfterCurrent] = useState(false)

  const [showTranslation, setShowTranslation] = useState(false)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptRetry, setTranscriptRetry] = useState(0)

  const [notes, setNotes] = useState<Record<string, string>>({})
  const [noteText, setNoteText] = useState('')
  const [secretInput, setSecretInput] = useState('')
  const [stats, setStats] = useState<ListeningStats>({ days: {} })

  const sync = usePodcastSync()
  const { favorites, videoDetails, videoProgress, saveProgress, getProgress, syncNow } = sync

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadlineRef = useRef<number | null>(null)
  const blockAutoAdvanceRef = useRef(false)
  const requester = useRef(createPlaybackRequester(() => { setPlaying(false); setPlaybackError('音频暂时无法播放，请检查网络后重试') })).current
  const transcriptLoader = useRef(createTranscriptLoader()).current
  const progressSaver = useRef(createProgressSaver(saveProgress)).current
  const seekingRef = useRef(false)
  const resumeAtRef = useRef(0)
  const currentIdRef = useRef<string | null>(null)
  const stopAfterCurrentRef = useRef(false)
  const videosRef = useRef(videos)
  const playRef = useRef<(v: Video, automatic?: boolean) => void>(() => {})
  const lastPosRef = useRef<number | null>(null)
  const pendingListenRef = useRef(0)
  const warmedRef = useRef<string | null>(null)
  const lastFractionRef = useRef(-1)
  // Re-read on return: an iOS home-screen app can sit in the background for days.
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setClock(Date.now()) }
    refresh()
    const interval = setInterval(refresh, 5 * 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  useEffect(() => { stopAfterCurrentRef.current = stopAfterCurrent }, [stopAfterCurrent])
  useEffect(() => { videosRef.current = videos }, [videos])

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])

  // The list is prerendered; this only picks up episodes published after the last deploy.
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/data/videos/${channel.id}.json`, { signal: controller.signal, cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then((data: { videos?: Video[] }) => {
        if (!Array.isArray(data.videos)) throw new Error()
        setVideos(data.videos); setListError(null)
      })
      .catch(error => { if (error?.name !== 'AbortError') setListError('节目列表加载失败，请检查网络后重试') })
    return () => controller.abort()
  }, [channel.id, listRetry])

  useEffect(() => {
    try {
      setShowTranslation(localStorage.getItem('podcast-translation') === '1')
      const speed = Number(localStorage.getItem('podcast-speed') || '1')
      if (SPEEDS.includes(speed)) setRate(speed)
      const loaded: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('podcast-note-')) loaded[key.slice(13)] = localStorage.getItem(key) || ''
      }
      setNotes(loaded)
      setStats(readStats(localStorage))
    } catch {}
    setHydrated(true)
  }, [])

  useEffect(() => { if (hydrated) try { localStorage.setItem('podcast-translation', showTranslation ? '1' : '0') } catch {} }, [showTranslation, hydrated])
  useEffect(() => { if (hydrated) try { localStorage.setItem('podcast-speed', String(rate)) } catch {} }, [rate, hydrated])

  const flushListening = useCallback(() => {
    const seconds = Math.round(pendingListenRef.current)
    if (seconds < 1) return
    pendingListenRef.current -= seconds
    setStats(prev => {
      const next = addListening(prev, new Date(), seconds)
      try { localStorage.setItem(STATS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const persistCurrent = useCallback((force = false) => {
    if (currentIdRef.current && audioRef.current) progressSaver(audioRef.current, currentIdRef.current, force)
  }, [progressSaver])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { persistCurrent(true); flushListening(); void syncNow(true) }
      else { void syncNow(false, true); checkTimer() }
    }
    const onPageHide = () => { persistCurrent(true); flushListening(); void syncNow(true) }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onPageHide) }
  }, [persistCurrent, syncNow, flushListening]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!current) return
    let active = true
    coverColor(current.thumbnail).then(color => { if (active) setTint(color ?? DEFAULT_TINT) })
    return () => { active = false }
  }, [current])

  function showToast(text: string) { setToast({ text, key: Date.now() }) }
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  function nextOf(id: string | null, step: 1 | -1, skipFinished = false) {
    const list = videosRef.current
    const idx = list.findIndex(v => v.id === id)
    if (idx < 0) return null
    for (let i = idx + step; i >= 0 && i < list.length; i += step) {
      if (!skipFinished || (videoProgressRef.current[list[i].id] ?? 0) < DONE_THRESHOLD) return list[i]
    }
    return null
  }

  function tick() {
    const a = audioRef.current
    if (!a || seekingRef.current) return
    const cur = a.currentTime || 0, dur = a.duration || 0, paused = a.paused
    if (!paused && lastPosRef.current !== null) {
      const delta = cur - lastPosRef.current
      if (delta > 0 && delta < 4 * a.playbackRate) pendingListenRef.current += delta / a.playbackRate
      if (pendingListenRef.current >= 15) flushListening()
    }
    lastPosRef.current = paused ? null : cur
    const id = currentIdRef.current
    if (!paused && dur > 0) {
      // Celebrate only a crossing heard in playback, not a seek or a resume past the line.
      const fraction = cur / dur, last = lastFractionRef.current
      if (last >= 0 && last < DONE_THRESHOLD && fraction >= DONE_THRESHOLD && fraction - last < 0.02) showToast('又听完一集 🎉')
      lastFractionRef.current = fraction
    }
    if (!paused && dur > 0 && cur > 20 && id && warmedRef.current !== id) {
      warmedRef.current = id
      const next = nextOf(id, 1, true)
      if (next) warmEpisode(next.id)
    }
    if (document.visibilityState === 'hidden') { persistCurrent(); return }
    setPlaying(prev => prev === !paused ? prev : !paused)
    setElapsed(cur)
    setDuration(dur)
    if ('mediaSession' in navigator && dur > 0 && isFinite(dur)) {
      try {
        navigator.mediaSession.playbackState = paused ? 'paused' : 'playing'
        navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(cur, dur), playbackRate: a.playbackRate })
      } catch {}
    }
    persistCurrent()
  }
  const videoProgressRef = useRef(videoProgress)
  useEffect(() => { videoProgressRef.current = videoProgress }, [videoProgress])
  const tickRef = useRef(tick)
  tickRef.current = tick

  function ensureAudio() {
    if (audioRef.current) return audioRef.current
    const a = document.querySelector<HTMLAudioElement>('audio[data-player]') ?? new Audio()
    a.preload = 'auto'
    a.addEventListener('play', () => { if (!a.paused) setPlaying(true) })
    a.addEventListener('pause', () => { if (a.paused) { setPlaying(false); lastPosRef.current = null; persistCurrent(true); flushListening(); void syncNow(true) } })
    a.addEventListener('timeupdate', () => { persistCurrent(); checkTimer() })
    a.addEventListener('seeked', () => { lastPosRef.current = null; persistCurrent(true) })
    a.addEventListener('error', () => {
      if (!a.error || a.error.code === 1 || (a.currentSrc && a.currentSrc !== a.src)) return
      setPlaying(false); setPlaybackError('音频暂时无法播放，请检查网络后重试')
    })
    a.addEventListener('ended', () => {
      if (currentIdRef.current && a.duration > 0) saveProgress(currentIdRef.current, a.duration, a.duration)
      checkTimer()
      if (blockAutoAdvanceRef.current) { setPlaying(false); return }
      if (stopAfterCurrentRef.current) { setStopAfterCurrent(false); setPlaying(false); return }
      const next = nextOf(currentIdRef.current, 1, true)
      if (next) playRef.current(next, true)
      else setPlaying(false)
    })
    a.addEventListener('loadedmetadata', () => {
      const at = resumeAtRef.current
      if (at > 0 && a.duration && at < a.duration - 2) a.currentTime = at
      resumeAtRef.current = 0
    })
    audioRef.current = a
    return a
  }

  function setupMediaSession(video: Video) {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: video.title, artist: channel.name,
      artwork: [{ src: video.thumbnail.replace('mqdefault', 'hqdefault'), sizes: '480x360', type: 'image/jpeg' }],
    })
    navigator.mediaSession.setActionHandler('play', () => requestPlayback())
    navigator.mediaSession.setActionHandler('pause', () => { requester.cancel(); audioRef.current?.pause(); setPlaying(false) })
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15))
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30))
    navigator.mediaSession.setActionHandler('seekto', d => { if (audioRef.current && typeof d.seekTime === 'number') audioRef.current.currentTime = d.seekTime })
  }

  function play(video: Video, automatic = false) {
    checkTimer()
    if (automatic && blockAutoAdvanceRef.current) return
    persistCurrent(true)
    flushListening()
    const a = ensureAudio()
    requester.cancel()
    a.pause()
    currentIdRef.current = video.id
    lastPosRef.current = null
    lastFractionRef.current = -1
    const saved = getProgress(video.id)
    resumeAtRef.current = saved ? resumePosition(saved.pos, saved.dur, saved.updatedAt, Date.now()) : 0
    setPlaybackError(null)
    setCurrent(video)
    setElapsed(resumeAtRef.current); setDuration(saved?.dur ?? video.duration ?? 0)
    a.src = audioUrl(video.id)
    a.playbackRate = rate
    requestPlayback(automatic)
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => tickRef.current(), 1000)
    setupMediaSession(video)
    fetch(`/data/transcripts/${encodeURIComponent(video.id)}.json`).catch(() => {})
  }
  playRef.current = play

  function requestPlayback(automatic = false) {
    const a = audioRef.current
    if (!a) return
    checkTimer()
    if (automatic && blockAutoAdvanceRef.current) return
    if (!automatic) blockAutoAdvanceRef.current = false
    setPlaybackError(null)
    void requester.play(a)
  }

  function togglePlay() {
    const a = audioRef.current
    if (!a) return
    if (a.paused) requestPlayback()
    else { requester.cancel(); a.pause(); setPlaying(false) }
  }

  function skip(seconds: number) {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(a.duration || Infinity, (a.currentTime || 0) + seconds))
    setElapsed(a.currentTime)
  }

  function seek(fraction: number, commit: boolean) {
    const a = audioRef.current
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return
    seekingRef.current = !commit
    if (!commit) return
    a.currentTime = fraction * a.duration
    setElapsed(a.currentTime)
    persistCurrent(true)
  }

  function checkTimer() {
    if (deadlineRef.current === null) return
    const remaining = remainingTimerSeconds(deadlineRef.current)
    setTimeLeft(remaining)
    if (remaining === 0) {
      blockAutoAdvanceRef.current = true
      requester.cancel()
      deadlineRef.current = null
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      audioRef.current?.pause()
      persistCurrent(true)
      setPlaying(false); setTimeLeft(null); setTimerMinutes(0)
    }
  }

  function startTimer(minutes: number) {
    setTimerMinutes(minutes)
    if (timerRef.current) clearInterval(timerRef.current)
    deadlineRef.current = minutes > 0 ? Date.now() + minutes * 60_000 : null
    if (!minutes) { setTimeLeft(null); setStopAfterCurrent(false); closeSheet(); return }
    setStopAfterCurrent(false)
    checkTimer()
    timerRef.current = setInterval(checkTimer, 1000)
    closeSheet()
    showToast(`${minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}后停止播放`)
  }

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (pollRef.current) clearInterval(pollRef.current)
    transcriptLoader.cancel()
    requester.cancel()
  }, [transcriptLoader, requester])

  function cycleRate() {
    const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length]
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  function openSheet(name: SheetName) { setClosingSheet(false); setSheet(name) }
  function closeSheet() { setClosingSheet(true); setTimeout(() => { setSheet(null); setClosingSheet(false) }, 280) }
  function openPlayer(page: 0 | 1) { setClosingPlayer(false); setPlayer({ page }) }
  function closePlayer() { setClosingPlayer(true); setTimeout(() => { setPlayer(null); setClosingPlayer(false) }, 360) }

  function saveNote(id: string, text: string) {
    const t = text.trim()
    setNotes(prev => { const n = { ...prev }; if (t) n[id] = t; else delete n[id]; return n })
    try { if (t) localStorage.setItem(`podcast-note-${id}`, t); else localStorage.removeItem(`podcast-note-${id}`) }
    catch { setPlaybackError('备注保存失败，请检查浏览器存储空间') }
  }

  // Warm the episode the home screen is most likely to start.
  useEffect(() => {
    if (!hydrated) return
    const recent = Object.entries(videoDetails).filter(([, d]) => d.pos / d.dur < DONE_THRESHOLD).sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0]
    warmEpisode(recent?.[0] ?? videos[0]?.id)
  }, [hydrated]) // eslint-disable-line react-hooks/exhaustive-deps

  const subtitleId = player ? current?.id : undefined
  useEffect(() => {
    if (!subtitleId) return
    let active = true
    setTranscriptLoading(true); setTranscriptError(null); setSegments([])
    void transcriptLoader.load(subtitleId).then(data => {
      if (!active || !data) return
      if (data.segments?.length) setSegments(data.segments)
      else setTranscriptError('这一期暂时没有字幕')
    }).catch(() => { if (active) setTranscriptError('字幕加载失败，请重试') })
      .finally(() => { if (active) setTranscriptLoading(false) })
    return () => { active = false; transcriptLoader.cancel() }
  }, [subtitleId, transcriptRetry, transcriptLoader])

  const currentSegIdx = useMemo(() => {
    if (!segments.length || elapsed < segments[0].start) return -1
    let lo = 0, hi = segments.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segments[mid].start <= elapsed) lo = mid; else hi = mid - 1 }
    return lo
  }, [segments, elapsed])

  // Stable callbacks keep memoized rows from re-rendering every second.
  const handlers = useRef({ play, togglePlay, openPlayer })
  handlers.current = { play, togglePlay, openPlayer }
  // Tapping the episode that is already loaded opens it rather than pausing it.
  const onPlay = useCallback((v: Video) => {
    if (currentIdRef.current === v.id && audioRef.current) handlers.current.openPlayer(0)
    else handlers.current.play(v)
  }, [])
  const onContinue = useCallback((v: Video) => {
    if (currentIdRef.current === v.id && audioRef.current) handlers.current.togglePlay()
    else handlers.current.play(v)
  }, [])
  const onToggleFav = useCallback((id: string) => sync.toggleFavorite(id), [sync.toggleFavorite]) // eslint-disable-line react-hooks/exhaustive-deps
  const onResetProgress = useCallback((id: string) => {
    if (currentIdRef.current === id && audioRef.current) { audioRef.current.currentTime = 0; lastFractionRef.current = -1 }
    sync.resetProgress(id)
  }, [sync.resetProgress]) // eslint-disable-line react-hooks/exhaustive-deps
  const onSeekSegment = useCallback((start: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = start
    if (a.paused) handlers.current.togglePlay()
  }, [])
  const onOpenSettings = useCallback(() => { setSecretInput(sync.secret); openSheet('settings') }, [sync.secret])
  const onRetryList = useCallback(() => setListRetry(v => v + 1), [])

  const homeStats = useMemo(() => {
    const today = new Date(clock)
    return {
      week: weekSeconds(stats, today), streak: streak(stats, today),
      finished: Object.values(videoProgress).filter(p => p >= DONE_THRESHOLD).length,
    }
  }, [stats, videoProgress, clock])

  const timerLabel = timeLeft !== null ? formatTime(timeLeft) : stopAfterCurrent ? '本集结束' : null
  const progress = duration > 0 ? elapsed / duration : 0

  return (
    <div className="h-dvh overflow-y-auto overflow-x-hidden" style={{ background: 'var(--bg)' }}>
      <audio data-player playsInline preload="auto" style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />
      <div className="fixed top-0 inset-x-0 z-20 glass" style={{ height: 'env(safe-area-inset-top)' }} />

      <HomeView hydrated={hydrated} videos={videos} details={videoDetails} favorites={favorites} notes={notes}
        currentId={current?.id ?? null} playing={playing} stats={homeStats} channel={channel}
        listError={listError} onRetryList={onRetryList} onPlay={onPlay} onContinue={onContinue} now={clock} onToggleFav={onToggleFav}
        onResetProgress={onResetProgress} onOpenSettings={onOpenSettings} />

      {playbackError && (
        <div role="alert" className="fixed left-3 right-3 z-40 p-3.5 rounded-2xl text-sm flex items-center gap-3 glass" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 92px)', border: '1px solid var(--line)' }}>
          <p className="flex-1">{playbackError}</p>
          <button className="tap font-semibold" style={{ color: 'var(--accent)' }} onClick={() => current && play(current)}>重试播放</button>
        </div>
      )}

      {current && <div style={{ height: 'calc(env(safe-area-inset-bottom) + 96px)' }} />}
      {current && !player && (
        <MiniPlayer video={current} playing={playing} progress={progress} timerLabel={timerLabel}
          onToggle={togglePlay} onOpen={openPlayer}
          onPrev={() => { const v = nextOf(current.id, -1); if (v) play(v) }}
          onNext={() => { const v = nextOf(current.id, 1); if (v) play(v) }} />
      )}

      {current && player && (
        <FullPlayer video={current} initialPage={player.page} closing={closingPlayer} tint={tint}
          playing={playing} elapsed={elapsed} duration={duration} rate={rate} timerLabel={timerLabel}
          isFav={favorites.has(current.id)} hasNote={!!notes[current.id]}
          segments={segments} transcriptLoading={transcriptLoading} transcriptError={transcriptError}
          currentSegIdx={currentSegIdx} showTranslation={showTranslation}
          onClose={closePlayer} onToggle={togglePlay} onSkip={skip} onSeek={seek} onCycleRate={cycleRate}
          onOpenTimer={() => openSheet('timer')} onToggleFav={() => sync.toggleFavorite(current.id)}
          onOpenNote={() => { setNoteText(notes[current.id] || ''); openSheet('note') }}
          onSeekSegment={onSeekSegment} onRetryTranscript={() => setTranscriptRetry(v => v + 1)}
          onToggleTranslation={() => setShowTranslation(v => !v)} />
      )}

      {sheet === 'timer' && (
        <Sheet title="定时停止" closing={closingSheet} onClose={closeSheet}>
          <TimerOptions activeMinutes={timeLeft !== null ? timerMinutes : 0} stopAfterCurrent={stopAfterCurrent} onPick={startTimer}
            onToggleAfterCurrent={() => {
              const next = !stopAfterCurrent
              if (next) { deadlineRef.current = null; if (timerRef.current) clearInterval(timerRef.current); setTimeLeft(null); setTimerMinutes(0) }
              setStopAfterCurrent(next); closeSheet()
              if (next) showToast('这一集放完就停')
            }} />
        </Sheet>
      )}

      {sheet === 'note' && current && (
        <Sheet title="备注" closing={closingSheet} onClose={closeSheet} z={80}>
          <textarea aria-label="节目备注" value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="记下这一期的想法、生词…" rows={4}
            className="w-full px-4 py-3 rounded-2xl text-[15px] resize-none outline-none" style={{ background: 'var(--surface-2)', color: 'var(--text)' }} />
          <div className="flex gap-3 mt-3">
            {notes[current.id] && (
              <button className="tap flex-1 py-3 rounded-2xl font-semibold" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}
                onClick={() => { saveNote(current.id, ''); closeSheet() }}>删除</button>
            )}
            <button className="tap flex-1 py-3 rounded-2xl font-semibold" style={{ background: 'var(--accent)', color: '#000' }}
              onClick={() => { saveNote(current.id, noteText); closeSheet() }}>保存</button>
          </div>
        </Sheet>
      )}

      {sheet === 'settings' && (
        <Sheet title="设置" closing={closingSheet} onClose={closeSheet} z={90}>
          <div className="grid grid-cols-3 gap-2.5 mb-5 text-center">
            {[
              ['本周收听', homeStats.week ? formatTime(homeStats.week) : '0:00'],
              ['连续天数', `${homeStats.streak} 天`],
              ['已听完', `${homeStats.finished} 集`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl py-3" style={{ background: 'var(--surface-2)' }}>
                <p className="text-[17px] font-bold tabular-nums">{value}</p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>{label}</p>
              </div>
            ))}
          </div>
          <h3 className="font-semibold">云同步</h3>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-2)' }}>在每台设备输入同一个口令，收藏和收听进度就会自动同步。只需输入一次，之后会记住。</p>
          <label htmlFor="sync-secret" className="block text-[13px] mt-3" style={{ color: 'var(--text-2)' }}>同步口令</label>
          <input id="sync-secret" type="password" autoComplete="current-password" spellCheck={false} value={secretInput} onChange={e => setSecretInput(e.target.value)}
            placeholder="至少 4 位" onKeyDown={e => { if (e.key === 'Enter') sync.configureSecret(secretInput) }}
            className="w-full rounded-xl p-3 mt-1.5 outline-none" style={{ background: 'var(--surface-2)', color: 'var(--text)' }} />
          <p role="status" className="text-[13px] mt-2" style={{ color: 'var(--text-2)' }}>{sync.status}</p>
          <div className="flex flex-wrap gap-2.5 mt-3">
            <button className="tap rounded-xl px-4 py-2.5 font-semibold" style={{ background: 'var(--accent)', color: '#000' }} onClick={() => sync.configureSecret(secretInput)}>{sync.secret ? '更换口令' : '开启同步'}</button>
            {sync.secret && <button className="tap rounded-xl px-4 py-2.5" style={{ background: 'var(--surface-2)' }} onClick={() => { void syncNow(false, true) }}>立即同步</button>}
            {sync.secret && <button className="tap rounded-xl px-4 py-2.5" style={{ background: 'var(--surface-2)' }} onClick={() => { sync.configureSecret(''); setSecretInput('') }}>关闭同步</button>}
          </div>
        </Sheet>
      )}

      {toast && (
        <div key={toast.key} role="status" className="fixed left-1/2 z-[100] px-5 py-3 rounded-full text-[14px] font-semibold shadow-2xl glass"
          style={{ top: 'calc(env(safe-area-inset-top) + 12px)', border: '1px solid var(--line)', animation: 'toast 2.6s var(--ease) both' }}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
