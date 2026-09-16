import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { postDueProvisionEntries } from "@/lib/finance-provisions"

export const runtime = "nodejs"

/**
 * Daily Provisions & Accruals periodic posting (Phase 6).
 *
 * Posts every provision/accrual/prepaid installment that has fallen due on or
 * before today — prepaid amortisation and recurring provision/accrual re-books.
 * Each installment posts a balanced Journal → General Ledger voucher through
 * the shared posting engine and is marked Posted so it never double-posts;
 * transient failures stay Pending for the next run. Authenticated for Vercel
 * Cron with the shared CRON_SECRET Bearer token (see vercel.json); a signed-in
 * user may also trigger a manual run. Mirrors /api/cron/journal-daily.
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
  const params = new URL(request.url).searchParams
  const asOf = params.get("asOf") || undefined
  const provisionId = params.get("provisionId") || undefined
  const result = await postDueProvisionEntries({ asOf, provisionId })
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
