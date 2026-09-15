import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runMonthlyTdsSweep } from "@/lib/finance-tds-automation"

export const runtime = "nodejs"

/**
 * Monthly TDS sweep (Phase 64/65).
 *
 * Fires on the 1st of each month to remind finance of the monthly challan
 * deposit obligation (7th of the month) and any carried-forward exceptions.
 * Dedup-guarded per calendar month, so it delivers each alert once. Auth mirrors
 * /api/cron/gst-monthly.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await runMonthlyTdsSweep()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
