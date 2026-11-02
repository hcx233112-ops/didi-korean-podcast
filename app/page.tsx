'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import channelsData from '@/data/channels.json'
import { usePodcastSync } from '@/hooks/use-podcast-sync'
import { createProgressSaver, createTranscriptLoader, createPlaybackRequester, remainingTimerSeconds } from '@/lib/player-runtime'

interface Channel { id: string; name: string; description: string; initial: string; color: string; channelId?: string; avatar?: string }
interface Video { id: string; title: string; published: string; thumbnail: string; duration?: number }
interface TranscriptSegment { start: number; end: number; ko: string; zh: string }
interface ChannelVideos { channelName: string; videos: Video[] }

const DONE_THRESHOLD = 0.9

const HOUR_VALUES = [0, 1, 2, 3, 4, 5]
const MIN_VALUES = Array.from({ length: 60 }, (_, i) => i)

function ScrollPicker({ values, selected, onChange, label }: {
  values: number[]; selected: number; onChange: (v: number) => void; label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const H = 44
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const idx = values.indexOf(selected)
    el.scrollTop = (idx < 0 ? 0 : idx) * H
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  function handleScroll() {
    const el = ref.current
    if (!el) return
    const idx = Math.round(el.scrollTop / H)
    onChange(values[Math.max(0, Math.min(idx, values.length - 1))])
  }
  return (
    <div className="relative flex-1 select-none">
      <div ref={ref} onScroll={handleScroll} role="spinbutton" tabIndex={0}
        aria-label={label} aria-valuemin={values[0]} aria-valuemax={values[values.length - 1]} aria-valuenow={selected}
        onKeyDown={e => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          const index = e.key === 'Home' ? 0 : e.key === 'End' ? values.length - 1 : Math.max(0, Math.min(values.length - 1, values.indexOf(selected) + (e.key === 'ArrowDown' ? 1 : -1)))
          onChange(values[index])
          if (ref.current) ref.current.scrollTop = index * H
        }}
        className="scroll-picker overflow-y-scroll"
        style={{ height: H * 5, scrollSnapType: 'y mandatory' }}>
        <div style={{ height: H * 2 }} />
        {values.map(v => (
          <div key={v} className="flex items-center justify-center text-[22px] font-medium"
            style={{ height: H, scrollSnapAlign: 'center',
              color: v === selected ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
            {String(v).padStart(2, '0')}
          </div>
        ))}
        <div style={{ height: H * 2 }} />
      </div>
      <div className="absolute inset-x-0 pointer-events-none"
        style={{ top: H * 2, height: H, borderTop: '1px solid var(--separator)', borderBottom: '1px solid var(--separator)' }} />
      <p className="text-[11px] text-center pt-1" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
    </div>
  )
}

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2]
const RAW_AUDIO_BASE = process.env.NEXT_PUBLIC_AUDIO_BASE || '/audio/'
const AUDIO_BASE = RAW_AUDIO_BASE.endsWith('/') ? RAW_AUDIO_BASE : RAW_AUDIO_BASE + '/'
const channels: Channel[] = channelsData

function formatTime(s: number) {
  if (!s || isNaN(s)) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}
const dateCache = new Map<string, string>()
function formatDate(s: string) {
  let d = dateCache.get(s)
  if (!d) {
    d = new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
    dateCache.set(s, d)
  }
  return d
}

type SheetName = 'channel' | 'timer' | 'transcript' | 'note'
type FilterType = 'all' | 'fav' | 'inprogress' | 'done'

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'fav', label: '收藏' },
  { key: 'inprogress', label: '进行中' },
  { key: 'done', label: '已听完' },
]

