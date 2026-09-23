import { NextResponse } from "next/server"
import { pruneSharedRateLimitCounters } from "@/lib/api-platform/rate-limit-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret ? process.env.NODE_ENV === "production" : request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try { return NextResponse.json({ ok: true, removed: await pruneSharedRateLimitCounters() }) }
  catch { return NextResponse.json({ error: "Rate-limit cleanup failed" }, { status: 500 }) }
}
