import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runEsignScheduler } from "@/lib/legal-esign-workflow"

export const runtime = "nodejs"

/**
 * Scheduled e-sign sweep (Phase 93): expire overdue requests, send tiered
 * reminders and retry auto-email of completed documents. Runs unattended via
 * Vercel Cron authenticated with the shared CRON_SECRET Bearer token, and can
 * also be triggered on demand by a signed-in user.
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
  const result = await runEsignScheduler()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
