'use client'

import { memo, useEffect, useRef, useState } from 'react'
import { useDragDismiss } from '@/hooks/use-drag-dismiss'
import { DRILL_LABEL, type DrillMode } from '@/lib/drill'
import { type Video, formatTime } from '@/lib/library'
import { BackIcon, BookmarkIcon, ChevronDown, ForwardIcon, HeartIcon, MoonIcon, NoteIcon, PauseIcon, PlayIcon, RepeatIcon, ReplayIcon, TextIcon } from './icons'

export interface TranscriptSegment { start: number; end: number; ko: string; zh: string }

/* ───────────── Mini player ───────────── */

export function MiniPlayer({ video, playing, progress, timerLabel, drillLabel, onToggle, onOpen, onPrev, onNext }: {
  video: Video; playing: boolean; progress: number; timerLabel: string | null; drillLabel: string | null
  onToggle: () => void; onOpen: (page: 0 | 1) => void; onPrev: () => void; onNext: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null)
  const actions = useRef({ onOpen, onPrev, onNext })
  useEffect(() => { actions.current = { onOpen, onPrev, onNext } })
  useEffect(() => {
    const el = box.current
    if (!el) return
    let start: { x: number; y: number } | null = null, axis: 'x' | 'y' | null = null, last = { x: 0, y: 0, t: 0, vy: 0 }
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1) { start = null; return }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }; axis = null; last = { ...start, t: e.timeStamp, vy: 0 }
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0], dx = t.clientX - start.x, dy = t.clientY - start.y
      if (!axis) {
        if (Math.hypot(dx, dy) < 6) return
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      }
      if (e.cancelable) e.preventDefault()
      if (e.timeStamp > last.t) last = { x: t.clientX, y: t.clientY, t: e.timeStamp, vy: (t.clientY - last.y) / (e.timeStamp - last.t) }
      setShift(axis === 'x' ? { x: Math.max(-110, Math.min(110, dx)), y: 0 } : { x: 0, y: Math.max(-90, Math.min(0, dy)) })
    }
    const up = (e: TouchEvent) => {
      const s = start
      start = null
      setShift(null)
      if (!s || !axis || e.type !== 'touchend') return
      const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y
      if (axis === 'y' && (dy < -50 || (dy < -15 && last.vy < -0.4 && e.timeStamp - last.t < 100))) actions.current.onOpen(0)
      else if (axis === 'x' && Math.abs(dx) > 70) { if (dx < 0) actions.current.onNext(); else actions.current.onPrev() }
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', up)
    el.addEventListener('touchcancel', up)
    return () => {
      el.removeEventListener('touchstart', down); el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', up); el.removeEventListener('touchcancel', up)
    }
  }, [])
  const hint = shift && Math.abs(shift.x) > 70 ? (shift.x < 0 ? '松手切到下一集' : '松手切到上一集') : shift && shift.y < -50 ? '松手展开' : null
  return (
    <div className="fixed left-0 right-0 z-30 px-2.5" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 8px)' }}>
      <div ref={box} className="glass rounded-[20px] overflow-hidden shadow-2xl" style={{
        border: '1px solid var(--line)', touchAction: 'none',
        transform: shift?.y ? `translateY(${shift.y * 0.5}px)` : undefined, transition: shift ? 'none' : 'transform .25s var(--ease)',
      }}>
        <div className="flex items-center gap-3 pl-2.5 pr-2 py-2" style={{ transform: `translateX(${(shift?.x ?? 0) * 0.4}px)`, transition: shift ? 'none' : 'transform .25s var(--ease)' }}>
          <button aria-label="打开播放器" onClick={() => onOpen(0)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
            <img src={video.thumbnail} alt="" className="w-11 h-11 rounded-xl object-cover flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold truncate">{video.title}</p>
              <p className="text-[12px] truncate" style={{ color: hint || timerLabel || drillLabel ? 'var(--accent)' : 'var(--text-3)' }}>
                {hint || [timerLabel && `${timerLabel}后停止`, drillLabel].filter(Boolean).join(' · ') || '左右滑动切换 · 上滑展开'}
              </p>
            </div>
          </button>
          <button aria-label="打开当前节目字幕" onClick={() => onOpen(1)} className="tap w-10 h-10 flex items-center justify-center" style={{ color: 'var(--text-2)' }}>
            <TextIcon size={20} />
          </button>
          <button aria-label={playing ? '暂停播放' : '开始播放'} onClick={onToggle} className="tap w-11 h-11 rounded-full flex items-center justify-center" style={{ background: 'var(--text)', color: 'var(--bg)' }}>
            {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} className="ml-0.5" />}
          </button>
        </div>
        <div className="h-[3px]" style={{ background: 'var(--line)' }}>
          <div className="h-full" style={{ width: `${progress * 100}%`, background: 'var(--accent)', transition: 'width 1s linear' }} />
        </div>
      </div>
    </div>
  )
}

