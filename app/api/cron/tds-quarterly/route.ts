import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runQuarterlyTdsSweep } from "@/lib/finance-tds-automation"

export const runtime = "nodejs"

/**
 * Quarterly TDS sweep (Phase 64/65).
 *
 * Fires around each quarter boundary to remind finance of the quarterly
 * 24Q/26Q return and the Form 16 / 16A certificate obligations that follow it.
 * Dedup-guarded per FY quarter. Auth mirrors the other TDS crons.
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
  const result = await runQuarterlyTdsSweep()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
