import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { resolveExportDownload } from "@/lib/data-export-store"
import { recordAuditLog } from "@/lib/audit-log-store"

// SPEC 73 — secure export download. Access is permission-checked AT ACCESS TIME
// on TWO independent layers:
//   1. a live tenant-admin SESSION scoped to the owning tenant, and
//   2. an HMAC token bound to the job + tenant + a per-job salt + an expiry.
// Either failing (wrong tenant, tampered/expired link) denies the download. The
// access itself is written to the immutable audit log.

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const jobId = Number(id)
  const url = new URL(request.url)
  const exp = url.searchParams.get("exp")
  const sig = url.searchParams.get("sig")

  const result = await resolveExportDownload(tenantId, jobId, exp, sig)
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status })
  }

  await recordAuditLog({
    action: "data_export.download",
    entityType: "data_export_job",
    entityId: jobId,
    entityLabel: result.fileName,
    context: {
      tenantId,
      actorUserId: guard.session.userId,
      actorName: guard.session.name ?? null,
      actorEmail: guard.session.email ?? null,
      actorRole: guard.ctx.tenantRole,
    },
  })

  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.fileName.replace(/"/g, "")}"`,
      "Content-Length": String(result.bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
