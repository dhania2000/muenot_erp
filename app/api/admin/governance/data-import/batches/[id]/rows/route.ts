import { NextResponse } from "next/server"
import { stageBatchRows } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId } from "@/lib/data-import-batches-http"

// Upload one chunk of parsed rows. Chunks are keyed by startRow and inserted
// with INSERT IGNORE, so re-sending a chunk after a network failure is safe.

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON body is required" }, { status: 400 })
  try {
    const job = await stageBatchRows(g.ctx.tenantId, jobId, { startRow: body.startRow, rows: body.rows })
    return NextResponse.json({ job })
  } catch (err) {
    return batchErrorResponse(err)
  }
}
