import { generateObject, jsonSchema } from 'ai'
import { NextResponse } from 'next/server'
import { getLanguage } from '@/lib/i18n/languages'

// Fast, low-cost model — this route translates short UI strings, not
// long-form content, so speed and cost matter more than nuance.
const MODEL = 'openai/gpt-5-nano'
const MAX_ITEMS = 120
const MAX_TEXT_LENGTH = 500
const MAX_BATCH_CHARS = 8000

// In-memory per-instance cache. It's intentionally not persisted to a
// database: UI strings are static enough that a warm serverless instance
// answers almost everything from cache, and a cold start just re-translates
// once per (language, string) pair.
const memoryCache = new Map<string, string>()

function cacheKey(lang: string, text: string) {
  return `${lang}::${text}`
}

export async function POST(request: Request) {
  let body: { texts?: unknown; target?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const language = getLanguage(typeof body.target === 'string' ? body.target : undefined)
  if (!language) {
    return NextResponse.json({ error: 'Unsupported or missing target language' }, { status: 400 })
  }

  const texts = Array.isArray(body.texts) ? body.texts.filter((t): t is string => typeof t === 'string') : []
  if (texts.length === 0) return NextResponse.json({ translations: [] })
  if (texts.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many strings; max ${MAX_ITEMS} per request` }, { status: 400 })
  }

  const clipped = texts.map((t) => t.slice(0, MAX_TEXT_LENGTH))

  if (language.code === 'en') {
    return NextResponse.json({ translations: clipped })
  }

  const uniqueTexts = [...new Set(clipped)]
  const resultMap = new Map<string, string>()
  const toTranslate: string[] = []

  for (const text of uniqueTexts) {
    const cached = memoryCache.get(cacheKey(language.code, text))
    if (cached) resultMap.set(text, cached)
    else toTranslate.push(text)
  }

  if (toTranslate.length > 0) {
    const batches: string[][] = []
    let current: string[] = []
    let currentChars = 0
    for (const text of toTranslate) {
      if (current.length > 0 && currentChars + text.length > MAX_BATCH_CHARS) {
        batches.push(current)
        current = []
        currentChars = 0
      }
      current.push(text)
      currentChars += text.length
    }
    if (current.length > 0) batches.push(current)

    await Promise.all(
      batches.map(async (batch) => {
        try {
          const { object } = await generateObject({
            model: MODEL,
            output: 'array',
            schema: jsonSchema<string>({ type: 'string' }),
            system:
              `You translate short user-interface strings for a business ERP application into ${language.name} ` +
              `(${language.nativeName}). Translate naturally and concisely, matching the tone and capitalization ` +
              'style of the original. Preserve numbers, dates, currency symbols, and any placeholders such as ' +
              '{name}, %s, or {{count}} exactly as-is. Keep proper nouns, product names, and codes unchanged. ' +
              'Return exactly one translated string per input string, in the same order, with no extra or missing items.',
            prompt: JSON.stringify(batch),
          })
          const translated = Array.isArray(object) ? object : []
          batch.forEach((text, i) => {
            const value = typeof translated[i] === 'string' && translated[i].trim() ? translated[i] : text
            memoryCache.set(cacheKey(language.code, text), value)
            resultMap.set(text, value)
          })
        } catch (error) {
          console.error('[v0] translate batch failed', error)
          batch.forEach((text) => resultMap.set(text, text))
        }
      }),
    )
  }

  const translations = clipped.map((text) => resultMap.get(text) ?? text)
  return NextResponse.json({ translations })
}
