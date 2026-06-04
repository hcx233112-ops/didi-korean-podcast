'use client'

import { useEffect, useRef, useState } from 'react'
import videosData from '@/data/videos.json'

interface Video {
  id: string
  title: string
  published: string
  thumbnail: string
}

const TIMER_OPTIONS = [
  { label: '不限时', minutes: 0 },
  { label: '15 分', minutes: 15 },
  { label: '30 分', minutes: 30 },
  { label: '60 分', minutes: 60 },
  { label: '90 分', minutes: 90 },
]

export default function Home() {
  const [currentVideo, setCurrentVideo] = useState<Video | null>(null)
  const [timerMinutes, setTimerMinutes] = useState(0)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const playerRef = useRef<YT.Player | null>(null)

  const videos: Video[] = videosData.videos

  // Load YouTube IFrame API
  useEffect(() => {
    if (document.getElementById('yt-iframe-api')) return
    const tag = document.createElement('script')
    tag.id = 'yt-iframe-api'
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  }, [])

  function play(video: Video) {
    setCurrentVideo(video)
    // Player will be created/updated via onReady or via cueVideoById
    setTimeout(() => {
      if (playerRef.current) {
        playerRef.current.loadVideoById(video.id)
      }
    }, 100)
  }

  function onPlayerReady(event: YT.PlayerEvent) {
    event.target.playVideo()
  }

  useEffect(() => {
    if (!currentVideo) return
    if (!(window as any).YT?.Player) {
      ;(window as any).onYouTubeIframeAPIReady = () => createPlayer(currentVideo.id)
      return
    }
    createPlayer(currentVideo.id)
  }, [currentVideo?.id])

  function createPlayer(videoId: string) {
    if (playerRef.current) {
      playerRef.current.loadVideoById(videoId)
      return
    }
    playerRef.current = new (window as any).YT.Player('yt-player', {
      videoId,
      playerVars: { autoplay: 1, controls: 1, playsinline: 1 },
      events: { onReady: onPlayerReady },
    })
  }

  function startTimer(minutes: number) {
    setTimerMinutes(minutes)
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

  function fmt(s: number) {
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-4">
        <h1 className="text-xl font-bold">{videosData.channelName}</h1>
        <p className="text-xs text-gray-500 mt-0.5">{videos.length} 个视频 · 锁屏不断播</p>
      </div>

      {/* Player */}
      {currentVideo && (
        <div className="border-b border-gray-800 bg-gray-900 px-4 pt-4 pb-4">
          <p className="text-sm font-medium text-white line-clamp-1 mb-3">{currentVideo.title}</p>

          {/* YouTube Embed - hide video, keep controls */}
          <div className="relative w-full rounded overflow-hidden mb-3" style={{ height: 0, paddingBottom: '56.25%' }}>
            <div id="yt-player" className="absolute inset-0 w-full h-full" />
          </div>

          {/* Sleep Timer */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <span className="text-xs text-gray-400">定时关闭：</span>
            {TIMER_OPTIONS.map((opt) => (
              <button
                key={opt.minutes}
                onClick={() => startTimer(opt.minutes)}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  timerMinutes === opt.minutes
                    ? 'bg-indigo-600 border-indigo-600 text-white'
                    : 'border-gray-700 text-gray-400 hover:border-gray-400'
                }`}
              >
                {opt.label}
              </button>
            ))}
            {timeLeft !== null && (
              <span className="text-xs text-indigo-400 ml-1">剩余 {fmt(timeLeft)}</span>
            )}
          </div>
        </div>
      )}

      {/* Video List */}
      <div className="divide-y divide-gray-800/60">
        {videos.map((video) => (
          <button
            key={video.id}
            onClick={() => play(video)}
            className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-900 ${
              currentVideo?.id === video.id ? 'bg-gray-900' : ''
            }`}
          >
            <img
              src={video.thumbnail}
              alt=""
              className="w-24 h-14 object-cover rounded flex-shrink-0 bg-gray-800"
            />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium line-clamp-2 leading-snug ${
                currentVideo?.id === video.id ? 'text-indigo-400' : 'text-gray-100'
              }`}>
                {video.title}
              </p>
              <p className="text-xs text-gray-500 mt-1">{video.published}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
