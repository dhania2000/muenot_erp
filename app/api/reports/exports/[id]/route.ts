import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getLargeExportJob, getLargeExportDownloadLink, cancelLargeExportJob } from "@/lib/reports/large-export-store"

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

/** Cancel a queued or running export. Repeated calls are a no-op. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const jobId = Number(id)
  if (!Number.isInteger(jobId) || jobId <= 0) return NextResponse.json({ error: "Invalid id." }, { status: 400 })

  const { job, changed } = await cancelLargeExportJob(tenantId, jobId, {
    userId: guard.ctx.userId,
    role: guard.ctx.tenantRole,
    name: guard.session.name,
    email: guard.session.email,
  })
  if (!job) return NextResponse.json({ error: "Export not found." }, { status: 404 })
  return NextResponse.json({ job, changed })
}
