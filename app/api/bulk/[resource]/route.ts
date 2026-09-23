import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { captureAuditContext } from "@/lib/audit-log-store"
import { BulkActionError } from "@/lib/bulk-actions/engine"
import { submitBulkAction } from "@/lib/bulk-actions/service"
import type { BulkActionKind } from "@/lib/bulk-actions/types"

/**
 * SPEC 85 — generic bulk-action submission. A single route dispatches every
 * registered resource by key. It validates + records a durable run, then either
 * runs the batch inline (small batches / exports) and returns the report, or
 * enqueues a background job and returns the run id for progress polling.
 *
 * All authorization (coarse feature gate + per-record scope) lives in the
 * service/engine; this route only resolves the session and shapes the response.
 */
export async function POST(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { resource } = await params
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 })
  }

  const auditContext = await captureAuditContext(request)

  try {
    const result = await submitBulkAction(
      {
        resourceKey: resource,
        action: (body as Record<string, unknown>).action as BulkActionKind,
        ids: (body as Record<string, unknown>).ids,
        value: (body as Record<string, unknown>).value,
        idempotencyKey:
          typeof (body as Record<string, unknown>).idempotencyKey === "string"
            ? ((body as Record<string, unknown>).idempotencyKey as string)
            : undefined,
      },
      session,
      auditContext,
    )

    // Export artifacts are returned to the caller directly as a downloadable file.
    if (result.mode === "completed" && result.report.export) {
      const artifact = result.report.export
      return new NextResponse(artifact.content, {
        status: 200,
        headers: {
          "Content-Type": artifact.mimeType,
          "Content-Disposition": `attachment; filename="${artifact.filename}"`,
          "X-Bulk-Run-Id": String(result.run.id),
        },
      })
    }

    if (result.mode === "queued") {
      return NextResponse.json(
        { mode: "queued", runId: result.run.id, status: result.run.status, total: result.run.total },
        { status: 202 },
      )
    }

    return NextResponse.json({
      mode: result.mode,
      runId: result.run.id,
      status: result.run.status,
      report: result.report,
    })
  } catch (error) {
    if (error instanceof BulkActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[api/bulk] unexpected error:", (error as Error).message)
    return NextResponse.json({ error: "Bulk action failed." }, { status: 500 })
  }
}
