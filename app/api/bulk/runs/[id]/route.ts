import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getBulkRun } from "@/lib/bulk-actions/runs-store"

/**
 * bulk run progress + partial-failure report. Polled by the client
 * after a large batch is queued. A run is only visible to the tenant that owns
 * it, so a leaked run id from another tenant reads as not found.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const runId = Number(id)
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "Invalid run id." }, { status: 400 })
  }

  const run = await getBulkRun(runId)
  if (!run || run.tenantId !== (session.tenantId ?? 0)) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 })
  }

  return NextResponse.json({
    runId: run.id,
    resource: run.resourceKey,
    action: run.action,
    status: run.status,
    total: run.total,
    processed: run.processed,
    succeeded: run.succeeded,
    failed: run.failed,
    skipped: run.skipped,
    error: run.error,
    // The per-record report is present once the run reaches a terminal state.
    report: run.report,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  })
}
