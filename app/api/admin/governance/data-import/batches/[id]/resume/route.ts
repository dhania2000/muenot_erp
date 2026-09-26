import { NextResponse } from "next/server"
import { resumeBatchImport } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId, readIdempotencyKey } from "@/lib/data-import-batches-http"

// Resume a failed/paused import from its last committed batch checkpoint.
// Requires an Idempotency-Key so a double-click never enqueues two workers.

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const idempotencyKey = readIdempotencyKey(request, body)
  if (!idempotencyKey) {
    return NextResponse.json({ error: "An Idempotency-Key (8-120 url-safe characters) is required" }, { status: 400 })
  }
  try {
    const job = await resumeBatchImport(g.ctx.tenantId, g.ctx.actor, jobId, idempotencyKey)
    return NextResponse.json({ job }, { status: 202 })
  } catch (err) {
    return batchErrorResponse(err)
  }
}
