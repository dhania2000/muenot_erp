import { NextResponse } from "next/server"
import { getBatchErrorRows, streamBatchErrorReport } from "@/lib/data-import-batches-store"
import { batchErrorResponse, batchImportGuard, parseJobId } from "@/lib/data-import-batches-http"

// Row-level error report. `?format=csv` streams the full report (formula-safe)
// without buffering 100k rows in memory; otherwise returns a keyset page.

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const jobId = parseJobId((await params).id)
  if (!jobId) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  const url = new URL(request.url)
  try {
    if (url.searchParams.get("format") === "csv") {
      const stream = await streamBatchErrorReport(g.ctx.tenantId, jobId)
      return new Response(stream, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="import-${jobId}-errors.csv"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      })
    }
    const afterRow = Number(url.searchParams.get("afterRow") ?? 0)
    const limit = Number(url.searchParams.get("limit") ?? 100)
    const page = await getBatchErrorRows(g.ctx.tenantId, jobId, {
      afterRow: Number.isFinite(afterRow) ? afterRow : 0,
      limit: Number.isFinite(limit) ? limit : 100,
    })
    return NextResponse.json(page)
  } catch (err) {
    return batchErrorResponse(err)
  }
}
