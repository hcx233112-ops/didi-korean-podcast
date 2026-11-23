const cache = new Map<string, Promise<string | null>>()

/** Average of the more saturated pixels of a cover, as "r g b"; null when the image is unusable. */
export function coverColor(src: string): Promise<string | null> {
  let pending = cache.get(src)
  if (!pending) {
    pending = new Promise(resolve => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = () => {
        try {
          const size = 24
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = size
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) return resolve(null)
          ctx.drawImage(img, 0, 0, size, size)
          const data = ctx.getImageData(0, 0, size, size).data
          let r = 0, g = 0, b = 0, weight = 0
          for (let i = 0; i < data.length; i += 4) {
            const max = Math.max(data[i], data[i + 1], data[i + 2]), min = Math.min(data[i], data[i + 1], data[i + 2])
            const w = (max - min) / 255 + 0.05
            r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; weight += w
          }
          // Keep the tint readable behind white text.
          const scale = Math.min(1, 150 / Math.max(r / weight, g / weight, b / weight, 1))
          resolve([r, g, b].map(c => Math.round((c / weight) * scale)).join(' '))
        } catch { resolve(null) }
      }
      img.onerror = () => resolve(null)
      img.src = src
    })
    cache.set(src, pending)
  }
  return pending
}
