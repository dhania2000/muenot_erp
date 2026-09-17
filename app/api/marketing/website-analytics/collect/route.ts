import { NextResponse } from "next/server"
import {
  ensureWebsiteAnalyticsSchema,
  getPropertyByTrackingId,
  ingestEvents,
  type IncomingEvent,
  type IngestContext,
} from "@/lib/marketing/website-analytics-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// Public analytics ingestion endpoint (Phases 5, 81, 82, 83).
//
// This is the ONE public, un-authenticated surface. It is hardened with:
//   - tracking-id + property validation (Active properties only)
//   - a strict event schema (unknown / oversized payloads rejected)
//   - a lightweight in-memory rate limiter per IP + tracking id
//   - best-effort bot filtering (done in the data layer)
// It never exposes database credentials or any server secret.
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
}

const MAX_EVENTS_PER_BATCH = 30
const MAX_BODY_BYTES = 64 * 1024

// Simple sliding-window limiter kept in module memory (best-effort per instance).
declare global {
  // eslint-disable-next-line no-var
  var __waRateBuckets: Map<string, { count: number; reset: number }> | undefined
}
const buckets = globalThis.__waRateBuckets ?? new Map()
globalThis.__waRateBuckets = buckets
const RATE_LIMIT = 120 // events-batches per window
const RATE_WINDOW_MS = 60_000

function rateLimited(key: string): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + RATE_WINDOW_MS })
    return false
  }
  b.count++
  if (b.count > RATE_LIMIT) return true
  return false
}

function clientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return request.headers.get("x-real-ip")
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(request: Request) {
  await ensureWebsiteAnalyticsSchema()

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: CORS })
  }

  let body: any
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: CORS })
  }

  const trackingId = String(body?.tracking_id || body?.t || "").trim().slice(0, 48)
  if (!trackingId) {
    return NextResponse.json({ error: "Missing tracking id" }, { status: 400, headers: CORS })
  }

  const ip = clientIp(request)
  if (rateLimited(`${trackingId}:${ip ?? "?"}`)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: CORS })
  }

  const property = await getPropertyByTrackingId(trackingId)
  if (!property || property.status !== "Active") {
    // Do not leak which ids exist; a paused/unknown property silently accepts nothing.
    return NextResponse.json({ ok: true, accepted: 0 }, { status: 202, headers: CORS })
  }

  const rawEvents: any[] = Array.isArray(body.events) ? body.events : body.event ? [body.event] : []
  if (!rawEvents.length) {
    return NextResponse.json({ ok: true, accepted: 0 }, { status: 202, headers: CORS })
  }

  const events: IncomingEvent[] = rawEvents.slice(0, MAX_EVENTS_PER_BATCH).map((e: any) => ({
    type: String(e?.type || e?.t || ""),
    name: e?.name ?? null,
    visitor_id: String(e?.visitor_id || e?.vid || ""),
    session_id: String(e?.session_id || e?.sid || ""),
    page_url: e?.page_url ?? e?.url ?? null,
    page_title: e?.page_title ?? e?.title ?? null,
    referrer: e?.referrer ?? e?.ref ?? null,
    utm: e?.utm && typeof e.utm === "object" ? e.utm : null,
    screen_size: e?.screen_size ?? e?.screen ?? null,
    language: e?.language ?? e?.lang ?? null,
    duration_ms: e?.duration_ms != null ? Number(e.duration_ms) : null,
    is_test: !!e?.is_test,
    metadata: e?.metadata && typeof e.metadata === "object" ? e.metadata : null,
    ts: e?.ts != null ? Number(e.ts) : null,
  }))

  const ctx: IngestContext = {
    userAgent: request.headers.get("user-agent") || "",
    ip,
    country: request.headers.get("x-vercel-ip-country") || null,
    region: request.headers.get("x-vercel-ip-country-region") || null,
    city: decodeHeader(request.headers.get("x-vercel-ip-city")),
  }

  try {
    const { accepted } = await ingestEvents(property, events, ctx)
    return NextResponse.json({ ok: true, accepted }, { status: 202, headers: CORS })
  } catch (error) {
    console.error("[wa] ingest failed", error)
    return NextResponse.json({ error: "Ingest failed" }, { status: 500, headers: CORS })
  }
}

function decodeHeader(value: string | null): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
