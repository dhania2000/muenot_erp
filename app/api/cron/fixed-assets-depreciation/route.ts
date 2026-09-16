import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runMonthlyDepreciation } from "@/lib/finance-fixed-assets"

export const runtime = "nodejs"

/**
 * Monthly Fixed Assets depreciation posting (Phase 11).
 *
 * Posts one period of depreciation for every capitalised, in-service asset with
 * a depreciation method set. Each asset books a balanced Journal → General
 * Ledger voucher (Dr Depreciation Expense / Cr Accumulated Depreciation) through
 * the shared posting engine, so the Trial Balance, Balance Sheet, P&L and
 * ledgers update automatically. Idempotent per accounting month via the unique
 * (asset_id, period) row in `fixed_asset_depreciation`, so a repeat run in the
 * same month never double-posts. Authenticated for Vercel Cron with the shared
 * CRON_SECRET Bearer token (see vercel.json); a signed-in user may also trigger
 * a manual run and may pass ?period=YYYY-MM. Mirrors /api/cron/provisions-periodic.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  let createdBy: number | null = null
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    createdBy = Number(session.userId) || null
  }
  const period = new URL(request.url).searchParams.get("period") || undefined
  const result = await runMonthlyDepreciation({ period, createdBy })
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
