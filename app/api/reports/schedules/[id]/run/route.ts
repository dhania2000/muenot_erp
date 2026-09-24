import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { runReportScheduleNow } from "@/lib/reports/scheduler-store"

/**
 * SPEC 98 Phase 4 — manual "Run now".
 *
 * Fires a schedule immediately (bypassing cron matching) while still honouring
 * per-minute slot idempotency, so it's safe to use for verifying delivery and
 * reproducing large-report / failed-delivery outcomes without waiting for the
 * dispatcher tick.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const id = Math.floor(Number((await params).id))
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 })
  }

  const result = await runReportScheduleNow(tenantId, id)
  if (!result) return NextResponse.json({ error: "Schedule not found." }, { status: 404 })
  return NextResponse.json(result)
}
