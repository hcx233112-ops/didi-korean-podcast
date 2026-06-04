'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import channelsData from '@/data/channels.json'

interface Channel {
  id: string
  name: string
  description: string
  initial: string
  color: string
}

interface Video {
  id: string
  title: string
  published: string
  thumbnail: string
}

interface TranscriptSegment {
  start: number
  end: number
  ko: string
  zh: string
}

interface ChannelVideos {
  channelName: string
  videos: Video[]
}

const TIMER_OPTIONS = [
  { label: '关闭', minutes: 0 },
  { label: '15分钟', minutes: 15 },
  { label: '30分钟', minutes: 30 },
  { label: '60分钟', minutes: 60 },
  { label: '90分钟', minutes: 90 },
]

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2]

const channels: Channel[] = channelsData

function formatTime(s: number) {
  if (!s || isNaN(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatDate(s: string) {
  return new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

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

  const playerRef = useRef<YT.Player | null>(null)
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
  const accentColor = activeChannel.color

  useEffect(() => {
    if (channelVideos[activeChannelId]) return
    fetch(`/data/videos/${activeChannelId}.json`)
      .then(r => r.json())
      .then((data: ChannelVideos) => {
        setChannelVideos(prev => ({ ...prev, [activeChannelId]: data.videos }))
      })
      .catch(console.error)
  }, [activeChannelId])

  useEffect(() => {
    if (document.getElementById('yt-iframe-api')) return
    const tag = document.createElement('script')
    tag.id = 'yt-iframe-api'
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('podcast-favorites')
      if (saved) setFavorites(new Set(JSON.parse(saved)))
    } catch {}
    const prog: Record<string, number> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('podcast-pos-')) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || '{}')
          if (data.pos > 0 && data.dur > 0) {
            prog[key.replace('podcast-pos-', '')] = data.pos / data.dur
          }
        } catch {}
      }
    }
    setVideoProgress(prog)
  }, [])

  const saveProgress = useCallback((id: string, cur: number, dur: number) => {
    if (cur < 5 || dur <= 0) return
    localStorage.setItem(`podcast-pos-${id}`, JSON.stringify({ pos: Math.floor(cur), dur: Math.floor(dur) }))
    setVideoProgress(prev => ({ ...prev, [id]: cur / dur }))
  }, [])

  useEffect(() => {
    const onHide = () => {
      if (!currentIdRef.current || !playerRef.current) return
      try {
        saveProgress(currentIdRef.current, playerRef.current.getCurrentTime() || 0, playerRef.current.getDuration() || 0)
      } catch {}
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [saveProgress])

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      if (!playerRef.current || seekingRef.current) return
      try {
        const state = playerRef.current.getPlayerState()
        const cur = playerRef.current.getCurrentTime() || 0
        const dur = playerRef.current.getDuration() || 0
        setPlaying(state === 1)
        setElapsed(cur)
        setDuration(dur)
        setProgress(dur > 0 ? cur / dur : 0)
        if (currentIdRef.current && cur - lastProgressSaveRef.current >= 5) {
          lastProgressSaveRef.current = cur
          saveProgress(currentIdRef.current, cur, dur)
        }
      } catch {}
    }, 500)
  }, [saveProgress])

  function createPlayer(videoId: string) {
    if (playerRef.current) {
      playerRef.current.loadVideoById(videoId)
      playerRef.current.setPlaybackRate(playbackRate)
      if (savedPosRef.current > 5) playerRef.current.seekTo(savedPosRef.current, true)
      setPlaying(true)
      return
    }
    playerRef.current = new (window as any).YT.Player('yt-player', {
      videoId,
      playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0 },
      events: {
        onReady: (e: YT.PlayerEvent) => {
          if (savedPosRef.current > 5) e.target.seekTo(savedPosRef.current, true)
          e.target.setPlaybackRate(playbackRate)
          e.target.playVideo()
          setPlaying(true)
          startPolling()
        },
        onStateChange: (e: YT.OnStateChangeEvent) => {
          setPlaying(e.data === 1)
        },
      },
    })
    startPolling()
  }

  function play(video: Video) {
    currentIdRef.current = video.id
    lastProgressSaveRef.current = 0
    try {
      const data = JSON.parse(localStorage.getItem(`podcast-pos-${video.id}`) || '{}')
      savedPosRef.current = data.pos || 0
    } catch { savedPosRef.current = 0 }
    setCurrent(video)
    setProgress(0); setElapsed(0); setDuration(0)
    if (!(window as any).YT?.Player) {
      ;(window as any).onYouTubeIframeAPIReady = () => createPlayer(video.id)
    } else {
      createPlayer(video.id)
    }
  }

  function togglePlay() {
    if (!playerRef.current) return
    playing ? playerRef.current.pauseVideo() : playerRef.current.playVideo()
    setPlaying(!playing)
  }

  function skip(seconds: number) {
    if (!playerRef.current) return
    playerRef.current.seekTo(Math.max(0, (playerRef.current.getCurrentTime() || 0) + seconds), true)
  }

  function onSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value)
    setProgress(val)
    setElapsed(val * duration)
  }

  function onSeekEnd() {
    playerRef.current?.seekTo(progress * duration, true)
    seekingRef.current = false
    setSeeking(false)
  }

  function startTimer(minutes: number) {
    setTimerMinutes(minutes)
    setShowTimer(false)
    if (timerRef.current) clearInterval(timerRef.current)
    if (minutes === 0) { setTimeLeft(null); return }
    let remaining = minutes * 60
    setTimeLeft(remaining)
    timerRef.current = setInterval(() => {
      remaining -= 1
      setTimeLeft(remaining)
      if (remaining <= 0) {
        clearInterval(timerRef.current!)
        playerRef.current?.pauseVideo()
        setTimeLeft(null); setTimerMinutes(0)
      }
    }, 1000)
  }

  function cycleSpeed() {
    const idx = SPEED_OPTIONS.indexOf(playbackRate)
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
    setPlaybackRate(next)
    playerRef.current?.setPlaybackRate(next)
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
    setTranscriptLoading(true)
    setTranscriptError(null)
    setTranscriptSegs([])
    setTranscriptVideoId(video.id)
    try {
      const res = await fetch(`/data/transcripts/${video.id}.json`)
      if (!res.ok) throw new Error('not_found')
      const data = await res.json()
      if (!data.segments?.length) {
        setTranscriptError('暂无字幕')
      } else {
        setTranscriptSegs(data.segments)
      }
    } catch {
      setTranscriptError('暂无字幕')
    } finally {
      setTranscriptLoading(false)
    }
  }

  const currentSegIdx = transcriptSegs.findIndex(
    (s, i) => elapsed >= s.start && (i === transcriptSegs.length - 1 || elapsed < transcriptSegs[i + 1].start)
  )

  useEffect(() => {
    if (!showTranscript || currentSegIdx < 0 || userScrollingRef.current) return
    const el = document.getElementById(`seg-${currentSegIdx}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentSegIdx, showTranscript])

  function switchChannel(id: string) {
    setActiveChannelId(id)
    setShowChannelPicker(false)
  }

  const filled = `${Math.round(progress * 100)}%`

  return (
    <div className="flex flex-col h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Hidden YouTube player */}
      <div className="fixed -top-full -left-full w-1 h-1 overflow-hidden">
        <div id="yt-player" />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">

        {/* Channel header */}
        <div className="px-5 pt-12 pb-6">
          <button
            onClick={() => channels.length > 1 && setShowChannelPicker(true)}
            className="block mb-4"
          >
            <div className="w-28 h-28 rounded-2xl overflow-hidden shadow-xl flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${accentColor} 0%, #5e5ce6 100%)` }}>
              <span className="text-5xl font-bold text-white select-none">{activeChannel.initial}</span>
            </div>
          </button>

          <h1 className="text-2xl font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
            {activeChannel.name}
          </h1>
          <p className="text-sm mt-1" style={{ color: accentColor }}>{activeChannel.description}</p>
          <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>{videos.length} 个节目</p>

          {channels.length > 1 && (
            <button
              onClick={() => setShowChannelPicker(true)}
              className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors"
              style={{
                borderColor: 'var(--separator)',
                color: 'var(--text-secondary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
              </svg>
              切换博主
            </button>
          )}
        </div>

        <div className="h-px mx-5" style={{ background: 'var(--separator)' }} />

        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>节目</span>
          <div className="flex gap-1">
            {(['all', 'inprogress', 'done'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className="text-xs px-2.5 py-1 rounded-full transition-colors"
                style={{
                  background: filter === f ? accentColor : 'var(--bg-raised)',
                  color: filter === f ? 'white' : 'var(--text-secondary)',
                }}>
                {f === 'all' ? '全部' : f === 'inprogress' ? '进行中' : '已听完'}
              </button>
            ))}
          </div>
        </div>

        {videos.length === 0 && (
          <div className="px-5 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>加载中...</div>
        )}

        <div>
          {videos.filter(v => {
            if (filter === 'all') return true
            const p = videoProgress[v.id] ?? 0
            return filter === 'inprogress' ? p > 0 && p < 0.97 : p >= 0.97
          }).map((video) => {
            const isActive = current?.id === video.id
            const isFav = favorites.has(video.id)
            return (
              <div key={video.id} className="relative">
                <div
                  onClick={() => play(video)}
                  className="w-full px-5 py-4 flex items-start gap-4 cursor-pointer transition-colors"
                  style={{ background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div className="relative flex-shrink-0">
                    <img src={video.thumbnail} alt="" className="w-14 h-14 rounded-xl object-cover"
                      style={{ background: 'var(--bg-raised)' }} />
                    {!isActive && (videoProgress[video.id] ?? 0) >= 0.97 && (
                      <div className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: accentColor }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </div>
                    )}
                    {isActive && (
                      <div className="absolute inset-0 rounded-xl flex items-center justify-center"
                        style={{ background: `${accentColor}99` }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                          {playing
                            ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                            : <path d="M8 5v14l11-7z"/>}
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5 pr-8">
                    <p className="text-sm font-medium leading-snug line-clamp-2"
                      style={{ color: isActive ? accentColor : 'var(--text-primary)' }}>
                      {video.title}
                    </p>
                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                      {formatDate(video.published)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={(e) => toggleFavorite(video.id, e)}
                  className="absolute right-5 top-4 p-1 active:opacity-60"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24"
                    fill={isFav ? accentColor : 'none'}
                    stroke={isFav ? accentColor : 'var(--text-tertiary)'}
                    strokeWidth="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                  </svg>
                </button>
                {!isActive && videoProgress[video.id] > 0 && videoProgress[video.id] < 0.97 && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: 'var(--separator)' }}>
                    <div className="h-full" style={{ width: `${Math.round(videoProgress[video.id] * 100)}%`, background: accentColor }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {current && <div className="h-28" />}
      </div>

      {/* Channel picker sheet */}
      {showChannelPicker && (
        <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowChannelPicker(false)}
          style={{ background: 'rgba(0,0,0,0.4)' }}>
          <div className="w-full rounded-t-3xl p-6 pb-10" style={{ background: 'var(--bg-card)' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'var(--separator)' }} />
            <p className="text-lg font-semibold mb-5" style={{ color: 'var(--text-primary)' }}>选择博主</p>
            {channels.map(ch => (
              <button key={ch.id} onClick={() => switchChannel(ch.id)}
                className="w-full flex items-center gap-4 py-3 border-b last:border-0"
                style={{ borderColor: 'var(--separator)' }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `linear-gradient(135deg, ${ch.color} 0%, #5e5ce6 100%)` }}>
                  <span className="text-lg font-bold text-white">{ch.initial}</span>
                </div>
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{ch.name}</p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{ch.description}</p>
                </div>
                {activeChannelId === ch.id && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ch.color} strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Timer sheet */}
      {showTimer && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setShowTimer(false)}
          style={{ background: 'rgba(0,0,0,0.4)' }}>
          <div className="w-full rounded-t-3xl p-6 pb-10" style={{ background: 'var(--bg-card)' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'var(--separator)' }} />
            <p className="text-lg font-semibold mb-5" style={{ color: 'var(--text-primary)' }}>定时停止播放</p>
            {TIMER_OPTIONS.map(opt => (
              <button key={opt.minutes} onClick={() => startTimer(opt.minutes)}
                className="w-full flex items-center justify-between py-4 border-b last:border-0"
                style={{ borderColor: 'var(--separator)' }}>
                <span className="text-base" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
                {timerMinutes === opt.minutes && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mini Player */}
      {current && (
        <div className="fixed bottom-0 left-0 right-0 z-30" style={{ background: 'var(--bg-card)' }}>
          <div className="relative h-0.5" style={{ background: 'var(--separator)' }}>
            <div className="absolute top-0 left-0 h-full" style={{ width: filled, background: accentColor }} />
            <input type="range" min="0" max="1" step="0.001" value={progress}
              onMouseDown={() => { seekingRef.current = true; setSeeking(true) }}
              onTouchStart={() => { seekingRef.current = true; setSeeking(true) }}
              onChange={onSeekChange}
              onMouseUp={onSeekEnd}
              onTouchEnd={onSeekEnd}
              className="absolute inset-0 w-full opacity-0 cursor-pointer h-3 -top-1"
            />
          </div>

          <div className="px-4 py-3 flex items-center gap-4">
            <button onClick={() => current && openTranscript(current)} className="flex items-center gap-4 flex-1 min-w-0 text-left active:opacity-70">
              <img src={current.thumbnail} alt="" className="w-11 h-11 rounded-lg object-cover flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{current.title}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {formatTime(elapsed)} / {formatTime(duration)}
                  {timeLeft !== null && (
                    <span style={{ color: accentColor }}> · {formatTime(timeLeft)} 后停止</span>
                  )}
                </p>
              </div>
            </button>
            <div className="flex items-center gap-4 flex-shrink-0">
              <button onClick={() => skip(-15)} className="active:opacity-60" style={{ color: 'var(--text-secondary)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={togglePlay} className="active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: accentColor }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                    {playing
                      ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                      : <path d="M8 5v14l11-7z"/>}
                  </svg>
                </div>
              </button>
              <button onClick={() => skip(15)} className="active:opacity-60" style={{ color: 'var(--text-secondary)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={() => setShowTimer(true)} className="active:opacity-60">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 ? accentColor : 'var(--text-tertiary)'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3"/>
                  <path d="M9 3h6M12 3v2"/>
                </svg>
              </button>
              <button onClick={() => current && openTranscript(current)} className="active:opacity-60">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={showTranscript ? accentColor : 'var(--text-tertiary)'} strokeWidth="2">
                  <rect x="3" y="5" width="18" height="14" rx="2"/>
                  <line x1="7" y1="9" x2="17" y2="9"/>
                  <line x1="7" y1="13" x2="17" y2="13"/>
                  <line x1="7" y1="17" x2="13" y2="17"/>
                </svg>
              </button>
            </div>
          </div>
          <div style={{ height: 'env(safe-area-inset-bottom)' }} />
        </div>
      )}

      {/* Transcript Sheet */}
      {showTranscript && current && (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-14 pb-4 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--separator)' }}>
            <button
              onClick={() => setShowTranscript(false)}
              className="text-sm font-medium active:opacity-60"
              style={{ color: accentColor }}
            >
              关闭
            </button>
            <div className="text-center">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>字幕</span>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>한국어</p>
            </div>
            {/* Translation toggle */}
            <button
              onClick={() => setShowTranslation(v => !v)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors"
              style={{
                borderColor: showTranslation ? accentColor : 'var(--separator)',
                background: showTranslation ? `${accentColor}22` : 'transparent',
                color: showTranslation ? accentColor : 'var(--text-secondary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 5h12M9 3v2M11 11c-1.5 2-3.5 3.5-6 4.5"/>
                <path d="M8 11c1 2 3 4 5.5 5"/>
                <path d="M14 12l2.5 7M16 16h4"/>
              </svg>
              中文翻译
            </button>
          </div>

          {/* Now playing mini bar */}
          <div className="px-5 py-3 flex items-center gap-3 flex-shrink-0"
            style={{ background: 'var(--bg-raised)', borderBottom: '1px solid var(--separator)' }}>
            <img src={current.thumbnail} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
            <p className="text-xs truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{current.title}</p>
            <button onClick={togglePlay} className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: accentColor }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  {playing
                    ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                    : <path d="M8 5v14l11-7z"/>}
                </svg>
              </div>
            </button>
            <button onClick={cycleSpeed} className="flex-shrink-0 active:opacity-60 w-10 text-center">
              <span className="text-xs font-bold" style={{ color: accentColor }}>{playbackRate}x</span>
            </button>
          </div>

          {/* Transcript content */}
          <div
            ref={transcriptListRef}
            className="flex-1 overflow-y-auto px-5 py-6"
            onTouchStart={() => { userScrollingRef.current = true }}
            onTouchEnd={() => { setTimeout(() => { userScrollingRef.current = false }, 3000) }}
          >
            {transcriptLoading && (
              <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>加载字幕中...</p>
            )}
            {transcriptError && (
              <p className="text-center py-20 text-sm" style={{ color: 'var(--text-tertiary)' }}>{transcriptError}</p>
            )}
            {transcriptSegs.map((seg, i) => {
              const isActive = i === currentSegIdx
              return (
                <button
                  id={`seg-${i}`}
                  key={i}
                  onClick={() => {
                    playerRef.current?.seekTo(seg.start, true)
                    if (!playing) playerRef.current?.playVideo()
                  }}
                  className="w-full text-left mb-1 px-3 py-2 rounded-xl transition-colors"
                  style={{ background: isActive ? 'var(--bg-card)' : 'transparent' }}
                >
                  <p
                    className="leading-relaxed transition-all"
                    style={{
                      color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      fontWeight: isActive ? 600 : 400,
                      fontSize: isActive ? '17px' : '15px',
                    }}
                  >
                    {seg.ko}
                  </p>
                  {showTranslation && seg.zh && (
                    <p
                      className="leading-relaxed mt-1 transition-all"
                      style={{
                        color: isActive ? accentColor : 'var(--text-tertiary)',
                        fontSize: isActive ? '14px' : '13px',
                        fontWeight: isActive ? 500 : 400,
                      }}
                    >
                      {seg.zh}
                    </p>
                  )}
                </button>
              )
            })}
            <div className="h-20" />
          </div>

          {/* Progress bar at bottom */}
          <div className="flex-shrink-0 px-5 pb-8 pt-3" style={{ background: 'var(--bg)', borderTop: '1px solid var(--separator)' }}>
            <div className="flex items-center gap-3 text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
              <span>{formatTime(elapsed)}</span>
              <div className="flex-1 relative h-1 rounded-full" style={{ background: 'var(--separator)' }}>
                <div className="absolute top-0 left-0 h-full rounded-full" style={{ width: filled, background: accentColor }} />
              </div>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
