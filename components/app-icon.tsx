import { ImageResponse } from 'next/og'

// Sound waves on the channel's purple, readable at home-screen size.
export function renderAppIcon(px: number) {
  const bars = [0.34, 0.62, 0.9, 0.56, 0.78, 0.42]
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: px * 0.045,
        background: 'linear-gradient(145deg, #c58cff 0%, #7b4dff 55%, #3a1f8f 100%)' }}>
        {bars.map((h, i) => (
          <div key={i} style={{ width: px * 0.07, height: px * 0.5 * h, borderRadius: px, background: 'white', opacity: i % 2 ? 0.92 : 1 }} />
        ))}
      </div>
    ),
    { width: px, height: px },
  )
}
