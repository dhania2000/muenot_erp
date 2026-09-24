import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  listFiscalYears,
  listReopenRequests,
  createFiscalYear,
  deleteFiscalYear,
  closePeriod,
  lockPeriod,
  closeFiscalYear,
  requestReopen,
  approveReopen,
  rejectReopen,
} from "@/lib/finance/fiscal-year"

/**
 * Fiscal Year Engine API (SPEC 161).
 *
 *   GET  → all fiscal years (with periods) + reopen requests for the tenant.
 *   POST { action, ... }
 *     create_year   { name, startDate, endDate, entityId? }
 *     delete_year   { yearId }
 *     close_year    { yearId }
 *     close_period  { periodId }
 *     lock_period   { periodId }
 *     request_reopen{ periodId, reason }
 *     approve_reopen{ requestId }
 *     reject_reopen { requestId, note? }
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [fiscalYears, reopenRequests] = await Promise.all([listFiscalYears(), listReopenRequests()])
  return NextResponse.json({ fiscalYears, reopenRequests })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? "").trim()
  const userId = session.userId

  const num = (v: any) => Number(v) || 0

  switch (action) {
    case "create_year": {
      const res = await createFiscalYear({
        name: String(body.name ?? ""),
        startDate: String(body.startDate ?? ""),
        endDate: String(body.endDate ?? ""),
        entityId: body.entityId != null ? num(body.entityId) : 0,
        userId,
      })
      return res.ok ? NextResponse.json({ ok: true, id: res.id }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "delete_year": {
      const res = await deleteFiscalYear(num(body.yearId))
      return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "close_year": {
      const res = await closeFiscalYear(num(body.yearId), { userId })
      return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "close_period": {
      const res = await closePeriod(num(body.periodId), { userId })
      return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "lock_period": {
      const res = await lockPeriod(num(body.periodId), { userId })
      return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "request_reopen": {
      const res = await requestReopen(num(body.periodId), { reason: body.reason ?? null, userId })
      return res.ok ? NextResponse.json({ ok: true, id: res.id }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "approve_reopen": {
      const res = await approveReopen(num(body.requestId), { userId })
      return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    case "reject_reopen": {
      const res = await rejectReopen(num(body.requestId), { userId, note: body.note ?? null })
      return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: 400 })
    }
    default:
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 })
  }
}
