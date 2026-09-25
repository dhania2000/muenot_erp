import crypto from "crypto"
import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { runTenantJobNow, TenantJobConflict, TenantJobNotFound } from "@/lib/tenant-jobs/store"

/**
 * Spec12 (#22-29). Manual "Run now".
 *
 * Fires a schedule immediately through the same shared queue path as the
 * dispatcher. The Idempotency-Key header makes repeated clicks a no-op: the
 * run row is unique on (schedule_id, `manual:<key>`), so a retry returns the
 * existing run instead of enqueuing a second one.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context." }, { status: 403 })

  const id = Math.floor(Number((await params).id))
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 })

  const requestKey = request.headers.get("idempotency-key")?.trim() || crypto.randomUUID()
  try {
    const { run, replayed } = await runTenantJobNow(tenantId, guard.session.userId, id, requestKey)
    if (!replayed) {
      await recordAuditLogFromRequest(request, {
        action: "tenant_scheduled_job.run_now",
        entityType: "tenant_scheduled_jobs",
        entityId: id,
        metadata: { runId: run.id },
      })
    }
    return NextResponse.json({ run, replayed })
  } catch (error) {
    if (error instanceof TenantJobNotFound) return NextResponse.json({ error: error.message }, { status: 404 })
    if (error instanceof TenantJobConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
