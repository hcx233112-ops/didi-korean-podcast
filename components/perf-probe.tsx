'use client'

import { useEffect, useState } from 'react'

const SWITCHES = [
  { cls: 'perf-noglass', label: '关毛玻璃' },
  { cls: 'perf-nocover', label: '关模糊封面' },
  { cls: 'perf-noimg', label: '关缩略图' },
  { cls: 'perf-noanim', label: '关动画' },
]

/** Opened with ?perf on a phone: the live frame rate, and switches that each turn one suspected cost off. */
export function PerfProbe() {
  const [stats, setStats] = useState({ fps: 0, janks: 0 })
  const [off, setOff] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let frame = 0, last = performance.now()
    const frames: number[] = [], janks: number[] = []
    const loop = (t: number) => {
      // Two or more missed frames at 60 Hz is a visible hitch.
      if (t - last > 45 && t - last < 1000) janks.push(t)
      last = t
      frames.push(t)
      while (frames[0] < t - 1000) frames.shift()
      while (janks.length && janks[0] < t - 5000) janks.shift()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    const show = setInterval(() => setStats({ fps: frames.length, janks: janks.length }), 500)
    return () => { cancelAnimationFrame(frame); clearInterval(show) }
  }, [])

  useEffect(() => { for (const s of SWITCHES) document.documentElement.classList.toggle(s.cls, off.has(s.cls)) }, [off])

  return (
    <section aria-label="性能检测" className="fixed right-2 z-[200] w-[132px] p-2 rounded-xl text-[11px] flex flex-col gap-1"
      style={{ top: 'calc(env(safe-area-inset-top) + 6px)', background: 'rgba(0,0,0,.88)', border: '1px solid var(--line)' }}>
      <p className="font-semibold tabular-nums" style={{ color: stats.janks ? '#ff8a8a' : '#8affa8' }}>{stats.fps} fps · 卡顿 {stats.janks}</p>
      {SWITCHES.map(s => (
        <button key={s.cls} aria-pressed={off.has(s.cls)}
          onClick={() => setOff(prev => { const next = new Set(prev); if (next.has(s.cls)) next.delete(s.cls); else next.add(s.cls); return next })}
          className="text-left px-2 py-1 rounded-md" style={{ background: off.has(s.cls) ? 'var(--accent)' : 'var(--surface-2)', color: off.has(s.cls) ? '#000' : 'var(--text)' }}>
          {s.label}
        </button>
      ))}
    </section>
  )
}
