import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { isAuditStream, parseExportRequest, isValidIdempotencyKey } from "@/lib/audit-streams-model"
import {
  createStreamExport,
  listStreamExports,
  listStreamRecords,
  platformStreamViewer,
} from "@/lib/audit-streams-store"
import { exportToCsv, streamErrorResponse } from "../../../admin/security/audit-streams-shared"

export const dynamic = "force-dynamic"

// Platform-facing separated audit streams (Spec47). Platform staff read the
// operator (platform) stream plus the cross-tenant billing/support projections
// they operate; ONLY a platform super admin can read the cross-tenant security
// stream or produce an unmasked export. A platform role never reaches a tenant's
// own business trail here — that requires audited impersonation. The customer
// `tenant` stream is unreadable from this route (canReadStream denies it).

function parseTenantFilter(url: URL): number | null {
  const raw = url.searchParams.get("tenantId")
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const viewer = platformStreamViewer(guard.ctx)
    const url = new URL(req.url)
    const streamParam = url.searchParams.get("stream") ?? "platform"
    if (!isAuditStream(streamParam)) return NextResponse.json({ error: "Unknown stream" }, { status: 400 })
    const records = await listStreamRecords(streamParam, viewer, {
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      limit: Number(url.searchParams.get("limit") ?? 200),
      filterTenantId: parseTenantFilter(url),
    })
    const exports = await listStreamExports(viewer, 50)
    return NextResponse.json({ stream: streamParam, records, exports })
  } catch (error) {
    return streamErrorResponse(error, "Unable to load audit stream")
  }
}

export async function POST(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const viewer = platformStreamViewer(guard.ctx)
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
      audit: { actorUserId: guard.session.userId, actorEmail: guard.session.email, actorName: guard.session.name, tenantId: request.tenantId },
    })

    const format = new URL(req.url).searchParams.get("format")
    if (format === "csv") {
      return new NextResponse(exportToCsv(result.records), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="platform-audit-${request.stream}-${result.id}.csv"`,
          "x-export-digest": result.digest,
        },
      })
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  } catch (error) {
    return streamErrorResponse(error, "Unable to create export")
  }
}
