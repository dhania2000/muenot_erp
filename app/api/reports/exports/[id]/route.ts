import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getLargeExportJob, getLargeExportDownloadLink } from "@/lib/reports/large-export-store"

export const runtime = "nodejs"

/** Poll one export job's status (with a signed link once it is ready). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const jobId = Number(id)
  if (!Number.isInteger(jobId) || jobId <= 0) return NextResponse.json({ error: "Invalid id." }, { status: 400 })

  const job = await getLargeExportJob(tenantId, jobId)
  if (!job) return NextResponse.json({ error: "Export not found." }, { status: 404 })
  const downloadPath = job.status === "completed" ? await getLargeExportDownloadLink(tenantId, jobId) : null
  return NextResponse.json({ job: { ...job, downloadPath } })
}
