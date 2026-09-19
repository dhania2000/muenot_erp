import { NextResponse } from "next/server"
import { runBackgroundQueueWorker } from "@/lib/background-jobs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== "production"
  return request.headers.get("authorization") === `Bearer ${secret}`
}

/** Invoked by the SPEC 41 scheduler; never accepts arbitrary jobs from HTTP. */
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    return NextResponse.json({ ok: true, ...(await runBackgroundQueueWorker()) })
  } catch (error) {
    console.error("[background-queue] worker failed", error)
    return NextResponse.json({ error: "Background queue worker failed" }, { status: 500 })
  }
}