/* ───────────── Full player ───────────── */

const TranscriptRow = memo(function TranscriptRow({ index, seg, active, drilling, saved, wait, showTranslation, onSeek }: {
  index: number; seg: TranscriptSegment; active: boolean; drilling: boolean; saved: boolean; wait: { ms: number; key: number } | null
  showTranslation: boolean; onSeek: (start: number) => void
}) {
  return (
    <button id={`seg-${index}`} data-seg={index} onClick={() => onSeek(seg.start)} className="seg-row relative w-full text-left px-6 py-3 rounded-2xl active:bg-white/5"
      style={{ background: active && drilling ? 'rgba(255,255,255,.07)' : undefined }}>
      {saved && <span className="absolute left-2 top-[18px]" style={{ color: 'var(--accent)' }}><BookmarkIcon size={11} filled /></span>}
      <p style={{ color: active ? 'var(--text)' : 'var(--text-3)', fontWeight: active ? 650 : 500, fontSize: active ? 20 : 18, lineHeight: 1.5, transition: 'color .2s, font-size .2s' }}>{seg.ko}</p>
      {showTranslation && seg.zh && seg.zh !== seg.ko && (
        <p style={{ color: active ? 'var(--accent)' : 'var(--text-3)', opacity: active ? 1 : 0.7, fontSize: 14, lineHeight: 1.5, marginTop: 4 }}>{seg.zh}</p>
      )}
      {wait && (
        <span key={wait.key} className="flex items-center gap-2 mt-2 text-[12px] font-semibold" style={{ color: 'var(--accent)' }}>
          该你说了
          <span className="flex-1 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
            <span className="block h-full origin-left" style={{ background: 'var(--accent)', animation: `drill-wait ${wait.ms}ms linear both` }} />
          </span>
        </span>
      )}
    </button>
  )
})

function SeekBar({ elapsed, duration, onSeek }: { elapsed: number; duration: number; onSeek: (fraction: number, commit: boolean) => void }) {
  const [drag, setDrag] = useState<number | null>(null)
  const value = drag ?? (duration > 0 ? elapsed / duration : 0)
  const end = (v: number) => { onSeek(v, true); setDrag(null) }
  return (
    <div className="relative">
      {drag !== null && duration > 0 && (
        <span className="absolute -top-8 px-2 py-1 rounded-lg text-[12px] font-semibold tabular-nums -translate-x-1/2 pointer-events-none"
          style={{ left: `${drag * 100}%`, background: 'var(--text)', color: 'var(--bg)' }}>{formatTime(drag * duration)}</span>
      )}
      <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[5px] rounded-full overflow-hidden pointer-events-none" style={{ background: 'rgba(255,255,255,.18)' }}>
        <div className="h-full" style={{ width: `${value * 100}%`, background: '#fff' }} />
      </div>
      <input type="range" className="seek relative" min="0" max="1" step="0.001" value={value} aria-label="播放进度"
        aria-valuetext={`${formatTime(value * duration)} / ${formatTime(duration)}`}
        onPointerDown={() => setDrag(value)}
        onChange={e => { const v = Number(e.target.value); if (drag === null) onSeek(v, true); else { setDrag(v); onSeek(v, false) } }}
        onPointerUp={e => end(Number((e.target as HTMLInputElement).value))}
        // An interrupted drag must still release the player's seeking state.
        onPointerCancel={() => { if (drag !== null) end(drag) }} onBlur={() => { if (drag !== null) end(drag) }} />
      <div className="flex justify-between text-[12px] tabular-nums mt-0.5" style={{ color: 'var(--text-2)' }}>
        <span>{formatTime(value * duration)}</span>
        <span>-{formatTime(Math.max(0, duration - value * duration))}</span>
      </div>
    </div>
  )
}

