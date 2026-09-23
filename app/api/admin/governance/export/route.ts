import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import {
  createAndRunExport,
  getExportJobWithLink,
  listExportJobs,
  listExportSchedules,
} from "@/lib/data-export-store"
import { exportCatalogForClient } from "@/lib/data-export-catalog"
import { EXPORT_FORMAT_LABELS, EXPORT_FREQUENCIES, FULL_TENANT_EXPORT_KEY } from "@/lib/data-export-model"

// Tenant Data Export admin API. Tenant-admin only, tenant-scoped, and
// audited (the store records every export + schedule mutation to the immutable
// audit log). Exports respect data classification: fields the acting
// role may not export are redacted from the artifact.

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const [jobs, schedules] = await Promise.all([listExportJobs(tenantId), listExportSchedules(tenantId)])
  return NextResponse.json({
    jobs,
    schedules,
    catalog: exportCatalogForClient(),
    fullTenantKey: FULL_TENANT_EXPORT_KEY,
    formats: EXPORT_FORMAT_LABELS,
    frequencies: EXPORT_FREQUENCIES,
  })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  const body = await request.json().catch(() => ({}))
  const datasetKey = String(body?.datasetKey ?? "").trim()
  if (!datasetKey) return NextResponse.json({ error: "A dataset or full-tenant scope is required" }, { status: 400 })
  try {
    const job = await createAndRunExport(tenantId, { datasetKey, format: body?.format }, actor)
    const withLink = await getExportJobWithLink(tenantId, job.id)
    return NextResponse.json({ job: withLink ?? job }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
