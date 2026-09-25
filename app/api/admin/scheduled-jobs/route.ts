import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { exportCatalogForClient } from "@/lib/data-export-catalog"
import { EXPORT_FORMATS, EXPORT_FORMAT_LABELS } from "@/lib/data-export-model"
import { listReportSchedules } from "@/lib/reports/scheduler-store"
import {
  TENANT_JOB_ACTIONS,
  TENANT_JOB_ACTION_KEYS,
  TENANT_JOB_PRESETS,
  TENANT_JOB_LIMITS,
  validateTenantJobInput,
} from "@/lib/tenant-jobs/model"
import {
  createTenantJob,
  listTenantJobs,
  tenantJobOverview,
  TenantJobConflict,
} from "@/lib/tenant-jobs/store"

/**
 * Spec12 (#22-29). Tenant scheduled jobs — collection endpoint.
 *
 * Tenant-admin only. The acting tenant id ALWAYS comes from the verified guard
 * (effectiveTenantId), never from the request body, so a tenant can only ever
 * read or create schedules within its own scope.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function metadataFor(tenantId: number) {
  const [datasets, reportSchedules] = await Promise.all([
    Promise.resolve(exportCatalogForClient()),
    listReportSchedules(tenantId).catch(() => []),
  ])
  return {
    actions: TENANT_JOB_ACTION_KEYS.map((key) => TENANT_JOB_ACTIONS[key]),
    presets: TENANT_JOB_PRESETS,
    limits: TENANT_JOB_LIMITS,
    formats: EXPORT_FORMATS.map((value) => ({ value, label: EXPORT_FORMAT_LABELS[value] })),
    datasets: datasets.map((d) => ({ key: d.key, label: d.label, module: d.module })),
    reportSchedules: reportSchedules.map((s) => ({ id: s.id, label: `${s.reportName} · ${s.frequency}` })),
  }
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context." }, { status: 403 })

  const [jobs, overview, metadata] = await Promise.all([
    listTenantJobs(tenantId),
    tenantJobOverview(tenantId),
    metadataFor(tenantId),
  ])
  return NextResponse.json({ jobs, overview, metadata })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context." }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const parsed = validateTenantJobInput(body)
  if (!parsed.ok) return NextResponse.json({ error: "Validation failed.", fieldErrors: parsed.errors }, { status: 400 })

  const createKey = request.headers.get("idempotency-key")
  try {
    const { job, replayed } = await createTenantJob(tenantId, guard.session.userId, parsed.value, createKey)
    if (!replayed) {
      await recordAuditLogFromRequest(request, {
        action: "tenant_scheduled_job.create",
        entityType: "tenant_scheduled_jobs",
        entityId: job.id,
        entityLabel: job.name,
        after: { name: job.name, actionKey: job.actionKey, cronExpression: job.cronExpression, timezone: job.timezone, enabled: job.enabled },
      })
    }
    return NextResponse.json({ job, replayed }, { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof TenantJobConflict) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
