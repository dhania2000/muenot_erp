import { NextResponse } from "next/server"
import { rollbackBatchImport } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId } from "@/lib/data-import-batches-http"

// Safe rollback: deletes only the exact target-table ids recorded as inserted by
// this job, scoped to the caller's tenant. Refused while a worker is running.

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  try {
    return NextResponse.json({ job: await rollbackBatchImport(g.ctx.tenantId, g.ctx.actor, jobId) })
  } catch (err) {
    return batchErrorResponse(err)
  }
}