export default function Home() {
  const [activeChannelId, setActiveChannelId] = useState(channels[0].id)
  const [channelVideos, setChannelVideos] = useState<Record<string, Video[]>>({})
  const [showChannelPicker, setShowChannelPicker] = useState(false)
  const [current, setCurrent] = useState<Video | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [showTimer, setShowTimer] = useState(false)
  const [timerMinutes, setTimerMinutes] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const [transcriptSegs, setTranscriptSegs] = useState<TranscriptSegment[]>([])
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptRetry, setTranscriptRetry] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [filter, setFilter] = useState<FilterType>('all')
  const [closingSheet, setClosingSheet] = useState<SheetName | null>(null)
  const [stopAfterCurrent, setStopAfterCurrent] = useState(false)
  const [pickerHours, setPickerHours] = useState(0)
  const [pickerMins, setPickerMins] = useState(0)
  // Feature: notes
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [noteVideoId, setNoteVideoId] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [showNote, setShowNote] = useState(false)
  // Feature: search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  // Pull-to-close
  const [pullY, setPullY] = useState(0)
  const [listError, setListError] = useState<string | null>(null)
  const [listRetry, setListRetry] = useState(0)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [showSyncSettings, setShowSyncSettings] = useState(false)
  const [secretInput, setSecretInput] = useState('')
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const { favorites, videoProgress, videoDetails, saveProgress, resetProgress: clearSavedProgress, toggleFavorite: changeFavorite, getProgress, secret, status: syncStatus, configureSecret, syncNow } = usePodcastSync()

  const playerRef = useRef<HTMLAudioElement | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadlineRef = useRef<number | null>(null)
  const blockAutoAdvanceRef = useRef(false)
  const playbackRequesterRef = useRef(createPlaybackRequester(() => {
    setPlaying(false); setPlaybackError('音频暂时无法播放，请检查网络后重试')
  }))
  const transcriptLoaderRef = useRef(createTranscriptLoader())
  const seekingRef = useRef(false)
  const transcriptListRef = useRef<HTMLDivElement>(null)
  const transcriptHeaderRef = useRef<HTMLDivElement>(null)
  const userScrollingRef = useRef(false)
  const scrollIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedPosRef = useRef(0)
  const currentIdRef = useRef<string | null>(null)
  const progressSaverRef = useRef(createProgressSaver(saveProgress))
  const stopAfterCurrentRef = useRef(false)
  const videosRef = useRef<Video[]>([])
  const playFnRef = useRef<(v: Video, automatic?: boolean) => void>(() => {})
  const pullYRef = useRef(0)

  const activeChannel = channels.find(c => c.id === activeChannelId) ?? channels[0]
  const videos = channelVideos[activeChannelId] ?? []
  const ac = activeChannel.color

  // ── Register service worker ──
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  // Keep refs current
  useEffect(() => { stopAfterCurrentRef.current = stopAfterCurrent }, [stopAfterCurrent])
  useEffect(() => { videosRef.current = channelVideos[activeChannelId] ?? [] }, [channelVideos, activeChannelId])

  function closeSheet(name: SheetName, setter: (v: boolean) => void) {
    setClosingSheet(name)
    setTimeout(() => { setter(false); setClosingSheet(null) }, 300)
  }

  // Video requests are retryable and cancelled when the selected channel changes.
  useEffect(() => {
    const controller = new AbortController()
    setListError(null)
    fetch(`/data/videos/${activeChannelId}.json`, { signal: controller.signal, cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('节目列表加载失败'); return r.json() })
      .then((data: ChannelVideos) => {
        if (!Array.isArray(data.videos)) throw new Error('节目列表格式异常')
        if (!controller.signal.aborted) setChannelVideos(prev => ({ ...prev, [activeChannelId]: data.videos }))
      })
      .catch(error => { if (error.name !== 'AbortError') setListError('节目列表加载失败，请检查网络后重试') })
    return () => controller.abort()
  }, [activeChannelId, listRetry])

  useEffect(() => {
    try {
      setShowTranslation(localStorage.getItem('podcast-translation') === '1')
      const speed = Number(localStorage.getItem('podcast-speed') || '1')
      if (SPEED_OPTIONS.includes(speed)) setPlaybackRate(speed)
      const loadedNotes: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('podcast-note-')) loadedNotes[key.slice(13)] = localStorage.getItem(key) || ''
      }
      setNotes(loadedNotes)
    } catch {}
    setPreferencesLoaded(true)
  }, [])

  const persistCurrent = useCallback((force = false) => {
    if (currentIdRef.current && playerRef.current) progressSaverRef.current(playerRef.current, currentIdRef.current, force)
  }, [])

  useEffect(() => {
    if (!preferencesLoaded) return
    try { localStorage.setItem('podcast-translation', showTranslation ? '1' : '0') } catch {}
  }, [showTranslation, preferencesLoaded])

  useEffect(() => {
    if (!preferencesLoaded) return
    try { localStorage.setItem('podcast-speed', String(playbackRate)) } catch {}
  }, [playbackRate, preferencesLoaded])

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') { persistCurrent(true); void syncNow(true) }
      else { void syncNow(false, true); checkTimer() }
    }
    const onPageHide = () => { persistCurrent(true); void syncNow(true) }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onPageHide) }
  }, [persistCurrent, syncNow])

  // ── Pull-to-close transcript: touchstart from header, move/end on document ──
  useEffect(() => {
    if (!showTranscript) { setPullY(0); return }
    let startY = 0
    let active = false

    const onHeaderStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY
      active = true
    }
    const onDocMove = (e: TouchEvent) => {
      if (!active) return
      const delta = e.touches[0].clientY - startY
      if (delta > 0) {
        e.preventDefault()
        const y = Math.min(delta * 0.45, 200)
        pullYRef.current = y
        setPullY(y)
      } else {
        pullYRef.current = 0
        setPullY(0)
      }
    }
    const onDocEnd = () => {
      if (!active) return
      active = false
      if (pullYRef.current > 80) {
        setPullY(0)
        closeSheet('transcript', setShowTranscript)
      } else {
        setPullY(0)
      }
      pullYRef.current = 0
    }

    const headerEl = transcriptHeaderRef.current
    headerEl?.addEventListener('touchstart', onHeaderStart, { passive: true })
    document.addEventListener('touchmove', onDocMove, { passive: false })
    document.addEventListener('touchend', onDocEnd, { passive: true })
    document.addEventListener('touchcancel', onDocEnd, { passive: true })
    return () => {
      headerEl?.removeEventListener('touchstart', onHeaderStart)
      document.removeEventListener('touchmove', onDocMove)
      document.removeEventListener('touchend', onDocEnd)
      document.removeEventListener('touchcancel', onDocEnd)
    }
  }, [showTranscript])

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      const a = playerRef.current
      if (!a || seekingRef.current) return
      try {
        const cur = a.currentTime || 0
        const dur = a.duration || 0
        const paused = a.paused
        setPlaying(prev => prev === !paused ? prev : !paused)
        setElapsed(cur)
        setDuration(dur)
        setProgress(dur > 0 ? cur / dur : 0)
        if ('mediaSession' in navigator && dur > 0 && isFinite(dur)) {
          try {
            navigator.mediaSession.playbackState = paused ? 'paused' : 'playing'
            navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(cur, dur), playbackRate: a.playbackRate })
          } catch {}
        }
        persistCurrent()
      } catch {}
    }, 1000)
  }, [persistCurrent])

  function ensureAudio(): HTMLAudioElement {
    if (playerRef.current) return playerRef.current
    const a = audioElRef.current ?? new Audio()
    a.preload = 'auto'
    a.addEventListener('play', () => { if (!a.paused) setPlaying(true) })
    a.addEventListener('pause', () => { if (a.paused) { setPlaying(false); persistCurrent(true); void syncNow(true) } })
    a.addEventListener('timeupdate', () => { persistCurrent(); checkTimer() })
    a.addEventListener('seeked', () => persistCurrent(true))
    a.addEventListener('error', () => {
      // A queued event from the previous resource can arrive after src changes.
      // The media error is reset by resource selection; aborted loads are expected.
      if (!a.error || a.error.code === 1 || (a.currentSrc && a.currentSrc !== a.src)) return
      setPlaying(false); setPlaybackError('音频暂时无法播放，请检查网络后重试')
    })
    a.addEventListener('ended', () => {
      if (currentIdRef.current && a.duration > 0) saveProgress(currentIdRef.current, a.duration, a.duration)
      checkTimer()
      if (blockAutoAdvanceRef.current) { setPlaying(false); return }
      if (stopAfterCurrentRef.current) {
        setStopAfterCurrent(false)
        setPlaying(false)
        return
      }
      const vids = videosRef.current
      const idx = vids.findIndex(v => v.id === currentIdRef.current)
      if (idx >= 0 && idx < vids.length - 1) playFnRef.current(vids[idx + 1], true)
      else setPlaying(false)
    })
    a.addEventListener('loadedmetadata', () => {
      if (savedPosRef.current > 0 && a.duration && savedPosRef.current < a.duration - 2)
        a.currentTime = savedPosRef.current
    })
    playerRef.current = a
    return a
  }

  function setupMediaSession(video: Video) {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: video.title,
      artist: activeChannel.name,
      artwork: [{ src: video.thumbnail, sizes: '480x360', type: 'image/jpeg' }],
    })
    navigator.mediaSession.setActionHandler('play', () => {
      requestPlayback()
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      playbackRequesterRef.current.cancel()
      playerRef.current?.pause(); setPlaying(false)
      navigator.mediaSession.playbackState = 'paused'
    })
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15))
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30))
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (playerRef.current && typeof d.seekTime === 'number') playerRef.current.currentTime = d.seekTime
    })
  }

  function play(video: Video, automatic = false) {
    checkTimer()
    if (automatic && blockAutoAdvanceRef.current) return
    persistCurrent(true)
    const a = ensureAudio()
    playbackRequesterRef.current.cancel()
    a.pause()
    currentIdRef.current = video.id
    savedPosRef.current = getProgress(video.id)
    setPlaybackError(null)
    setCurrent(video)
    setProgress(0); setElapsed(0); setDuration(0)
    a.src = AUDIO_BASE + encodeURIComponent(video.id) + '.m4a'
    a.playbackRate = playbackRate
    requestPlayback(automatic)
    startPolling()
    setupMediaSession(video)
  }

  function togglePlay() {
    const a = playerRef.current
    if (!a) return
    if (a.paused) requestPlayback()
    else { playbackRequesterRef.current.cancel(); a.pause(); setPlaying(false) }
  }

  function requestPlayback(automatic = false) {
    const audio = playerRef.current
    if (!audio) return
    checkTimer()
    if (automatic && blockAutoAdvanceRef.current) return
    // A user play action explicitly resumes after a completed sleep timer.
    if (!automatic) blockAutoAdvanceRef.current = false
    setPlaybackError(null)
    void playbackRequesterRef.current.play(audio)
  }

  function skip(seconds: number) {
    const a = playerRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(a.duration || Infinity, (a.currentTime || 0) + seconds))
  }

  function onSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value)
    const audio = playerRef.current
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    audio.currentTime = value * audio.duration
    setProgress(value); setElapsed(audio.currentTime)
    persistCurrent(true)
  }

  function onSeekEnd() { seekingRef.current = false; persistCurrent(true) }

  function openTimerSheet() {
    const base = timerMinutes > 0 ? timerMinutes : 30
    setPickerHours(Math.floor(base / 60))
    setPickerMins(base % 60)
    setShowTimer(true)
  }

  function checkTimer() {
    if (deadlineRef.current === null) return
    const remaining = remainingTimerSeconds(deadlineRef.current)
    setTimeLeft(remaining)
    if (remaining === 0) {
      blockAutoAdvanceRef.current = true
      playbackRequesterRef.current.cancel()
      deadlineRef.current = null
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      playerRef.current?.pause()
      persistCurrent(true)
      setPlaying(false); setTimeLeft(null); setTimerMinutes(0)
    }
  }

  function startTimer(minutes: number) {
    setTimerMinutes(minutes)
    closeSheet('timer', setShowTimer)
    if (timerRef.current) clearInterval(timerRef.current)
    deadlineRef.current = minutes > 0 ? Date.now() + minutes * 60_000 : null
    if (!minutes) { setTimeLeft(null); return }
    checkTimer()
    timerRef.current = setInterval(checkTimer, 1000)
  }

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (pollRef.current) clearInterval(pollRef.current)
    if (scrollIdleRef.current) clearTimeout(scrollIdleRef.current)
    transcriptLoaderRef.current.cancel()
    playbackRequesterRef.current.cancel()
  }, [])

  function cycleSpeed() {
    const next = SPEED_OPTIONS[(SPEED_OPTIONS.indexOf(playbackRate) + 1) % SPEED_OPTIONS.length]
    setPlaybackRate(next)
    if (playerRef.current) playerRef.current.playbackRate = next
  }

  function resetProgress(videoId: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (currentIdRef.current === videoId && playerRef.current) { playerRef.current.currentTime = 0; savedPosRef.current = 0 }
    clearSavedProgress(videoId)
  }

  function toggleFavorite(videoId: string, e: React.MouseEvent) {
    e.stopPropagation()
    changeFavorite(videoId)
  }

  function saveNote(id: string, text: string) {
    const t = text.trim()
    if (t) {
      setNotes(prev => ({ ...prev, [id]: t }))
      try { localStorage.setItem(`podcast-note-${id}`, t) } catch { setPlaybackError('备注保存失败，请检查浏览器存储空间') }
    } else {
      setNotes(prev => { const n = { ...prev }; delete n[id]; return n })
      try { localStorage.removeItem(`podcast-note-${id}`) } catch { setPlaybackError('备注删除失败，请检查浏览器存储权限') }
    }
  }

  function openTranscript(video: Video) {
    if (currentIdRef.current !== video.id) play(video)
    setShowTranscript(true)
  }

  const subtitleId = current?.id
  useEffect(() => {
    if (!showTranscript || !subtitleId) return
    let active = true
    setTranscriptLoading(true); setTranscriptError(null); setTranscriptSegs([])
    void transcriptLoaderRef.current.load(subtitleId).then(data => {
      if (!active || !data) return
      if (data.segments?.length) setTranscriptSegs(data.segments)
      else setTranscriptError('暂无字幕')
    }).catch(() => { if (active) setTranscriptError('字幕加载失败，请重试') })
      .finally(() => { if (active) setTranscriptLoading(false) })
    return () => { active = false; transcriptLoaderRef.current.cancel() }
  }, [showTranscript, subtitleId, transcriptRetry])

  function markTranscriptScrolling() {
    userScrollingRef.current = true
    if (scrollIdleRef.current) clearTimeout(scrollIdleRef.current)
    scrollIdleRef.current = setTimeout(() => { userScrollingRef.current = false }, 3000)
  }

  const currentSegIdx = useMemo(() => {
    const arr = transcriptSegs
    if (!arr.length || elapsed < arr[0].start) return -1
    let lo = 0, hi = arr.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (arr[mid].start <= elapsed) lo = mid; else hi = mid - 1
    }
    return lo
  }, [transcriptSegs, elapsed])

  useEffect(() => {
    if (!showTranscript || currentSegIdx < 0 || userScrollingRef.current) return
    document.getElementById(`seg-${currentSegIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentSegIdx, showTranscript])

  const filled = `${Math.round(progress * 100)}%`

  const overlayAnim = (name: SheetName) => ({
    animation: `${closingSheet === name ? 'fade-out' : 'fade-in'} 0.28s ease forwards`,
    background: 'rgba(0,0,0,0.48)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  })
  const sheetAnim = (name: SheetName) => ({
    animation: `${closingSheet === name ? 'sheet-down' : 'sheet-up'} 0.32s cubic-bezier(0.32,0.72,0,1) forwards`,
    background: 'var(--bg-card)',
  })

  const filteredVideos = useMemo(() => videos.filter(v => {
    if (searchQuery.trim() && !v.title.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false
    const p = videoProgress[v.id] ?? 0
    if (filter === 'all') return true
    if (filter === 'fav') return favorites.has(v.id)
    if (filter === 'inprogress') return p > 0 && p < DONE_THRESHOLD
    if (filter === 'done') return p >= DONE_THRESHOLD
    return true
  }), [videos, videoProgress, filter, favorites, searchQuery])

  // 稳定回调：列表用 useMemo 缓存，回调引用必须稳定，避免每秒进度更新触发整列重渲染
  const handlersRef = useRef({ play, toggleFavorite, resetProgress })
  useEffect(() => { handlersRef.current = { play, toggleFavorite, resetProgress } })
  const onPlay = useCallback((v: Video) => handlersRef.current.play(v), [])
  const onToggleFav = useCallback((id: string, e: React.MouseEvent) => handlersRef.current.toggleFavorite(id, e), [])
  const onResetProgress = useCallback((id: string, e: React.MouseEvent) => handlersRef.current.resetProgress(id, e), [])

  const videoList = useMemo(() => filteredVideos.map(video => {
    const isActive = current?.id === video.id
    const isFav = favorites.has(video.id)
    const prog = videoProgress[video.id] ?? 0
    const isDone = prog >= DONE_THRESHOLD
    const det = videoDetails[video.id]
    const totalDur = video.duration ?? det?.dur
    const pct = prog > 0 ? Math.round(prog * 100) : 0
    const note = notes[video.id]
    return (
      <div key={video.id} className="relative">
        {isActive && (
          <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full" style={{ background: ac }} />
        )}
        <div
          role="button" tabIndex={0} aria-label={`播放 ${video.title}`}
          onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPlay(video) } }}
          onClick={() => onPlay(video)}
          className="flex items-center gap-3.5 px-5 py-3.5 cursor-pointer active:opacity-60 transition-opacity"
          style={{ background: isActive ? `${ac}12` : 'transparent' }}
        >
          <div className="relative flex-shrink-0">
            <img src={video.thumbnail} alt="" loading="lazy"
              className="w-[54px] h-[54px] rounded-xl object-cover"
              style={{ background: 'var(--bg-raised)' }} />
            {!isActive && isDone && (
              <div className="absolute -top-1 -right-1 w-[18px] h-[18px] rounded-full flex items-center justify-center shadow-sm"
                style={{ background: ac }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
            )}
            {isActive && (
              <div className="absolute inset-0 rounded-xl flex items-center justify-center"
                style={{ background: `${ac}cc` }}>
                {playing ? (
                  <div className="flex items-end gap-[3px]" style={{ height: 14 }}>
                    {[0, 0.18, 0.36].map((delay, i) => (
                      <div key={i} style={{
                        width: 3, height: 14, background: 'white', borderRadius: 2,
                        transformOrigin: 'bottom',
                        animation: `eq-bounce 0.65s ease-in-out infinite`,
                        animationDelay: `${delay}s`,
                      }} />
                    ))}
                  </div>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 pr-9">
            <p className="text-[14px] leading-snug line-clamp-2"
              style={{
                color: isActive ? ac : 'var(--text-primary)',
                fontWeight: isActive ? 600 : 500,
              }}>
              {video.title}
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {formatDate(video.published)}
              </p>
              {totalDur !== undefined && (
                <p className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                  {det && !isDone
                    ? <>{formatTime(det.pos)}<span style={{ opacity: 0.5 }}> / {formatTime(totalDur)}</span></>
                    : formatTime(totalDur)}
                </p>
              )}
              {pct > 0 && !isDone && !isActive && (
                <span className="text-[10px] tabular-nums font-medium" style={{ color: ac, opacity: 0.8 }}>
                  {pct}%
                </span>
              )}
              {isDone && !isActive && (
                <button onClick={(e) => onResetProgress(video.id, e)}
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-medium active:opacity-50 flex items-center gap-1"
                  style={{ background: `${ac}20`, color: ac }}>
                  已听完
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              )}
            </div>
            {prog > 0 && prog < DONE_THRESHOLD && (
              <div className="mt-1.5 h-[2px] rounded-full overflow-hidden" style={{ background: 'var(--separator)' }}>
                <div className="h-full rounded-full"
                  style={{ width: `${Math.round(prog * 100)}%`, background: ac, opacity: isActive ? 1 : 0.6 }} />
              </div>
            )}
            {note && (
              <p className="text-[11px] mt-1 line-clamp-1" style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                {note}
              </p>
            )}
          </div>
        </div>

        <button
          aria-label={isFav ? `取消收藏 ${video.title}` : `收藏 ${video.title}`} aria-pressed={isFav}
          onClick={(e) => onToggleFav(video.id, e)}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 active:scale-90 transition-transform">
          <svg width="17" height="17" viewBox="0 0 24 24"
            fill={isFav ? ac : 'none'}
            stroke={isFav ? ac : 'var(--text-tertiary)'}
            strokeWidth="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      </div>
    )
  }), [filteredVideos, videoProgress, favorites, notes, videoDetails, current, playing, ac, onPlay, onToggleFav, onResetProgress])

  playFnRef.current = play

  return (
    <div className="flex flex-col h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      <audio ref={audioElRef} playsInline preload="auto"
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />

      {/* ── Main list ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Channel header */}
        <div className="px-4 pb-3" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)' }}>
          <div className="flex items-center gap-3">
            <button
              onClick={() => channels.length > 1 && setShowChannelPicker(true)}
              className="flex-shrink-0 active:scale-95 transition-transform duration-150">
              <div className="w-[52px] h-[52px] rounded-[14px] shadow overflow-hidden flex items-center justify-center"
                style={{ background: `linear-gradient(145deg, ${ac} 0%, #5e5ce6 100%)` }}>
                {activeChannel.avatar
                  ? <img src={activeChannel.avatar} alt="" className="w-full h-full object-cover" />
                  : <span className="text-2xl font-bold text-white select-none">{activeChannel.initial}</span>
                }
              </div>
            </button>
            <div className="flex-1 min-w-0">
              <h1 className="text-[16px] font-bold leading-tight truncate" style={{ color: 'var(--text-primary)' }}>
                {activeChannel.name}
              </h1>
              <p className="text-[12px] font-medium mt-0.5" style={{ color: ac }}>{activeChannel.description}</p>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{videos.length} 个节目</p>
            </div>
            {channels.length > 1 && (
              <button onClick={() => setShowChannelPicker(true)}
                className="flex-shrink-0 p-2 rounded-full active:opacity-50"
                style={{ background: 'var(--bg-raised)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ color: 'var(--text-secondary)' }}>
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
                </svg>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 mt-3">
            <button className="text-xs underline" onClick={() => { setSecretInput(secret); setShowSyncSettings(true) }}>云同步设置</button>
            <span className="text-xs" role="status" style={{ color: 'var(--text-secondary)' }}>{syncStatus}</span>
          </div>
          {/* Filter tabs / Search */}
          {searchActive ? (
            <div className="flex items-center gap-2 mt-3">
              <input
                autoFocus
                aria-label="搜索节目标题"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索节目…"
                className="flex-1 px-3 py-1.5 rounded-full text-[13px] outline-none"
                style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
              />
              <button onClick={() => { setSearchActive(false); setSearchQuery('') }}
                className="text-[13px] font-medium active:opacity-50 flex-shrink-0"
                style={{ color: 'var(--text-secondary)' }}>
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 mt-3 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  className="text-[12px] px-3 py-1.5 rounded-full whitespace-nowrap transition-colors flex-shrink-0"
                  style={{
                    background: filter === f.key ? ac : 'var(--bg-raised)',
                    color: filter === f.key ? 'white' : 'var(--text-secondary)',
                    fontWeight: filter === f.key ? 600 : 400,
                  }}>
                  {f.key === 'fav' ? '♥ 收藏' : f.label}
                </button>
              ))}
              <button aria-label="搜索节目" onClick={() => setSearchActive(true)}
                className="ml-auto flex-shrink-0 p-1.5 rounded-full active:opacity-50"
                style={{ background: 'var(--bg-raised)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="h-px" style={{ background: 'var(--separator)' }} />

        {listError && <div role="alert" className="px-5 py-4 text-sm"><p>{listError}</p><button className="underline mt-2" onClick={() => setListRetry(value => value + 1)}>重试加载</button></div>}
        {playbackError && <div role="alert" className="px-5 py-3 text-sm"><p>{playbackError}</p><button className="underline mt-2" onClick={() => current && play(current)}>重试播放</button></div>}

        {filteredVideos.length === 0 && (
          <div className="px-5 py-12 text-center">
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {videos.length === 0 ? (listError ? '暂时无法加载节目' : '加载中…') :
               searchQuery ? `没有找到「${searchQuery}」` :
               filter === 'fav' ? '还没有收藏的节目' :
               filter === 'inprogress' ? '没有进行中的节目' :
               filter === 'done' ? '还没有听完的节目' : '暂无节目'}
            </p>
          </div>
        )}

        {/* Video list */}
        <div className="pb-1">
          {videoList}
        </div>

        {current && <div className="h-28" />}
      </div>

      {showSyncSettings && (
        <div className="fixed inset-0 flex items-end justify-center bg-black/50 px-4 pb-6" style={{ zIndex: 90 }} onClick={() => setShowSyncSettings(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="sync-title" className="w-full max-w-lg rounded-3xl p-5" style={{ background: 'var(--bg-card)' }} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') setShowSyncSettings(false) }}>
            <h2 id="sync-title" className="font-semibold">云同步</h2>
            <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>输入你设置的同步密钥。其他设备使用同一密钥，收藏和收听进度即可同步。备注保存在当前设备。</p>
            <label htmlFor="sync-secret" className="block text-sm mt-4">同步密钥（至少 32 个字符）</label>
            <input id="sync-secret" autoFocus type="password" autoComplete="off" spellCheck={false} value={secretInput} onChange={e => setSecretInput(e.target.value)} className="w-full rounded-xl border p-3 mt-2" style={{ borderColor: 'var(--separator)', background: 'var(--bg-raised)' }} />
            <p role="status" className="text-sm mt-3">{syncStatus}</p>
            <div className="flex flex-wrap gap-3 mt-4">
              <button className="rounded-xl px-4 py-2 font-medium" style={{ background: ac, color: '#fff' }} onClick={() => { configureSecret(secretInput) }}>保存并同步</button>
              {secret && <button className="rounded-xl border px-4 py-2" onClick={() => { void syncNow(false, true) }}>重试同步</button>}
              <button className="rounded-xl border px-4 py-2" onClick={() => { configureSecret(''); setSecretInput('') }}>仅本地使用</button>
              <button className="px-4 py-2" onClick={() => setShowSyncSettings(false)}>关闭</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Channel picker sheet ── */}
      {showChannelPicker && (
        <div className="fixed inset-0 z-50 flex items-end"
          onClick={() => closeSheet('channel', setShowChannelPicker)}
          style={overlayAnim('channel')}>
          <div className="w-full rounded-t-[28px] px-5 pt-3"
            style={{ ...sheetAnim('channel'), paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-9 h-1 rounded-full mx-auto mb-5" style={{ background: 'var(--separator)' }} />
            <p className="text-[17px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>选择博主</p>
            {channels.map(ch => (
              <button key={ch.id}
                onClick={() => { setActiveChannelId(ch.id); closeSheet('channel', setShowChannelPicker) }}
                className="w-full flex items-center gap-3.5 py-3.5 border-b last:border-0 active:opacity-60"
                style={{ borderColor: 'var(--separator)' }}>
                <div className="w-10 h-10 rounded-[12px] overflow-hidden flex items-center justify-center flex-shrink-0"
                  style={{ background: `linear-gradient(145deg, ${ch.color} 0%, #5e5ce6 100%)` }}>
                  {ch.avatar
                    ? <img src={ch.avatar} alt="" className="w-full h-full object-cover" />
                    : <span className="text-lg font-bold text-white">{ch.initial}</span>
                  }
                </div>
                <div className="flex-1 text-left">
                  <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{ch.name}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{ch.description}</p>
                </div>
                {activeChannelId === ch.id && (
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ch.color} strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Timer sheet ── */}
      {showTimer && (
        <div className="fixed inset-0 flex items-end" style={{ zIndex: 70, ...overlayAnim('timer') }}
          onClick={() => closeSheet('timer', setShowTimer)}>
          <div className="w-full rounded-t-[28px] px-5 pt-3"
            style={{ ...sheetAnim('timer'), paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-9 h-1 rounded-full mx-auto mb-5" style={{ background: 'var(--separator)' }} />
            <p className="text-[17px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>定时停止播放</p>

            <div className="flex items-center gap-1 mt-2">
              <ScrollPicker values={HOUR_VALUES} selected={pickerHours} onChange={setPickerHours} label="小时" />
              <span className="text-[28px] font-light pb-6" style={{ color: 'var(--text-secondary)' }}>:</span>
              <ScrollPicker values={MIN_VALUES} selected={pickerMins} onChange={setPickerMins} label="分钟" />
            </div>

            <button onClick={() => setStopAfterCurrent(p => !p)}
              className="w-full flex items-center justify-between py-3.5 border-t mt-1 active:opacity-60"
              style={{ borderColor: 'var(--separator)' }}>
              <span className="text-[15px]" style={{ color: 'var(--text-primary)' }}>放完这个停止</span>
              {stopAfterCurrent
                ? <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ac} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                : <div className="w-5 h-5 rounded-full border-2" style={{ borderColor: 'var(--separator)' }} />
              }
            </button>

            <button onClick={() => startTimer(pickerHours * 60 + pickerMins)}
              className="w-full py-3.5 rounded-2xl text-[16px] font-semibold mt-3 active:opacity-80"
              style={{ background: ac, color: '#fff' }}>
              {(() => {
                const t = pickerHours * 60 + pickerMins
                if (t <= 0) return timerMinutes > 0 ? '关闭定时' : '不设定时'
                const parts = []
                if (pickerHours > 0) parts.push(`${pickerHours} 小时`)
                if (pickerMins > 0) parts.push(`${pickerMins} 分钟`)
                return parts.join(' ') + '后停止'
              })()}
            </button>
          </div>
        </div>
      )}

      {/* ── Note sheet ── */}
      {showNote && (
        <div className="fixed inset-0 flex items-end" style={{ zIndex: 80, ...overlayAnim('note') }}
          onClick={() => closeSheet('note', setShowNote)}>
          <div className="w-full rounded-t-[28px] px-5 pt-3"
            style={{ ...sheetAnim('note'), paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-9 h-1 rounded-full mx-auto mb-5" style={{ background: 'var(--separator)' }} />
            <p className="text-[17px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>备注</p>
            <textarea
              aria-label="节目备注"
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="添加备注…"
              rows={4}
              className="w-full px-3 py-2.5 rounded-xl text-[14px] resize-none outline-none"
              style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
            />
            <div className="flex gap-3 mt-3">
              {notes[noteVideoId ?? ''] && (
                <button onClick={() => {
                  if (!noteVideoId) return
                  saveNote(noteVideoId, '')
                  closeSheet('note', setShowNote)
                }}
                  className="flex-1 py-3 rounded-2xl text-[15px] font-semibold active:opacity-80"
                  style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)' }}>
                  删除
                </button>
              )}
              <button onClick={() => {
                if (noteVideoId) saveNote(noteVideoId, noteText)
                closeSheet('note', setShowNote)
              }}
                className="flex-1 py-3 rounded-2xl text-[15px] font-semibold active:opacity-80"
                style={{ background: ac, color: '#fff' }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mini Player ── */}
      {current && (
        <div className="fixed bottom-0 left-0 right-0 z-30"
          style={{
            background: 'var(--bg-glass)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            borderTop: '1px solid var(--separator)',
          }}>
          <div className="relative h-[2px]" style={{ background: 'var(--separator)' }}>
            <div className="absolute inset-y-0 left-0" style={{ width: filled, background: ac }} />
            <input type="range" min="0" max="1" step="0.001" value={progress}
              aria-label="播放进度"
              onPointerDown={e => { seekingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
              onChange={onSeekChange} onPointerUp={onSeekEnd} onPointerCancel={onSeekEnd} onLostPointerCapture={onSeekEnd}
              className="absolute w-full opacity-0 cursor-pointer"
              style={{ height: 16, top: -7 }} />
          </div>

          <div className="flex items-center gap-3 px-4 pt-3 pb-2.5">
            <button aria-label="打开当前节目字幕" onClick={() => current && openTranscript(current)}
              className="flex items-center gap-3 flex-1 min-w-0 text-left active:opacity-70">
              <img src={current.thumbnail} alt=""
                className="w-[42px] h-[42px] rounded-xl object-cover flex-shrink-0 shadow"
                style={{ background: 'var(--bg-raised)' }} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {current.title}
                </p>
                <p className="text-[11px] mt-0.5 flex items-center gap-1.5 tabular-nums"
                  style={{ color: 'var(--text-tertiary)' }}>
                  <span>{formatTime(elapsed)}</span>
                  <span>·</span>
                  <span>{formatTime(duration)}</span>
                  {timeLeft !== null && (
                    <span className="ml-1 font-medium" style={{ color: ac }}>{formatTime(timeLeft)} 后停</span>
                  )}
                </p>
              </div>
            </button>
            <div className="flex items-center gap-2.5 flex-shrink-0">
              <button aria-label="后退 15 秒" onClick={() => skip(-15)} className="active:opacity-50 p-1" style={{ color: 'var(--text-secondary)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button aria-label={playing ? '暂停播放' : '开始播放'} onClick={togglePlay} className="active:scale-90 transition-transform duration-100">
                <div className="w-[42px] h-[42px] rounded-full flex items-center justify-center shadow"
                  style={{ background: ac }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                    {playing
                      ? <><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></>
                      : <path d="M8 5v14l11-7z"/>}
                  </svg>
                </div>
              </button>
              <button aria-label="前进 15 秒" onClick={() => skip(15)} className="active:opacity-50 p-1" style={{ color: 'var(--text-secondary)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button aria-label="定时停止播放" onClick={openTimerSheet} className="active:opacity-50 p-1">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 || stopAfterCurrent ? ac : 'var(--text-tertiary)'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3M9 3h6M12 3v2"/>
                </svg>
              </button>
            </div>
          </div>
          <div style={{ height: 'env(safe-area-inset-bottom)' }} />
        </div>
      )}

      {/* ── Transcript page ── */}
      {showTranscript && current && (
        <div className="fixed inset-0 z-50 flex flex-col"
          style={{
            animation: pullY > 0 ? 'none' : `${closingSheet === 'transcript' ? 'page-down' : 'page-up'} 0.35s cubic-bezier(0.32,0.72,0,1) forwards`,
            background: 'var(--bg)',
            transform: pullY > 0 ? `translateY(${pullY}px)` : undefined,
          }}>

          {/* Header — drag handle + nav */}
          <div ref={transcriptHeaderRef} className="flex-shrink-0"
            style={{ borderBottom: '1px solid var(--separator)', paddingTop: 'env(safe-area-inset-top)' }}>
            <div className="flex justify-center pt-2.5 pb-1">
              <div className="w-9 h-1 rounded-full" style={{ background: 'var(--separator)' }} />
            </div>
            <div className="flex items-center justify-between px-5 pt-1 pb-3">
              <button
                onClick={() => closeSheet('transcript', setShowTranscript)}
                className="flex items-center gap-1 text-[14px] font-medium active:opacity-60 py-1 pr-2"
                style={{ color: ac }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
                返回
              </button>
              <p className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>字幕</p>
              <button
                onClick={() => setShowTranslation(v => !v)}
                className="text-[12px] px-3 py-1.5 rounded-full border"
                style={{
                  borderColor: showTranslation ? ac : 'var(--separator)',
                  background: showTranslation ? `${ac}20` : 'transparent',
                  color: showTranslation ? ac : 'var(--text-secondary)',
                  fontWeight: showTranslation ? 600 : 400,
                }}>
                中文翻译
              </button>
            </div>
          </div>

          {/* Content strip */}
          <div className="px-4 py-2.5 flex items-center gap-2.5 flex-shrink-0"
            style={{ background: 'var(--bg-raised)', borderBottom: '1px solid var(--separator)' }}>
            <img src={current.thumbnail} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
            <p className="text-[12px] truncate flex-1 font-medium" style={{ color: 'var(--text-secondary)' }}>{current.title}</p>
            <button aria-label="编辑当前节目备注" onClick={() => {
              setNoteVideoId(current.id)
              setNoteText(notes[current.id] || '')
              setShowNote(true)
            }} className="active:opacity-60 p-1 flex-shrink-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke={notes[current.id] ? ac : 'var(--text-tertiary)'} strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button aria-label={`播放速度 ${playbackRate} 倍，点击切换`} onClick={cycleSpeed} className="active:opacity-60 flex-shrink-0">
              <span className="text-[12px] font-bold" style={{ color: ac }}>{playbackRate}x</span>
            </button>
            <button aria-label={playing ? '暂停播放' : '开始播放'} onClick={togglePlay} className="active:scale-90 transition-transform flex-shrink-0">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: ac }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="white">
                  {playing
                    ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                    : <path d="M8 5v14l11-7z"/>}
                </svg>
              </div>
            </button>
          </div>

          {/* Transcript list */}
          <div ref={transcriptListRef} className="flex-1 overflow-y-auto py-3"
            onWheel={markTranscriptScrolling}
            onTouchStart={() => { userScrollingRef.current = true }}
            onTouchEnd={markTranscriptScrolling}>
            {transcriptLoading && <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>加载字幕中…</p>}
            {transcriptError && <div className="text-center py-12 text-sm" role="status"><p>{transcriptError}</p><button className="underline mt-3" onClick={() => setTranscriptRetry(value => value + 1)}>重新加载字幕</button></div>}
            {transcriptSegs.map((seg, i) => {
              const isActiveSeg = i === currentSegIdx
              return (
                <button id={`seg-${i}`} key={i}
                  onClick={() => {
                    const a = playerRef.current
                    if (!a) return
                    a.currentTime = seg.start
                    if (a.paused) requestPlayback()
                  }}
                  className="w-full text-left px-5 py-2.5 active:opacity-60"
                  style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 72px' }}>
                  {isActiveSeg && <div className="w-5 h-[2px] rounded-full mb-2" style={{ background: ac }} />}
                  <p style={{
                    color: isActiveSeg ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    fontWeight: isActiveSeg ? 600 : 400,
                    fontSize: isActiveSeg ? 17 : 15,
                    lineHeight: 1.6,
                    transition: 'color 0.15s',
                  }}>{seg.ko}</p>
                  {showTranslation && seg.zh && seg.zh !== seg.ko && (
                    <p style={{
                      color: isActiveSeg ? ac : 'var(--text-tertiary)',
                      fontSize: isActiveSeg ? 14 : 13,
                      fontWeight: isActiveSeg ? 500 : 400,
                      lineHeight: 1.5,
                      marginTop: 4,
                      opacity: isActiveSeg ? 1 : 0.65,
                      transition: 'color 0.15s',
                    }}>{seg.zh}</p>
                  )}
                </button>
              )
            })}
            <div className="h-24" />
          </div>

          {/* Bottom controls */}
          <div className="flex-shrink-0 px-5 pt-3"
            style={{
              background: 'var(--bg-glass)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              borderTop: '1px solid var(--separator)',
              paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
            }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[11px] tabular-nums w-8 text-right" style={{ color: 'var(--text-tertiary)' }}>{formatTime(elapsed)}</span>
              <div className="flex-1 relative h-[3px] rounded-full" style={{ background: 'var(--separator)' }}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: filled, background: ac }} />
                <input type="range" min="0" max="1" step="0.001" value={progress}
                  aria-label="播放进度"
                  onPointerDown={e => { seekingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
                  onChange={onSeekChange} onPointerUp={onSeekEnd} onPointerCancel={onSeekEnd} onLostPointerCapture={onSeekEnd}
                  className="absolute w-full opacity-0 cursor-pointer"
                  style={{ height: 20, top: -9 }} />
              </div>
              <span className="text-[11px] tabular-nums w-8" style={{ color: 'var(--text-tertiary)' }}>{formatTime(duration)}</span>
            </div>
            {/* Play controls: -15 | play | +15 centered, timer absolutely right */}
            <div className="relative flex items-center justify-center gap-10">
              <button aria-label="后退 15 秒" onClick={() => skip(-15)} className="active:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button aria-label={playing ? '暂停播放' : '开始播放'} onClick={togglePlay} className="active:scale-90 transition-transform duration-100">
                <div className="w-[54px] h-[54px] rounded-full flex items-center justify-center shadow-md" style={{ background: ac }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                    {playing
                      ? <><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></>
                      : <path d="M8 5v14l11-7z"/>}
                  </svg>
                </div>
              </button>
              <button aria-label="前进 15 秒" onClick={() => skip(15)} className="active:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button aria-label="定时停止播放" onClick={openTimerSheet} className="absolute right-0 active:opacity-50 p-2">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 || stopAfterCurrent ? ac : 'var(--text-secondary)'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3M9 3h6M12 3v2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
