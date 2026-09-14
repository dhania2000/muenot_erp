import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runMonthlyGstSweep } from "@/lib/finance-gst-automation"

export const runtime = "nodejs"

/**
 * Monthly GST sweep (Phase 37/38).
 *
 * Prepares the period that just ended: refreshes the drafted GSTR-2B, re-runs
 * ITC reconciliation, and pushes the GSTR-1/3B-ready, filing and payment
 * reminders. It NEVER files a return, records a payment, or posts a Journal/GL
 * voucher — those stay user actions — so re-running the month cannot duplicate
 * any Filing / GST record / ITC / Payment / Journal / GL entry. Authenticated
 * for Vercel Cron with CRON_SECRET; a signed-in user may trigger it manually and
 * may pass an explicit ?period=YYYY-MM.
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
  const url = new URL(request.url)
  const period = url.searchParams.get("period") || undefined
  const result = await runMonthlyGstSweep(period)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
