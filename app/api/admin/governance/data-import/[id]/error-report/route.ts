import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getImportJobIssues } from "@/lib/data-import-store"
import { buildImportErrorCsv } from "@/lib/data-import-model"

// SPEC 74 — download the row-level error report for a completed job as CSV
// (Row, Type, Details). Tenant-scoped: a job from another tenant 404s.

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const jobId = Number(id)
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  const result = await getImportJobIssues(tenantId, jobId)
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const csv = buildImportErrorCsv(result.issues)
  const fileName = `import-${jobId}-errors.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
