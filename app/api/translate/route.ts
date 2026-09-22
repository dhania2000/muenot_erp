import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const CONCURRENCY = 6
const MAX_TEXTS_PER_REQUEST = 300

// Per-instance cache so repeated words within the same server instance never
// hit the network twice. Keyed by `${source}:${target}:${text}`.
const cache = new Map<string, string>()

async function translateOne(text: string, target: string, source: string): Promise<string> {
  const key = `${source}:${target}:${text}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
    source,
  )}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MuenotERP/1.0)" },
  })
  if (!res.ok) throw new Error(`Google Translate request failed: ${res.status}`)

  const data = await res.json()
  const sentences = Array.isArray(data?.[0]) ? data[0] : []
  const translated = sentences.map((chunk: unknown) => (Array.isArray(chunk) ? String(chunk[0] ?? "") : "")).join("")

  const result = translated || text
  cache.set(key, result)
  return result
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0

  async function next(): Promise<void> {
    const current = index++
    if (current >= items.length) return
    results[current] = await worker(items[current])
    return next()
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next))
  return results
}

export async function POST(request: Request) {
  let body: { texts?: unknown; target?: unknown; source?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { texts, target, source } = body
  if (!Array.isArray(texts) || texts.length === 0 || typeof target !== "string" || !target) {
    return NextResponse.json({ error: "texts (string[]) and target (string) are required" }, { status: 400 })
  }

  const cleanTexts = texts
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .slice(0, MAX_TEXTS_PER_REQUEST)
  const sourceLang = typeof source === "string" && source ? source : "en"

  if (target === sourceLang || cleanTexts.length === 0) {
    return NextResponse.json({ translations: cleanTexts })
  }

  try {
    const translations = await runWithConcurrency(cleanTexts, CONCURRENCY, (text) =>
      translateOne(text, target, sourceLang).catch(() => text),
    )
    return NextResponse.json({ translations })
  } catch (error) {
    console.error("[v0] translate route error", error)
    return NextResponse.json({ error: "Translation failed" }, { status: 502 })
  }
}
