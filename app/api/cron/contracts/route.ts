import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runExpiryScheduler } from "@/lib/sales/contract-service"

export const runtime = "nodejs"

/**
 * Contract expiry + renewal-reminder scheduler.
 *
 * Runs unattended via Vercel Cron (see vercel.json) authenticated with the
 * shared `CRON_SECRET` Bearer token. Also runnable on demand by a signed-in
 * user so the button in the UI can trigger a manual sweep.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  const isCron = authorized(request)
  if (!isCron) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await runExpiryScheduler(30)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
