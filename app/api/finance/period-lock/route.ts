import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { listPeriodLocks, lockPeriod, unlockPeriod, periodKeyFor } from "@/lib/finance-period-lock"

/**
 * Accounting Period Lock API (SPEC 162).
 *
 *   GET  → all period-lock records for the finance workspace.
 *   POST { action, period, note? }
 *     lock    { period, note? }  — requires finance.journal / lock_period
 *     unlock  { period }         — requires finance.journal / unlock_period
 *
 * Locking is what actually seals a month: once a period is Locked, every
 * financial write dated in it (journal posting, invoice / payment / tax
 * postings) is rejected by assertPeriodOpen at the module entry points. Only
 * authorized finance users may lock or unlock, so the enforcement can never be
 * toggled by an unprivileged caller.
 */

const MODULE = "finance.journal"

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 })
}

export async function GET() {
  const session = await requireFeature(MODULE)
  if (!session) return forbidden()
  const locks = await listPeriodLocks()
  return NextResponse.json({ locks })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}) as any)
  const action = String(body.action ?? "").trim()
  const period = periodKeyFor(String(body.period ?? ""))
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "A valid period (YYYY-MM) is required." }, { status: 400 })
  }

  if (action === "lock") {
    const session = await requireModuleAction(MODULE, "lock_period")
    if (!session) return forbidden()
    const res = await lockPeriod(period, { userId: session.userId, note: body.note ?? null })
    return NextResponse.json({ ok: true, ...res })
  }

  if (action === "unlock") {
    const session = await requireModuleAction(MODULE, "unlock_period")
    if (!session) return forbidden()
    const res = await unlockPeriod(period, { userId: session.userId })
    return NextResponse.json({ ok: true, ...res })
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 })
}
