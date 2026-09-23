import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { analyzeImport, listImportJobs } from "@/lib/data-import-store"
import { importCatalogForClient } from "@/lib/data-import-catalog"
import { IMPORT_ROW_LIMIT, IMPORT_STATUS_LABELS } from "@/lib/data-import-model"

// SPEC 74 — Enterprise Data Import admin API. Tenant-admin only, tenant-scoped,
// and audited (the store records every commit + rollback to the immutable audit
// log). GET returns the importable-dataset catalog plus this tenant's import
// history. POST runs a DRY-RUN analysis (map → validate → dedupe → preview) and
// writes nothing — the client commits separately once the preview looks right.

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const jobs = await listImportJobs(tenantId)
  return NextResponse.json({
    jobs,
    catalog: importCatalogForClient(),
    rowLimit: IMPORT_ROW_LIMIT,
    statusLabels: IMPORT_STATUS_LABELS,
  })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const body = await request.json().catch(() => ({}))
  const datasetKey = String(body?.datasetKey ?? "").trim()
  if (!datasetKey) return NextResponse.json({ error: "A dataset is required" }, { status: 400 })
  try {
    const analysis = await analyzeImport(tenantId, {
      datasetKey,
      headers: Array.isArray(body?.headers) ? body.headers : [],
      rows: Array.isArray(body?.rows) ? body.rows : [],
      mapping: body?.mapping && typeof body.mapping === "object" ? body.mapping : undefined,
      fileName: body?.fileName ?? null,
    })
    return NextResponse.json({ analysis })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