export interface FullPlayerProps {
  video: Video
  channelName: string
  initialPage: 0 | 1
  closing: boolean
  tint: string
  playing: boolean
  elapsed: number
  duration: number
  rate: number
  timerLabel: string | null
  isFav: boolean
  hasNote: boolean
  segments: TranscriptSegment[]
  transcriptLoading: boolean
  transcriptError: string | null
  currentSegIdx: number
  showTranslation: boolean
  drill: DrillMode
  drillWait: { idx: number; ms: number; key: number } | null
  savedStarts: Set<number>
  onClose: () => void
  onToggle: () => void
  onSkip: (seconds: number) => void
  onSeek: (fraction: number, commit: boolean) => void
  onCycleRate: () => void
  onOpenTimer: () => void
  onToggleFav: () => void
  onOpenNote: () => void
  onSeekSegment: (start: number) => void
  onRetryTranscript: () => void
  onToggleTranslation: () => void
  onOpenDrill: () => void
  onSegmentMenu: (index: number) => void
  onReplaySentence: () => void
}

export function FullPlayer(p: FullPlayerProps) {
  const pager = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<0 | 1>(p.initialPage)
  const [detached, setDetached] = useState(false)
  // Drag down from the header, or anywhere on the now-playing page while it is scrolled to the top.
  const drag = useDragDismiss<HTMLElement>(p.onClose, target => {
    if (target.closest('input, textarea')) return false
    if (target.closest('[data-drag-handle]')) return true
    const page0 = target.closest('[data-drag-page]') as HTMLElement | null
    return !!page0 && page0.scrollTop <= 0
  })
  const detachTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = pager.current
    if (el && p.initialPage === 1) el.scrollLeft = el.clientWidth
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function goPage(next: 0 | 1) {
    pager.current?.scrollTo({ left: next * pager.current.clientWidth, behavior: 'smooth' })
    setPage(next)
  }

  const centered = useRef(false)
  function centerSegment(index: number) {
    const box = list.current, el = document.getElementById(`seg-${index}`)
    if (!box || !el) return
    // Jump on first show, glide afterwards.
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: centered.current ? 'smooth' : 'auto' })
    centered.current = true
  }

  useEffect(() => { centered.current = false }, [p.segments])
  useEffect(() => {
    if (page === 1 && !detached && p.currentSegIdx >= 0) centerSegment(p.currentSegIdx)
  }, [p.currentSegIdx, page, detached, p.segments])

  useEffect(() => () => { if (detachTimer.current) clearTimeout(detachTimer.current) }, [])

  // Only a finger or wheel detaches; programmatic smooth scrolling must not.
  function onUserScroll() {
    setDetached(true)
    if (detachTimer.current) clearTimeout(detachTimer.current)
    detachTimer.current = setTimeout(() => setDetached(false), 8000)
  }

  // Long-press (or right-click) a sentence for its menu; one delegated handler serves every row.
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null)
  const rowIndex = (target: EventTarget) => {
    const row = (target as HTMLElement).closest?.('[data-seg]') as HTMLElement | null
    return row ? Number(row.dataset.seg) : null
  }
  const endPress = () => { if (press.current && !press.current.fired) { clearTimeout(press.current.timer); press.current = null } }
  const pressHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const idx = rowIndex(e.target)
      if (idx === null || e.button !== 0) return
      if (press.current) clearTimeout(press.current.timer)
      const timer = setTimeout(() => {
        if (!press.current) return
        press.current.fired = true
        navigator.vibrate?.(12)
        p.onSegmentMenu(idx)
      }, 480)
      press.current = { x: e.clientX, y: e.clientY, timer, fired: false }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (press.current && !press.current.fired && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) endPress()
    },
    onPointerUp: endPress,
    onPointerCancel: endPress,
    // The release after a long press must not also seek.
    onClickCapture: (e: React.MouseEvent) => { if (press.current?.fired) { e.stopPropagation(); e.preventDefault() } press.current = null },
    onContextMenu: (e: React.MouseEvent) => { const idx = rowIndex(e.target); if (idx !== null) { e.preventDefault(); endPress(); p.onSegmentMenu(idx) } },
  }
  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer) }, [])

  return (
    <div className="fixed inset-0 z-50" style={{ animation: `${p.closing ? 'sheet-down' : 'sheet-up'} .38s var(--ease) both`, pointerEvents: p.closing ? 'none' : undefined }}>
    <div role="dialog" aria-modal="true" aria-label="正在播放" className="absolute inset-0 flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--bg)',
        backgroundImage: `linear-gradient(180deg, rgb(${p.tint}) 0%, rgb(${p.tint} / .55) 38%, rgb(${p.tint} / 0) 82%)`,
        transform: drag.offset ? `translateY(${drag.offset}px)` : undefined,
        transition: drag.dragging ? 'background 0.8s ease' : 'background 0.8s ease, transform .3s var(--ease), border-radius .3s var(--ease)',
        borderRadius: drag.offset ? 28 : 0,
      }}>
      <div ref={drag.area} data-drag-handle className="flex-shrink-0 px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}>
        <div className="w-10 h-[5px] rounded-full mx-auto mb-2" style={{ background: 'rgba(255,255,255,.35)' }} />
        <div className="flex items-center">
          <button aria-label="收起播放器" onClick={p.onClose} className="tap w-10 h-10 flex items-center justify-center"><ChevronDown /></button>
          <div className="flex-1 flex justify-center">
            <div className="flex p-1 rounded-full" style={{ background: 'rgba(0,0,0,.25)' }}>
              {(['播放', '字幕'] as const).map((label, i) => (
                <button key={label} onClick={() => goPage(i as 0 | 1)} aria-pressed={page === i}
                  className="px-4 py-1 rounded-full text-[13px] font-semibold transition-colors"
                  style={{ background: page === i ? 'rgba(255,255,255,.9)' : 'transparent', color: page === i ? '#000' : 'var(--text-2)' }}>{label}</button>
              ))}
            </div>
          </div>
          <button aria-label="编辑当前节目备注" onClick={p.onOpenNote} className="tap w-10 h-10 flex items-center justify-center" style={{ color: p.hasNote ? 'var(--accent)' : 'var(--text-2)' }}>
            <NoteIcon />
          </button>
        </div>
      </div>

      <div ref={pager} className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden no-scrollbar snap-x snap-mandatory"
        onScroll={e => { const el = e.currentTarget; const next = el.scrollLeft > el.clientWidth / 2 ? 1 : 0; if (next !== page) setPage(next) }}>
        {/* Page 1: now playing */}
        <section ref={drag.area} data-drag-page className="w-full flex-shrink-0 snap-start flex flex-col px-7 overflow-y-auto no-scrollbar" aria-label="播放" style={{ overscrollBehavior: 'none' }}>
          <div className="flex-1 min-h-4" />
          {/* hqdefault is letterboxed 4:3; a 16:9 cover crop removes the bars. */}
          <img src={p.video.thumbnail.replace('mqdefault', 'hqdefault')} alt="" className="w-full aspect-video object-cover rounded-[24px] shadow-2xl mx-auto"
            style={{ maxWidth: 520, transform: p.playing ? 'scale(1)' : 'scale(.92)', transition: 'transform .5s var(--ease)' }} />
          <div className="flex-1 min-h-4" />
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[21px] font-bold leading-snug line-clamp-2">{p.video.title}</p>
              <p className="text-[14px] mt-1" style={{ color: 'var(--text-2)' }}>{p.channelName}</p>
            </div>
            <button aria-label={p.isFav ? '取消收藏当前节目' : '收藏当前节目'} aria-pressed={p.isFav} onClick={p.onToggleFav}
              className="tap w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,.1)', color: p.isFav ? 'var(--accent)' : 'var(--text)' }}>
              <HeartIcon size={20} filled={p.isFav} />
            </button>
          </div>
          <div className="mt-6"><SeekBar elapsed={p.elapsed} duration={p.duration} onSeek={p.onSeek} /></div>
          <div className="flex items-center justify-between mt-4 px-4">
            <button aria-label="后退 15 秒" onClick={() => p.onSkip(-15)} className="tap w-14 h-14 flex items-center justify-center"><BackIcon size={34} /></button>
            <button aria-label={p.playing ? '暂停播放' : '开始播放'} onClick={p.onToggle}
              className="tap w-[76px] h-[76px] rounded-full flex items-center justify-center shadow-xl" style={{ background: '#fff', color: '#000' }}>
              {p.playing ? <PauseIcon size={32} /> : <PlayIcon size={32} className="ml-1" />}
            </button>
            <button aria-label="前进 30 秒" onClick={() => p.onSkip(30)} className="tap w-14 h-14 flex items-center justify-center"><ForwardIcon size={34} /></button>
          </div>
          <div className="flex items-center justify-between mt-6 mb-2">
            <button aria-label={`播放速度 ${p.rate} 倍，点击切换`} onClick={p.onCycleRate} className="tap px-3.5 py-2 rounded-full text-[14px] font-bold tabular-nums" style={{ background: 'rgba(255,255,255,.1)' }}>
              {p.rate}×
            </button>
            <button aria-label="定时停止播放" onClick={p.onOpenTimer} className="tap px-3.5 py-2 rounded-full text-[14px] font-semibold flex items-center gap-1.5"
              style={{ background: p.timerLabel ? 'var(--accent-soft)' : 'rgba(255,255,255,.1)', color: p.timerLabel ? 'var(--accent)' : 'var(--text)' }}>
              <MoonIcon size={16} /> {p.timerLabel ?? '定时'}
            </button>
            <button onClick={() => goPage(1)} className="tap px-3.5 py-2 rounded-full text-[14px] font-semibold flex items-center gap-1.5" style={{ background: 'rgba(255,255,255,.1)' }}>
              <TextIcon size={16} /> 字幕
            </button>
          </div>
          <div style={{ height: 'calc(env(safe-area-inset-bottom) + 16px)' }} />
        </section>

        {/* Page 2: transcript */}
        <section className="w-full flex-shrink-0 snap-start flex flex-col relative" aria-label="字幕">
          <div className="flex items-center gap-3 px-6 pb-2">
            <img src={p.video.thumbnail} alt="" className="w-9 h-9 rounded-lg object-cover" />
            <p className="flex-1 min-w-0 text-[13px] font-semibold truncate">{p.video.title}</p>
            <button onClick={p.onOpenDrill} aria-label={`跟读练习：${p.drill === 'off' ? '关闭' : DRILL_LABEL[p.drill]}`} className="tap px-3 py-1.5 rounded-full text-[12px] font-semibold flex items-center gap-1 flex-shrink-0"
              style={{ background: p.drill !== 'off' ? 'var(--accent-soft)' : 'rgba(255,255,255,.1)', color: p.drill !== 'off' ? 'var(--accent)' : 'var(--text-2)' }}>
              <RepeatIcon size={13} />{DRILL_LABEL[p.drill]}
            </button>
            <button onClick={p.onToggleTranslation} aria-pressed={p.showTranslation} className="tap px-3 py-1.5 rounded-full text-[12px] font-semibold flex-shrink-0"
              style={{ background: p.showTranslation ? 'var(--accent-soft)' : 'rgba(255,255,255,.1)', color: p.showTranslation ? 'var(--accent)' : 'var(--text-2)' }}>中文翻译</button>
          </div>
          <div ref={list} className="relative flex-1 min-h-0 overflow-y-auto no-scrollbar py-2 px-1"
            onTouchMove={onUserScroll} onWheel={onUserScroll} {...pressHandlers}
            style={{ maskImage: 'linear-gradient(transparent, #000 6%, #000 88%, transparent)', WebkitMaskImage: 'linear-gradient(transparent, #000 6%, #000 88%, transparent)' }}>
            {p.transcriptLoading && Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-6 rounded-lg mx-6 my-4" style={{ width: `${60 + (i * 13) % 35}%` }} />)}
            {p.transcriptError && (
              <div className="text-center py-16 text-sm" role="status" style={{ color: 'var(--text-2)' }}>
                <p>{p.transcriptError}</p>
                <button className="tap mt-3 font-semibold" style={{ color: 'var(--accent)' }} onClick={p.onRetryTranscript}>重新加载字幕</button>
              </div>
            )}
            <div className="h-[30vh] flex items-end justify-center pb-3">
              {p.segments.length > 0 && <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>点句子跳转 · 长按句子可循环、收藏、查词</p>}
            </div>
            {p.segments.map((seg, i) => (
              <TranscriptRow key={i} index={i} seg={seg} active={i === p.currentSegIdx} drilling={p.drill !== 'off'} saved={p.savedStarts.has(seg.start)}
                wait={p.drillWait?.idx === i ? p.drillWait : null} showTranslation={p.showTranslation} onSeek={p.onSeekSegment} />
            ))}
            <div className="h-[40vh]" />
          </div>
          {detached && p.currentSegIdx >= 0 && (
            <button onClick={() => { setDetached(false); centerSegment(p.currentSegIdx) }}
              className="tap absolute left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-[13px] font-semibold shadow-xl"
              style={{ bottom: 'calc(env(safe-area-inset-bottom) + 92px)', background: 'var(--text)', color: 'var(--bg)', animation: 'fade-in .2s' }}>
              回到当前句
            </button>
          )}
          <div className="flex-shrink-0 px-6 pt-2 flex items-center gap-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}>
            <button aria-label="重听这一句" onClick={p.onReplaySentence} className="tap"><ReplayIcon size={28} /></button>
            <button aria-label="后退 15 秒" onClick={() => p.onSkip(-15)} className="tap"><BackIcon size={28} /></button>
            <button aria-label={p.playing ? '暂停播放' : '开始播放'} onClick={p.onToggle} className="tap w-12 h-12 rounded-full flex items-center justify-center" style={{ background: '#fff', color: '#000' }}>
              {p.playing ? <PauseIcon size={20} /> : <PlayIcon size={20} className="ml-0.5" />}
            </button>
            <button aria-label="前进 30 秒" onClick={() => p.onSkip(30)} className="tap"><ForwardIcon size={28} /></button>
            <div className="flex-1 text-right text-[12px] tabular-nums" style={{ color: 'var(--text-2)' }}>{formatTime(p.elapsed)} / {formatTime(p.duration)}</div>
            <button aria-label={`播放速度 ${p.rate} 倍，点击切换`} onClick={p.onCycleRate} className="tap text-[13px] font-bold tabular-nums">{p.rate}×</button>
          </div>
        </section>
      </div>
    </div>
    </div>
  )
}

