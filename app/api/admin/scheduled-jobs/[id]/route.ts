import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { validateTenantJobInput } from "@/lib/tenant-jobs/model"
import {
  deleteTenantJob,
  getTenantJob,
  listTenantJobRuns,
  setTenantJobEnabled,
  updateTenantJob,
  TenantJobConflict,
  TenantJobNotFound,
} from "@/lib/tenant-jobs/store"

/**
 * Spec12 (#22-29). Tenant scheduled jobs — item endpoint.
 *
 * Every operation is bound to the acting tenant from the verified guard. A
 * request that names an id belonging to another tenant simply resolves to
 * "not found" (404) because every query filters on tenant_id.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function resolve(params: Promise<{ id: string }>) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return { error: NextResponse.json({ error: guard.reason }, { status: guard.status }) }
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return { error: NextResponse.json({ error: "No tenant in context." }, { status: 403 }) }
  const id = Math.floor(Number((await params).id))
  if (!Number.isInteger(id) || id <= 0) return { error: NextResponse.json({ error: "Invalid schedule id." }, { status: 400 }) }
  return { guard, tenantId, id }
}

function toStatus(error: unknown): number | null {
  if (error instanceof TenantJobNotFound) return 404
  if (error instanceof TenantJobConflict) return 409
  return null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(params)
  if ("error" in r) return r.error
  const job = await getTenantJob(r.tenantId, r.id)
  if (!job) return NextResponse.json({ error: "Scheduled job not found." }, { status: 404 })
  const runs = await listTenantJobRuns(r.tenantId, r.id, 50)
  return NextResponse.json({ job, runs })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(params)
  if ("error" in r) return r.error

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body." }, { status: 400 })
  const expectedVersion = Math.floor(Number(body.version))
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return NextResponse.json({ error: "A valid version is required." }, { status: 400 })

  const parsed = validateTenantJobInput(body)
  if (!parsed.ok) return NextResponse.json({ error: "Validation failed.", fieldErrors: parsed.errors }, { status: 400 })

  try {
    const before = await getTenantJob(r.tenantId, r.id)
    const job = await updateTenantJob(r.tenantId, r.guard.session.userId, r.id, parsed.value, expectedVersion)
    await recordAuditLogFromRequest(request, {
      action: "tenant_scheduled_job.update",
      entityType: "tenant_scheduled_jobs",
      entityId: job.id,
      entityLabel: job.name,
      before: before ? { cronExpression: before.cronExpression, timezone: before.timezone, enabled: before.enabled } : null,
      after: { cronExpression: job.cronExpression, timezone: job.timezone, enabled: job.enabled },
    })
    return NextResponse.json({ job })
  } catch (error) {
    const status = toStatus(error)
    if (status) return NextResponse.json({ error: (error as Error).message }, { status })
    throw error
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(params)
  if ("error" in r) return r.error

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "An `enabled` boolean is required." }, { status: 400 })
  }
  const expectedVersion = Math.floor(Number(body.version))
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return NextResponse.json({ error: "A valid version is required." }, { status: 400 })

  try {
    const job = await setTenantJobEnabled(r.tenantId, r.guard.session.userId, r.id, body.enabled, expectedVersion)
    await recordAuditLogFromRequest(request, {
      action: body.enabled ? "tenant_scheduled_job.enable" : "tenant_scheduled_job.disable",
      entityType: "tenant_scheduled_jobs",
      entityId: job.id,
      entityLabel: job.name,
      after: { enabled: job.enabled },
    })
    return NextResponse.json({ job })
  } catch (error) {
    const status = toStatus(error)
    if (status) return NextResponse.json({ error: (error as Error).message }, { status })
    throw error
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await resolve(params)
  if ("error" in r) return r.error

  const before = await getTenantJob(r.tenantId, r.id)
  const deleted = await deleteTenantJob(r.tenantId, r.guard.session.userId, r.id)
  if (!deleted) return NextResponse.json({ error: "Scheduled job not found." }, { status: 404 })
  await recordAuditLogFromRequest(request, {
    action: "tenant_scheduled_job.delete",
    entityType: "tenant_scheduled_jobs",
    entityId: r.id,
    entityLabel: before?.name ?? null,
  })
  return NextResponse.json({ success: true })
}
