import { NextResponse } from "next/server"
import { validateBatchImport } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId } from "@/lib/data-import-batches-http"

// Dry-run validation over every staged row: mapping, type checks, in-file and
// existing-record duplicate detection and formula neutralization. Writes only
// the per-row verdicts and a preview summary — no target-table changes.

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  try {
    return NextResponse.json({ job: await validateBatchImport(g.ctx.tenantId, jobId) })
  } catch (err) {
    return batchErrorResponse(err)
  }
}
