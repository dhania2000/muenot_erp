import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runMonthlyDepreciation } from "@/lib/finance-fixed-assets"

export const runtime = "nodejs"

// Manual "Run depreciation" trigger for a chosen accounting month. Idempotent:
// assets already depreciated for that month are skipped, so it is safe to click
// twice. The scheduled cron (/api/cron/fixed-asset-depreciation) runs the same
// engine automatically once a month.
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const period = typeof body.period === "string" && /^\d{4}-\d{2}$/.test(body.period) ? body.period : null
  const result = await runMonthlyDepreciation({ period, createdBy: session.userId })
  return NextResponse.json({ ok: true, ...result })
}
