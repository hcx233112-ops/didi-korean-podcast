import { NextResponse } from 'next/server'

const BASE = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN
const KEY = 'podcast-sync'

async function kvGet() {
  if (!BASE || !TOKEN) return null
  try {
    const r = await fetch(`${BASE}/get/${KEY}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: 'no-store',
    })
    if (!r.ok) return null
    const { result } = await r.json()
    return result ? JSON.parse(result) : null
  } catch { return null }
}

async function kvSet(value: unknown) {
  if (!BASE || !TOKEN) return
  await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', KEY, JSON.stringify(value)]),
  }).catch(() => {})
}

export async function GET() {
  return NextResponse.json(await kvGet())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (body) await kvSet(body)
  return NextResponse.json({ ok: true })
}
