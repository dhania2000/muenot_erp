import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { isAuditStream, parseExportRequest, StreamAccessError, isValidIdempotencyKey } from "@/lib/audit-streams-model"
import {
  createStreamExport,
  listStreamExports,
  listStreamRecords,
  tenantStreamViewer,
} from "@/lib/audit-streams-store"
import { exportToCsv, streamErrorResponse } from "../audit-streams-shared"

export const dynamic = "force-dynamic"

// Tenant-facing separated audit streams (Spec47). A tenant admin reads their
// OWN tenant/billing/support/security projections; the platform stream and other
// tenants' rows are never reachable here (enforced by requireTenantAdmin + the
// tenant viewer, which pins tenant_id to the session tenant).

export async function GET(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const viewer = tenantStreamViewer(guard.ctx)
    const url = new URL(req.url)
    const streamParam = url.searchParams.get("stream") ?? "tenant"
    if (!isAuditStream(streamParam)) return NextResponse.json({ error: "Unknown stream" }, { status: 400 })
    const records = await listStreamRecords(streamParam, viewer, {
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      limit: Number(url.searchParams.get("limit") ?? 200),
    })
    const exports = await listStreamExports(viewer, 50)
    return NextResponse.json({ stream: streamParam, records, exports })
  } catch (error) {
    return streamErrorResponse(error, "Unable to load audit stream")
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const viewer = tenantStreamViewer(guard.ctx)
    const body = await req.json().catch(() => ({}))
    const request = parseExportRequest(body, viewer)

    const headerKey = req.headers.get("idempotency-key")
    const bodyKey = typeof (body as { idempotencyKey?: unknown }).idempotencyKey === "string" ? (body as { idempotencyKey: string }).idempotencyKey : null
    const idempotencyKey = headerKey || bodyKey
    if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
      return NextResponse.json({ error: "Invalid idempotency key" }, { status: 400 })
    }

    const result = await createStreamExport(viewer, request, {
      actorUserId: guard.session.userId,
      actorEmail: guard.session.email,
      idempotencyKey,
      audit: { actorUserId: guard.session.userId, actorEmail: guard.session.email, actorName: guard.session.name, tenantId: viewer.tenantId },
    })

    const format = new URL(req.url).searchParams.get("format")
    if (format === "csv") {
      return new NextResponse(exportToCsv(result.records), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="audit-${request.stream}-${result.id}.csv"`,
          "x-export-digest": result.digest,
        },
      })
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  } catch (error) {
    return streamErrorResponse(error, "Unable to create export")
  }
}
