import { NextRequest, NextResponse } from "next/server"
import { ensureCronJobSchema } from "@/lib/cron-jobs"
import { runSchedulerTick } from "@/lib/scheduler"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== "production"
  return request.headers.get("authorization") === `Bearer ${secret}`
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await ensureCronJobSchema()
    return NextResponse.json({ ok: true, ...(await runSchedulerTick(request)) })
  } catch (error) {
    console.error("[cron-dispatcher] failed", error)
    return NextResponse.json({ error: "Scheduler dispatch failed" }, { status: 500 })
  }
}
