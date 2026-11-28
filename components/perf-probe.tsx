'use client'

import { useEffect, useState } from 'react'

const SWITCHES = [
  { cls: 'perf-docscroll', label: '整页滚动' },
  { cls: 'perf-nosticky', label: '吸顶改普通' },
  { cls: 'perf-short', label: '只留40行' },
  { cls: 'perf-noimg', label: '关缩略图' },
  { cls: 'perf-nosvg', label: '关图标' },
]

/**
 * Opened with ?perf on a phone. Frame rate is split into still and scrolling, so a browser that caps
 * frames (heat, Low Power Mode) is told apart from a page that is slow to render; render time is how long
 * the browser spends drawing each frame after scripts run. The switches each change one suspect.
 */
export function PerfProbe() {
  const [stats, setStats] = useState({ still: 0, scrolling: 0, janks: 0, render: 0, renderMax: 0 })
  const [on, setOn] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let frame = 0, last = performance.now(), lastScroll = -Infinity
    const frames: { t: number; scrolling: boolean }[] = [], janks: number[] = [], renders: { t: number; ms: number }[] = []
    const onScroll = () => { lastScroll = performance.now() }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    const loop = (t: number) => {
      const start = performance.now()
      // A timer queued here runs once the browser has finished drawing this frame.
      setTimeout(() => renders.push({ t, ms: performance.now() - start }), 0)
      if (t - last > 45 && t - last < 1000) janks.push(t)
      last = t
      frames.push({ t, scrolling: t - lastScroll < 200 })
      while (frames[0].t < t - 2000) frames.shift()
      while (janks.length && janks[0] < t - 5000) janks.shift()
      while (renders.length && renders[0].t < t - 2000) renders.shift()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    const rate = (list: typeof frames) => list.length < 2 ? 0 : Math.round((list.length - 1) * 1000 / (list[list.length - 1].t - list[0].t))
    const show = setInterval(() => setStats({
      still: rate(frames.filter(f => !f.scrolling)), scrolling: rate(frames.filter(f => f.scrolling)), janks: janks.length,
      render: renders.length ? Math.round(renders.reduce((sum, r) => sum + r.ms, 0) / renders.length) : 0,
      renderMax: Math.round(Math.max(0, ...renders.map(r => r.ms))),
    }), 500)
    return () => { cancelAnimationFrame(frame); clearInterval(show); document.removeEventListener('scroll', onScroll, { capture: true }) }
  }, [])

  useEffect(() => {
    for (const s of SWITCHES) document.documentElement.classList.toggle(s.cls, on.has(s.cls))
    const rows = document.querySelectorAll<HTMLElement>('[data-video-row]')
    rows.forEach((row, i) => { row.style.display = on.has('perf-short') && i >= 40 ? 'none' : '' })
  }, [on])

  return (
    <section aria-label="性能检测" className="fixed right-2 z-[200] w-[150px] p-2 rounded-xl text-[11px] flex flex-col gap-1"
      style={{ top: 'calc(env(safe-area-inset-top) + 6px)', background: 'rgba(0,0,0,.9)', border: '1px solid var(--line)' }}>
      <p className="font-semibold tabular-nums leading-snug" style={{ color: stats.janks ? '#ff8a8a' : '#8affa8' }}>
        静止 {stats.still} · 滑动 {stats.scrolling} fps<br />卡顿 {stats.janks} · 渲染 {stats.render}/{stats.renderMax} ms
      </p>
      <div className="grid grid-cols-2 gap-1">
        {SWITCHES.map(s => (
          <button key={s.cls} aria-pressed={on.has(s.cls)}
            onClick={() => setOn(prev => { const next = new Set(prev); if (next.has(s.cls)) next.delete(s.cls); else next.add(s.cls); return next })}
            className="px-1.5 py-1 rounded-md" style={{ background: on.has(s.cls) ? 'var(--accent)' : 'var(--surface-2)', color: on.has(s.cls) ? '#000' : 'var(--text)' }}>
            {s.label}
          </button>
        ))}
      </div>
    </section>
  )
}
