import { NextResponse } from "next/server"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { latestPublicRelease } from "@/lib/mobile-app-releases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const rate = checkRateLimit(`mobile-app-version:${getClientIp(request)}`, { max: 120, windowMs: 60_000 })
  if (!rate.allowed) return NextResponse.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfter), "Cache-Control": "no-store" } })
  try {
    const release = await latestPublicRelease()
    if (!release) return NextResponse.json({ error: "No published Android release is available.", code: "release_unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } })
    return NextResponse.json(release, { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } })
  } catch { return NextResponse.json({ error: "Version check is temporarily unavailable.", code: "version_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }) }
}
