import { readFile } from 'node:fs/promises'
import path from 'node:path'
import channels from '@/data/channels.json'
import PodcastApp from '@/components/podcast-app'
import type { Video } from '@/lib/library'

// Prerendered with the episode list, so the library shows instantly; the client refreshes it.
export default async function Page() {
  const initialVideos: Record<string, Video[]> = {}
  for (const channel of channels) {
    try {
      const raw = JSON.parse(await readFile(path.join(process.cwd(), 'public', 'data', 'videos', `${channel.id}.json`), 'utf8'))
      if (Array.isArray(raw.videos)) initialVideos[channel.id] = raw.videos
    } catch {}
  }
  return <PodcastApp initialVideos={initialVideos} />
}
