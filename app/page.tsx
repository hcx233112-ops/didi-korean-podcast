'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import channelsData from '@/data/channels.json'

interface Channel { id: string; name: string; description: string; initial: string; color: string; channelId?: string }
interface Video { id: string; title: string; published: string; thumbnail: string; duration?: number }
interface TranscriptSegment { start: number; end: number; ko: string; zh: string }
interface ChannelVideos { channelName: string; videos: Video[] }
interface SyncData {
  favorites: string[]
  progress: Record<string, { pos: number; dur: number }>
}

const DONE_THRESHOLD = 0.9
const AVATAR_TTL = 7 * 24 * 3600 * 1000

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
      <div ref={ref} onScroll={handleScroll}
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
function formatDate(s: string) {
  return new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

type SheetName = 'channel' | 'timer' | 'transcript'
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
  const [transcriptVideoId, setTranscriptVideoId] = useState<string | null>(null)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [videoProgress, setVideoProgress] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<FilterType>('all')
  const [videoDetails, setVideoDetails] = useState<Record<string, { pos: number; dur: number }>>({})
  const [closingSheet, setClosingSheet] = useState<SheetName | null>(null)
  const [stopAfterCurrent, setStopAfterCurrent] = useState(false)
  const [channelAvatars, setChannelAvatars] = useState<Record<string, string>>({})
  const [pickerHours, setPickerHours] = useState(0)
  const [pickerMins, setPickerMins] = useState(0)

  const playerRef = useRef<HTMLAudioElement | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seekingRef = useRef(false)
  const transcriptListRef = useRef<HTMLDivElement>(null)
  const userScrollingRef = useRef(false)
  const savedPosRef = useRef(0)
  const currentIdRef = useRef<string | null>(null)
  const lastProgressSaveRef = useRef(0)
  const favoritesRef = useRef<Set<string>>(new Set())
  const stopAfterCurrentRef = useRef(false)
  const videosRef = useRef<Video[]>([])
  const playFnRef = useRef<(v: Video) => void>(() => {})
  const transcriptPageRef = useRef<HTMLDivElement>(null)
  const pullStartYRef = useRef(0)
  const pullYRef = useRef(0)
  const pullActiveRef = useRef(false)
  const [pullY, setPullY] = useState(0)

  const activeChannel = channels.find(c => c.id === activeChannelId) ?? channels[0]
  const videos = channelVideos[activeChannelId] ?? []
  const ac = activeChannel.color

  // ── Load channel avatars (cached with 7-day TTL) ──
  useEffect(() => {
    channels.forEach(ch => {
      const raw = localStorage.getItem(`podcast-avatar-${ch.id}`)
      let cachedUrl: string | null = null
      let needsFetch = true
      if (raw) {
        try {
          const obj = JSON.parse(raw)
          cachedUrl = obj.url ?? null
          needsFetch = !obj.ts || Date.now() - obj.ts >= AVATAR_TTL
        } catch {
          cachedUrl = raw   // old plain-string format
          needsFetch = true // re-fetch to update to new format
        }
      }
      if (cachedUrl) setChannelAvatars(prev => ({ ...prev, [ch.id]: cachedUrl! }))
      if (!needsFetch) return
      fetch(`/api/avatar?channelId=${ch.channelId || ch.id}`)
        .then(r => r.json())
        .then(({ url }: { url: string | null }) => {
          if (!url) return
          setChannelAvatars(prev => ({ ...prev, [ch.id]: url }))
          localStorage.setItem(`podcast-avatar-${ch.id}`, JSON.stringify({ url, ts: Date.now() }))
        })
        .catch(() => {})
    })
  }, [])

  // Keep refs current for async/stale-closure usage
  useEffect(() => { favoritesRef.current = favorites }, [favorites])
  useEffect(() => { stopAfterCurrentRef.current = stopAfterCurrent }, [stopAfterCurrent])
  useEffect(() => { videosRef.current = channelVideos[activeChannelId] ?? [] }, [channelVideos, activeChannelId])

  function closeSheet(name: SheetName, setter: (v: boolean) => void) {
    setClosingSheet(name)
    setTimeout(() => { setter(false); setClosingSheet(null) }, 300)
  }

  // ── Load videos ──
  useEffect(() => {
    if (channelVideos[activeChannelId]) return
    fetch(`/data/videos/${activeChannelId}.json`)
      .then(r => r.json())
      .then((data: ChannelVideos) => setChannelVideos(prev => ({ ...prev, [activeChannelId]: data.videos })))
      .catch(console.error)
  }, [activeChannelId])

  // ── Load local preferences ──
  useEffect(() => {
    try {
      const fav = localStorage.getItem('podcast-favorites')
      if (fav) { const s = new Set<string>(JSON.parse(fav)); setFavorites(s); favoritesRef.current = s }
      const trans = localStorage.getItem('podcast-translation')
      if (trans !== null) setShowTranslation(trans === '1')
    } catch {}
    const prog: Record<string, number> = {}
    const details: Record<string, { pos: number; dur: number }> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('podcast-pos-')) {
        try {
          const d = JSON.parse(localStorage.getItem(key)!)
          if (d.pos > 0 && d.dur > 0) {
            const id = key.replace('podcast-pos-', '')
            prog[id] = d.pos / d.dur
            details[id] = { pos: d.pos, dur: d.dur }
          }
        } catch {}
      }
    }
    setVideoProgress(prog)
    setVideoDetails(details)
  }, [])

  // ── Cloud sync: load on mount ──
  useEffect(() => {
    ;(async () => {
      try {
        const r = await fetch('/api/sync', { cache: 'no-store' })
        if (!r.ok) return
        const remote: SyncData | null = await r.json()
        if (!remote) return

        // Merge favorites (union)
        if (remote.favorites?.length) {
          const local: string[] = JSON.parse(localStorage.getItem('podcast-favorites') || '[]')
          const merged = [...new Set([...local, ...remote.favorites])]
          localStorage.setItem('podcast-favorites', JSON.stringify(merged))
          const s = new Set<string>(merged)
          setFavorites(s)
          favoritesRef.current = s
        }

        // Merge progress (take whichever is further)
        if (remote.progress) {
          const progUpdates: Record<string, number> = {}
          const detailUpdates: Record<string, { pos: number; dur: number }> = {}
          for (const [id, rd] of Object.entries(remote.progress)) {
            if (!rd?.dur) continue
            const local = localStorage.getItem(`podcast-pos-${id}`)
            const ld = local ? JSON.parse(local) : { pos: 0 }
            if ((rd.pos || 0) > (ld.pos || 0)) {
              localStorage.setItem(`podcast-pos-${id}`, JSON.stringify(rd))
              progUpdates[id] = rd.pos / rd.dur
              detailUpdates[id] = rd
            }
          }
          if (Object.keys(progUpdates).length) {
            setVideoProgress(prev => ({ ...prev, ...progUpdates }))
            setVideoDetails(prev => ({ ...prev, ...detailUpdates }))
          }
        }
      } catch {}
    })()
  }, [])

  // ── Cloud sync: push ──
  async function pushSync() {
    const progress: Record<string, { pos: number; dur: number }> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('podcast-pos-')) {
        try { progress[k.replace('podcast-pos-', '')] = JSON.parse(localStorage.getItem(k)!) } catch {}
      }
    }
    try {
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites: [...favoritesRef.current], progress }),
      })
    } catch {}
  }

  // 收藏变化时立即同步（防抖 500ms）
  function scheduleSync() {
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(pushSync, 500)
  }

  // 每 5 秒同步一次进度（播放期间）
  useEffect(() => {
    const id = setInterval(() => {
      if (playerRef.current && !playerRef.current.paused) pushSync()
    }, 5_000)
    return () => clearInterval(id)
  }, [])

  // Persist translation toggle
  useEffect(() => {
    try { localStorage.setItem('podcast-translation', showTranslation ? '1' : '0') } catch {}
  }, [showTranslation])

  const saveProgress = useCallback((id: string, cur: number, dur: number) => {
    if (cur < 5 || dur <= 0) return
    const data = { pos: Math.floor(cur), dur: Math.floor(dur) }
    localStorage.setItem(`podcast-pos-${id}`, JSON.stringify(data))
    setVideoProgress(prev => ({ ...prev, [id]: cur / dur }))
    setVideoDetails(prev => ({ ...prev, [id]: data }))
  }, [])

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return
      if (currentIdRef.current && playerRef.current)
        try { saveProgress(currentIdRef.current, playerRef.current.currentTime || 0, playerRef.current.duration || 0) } catch {}
      pushSync()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [saveProgress])

  // ── Pull-to-close transcript ──
  useEffect(() => {
    if (!showTranscript) { setPullY(0); return }
    const el = transcriptPageRef.current
    if (!el) return
    const onStart = (e: TouchEvent) => {
      pullStartYRef.current = e.touches[0].clientY
      pullActiveRef.current = false
    }
    const onMove = (e: TouchEvent) => {
      const listEl = transcriptListRef.current
      if (listEl && listEl.scrollTop > 0) { pullActiveRef.current = false; return }
      const delta = e.touches[0].clientY - pullStartYRef.current
      if (delta > 8) {
        pullActiveRef.current = true
        const y = Math.min(delta * 0.4, 200)
        pullYRef.current = y
        setPullY(y)
        e.preventDefault()
      }
    }
    const onEnd = () => {
      if (pullActiveRef.current && pullYRef.current > 80) {
        setPullY(0)
        closeSheet('transcript', setShowTranscript)
      } else {
        setPullY(0)
      }
      pullYRef.current = 0
      pullActiveRef.current = false
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
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
        if (currentIdRef.current && cur - lastProgressSaveRef.current >= 5) {
          lastProgressSaveRef.current = cur
          saveProgress(currentIdRef.current, cur, dur)
        }
      } catch {}
    }, 1000)
  }, [saveProgress])

  function ensureAudio(): HTMLAudioElement {
    if (playerRef.current) return playerRef.current
    const a = audioElRef.current ?? new Audio()
    a.preload = 'auto'
    a.addEventListener('play', () => setPlaying(true))
    a.addEventListener('pause', () => setPlaying(false))
    a.addEventListener('ended', () => {
      if (currentIdRef.current && a.duration > 0) saveProgress(currentIdRef.current, a.duration, a.duration)
      if (stopAfterCurrentRef.current) {
        setStopAfterCurrent(false)
        setPlaying(false)
        return
      }
      const vids = videosRef.current
      const idx = vids.findIndex(v => v.id === currentIdRef.current)
      if (idx >= 0 && idx < vids.length - 1) playFnRef.current(vids[idx + 1])
      else setPlaying(false)
    })
    a.addEventListener('loadedmetadata', () => {
      if (savedPosRef.current > 5 && a.duration && savedPosRef.current < a.duration - 2)
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
      playerRef.current?.play(); setPlaying(true)
      navigator.mediaSession.playbackState = 'playing'
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      playerRef.current?.pause(); setPlaying(false)
      navigator.mediaSession.playbackState = 'paused'
    })
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15))
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30))
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (playerRef.current && typeof d.seekTime === 'number') playerRef.current.currentTime = d.seekTime
    })
  }

  function play(video: Video) {
    currentIdRef.current = video.id
    lastProgressSaveRef.current = 0
    try {
      const d = JSON.parse(localStorage.getItem(`podcast-pos-${video.id}`) || '{}')
      savedPosRef.current = d.pos || 0
    } catch { savedPosRef.current = 0 }
    setCurrent(video)
    setProgress(0); setElapsed(0); setDuration(0)
    const a = ensureAudio()
    a.src = AUDIO_BASE + encodeURIComponent(video.id) + '.m4a'
    a.playbackRate = playbackRate
    a.play().catch(() => {})
    setPlaying(true)
    startPolling()
    setupMediaSession(video)
  }

  function togglePlay() {
    const a = playerRef.current
    if (!a) return
    if (a.paused) { a.play().catch(() => {}); setPlaying(true) }
    else { a.pause(); setPlaying(false) }
  }

  function skip(seconds: number) {
    const a = playerRef.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(a.duration || Infinity, (a.currentTime || 0) + seconds))
  }

  function onSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value)
    setProgress(val); setElapsed(val * duration)
  }

  function onSeekEnd() {
    if (playerRef.current) playerRef.current.currentTime = progress * duration
    seekingRef.current = false
  }

  function openTimerSheet() {
    const base = timerMinutes > 0 ? timerMinutes : 30
    setPickerHours(Math.floor(base / 60))
    setPickerMins(base % 60)
    setShowTimer(true)
  }

  function startTimer(minutes: number) {
    setTimerMinutes(minutes)
    closeSheet('timer', setShowTimer)
    if (timerRef.current) clearInterval(timerRef.current)
    if (minutes === 0) { setTimeLeft(null); return }
    let remaining = minutes * 60
    setTimeLeft(remaining)
    timerRef.current = setInterval(() => {
      remaining -= 1
      setTimeLeft(remaining)
      if (remaining <= 0) {
        clearInterval(timerRef.current!)
        playerRef.current?.pause()
        setPlaying(false)
        setTimeLeft(null); setTimerMinutes(0)
      }
    }, 1000)
  }

  function cycleSpeed() {
    const next = SPEED_OPTIONS[(SPEED_OPTIONS.indexOf(playbackRate) + 1) % SPEED_OPTIONS.length]
    setPlaybackRate(next)
    if (playerRef.current) playerRef.current.playbackRate = next
  }

  function resetProgress(videoId: string, e: React.MouseEvent) {
    e.stopPropagation()
    localStorage.removeItem(`podcast-pos-${videoId}`)
    setVideoProgress(prev => { const n = { ...prev }; delete n[videoId]; return n })
    setVideoDetails(prev => { const n = { ...prev }; delete n[videoId]; return n })
    scheduleSync()
  }

  function toggleFavorite(videoId: string, e: React.MouseEvent) {
    e.stopPropagation()
    setFavorites(prev => {
      const next = new Set(prev)
      next.has(videoId) ? next.delete(videoId) : next.add(videoId)
      localStorage.setItem('podcast-favorites', JSON.stringify([...next]))
      favoritesRef.current = next
      scheduleSync()
      return next
    })
  }

  async function openTranscript(video: Video) {
    setShowTranscript(true)
    if (transcriptVideoId === video.id && transcriptSegs.length > 0) return
    setTranscriptLoading(true); setTranscriptError(null)
    setTranscriptSegs([]); setTranscriptVideoId(video.id)
    try {
      const res = await fetch(`/data/transcripts/${video.id}.json`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      data.segments?.length ? setTranscriptSegs(data.segments) : setTranscriptError('暂无字幕')
    } catch { setTranscriptError('暂无字幕') }
    finally { setTranscriptLoading(false) }
  }

  const currentSegIdx = useMemo(() => transcriptSegs.findIndex(
    (s, i) => elapsed >= s.start && (i === transcriptSegs.length - 1 || elapsed < transcriptSegs[i + 1].start)
  ), [transcriptSegs, elapsed])

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
    const p = videoProgress[v.id] ?? 0
    if (filter === 'all') return true
    if (filter === 'fav') return favorites.has(v.id)
    if (filter === 'inprogress') return p > 0 && p < DONE_THRESHOLD
    if (filter === 'done') return p >= DONE_THRESHOLD
    return true
  }), [videos, videoProgress, filter, favorites])

  playFnRef.current = play

  return (
    <div className="flex flex-col h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      <audio ref={audioElRef} playsInline preload="auto"
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />

      {/* ── Main list ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Channel header — compact horizontal */}
        <div className="px-4 pb-3" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)' }}>
          <div className="flex items-center gap-3">
            <button
              onClick={() => channels.length > 1 && setShowChannelPicker(true)}
              className="flex-shrink-0 active:scale-95 transition-transform duration-150">
              <div className="w-[52px] h-[52px] rounded-[14px] shadow overflow-hidden flex items-center justify-center"
                style={{ background: `linear-gradient(145deg, ${ac} 0%, #5e5ce6 100%)` }}>
                {channelAvatars[activeChannel.id]
                  ? <img src={channelAvatars[activeChannel.id]} alt="" className="w-full h-full object-cover" />
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

          {/* Filter tabs */}
          <div className="flex gap-1.5 mt-3 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
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
          </div>
        </div>

        <div className="h-px" style={{ background: 'var(--separator)' }} />

        {filteredVideos.length === 0 && (
          <div className="px-5 py-12 text-center">
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {videos.length === 0 ? '加载中…' :
               filter === 'fav' ? '还没有收藏的节目' :
               filter === 'inprogress' ? '没有进行中的节目' :
               filter === 'done' ? '还没有听完的节目' : '暂无节目'}
            </p>
          </div>
        )}

        {/* Video list */}
        <div className="pb-1">
          {filteredVideos.map(video => {
            const isActive = current?.id === video.id
            const isFav = favorites.has(video.id)
            const prog = videoProgress[video.id] ?? 0
            const isDone = prog >= DONE_THRESHOLD
            const det = videoDetails[video.id]
            const totalDur = video.duration ?? det?.dur
            const displayProg = isActive ? progress : prog
            const pct = prog > 0 ? Math.round(prog * 100) : 0
            return (
              <div key={video.id} className="relative">
                {isActive && (
                  <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full"
                    style={{ background: ac }} />
                )}
                <div
                  onClick={() => play(video)}
                  className="flex items-center gap-3.5 px-5 py-3.5 cursor-pointer active:opacity-60 transition-opacity"
                  style={{ background: isActive ? `${ac}12` : 'transparent' }}
                >
                  {/* Thumbnail */}
                  <div className="relative flex-shrink-0">
                    <img src={video.thumbnail} alt="" loading="lazy"
                      className="w-[54px] h-[54px] rounded-xl object-cover"
                      style={{ background: 'var(--bg-raised)' }} />
                    {/* Completed badge */}
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

                  {/* Info */}
                  <div className="flex-1 min-w-0 pr-8">
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
                          {isActive
                            ? <>{formatTime(elapsed)}<span style={{ opacity: 0.5 }}> / {formatTime(duration || totalDur)}</span></>
                            : det && !isDone
                              ? <>{formatTime(det.pos)}<span style={{ opacity: 0.5 }}> / {formatTime(totalDur)}</span></>
                              : formatTime(totalDur)
                          }
                        </p>
                      )}
                      {pct > 0 && !isDone && !isActive && (
                        <span className="text-[10px] tabular-nums font-medium" style={{ color: ac, opacity: 0.8 }}>
                          {pct}%
                        </span>
                      )}
                      {isDone && !isActive && (
                        <button onClick={(e) => resetProgress(video.id, e)}
                          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium active:opacity-50 flex items-center gap-1"
                          style={{ background: `${ac}20`, color: ac }}>
                          已听完
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        </button>
                      )}
                    </div>
                    {displayProg > 0 && displayProg < DONE_THRESHOLD && (
                      <div className="mt-1.5 h-[2px] rounded-full overflow-hidden" style={{ background: 'var(--separator)' }}>
                        <div className="h-full rounded-full"
                          style={{ width: `${Math.round(displayProg * 100)}%`, background: ac, opacity: isActive ? 1 : 0.6 }} />
                      </div>
                    )}
                  </div>
                </div>

                {/* Favorite button */}
                <button
                  onClick={(e) => toggleFavorite(video.id, e)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-2 active:scale-90 transition-transform">
                  <svg width="16" height="16" viewBox="0 0 24 24"
                    fill={isFav ? ac : 'none'}
                    stroke={isFav ? ac : 'var(--text-tertiary)'}
                    strokeWidth="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                  </svg>
                </button>
              </div>
            )
          })}
        </div>

        {current && <div className="h-28" />}
      </div>

      {/* ── Channel picker sheet ── */}
      {showChannelPicker && (
        <div className="fixed inset-0 z-50 flex items-end"
          onClick={() => closeSheet('channel', setShowChannelPicker)}
          style={overlayAnim('channel')}>
          <div className="w-full rounded-t-[28px] px-5 pt-3 pb-10"
            style={sheetAnim('channel')}
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
                  {channelAvatars[ch.id]
                    ? <img src={channelAvatars[ch.id]} alt="" className="w-full h-full object-cover" />
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
        <div className="fixed inset-0 z-40 flex items-end"
          onClick={() => closeSheet('timer', setShowTimer)}
          style={overlayAnim('timer')}>
          <div className="w-full rounded-t-[28px] px-5 pt-3 pb-10"
            style={sheetAnim('timer')}
            onClick={e => e.stopPropagation()}>
            <div className="w-9 h-1 rounded-full mx-auto mb-5" style={{ background: 'var(--separator)' }} />
            <p className="text-[17px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>定时停止播放</p>

            {/* Scroll picker */}
            <div className="flex items-center gap-1 mt-2">
              <ScrollPicker values={HOUR_VALUES} selected={pickerHours} onChange={setPickerHours} label="小时" />
              <span className="text-[28px] font-light pb-6" style={{ color: 'var(--text-secondary)' }}>:</span>
              <ScrollPicker values={MIN_VALUES} selected={pickerMins} onChange={setPickerMins} label="分钟" />
            </div>

            {/* 放完这个停止 */}
            <button onClick={() => setStopAfterCurrent(p => !p)}
              className="w-full flex items-center justify-between py-3.5 border-t mt-1 active:opacity-60"
              style={{ borderColor: 'var(--separator)' }}>
              <span className="text-[15px]" style={{ color: 'var(--text-primary)' }}>放完这个停止</span>
              {stopAfterCurrent
                ? <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ac} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                : <div className="w-5 h-5 rounded-full border-2" style={{ borderColor: 'var(--separator)' }} />
              }
            </button>

            {/* 确认按钮 */}
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
              onMouseDown={() => { seekingRef.current = true; seekingRef.current = true }}
              onTouchStart={() => { seekingRef.current = true; seekingRef.current = true }}
              onChange={onSeekChange} onMouseUp={onSeekEnd} onTouchEnd={onSeekEnd}
              className="absolute w-full opacity-0 cursor-pointer"
              style={{ height: 16, top: -7 }} />
          </div>

          <div className="flex items-center gap-3 px-4 pt-3 pb-2.5">
            <button onClick={() => current && openTranscript(current)}
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
              <button onClick={() => skip(-15)} className="active:opacity-50 p-1" style={{ color: 'var(--text-secondary)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={togglePlay} className="active:scale-90 transition-transform duration-100">
                <div className="w-[42px] h-[42px] rounded-full flex items-center justify-center shadow"
                  style={{ background: ac }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                    {playing
                      ? <><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></>
                      : <path d="M8 5v14l11-7z"/>}
                  </svg>
                </div>
              </button>
              <button onClick={() => skip(15)} className="active:opacity-50 p-1" style={{ color: 'var(--text-secondary)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={openTimerSheet} className="active:opacity-50 p-1">
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
        <div ref={transcriptPageRef} className="fixed inset-0 z-50 flex flex-col"
          style={{
            animation: pullY > 0 ? 'none' : `${closingSheet === 'transcript' ? 'page-down' : 'page-up'} 0.35s cubic-bezier(0.32,0.72,0,1) forwards`,
            background: 'var(--bg)',
            transform: pullY > 0 ? `translateY(${pullY}px)` : undefined,
          }}>
          <div className="flex items-center justify-between px-5 pt-14 pb-3 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--separator)' }}>
            <button
              onClick={() => closeSheet('transcript', setShowTranscript)}
              className="flex items-center gap-1 text-[14px] font-medium active:opacity-60"
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

          <div className="px-5 py-2.5 flex items-center gap-3 flex-shrink-0"
            style={{ background: 'var(--bg-raised)', borderBottom: '1px solid var(--separator)' }}>
            <img src={current.thumbnail} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
            <p className="text-[12px] truncate flex-1 font-medium" style={{ color: 'var(--text-secondary)' }}>{current.title}</p>
            <button onClick={cycleSpeed} className="active:opacity-60">
              <span className="text-[12px] font-bold" style={{ color: ac }}>{playbackRate}x</span>
            </button>
            <button onClick={togglePlay} className="active:scale-90 transition-transform">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: ac }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="white">
                  {playing
                    ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                    : <path d="M8 5v14l11-7z"/>}
                </svg>
              </div>
            </button>
          </div>

          <div ref={transcriptListRef} className="flex-1 overflow-y-auto py-3"
            onTouchStart={() => { userScrollingRef.current = true }}
            onTouchEnd={() => { setTimeout(() => { userScrollingRef.current = false }, 3000) }}>
            {transcriptLoading && <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>加载字幕中…</p>}
            {transcriptError && <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>{transcriptError}</p>}
            {transcriptSegs.map((seg, i) => {
              const isActive = i === currentSegIdx
              return (
                <button id={`seg-${i}`} key={i}
                  onClick={() => {
                    const a = playerRef.current
                    if (!a) return
                    a.currentTime = seg.start
                    if (a.paused) { a.play().catch(() => {}); setPlaying(true) }
                  }}
                  className="w-full text-left px-5 py-2.5 active:opacity-60">
                  {isActive && <div className="w-5 h-[2px] rounded-full mb-2" style={{ background: ac }} />}
                  <p style={{
                    color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    fontWeight: isActive ? 600 : 400,
                    fontSize: isActive ? 17 : 15,
                    lineHeight: 1.6,
                    transition: 'color 0.15s',
                  }}>{seg.ko}</p>
                  {showTranslation && seg.zh && seg.zh !== seg.ko && (
                    <p style={{
                      color: isActive ? ac : 'var(--text-tertiary)',
                      fontSize: isActive ? 14 : 13,
                      fontWeight: isActive ? 500 : 400,
                      lineHeight: 1.5,
                      marginTop: 4,
                      opacity: isActive ? 1 : 0.65,
                      transition: 'color 0.15s',
                    }}>{seg.zh}</p>
                  )}
                </button>
              )
            })}
            <div className="h-24" />
          </div>

          <div className="flex-shrink-0 px-5 pt-3 pb-3"
            style={{
              background: 'var(--bg-glass)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              borderTop: '1px solid var(--separator)',
            }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[11px] tabular-nums w-8 text-right" style={{ color: 'var(--text-tertiary)' }}>{formatTime(elapsed)}</span>
              <div className="flex-1 relative h-[3px] rounded-full" style={{ background: 'var(--separator)' }}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: filled, background: ac }} />
                <input type="range" min="0" max="1" step="0.001" value={progress}
                  onMouseDown={() => { seekingRef.current = true; seekingRef.current = true }}
                  onTouchStart={() => { seekingRef.current = true; seekingRef.current = true }}
                  onChange={onSeekChange} onMouseUp={onSeekEnd} onTouchEnd={onSeekEnd}
                  className="absolute w-full opacity-0 cursor-pointer"
                  style={{ height: 20, top: -9 }} />
              </div>
              <span className="text-[11px] tabular-nums w-8" style={{ color: 'var(--text-tertiary)' }}>{formatTime(duration)}</span>
            </div>
            <div className="flex items-center justify-center gap-8">
              <button onClick={() => skip(-15)} className="active:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={togglePlay} className="active:scale-90 transition-transform duration-100">
                <div className="w-[54px] h-[54px] rounded-full flex items-center justify-center shadow-md" style={{ background: ac }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                    {playing
                      ? <><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></>
                      : <path d="M8 5v14l11-7z"/>}
                  </svg>
                </div>
              </button>
              <button onClick={() => skip(15)} className="active:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={openTimerSheet} className="active:opacity-50 p-1">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 || stopAfterCurrent ? ac : 'var(--text-secondary)'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3M9 3h6M12 3v2"/>
                </svg>
              </button>
            </div>
            <div style={{ height: 'env(safe-area-inset-bottom)' }} />
          </div>
        </div>
      )}
    </div>
  )
}
