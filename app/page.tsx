'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import channelsData from '@/data/channels.json'

interface Channel { id: string; name: string; description: string; initial: string; color: string }
interface Video { id: string; title: string; published: string; thumbnail: string }
interface TranscriptSegment { start: number; end: number; ko: string; zh: string }
interface ChannelVideos { channelName: string; videos: Video[] }

const TIMER_OPTIONS = [
  { label: '关闭', minutes: 0 },
  { label: '15分钟', minutes: 15 },
  { label: '30分钟', minutes: 30 },
  { label: '60分钟', minutes: 60 },
  { label: '90分钟', minutes: 90 },
]
const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2]
const RAW_AUDIO_BASE = process.env.NEXT_PUBLIC_AUDIO_BASE || '/audio/'
const AUDIO_BASE = RAW_AUDIO_BASE.endsWith('/') ? RAW_AUDIO_BASE : RAW_AUDIO_BASE + '/'
const channels: Channel[] = channelsData

function formatTime(s: number) {
  if (!s || isNaN(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

type SheetName = 'channel' | 'timer' | 'transcript'

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
  const [seeking, setSeeking] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const [transcriptSegs, setTranscriptSegs] = useState<TranscriptSegment[]>([])
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptVideoId, setTranscriptVideoId] = useState<string | null>(null)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [videoProgress, setVideoProgress] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<'all' | 'inprogress' | 'done'>('all')
  const [closingSheet, setClosingSheet] = useState<SheetName | null>(null)

  const playerRef = useRef<HTMLAudioElement | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const seekingRef = useRef(false)
  const transcriptListRef = useRef<HTMLDivElement>(null)
  const userScrollingRef = useRef(false)
  const savedPosRef = useRef(0)
  const currentIdRef = useRef<string | null>(null)
  const lastProgressSaveRef = useRef(0)

  const activeChannel = channels.find(c => c.id === activeChannelId) ?? channels[0]
  const videos = channelVideos[activeChannelId] ?? []
  const ac = activeChannel.color

  // Animate out then unmount
  function closeSheet(name: SheetName, setter: (v: boolean) => void) {
    setClosingSheet(name)
    setTimeout(() => { setter(false); setClosingSheet(null) }, 300)
  }

  useEffect(() => {
    if (channelVideos[activeChannelId]) return
    fetch(`/data/videos/${activeChannelId}.json`)
      .then(r => r.json())
      .then((data: ChannelVideos) => setChannelVideos(prev => ({ ...prev, [activeChannelId]: data.videos })))
      .catch(console.error)
  }, [activeChannelId])

  // Load persisted preferences + progress
  useEffect(() => {
    try {
      const fav = localStorage.getItem('podcast-favorites')
      if (fav) setFavorites(new Set(JSON.parse(fav)))
      const trans = localStorage.getItem('podcast-translation')
      if (trans !== null) setShowTranslation(trans === '1')
    } catch {}
    const prog: Record<string, number> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('podcast-pos-')) {
        try {
          const d = JSON.parse(localStorage.getItem(key) || '{}')
          if (d.pos > 0 && d.dur > 0) prog[key.replace('podcast-pos-', '')] = d.pos / d.dur
        } catch {}
      }
    }
    setVideoProgress(prog)
  }, [])

  // Persist translation toggle
  useEffect(() => {
    try { localStorage.setItem('podcast-translation', showTranslation ? '1' : '0') } catch {}
  }, [showTranslation])

  const saveProgress = useCallback((id: string, cur: number, dur: number) => {
    if (cur < 5 || dur <= 0) return
    localStorage.setItem(`podcast-pos-${id}`, JSON.stringify({ pos: Math.floor(cur), dur: Math.floor(dur) }))
    setVideoProgress(prev => ({ ...prev, [id]: cur / dur }))
  }, [])

  useEffect(() => {
    const onHide = () => {
      if (!currentIdRef.current || !playerRef.current) return
      try { saveProgress(currentIdRef.current, playerRef.current.currentTime || 0, playerRef.current.duration || 0) } catch {}
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [saveProgress])

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      const a = playerRef.current
      if (!a || seekingRef.current) return
      try {
        const cur = a.currentTime || 0
        const dur = a.duration || 0
        const paused = a.paused
        // Only re-render if values actually changed
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
    }, 500)
  }, [saveProgress])

  function ensureAudio(): HTMLAudioElement {
    if (playerRef.current) return playerRef.current
    const a = audioElRef.current ?? new Audio()
    a.preload = 'auto'
    a.addEventListener('play', () => setPlaying(true))
    a.addEventListener('pause', () => setPlaying(false))
    a.addEventListener('ended', () => {
      setPlaying(false)
      if (currentIdRef.current && a.duration > 0) saveProgress(currentIdRef.current, a.duration, a.duration)
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
    seekingRef.current = false; setSeeking(false)
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

  function toggleFavorite(videoId: string, e: React.MouseEvent) {
    e.stopPropagation()
    setFavorites(prev => {
      const next = new Set(prev)
      next.has(videoId) ? next.delete(videoId) : next.add(videoId)
      localStorage.setItem('podcast-favorites', JSON.stringify([...next]))
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
      if (!res.ok) throw new Error('not_found')
      const data = await res.json()
      data.segments?.length ? setTranscriptSegs(data.segments) : setTranscriptError('暂无字幕')
    } catch { setTranscriptError('暂无字幕') }
    finally { setTranscriptLoading(false) }
  }

  const currentSegIdx = transcriptSegs.findIndex(
    (s, i) => elapsed >= s.start && (i === transcriptSegs.length - 1 || elapsed < transcriptSegs[i + 1].start)
  )

  useEffect(() => {
    if (!showTranscript || currentSegIdx < 0 || userScrollingRef.current) return
    document.getElementById(`seg-${currentSegIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentSegIdx, showTranscript])

  const filled = `${Math.round(progress * 100)}%`

  // Shared sheet overlay style
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

  return (
    <div className="flex flex-col h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      <audio ref={audioElRef} playsInline preload="auto"
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />

      {/* ── Main scrollable list ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Channel header */}
        <div className="px-5 pt-12 pb-5">
          <button
            onClick={() => channels.length > 1 && setShowChannelPicker(true)}
            className="block mb-5 active:scale-95 transition-transform duration-150"
          >
            <div className="w-24 h-24 rounded-[22px] shadow-lg flex items-center justify-center"
              style={{ background: `linear-gradient(145deg, ${ac} 0%, #5e5ce6 100%)` }}>
              <span className="text-5xl font-bold text-white select-none">{activeChannel.initial}</span>
            </div>
          </button>
          <h1 className="text-[22px] font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
            {activeChannel.name}
          </h1>
          <p className="text-sm font-medium mt-0.5" style={{ color: ac }}>{activeChannel.description}</p>
          <div className="flex items-center gap-3 mt-2">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{videos.length} 个节目</p>
            {channels.length > 1 && (
              <button
                onClick={() => setShowChannelPicker(true)}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border"
                style={{ borderColor: 'var(--separator)', color: 'var(--text-secondary)' }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
                </svg>
                切换博主
              </button>
            )}
          </div>
        </div>

        <div className="h-px mx-5" style={{ background: 'var(--separator)' }} />

        {/* Filter */}
        <div className="px-5 pt-4 pb-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>节目列表</span>
          <div className="flex gap-1">
            {(['all', 'inprogress', 'done'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className="text-xs px-2.5 py-1 rounded-full transition-colors"
                style={{
                  background: filter === f ? ac : 'var(--bg-raised)',
                  color: filter === f ? 'white' : 'var(--text-secondary)',
                }}>
                {f === 'all' ? '全部' : f === 'inprogress' ? '进行中' : '已听完'}
              </button>
            ))}
          </div>
        </div>

        {videos.length === 0 && (
          <p className="px-5 py-12 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>加载中...</p>
        )}

        {/* Video list */}
        <div className="pb-1">
          {videos.filter(v => {
            if (filter === 'all') return true
            const p = videoProgress[v.id] ?? 0
            return filter === 'inprogress' ? p > 0 && p < 0.97 : p >= 0.97
          }).map(video => {
            const isActive = current?.id === video.id
            const isFav = favorites.has(video.id)
            const prog = videoProgress[video.id] ?? 0
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
                    {!isActive && prog >= 0.97 && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center shadow-sm"
                        style={{ background: ac }}>
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
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
                    <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {formatDate(video.published)}
                    </p>
                    {!isActive && prog > 0 && prog < 0.97 && (
                      <div className="mt-2 h-[2px] rounded-full overflow-hidden" style={{ background: 'var(--separator)' }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.round(prog * 100)}%`, background: ac, opacity: 0.5 }} />
                      </div>
                    )}
                  </div>
                </div>

                {/* Favorite */}
                <button
                  onClick={(e) => toggleFavorite(video.id, e)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-2 active:scale-90 transition-transform"
                >
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
                <div className="w-10 h-10 rounded-[12px] flex items-center justify-center flex-shrink-0"
                  style={{ background: `linear-gradient(145deg, ${ch.color} 0%, #5e5ce6 100%)` }}>
                  <span className="text-lg font-bold text-white">{ch.initial}</span>
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
            <p className="text-[17px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>定时停止播放</p>
            {TIMER_OPTIONS.map(opt => (
              <button key={opt.minutes} onClick={() => startTimer(opt.minutes)}
                className="w-full flex items-center justify-between py-4 border-b last:border-0 active:opacity-60"
                style={{ borderColor: 'var(--separator)' }}>
                <span className="text-[15px]" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
                {timerMinutes === opt.minutes && (
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={ac} strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
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
          {/* Seek bar */}
          <div className="relative h-[2px]" style={{ background: 'var(--separator)' }}>
            <div className="absolute inset-y-0 left-0" style={{ width: filled, background: ac }} />
            <input type="range" min="0" max="1" step="0.001" value={progress}
              onMouseDown={() => { seekingRef.current = true; setSeeking(true) }}
              onTouchStart={() => { seekingRef.current = true; setSeeking(true) }}
              onChange={onSeekChange} onMouseUp={onSeekEnd} onTouchEnd={onSeekEnd}
              className="absolute w-full opacity-0 cursor-pointer"
              style={{ height: 16, top: -7 }} />
          </div>

          <div className="flex items-center gap-3 px-4 pt-3 pb-2.5">
            {/* Tap to open transcript */}
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
                    <span className="ml-1 font-medium" style={{ color: ac }}>
                      {formatTime(timeLeft)} 后停
                    </span>
                  )}
                </p>
              </div>
            </button>

            {/* Controls */}
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
              <button onClick={() => setShowTimer(true)} className="active:opacity-50 p-1">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 ? ac : 'var(--text-tertiary)'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3M9 3h6M12 3v2"/>
                </svg>
              </button>
            </div>
          </div>
          <div style={{ height: 'env(safe-area-inset-bottom)' }} />
        </div>
      )}

      {/* ── Transcript full-screen page ── */}
      {showTranscript && current && (
        <div className="fixed inset-0 z-50 flex flex-col"
          style={{
            animation: `${closingSheet === 'transcript' ? 'page-down' : 'page-up'} 0.35s cubic-bezier(0.32,0.72,0,1) forwards`,
            background: 'var(--bg)',
          }}>
          {/* Header */}
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
              className="text-[12px] px-3 py-1.5 rounded-full border transition-colors"
              style={{
                borderColor: showTranslation ? ac : 'var(--separator)',
                background: showTranslation ? `${ac}20` : 'transparent',
                color: showTranslation ? ac : 'var(--text-secondary)',
                fontWeight: showTranslation ? 600 : 400,
              }}>
              中文翻译
            </button>
          </div>

          {/* Now playing bar */}
          <div className="px-5 py-2.5 flex items-center gap-3 flex-shrink-0"
            style={{ background: 'var(--bg-raised)', borderBottom: '1px solid var(--separator)' }}>
            <img src={current.thumbnail} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
            <p className="text-[12px] truncate flex-1 font-medium" style={{ color: 'var(--text-secondary)' }}>{current.title}</p>
            <button onClick={cycleSpeed} className="flex-shrink-0 active:opacity-60">
              <span className="text-[12px] font-bold" style={{ color: ac }}>{playbackRate}x</span>
            </button>
            <button onClick={togglePlay} className="flex-shrink-0 active:scale-90 transition-transform">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: ac }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="white">
                  {playing
                    ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                    : <path d="M8 5v14l11-7z"/>}
                </svg>
              </div>
            </button>
          </div>

          {/* Subtitles */}
          <div ref={transcriptListRef} className="flex-1 overflow-y-auto py-3"
            onTouchStart={() => { userScrollingRef.current = true }}
            onTouchEnd={() => { setTimeout(() => { userScrollingRef.current = false }, 3000) }}>
            {transcriptLoading && (
              <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>加载字幕中…</p>
            )}
            {transcriptError && (
              <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>{transcriptError}</p>
            )}
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
                  {isActive && (
                    <div className="w-5 h-[2px] rounded-full mb-2" style={{ background: ac }} />
                  )}
                  <p style={{
                    color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    fontWeight: isActive ? 600 : 400,
                    fontSize: isActive ? 17 : 15,
                    lineHeight: 1.6,
                    transition: 'color 0.15s, font-size 0.15s',
                  }}>
                    {seg.ko}
                  </p>
                  {showTranslation && seg.zh && seg.zh !== seg.ko && (
                    <p style={{
                      color: isActive ? ac : 'var(--text-tertiary)',
                      fontSize: isActive ? 14 : 13,
                      fontWeight: isActive ? 500 : 400,
                      lineHeight: 1.5,
                      marginTop: 4,
                      opacity: isActive ? 1 : 0.65,
                      transition: 'color 0.15s',
                    }}>
                      {seg.zh}
                    </p>
                  )}
                </button>
              )
            })}
            <div className="h-24" />
          </div>

          {/* Seek + controls */}
          <div className="flex-shrink-0 px-5 pt-3 pb-3"
            style={{
              background: 'var(--bg-glass)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              borderTop: '1px solid var(--separator)',
            }}>
            {/* Progress */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[11px] tabular-nums w-8 text-right" style={{ color: 'var(--text-tertiary)' }}>
                {formatTime(elapsed)}
              </span>
              <div className="flex-1 relative h-[3px] rounded-full" style={{ background: 'var(--separator)' }}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: filled, background: ac }} />
                <input type="range" min="0" max="1" step="0.001" value={progress}
                  onMouseDown={() => { seekingRef.current = true; setSeeking(true) }}
                  onTouchStart={() => { seekingRef.current = true; setSeeking(true) }}
                  onChange={onSeekChange} onMouseUp={onSeekEnd} onTouchEnd={onSeekEnd}
                  className="absolute w-full opacity-0 cursor-pointer"
                  style={{ height: 20, top: -9 }} />
              </div>
              <span className="text-[11px] tabular-nums w-8" style={{ color: 'var(--text-tertiary)' }}>
                {formatTime(duration)}
              </span>
            </div>
            {/* Skip + play */}
            <div className="flex items-center justify-center gap-12">
              <button onClick={() => skip(-15)} className="active:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={togglePlay} className="active:scale-90 transition-transform duration-100">
                <div className="w-[54px] h-[54px] rounded-full flex items-center justify-center shadow-md"
                  style={{ background: ac }}>
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
            </div>
            <div style={{ height: 'env(safe-area-inset-bottom)' }} />
          </div>
        </div>
      )}
    </div>
  )
}