/* ───────────── Sheets ───────────── */

export function Sheet({ title, closing, onClose, children, z = 70 }: { title: string; closing: boolean; onClose: () => void; children: React.ReactNode; z?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Drag down anywhere on the sheet, unless the finger is in a list that is scrolled away from its top.
  const drag = useDragDismiss<HTMLElement>(onClose, target => {
    if (target.closest('input, textarea, select')) return false
    const scroller = target.closest('[data-sheet-scroll]') as HTMLElement | null
    return !scroller || scroller.scrollTop <= 0
  })
  return (
    <div className="fixed inset-0 flex items-end" onClick={onClose}
      style={{ zIndex: z, background: `rgba(0,0,0,${0.5 * (1 - Math.min(1, drag.offset / 400))})`, animation: `${closing ? 'fade-out' : 'fade-in'} .28s ease both`, pointerEvents: closing ? 'none' : undefined }}>
      <div className="w-full" style={{ animation: `${closing ? 'sheet-down' : 'sheet-up'} .32s var(--ease) both` }}>
        <section ref={drag.area} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
          className="w-full rounded-t-[28px] px-5 pt-3"
          style={{
            background: 'var(--surface)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
            transform: drag.offset ? `translateY(${drag.offset}px)` : undefined, transition: drag.dragging ? 'none' : 'transform .3s var(--ease)',
          }}>
          <div className="w-10 h-[5px] rounded-full mx-auto mb-4" style={{ background: 'var(--line)' }} />
          <h2 className="text-[18px] font-bold mb-4">{title}</h2>
          <div data-sheet-scroll className="overflow-y-auto -mx-5 px-5" style={{ maxHeight: 'calc(86dvh - 90px)', overscrollBehavior: 'contain' }}>
            {children}
          </div>
        </section>
      </div>
    </div>
  )
}

const TIMER_CHOICES = [15, 30, 45, 60, 90]

export function TimerOptions({ activeMinutes, stopAfterCurrent, onPick, onToggleAfterCurrent }: {
  activeMinutes: number; stopAfterCurrent: boolean; onPick: (minutes: number) => void; onToggleAfterCurrent: () => void
}) {
  return (
    <>
      <div className="grid grid-cols-3 gap-2.5">
        {TIMER_CHOICES.map(m => (
          <button key={m} onClick={() => onPick(m)} className="tap py-3.5 rounded-2xl text-[15px] font-semibold"
            style={{ background: activeMinutes === m ? 'var(--accent)' : 'var(--surface-2)', color: activeMinutes === m ? '#000' : 'var(--text)' }}>
            {m < 60 ? `${m} 分钟` : m === 60 ? '1 小时' : '1.5 小时'}
          </button>
        ))}
        <button onClick={onToggleAfterCurrent} aria-pressed={stopAfterCurrent} className="tap py-3.5 rounded-2xl text-[15px] font-semibold"
          style={{ background: stopAfterCurrent ? 'var(--accent)' : 'var(--surface-2)', color: stopAfterCurrent ? '#000' : 'var(--text)' }}>
          放完本集
        </button>
      </div>
      {(activeMinutes > 0 || stopAfterCurrent) && (
        <button onClick={() => onPick(0)} className="tap w-full mt-3 py-3 rounded-2xl text-[15px] font-semibold" style={{ color: 'var(--text-2)' }}>关闭定时</button>
      )}
    </>
  )
}
