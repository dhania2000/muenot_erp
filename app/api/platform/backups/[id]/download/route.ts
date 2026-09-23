import { NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordAuditLog } from "@/lib/audit-log-store"
import { getBackupDownload } from "@/lib/backup/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Download the DECRYPTED artifact of a completed backup for a real restore.
 * Platform-super-admin only and audited — the plaintext leaves the vault only
 * for an authorized operator.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const runId = Number(id)
  const tenantIdRaw = req.nextUrl.searchParams.get("tenantId")
  const tenantId = tenantIdRaw && Number(tenantIdRaw) > 0 ? Number(tenantIdRaw) : null
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "A valid backup run id is required" }, { status: 400 })
  }

  const result = await getBackupDownload(tenantId, runId).catch(() => null)
  if (!result) return NextResponse.json({ error: "Backup not available" }, { status: 404 })

  await recordAuditLog({
    action: "backup.download",
    entityType: "backup_run",
    entityId: runId,
    entityLabel: result.fileName,
    context: { tenantId, actorUserId: guard.session.userId, actorName: guard.session.name, actorEmail: guard.session.email },
  })

  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Content-Length": String(result.bytes.length),
      "Cache-Control": "no-store",
    },
  })
}
