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
  const [transcriptLang, setTranscriptLang] = useState<'zh' | 'ko'>('zh')
  const [transcriptSegs, setTranscriptSegs] = useState<TranscriptSegment[]>([])
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptVideoId, setTranscriptVideoId] = useState<string | null>(null)

  const playerRef = useRef<YT.Player | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const seekingRef = useRef(false)
  const transcriptListRef = useRef<HTMLDivElement>(null)
  const userScrollingRef = useRef(false)

  const activeChannel = channels.find(c => c.id === activeChannelId) ?? channels[0]
  const videos = channelVideos[activeChannelId] ?? []
  const accentColor = activeChannel.color

  // Load videos for a channel
  useEffect(() => {
    if (channelVideos[activeChannelId]) return
    fetch(`/data/videos/${activeChannelId}.json`)
      .then(r => r.json())
      .then((data: ChannelVideos) => {
        setChannelVideos(prev => ({ ...prev, [activeChannelId]: data.videos }))
      })
      .catch(console.error)
  }, [activeChannelId])

  // Load YouTube IFrame API
  useEffect(() => {
    if (document.getElementById('yt-iframe-api')) return
    const tag = document.createElement('script')
    tag.id = 'yt-iframe-api'
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  }, [])

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
      } catch {}
    }, 500)
  }, [])

  function createPlayer(videoId: string) {
    if (playerRef.current) {
      playerRef.current.loadVideoById(videoId)
      setPlaying(true)
      return
    }
    playerRef.current = new (window as any).YT.Player('yt-player', {
      videoId,
      playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0 },
      events: {
        onReady: (e: YT.PlayerEvent) => {
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
    <div className="flex flex-col h-dvh bg-black overflow-hidden">
      {/* Hidden YouTube player */}
      <div className="fixed -top-full -left-full w-1 h-1 overflow-hidden">
        <div id="yt-player" />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">

        {/* Channel header */}
        <div className="px-5 pt-12 pb-6">
          {/* Artwork — tappable to switch channel */}
          <button
            onClick={() => channels.length > 1 && setShowChannelPicker(true)}
            className="block mb-4"
          >
            <div className="w-28 h-28 rounded-2xl overflow-hidden shadow-xl flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${accentColor} 0%, #5e5ce6 100%)` }}>
              <span className="text-5xl font-bold text-white select-none">{activeChannel.initial}</span>
            </div>
          </button>

          <h1 className="text-2xl font-bold text-white leading-tight">{activeChannel.name}</h1>
          <p className="text-sm mt-1" style={{ color: accentColor }}>{activeChannel.description}</p>
          <p className="text-xs text-gray-500 mt-2">{videos.length} 个节目</p>

          {/* Channel switcher button */}
          {channels.length > 1 && (
            <button
              onClick={() => setShowChannelPicker(true)}
              className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-400 hover:text-white transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
              </svg>
              切换博主
            </button>
          )}
        </div>

        <div className="h-px bg-white/10 mx-5" />

        <div className="px-5 pt-5 pb-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">节目</span>
        </div>

        {/* Loading state */}
        {videos.length === 0 && (
          <div className="px-5 py-10 text-center text-gray-600 text-sm">加载中...</div>
        )}

        {/* Episodes */}
        <div>
          {videos.map((video) => {
            const isActive = current?.id === video.id
            return (
              <button
                key={video.id}
                onClick={() => play(video)}
                className="w-full px-5 py-4 flex items-start gap-4 text-left active:bg-white/5 transition-colors"
              >
                <div className="relative flex-shrink-0">
                  <img src={video.thumbnail} alt="" className="w-14 h-14 rounded-xl object-cover bg-gray-800" />
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
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className="text-sm font-medium leading-snug line-clamp-2"
                    style={{ color: isActive ? accentColor : '#f3f4f6' }}>
                    {video.title}
                  </p>
                  <p className="text-xs text-gray-500 mt-1.5">{formatDate(video.published)}</p>
                </div>
                {!isActive && (
                  <div className="flex-shrink-0 pt-1">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M10 8l6 4-6 4V8z" fill="#6b7280" stroke="none"/>
                    </svg>
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {current && <div className="h-28" />}
      </div>

      {/* Channel picker sheet */}
      {showChannelPicker && (
        <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowChannelPicker(false)}>
          <div className="w-full rounded-t-3xl p-6 pb-10" style={{ background: '#1c1c1e' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-gray-600 mx-auto mb-6" />
            <p className="text-lg font-semibold text-white mb-5">选择博主</p>
            {channels.map(ch => (
              <button key={ch.id} onClick={() => switchChannel(ch.id)}
                className="w-full flex items-center gap-4 py-3 border-b border-white/10 last:border-0">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `linear-gradient(135deg, ${ch.color} 0%, #5e5ce6 100%)` }}>
                  <span className="text-lg font-bold text-white">{ch.initial}</span>
                </div>
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium text-white">{ch.name}</p>
                  <p className="text-xs text-gray-500">{ch.description}</p>
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
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setShowTimer(false)}>
          <div className="w-full rounded-t-3xl p-6 pb-10" style={{ background: '#1c1c1e' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-gray-600 mx-auto mb-6" />
            <p className="text-lg font-semibold text-white mb-5">定时停止播放</p>
            {TIMER_OPTIONS.map(opt => (
              <button key={opt.minutes} onClick={() => startTimer(opt.minutes)}
                className="w-full flex items-center justify-between py-4 border-b border-white/10 last:border-0">
                <span className="text-base text-white">{opt.label}</span>
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
        <div className="fixed bottom-0 left-0 right-0 z-30" style={{ background: '#1c1c1e' }}>
          <div className="relative h-0.5 bg-white/15">
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
            <img src={current.thumbnail} alt="" className="w-11 h-11 rounded-lg object-cover flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{current.title}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatTime(elapsed)} / {formatTime(duration)}
                {timeLeft !== null && (
                  <span style={{ color: accentColor }}> · {formatTime(timeLeft)} 后停止</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <button onClick={() => skip(-15)} className="text-gray-300 active:text-white">
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
              <button onClick={() => skip(15)} className="text-gray-300 active:text-white">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>
              <button onClick={() => setShowTimer(true)} className="active:opacity-60">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 ? accentColor : '#6b7280'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3"/>
                  <path d="M9 3h6M12 3v2"/>
                </svg>
              </button>
              <button onClick={() => current && openTranscript(current)} className="active:opacity-60">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={showTranscript ? accentColor : '#6b7280'} strokeWidth="2">
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
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#000' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-14 pb-4 border-b border-white/10 flex-shrink-0">
            <button
              onClick={() => setShowTranscript(false)}
              className="text-sm font-medium active:opacity-60"
              style={{ color: accentColor }}
            >
              关闭
            </button>
            <span className="text-sm font-semibold text-white">字幕</span>
            {/* Lang toggle */}
            <div className="flex rounded-lg overflow-hidden border border-white/15 text-xs">
              {(['zh', 'ko'] as const).map(lang => (
                <button
                  key={lang}
                  onClick={() => setTranscriptLang(lang)}
                  className="px-3 py-1.5 transition-colors"
                  style={{
                    background: transcriptLang === lang ? accentColor : 'transparent',
                    color: transcriptLang === lang ? '#fff' : '#9ca3af',
                  }}
                >
                  {lang === 'zh' ? '中文' : '한국어'}
                </button>
              ))}
            </div>
          </div>

          {/* Now playing mini bar */}
          <div className="px-5 py-3 flex items-center gap-3 border-b border-white/10 flex-shrink-0"
            style={{ background: '#111' }}>
            <img src={current.thumbnail} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
            <p className="text-xs text-gray-400 truncate flex-1">{current.title}</p>
            <button onClick={togglePlay} className="flex-shrink-0">
              <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: accentColor }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  {playing
                    ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                    : <path d="M8 5v14l11-7z"/>}
                </svg>
              </div>
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
              <p className="text-center text-gray-500 py-20">加载字幕中...</p>
            )}
            {transcriptError && (
              <p className="text-center text-gray-500 py-20">{transcriptError}</p>
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
                  className="w-full text-left mb-1 px-3 py-2 rounded-xl transition-colors active:bg-white/5"
                  style={isActive ? { background: '#1c1c1e' } : {}}
                >
                  <p
                    className="text-base leading-relaxed transition-all"
                    style={{
                      color: isActive ? '#fff' : '#6b7280',
                      fontWeight: isActive ? 600 : 400,
                      fontSize: isActive ? '17px' : '15px',
                    }}
                  >
                    {transcriptLang === 'zh' ? seg.zh : seg.ko}
                  </p>
                  {isActive && transcriptLang === 'zh' && seg.ko && (
                    <p className="text-xs text-gray-600 mt-1">{seg.ko}</p>
                  )}
                </button>
              )
            })}
            <div className="h-20" />
          </div>

          {/* Progress bar at bottom */}
          <div className="flex-shrink-0 px-5 pb-8 pt-3 border-t border-white/10" style={{ background: '#000' }}>
            <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
              <span>{formatTime(elapsed)}</span>
              <div className="flex-1 relative h-1 bg-white/15 rounded-full">
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
