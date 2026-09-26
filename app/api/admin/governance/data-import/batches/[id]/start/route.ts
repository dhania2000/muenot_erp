import { NextResponse } from "next/server"
import { startBatchImport } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId } from "@/lib/data-import-batches-http"

// Enqueue a validated import onto the shared background-job queue
// (`data.import_batch`). Re-submitting a queued/running job is a no-op.

export const runtime = "nodejs"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  try {
    return NextResponse.json({ job: await startBatchImport(g.ctx.tenantId, g.ctx.actor, jobId) }, { status: 202 })
  } catch (err) {
    return batchErrorResponse(err)
  }
}
