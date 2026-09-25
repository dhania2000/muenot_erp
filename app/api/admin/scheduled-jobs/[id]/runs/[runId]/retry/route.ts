import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { retryTenantJobRun, TenantJobConflict, TenantJobNotFound } from "@/lib/tenant-jobs/store"

/**
 * Spec12 (#22-29). Reviewed retry of a failed / dead-lettered run.
 *
 * Optimistic on `expectedAttempt` so two admins cannot double-retry the same
 * run. Actions whose external side effects may have partially happened
 * (report delivery) require `acknowledgeUncertain: true`, mirroring the
 * platform job-monitoring retry-with-acknowledgement pattern.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context." }, { status: 403 })

  const resolved = await params
  const id = Math.floor(Number(resolved.id))
  const runId = Math.floor(Number(resolved.runId))
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 })
  }

  const body = await request.json().catch(() => ({}))
  const expectedAttempt = Math.floor(Number(body?.expectedAttempt))
  if (!Number.isInteger(expectedAttempt) || expectedAttempt < 0) {
    return NextResponse.json({ error: "A valid expectedAttempt is required." }, { status: 400 })
  }
  const acknowledgeUncertain = body?.acknowledgeUncertain === true

  try {
    const result = await retryTenantJobRun(tenantId, guard.session.userId, id, runId, expectedAttempt, acknowledgeUncertain)
    await recordAuditLogFromRequest(request, {
      action: "tenant_scheduled_job.retry",
      entityType: "tenant_scheduled_jobs",
      entityId: id,
      metadata: { runId, acknowledgeUncertain },
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof TenantJobNotFound) return NextResponse.json({ error: error.message }, { status: 404 })
    if (error instanceof TenantJobConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
