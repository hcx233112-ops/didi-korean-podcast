'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import videosData from '@/data/videos.json'

interface Video {
  id: string
  title: string
  published: string
  thumbnail: string
}

const TIMER_OPTIONS = [
  { label: '关闭', minutes: 0 },
  { label: '15分钟', minutes: 15 },
  { label: '30分钟', minutes: 30 },
  { label: '60分钟', minutes: 60 },
  { label: '90分钟', minutes: 90 },
]

const PURPLE = '#bf5af2'
const videos: Video[] = videosData.videos

function formatTime(s: number) {
  if (!s || isNaN(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatDate(s: string) {
  const d = new Date(s)
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function Home() {
  const [current, setCurrent] = useState<Video | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)   // 0–1
  const [duration, setDuration] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [showTimer, setShowTimer] = useState(false)
  const [timerMinutes, setTimerMinutes] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [seeking, setSeeking] = useState(false)

  const playerRef = useRef<YT.Player | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const playerReadyRef = useRef(false)

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
      if (!playerRef.current || seeking) return
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
  }, [seeking])

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
          playerReadyRef.current = true
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
    setProgress(0)
    setElapsed(0)
    setDuration(0)

    if (!(window as any).YT?.Player) {
      ;(window as any).onYouTubeIframeAPIReady = () => createPlayer(video.id)
    } else {
      createPlayer(video.id)
    }
  }

  function togglePlay() {
    if (!playerRef.current) return
    if (playing) { playerRef.current.pauseVideo() }
    else { playerRef.current.playVideo() }
    setPlaying(!playing)
  }

  function skip(seconds: number) {
    if (!playerRef.current) return
    const t = (playerRef.current.getCurrentTime() || 0) + seconds
    playerRef.current.seekTo(Math.max(0, t), true)
  }

  function onSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value)
    setProgress(val)
    setElapsed(val * duration)
  }

  function onSeekEnd() {
    playerRef.current?.seekTo(progress * duration, true)
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
        setTimeLeft(null)
        setTimerMinutes(0)
      }
    }, 1000)
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
          {/* Artwork */}
          <div className="w-28 h-28 rounded-2xl mb-4 overflow-hidden shadow-xl"
            style={{ background: 'linear-gradient(135deg, #bf5af2 0%, #5e5ce6 100%)' }}>
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-4xl font-bold text-white select-none">D</span>
            </div>
          </div>

          <h1 className="text-2xl font-bold text-white leading-tight">
            {videosData.channelName}
          </h1>
          <p className="text-sm mt-1" style={{ color: PURPLE }}>韩语播客</p>
          <p className="text-xs text-gray-500 mt-2">{videos.length} 个节目</p>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/10 mx-5" />

        {/* Episode list label */}
        <div className="px-5 pt-5 pb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">节目</span>
        </div>

        {/* Episodes */}
        <div>
          {videos.map((video, i) => {
            const isActive = current?.id === video.id
            return (
              <button
                key={video.id}
                onClick={() => play(video)}
                className="w-full px-5 py-4 flex items-start gap-4 text-left active:bg-white/5 transition-colors"
              >
                {/* Thumbnail */}
                <div className="relative flex-shrink-0">
                  <img
                    src={video.thumbnail}
                    alt=""
                    className="w-14 h-14 rounded-xl object-cover bg-gray-800"
                  />
                  {isActive && (
                    <div className="absolute inset-0 rounded-xl flex items-center justify-center"
                      style={{ background: 'rgba(191,90,242,0.6)' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                        {playing
                          ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                          : <path d="M8 5v14l11-7z"/>}
                      </svg>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <p className={`text-sm font-medium leading-snug line-clamp-2 ${isActive ? 'text-white' : 'text-gray-100'}`}
                    style={isActive ? { color: PURPLE } : {}}>
                    {video.title}
                  </p>
                  <p className="text-xs text-gray-500 mt-1.5">{formatDate(video.published)}</p>
                </div>

                {/* Play icon */}
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

        {/* Bottom padding for player */}
        {current && <div className="h-28" />}
      </div>

      {/* Timer sheet overlay */}
      {showTimer && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setShowTimer(false)}>
          <div className="w-full rounded-t-3xl p-6 pb-10" style={{ background: '#1c1c1e' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-gray-600 mx-auto mb-6" />
            <p className="text-lg font-semibold text-white mb-5">定时停止播放</p>
            {TIMER_OPTIONS.map(opt => (
              <button
                key={opt.minutes}
                onClick={() => startTimer(opt.minutes)}
                className="w-full flex items-center justify-between py-4 border-b border-white/10 last:border-0"
              >
                <span className="text-base text-white">{opt.label}</span>
                {timerMinutes === opt.minutes && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2.5">
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
          {/* Progress bar */}
          <div className="relative h-0.5 bg-white/15">
            <div className="absolute top-0 left-0 h-full transition-none" style={{ width: filled, background: PURPLE }} />
            <input
              type="range" min="0" max="1" step="0.001"
              value={progress}
              onMouseDown={() => setSeeking(true)}
              onTouchStart={() => setSeeking(true)}
              onChange={onSeekChange}
              onMouseUp={onSeekEnd}
              onTouchEnd={onSeekEnd}
              className="absolute inset-0 w-full opacity-0 cursor-pointer h-3 -top-1"
            />
          </div>

          <div className="px-4 py-3 flex items-center gap-4">
            {/* Thumbnail */}
            <img src={current.thumbnail} alt="" className="w-11 h-11 rounded-lg object-cover flex-shrink-0" />

            {/* Title + time */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{current.title}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatTime(elapsed)} / {formatTime(duration)}
                {timeLeft !== null && (
                  <span style={{ color: PURPLE }}> · {formatTime(timeLeft)} 后停止</span>
                )}
              </p>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-4 flex-shrink-0">
              {/* Skip back 15s */}
              <button onClick={() => skip(-15)} className="text-gray-300 active:text-white">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>

              {/* Play/Pause */}
              <button onClick={togglePlay} className="active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: PURPLE }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                    {playing
                      ? <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>
                      : <path d="M8 5v14l11-7z"/>}
                  </svg>
                </div>
              </button>

              {/* Skip forward 15s */}
              <button onClick={() => skip(15)} className="text-gray-300 active:text-white">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="8" y="15" fontSize="5" fill="currentColor" fontWeight="bold">15</text>
                </svg>
              </button>

              {/* Timer */}
              <button onClick={() => setShowTimer(true)} className="active:opacity-60">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke={timerMinutes > 0 ? PURPLE : '#6b7280'} strokeWidth="2">
                  <circle cx="12" cy="13" r="8"/>
                  <path d="M12 9v4l3 3"/>
                  <path d="M9 3h6M12 3v2"/>
                </svg>
              </button>
            </div>
          </div>

          {/* iPhone home indicator safe area */}
          <div className="h-safe-b" style={{ height: 'env(safe-area-inset-bottom)' }} />
        </div>
      )}
    </div>
  )
}
