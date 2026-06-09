import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const channelId = searchParams.get('channelId')
  if (!channelId) return NextResponse.json({ url: null })

  try {
    const r = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    })
    const html = await r.text()
    // Try various patterns YouTube uses for channel avatar
    const m =
      html.match(/"width":88,"height":88[^}]*"url":"([^"]+)"/) ??
      html.match(/"channelThumbnailSupportedRenderers"[\s\S]{0,300}"url":"([^"]+)"/) ??
      html.match(/<meta property="og:image" content="([^"]+)"/)
    const url = m ? m[1].replace(/\\u0026/g, '&') : null
    return NextResponse.json({ url }, {
      headers: { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' },
    })
  } catch {
    return NextResponse.json({ url: null })
  }
}
