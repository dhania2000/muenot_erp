import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { dispatchDueHrEmails } from "@/lib/hr-email"

/**
 * Dispatches due HR emails (scheduled sends + queued retries). Idempotent, so
 * it can run on any interval.
 *
 * Auth: either an admin session, or an unattended cron request carrying the
 * shared `CRON_SECRET` as a Bearer token — mirrors the WhatsApp scheduler.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function run() {
  return { ok: true, ...(await dispatchDueHrEmails()) }
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await run())
}

export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }
  return NextResponse.json(await run())
}
