import { NextResponse } from "next/server"
import { getBatchImport, getBatchImportHistory } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId } from "@/lib/data-import-batches-http"

// Job status + progress history (created, staged, validated, batch checkpoints,
// resumes, rollback). Cross-tenant ids resolve to 404.

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  try {
    const [job, history] = await Promise.all([
      getBatchImport(g.ctx.tenantId, jobId),
      getBatchImportHistory(g.ctx.tenantId, jobId),
    ])
    return NextResponse.json({ job, history })
  } catch (err) {
    return batchErrorResponse(err)
  }
}
