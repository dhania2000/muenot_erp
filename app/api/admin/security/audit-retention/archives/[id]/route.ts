import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getArchiveExport } from "@/lib/audit-retention"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import type { AuditEntry } from "@/lib/audit-log-store"

export const dynamic = "force-dynamic"

function csvCell(value: unknown): string {
  if (value == null) return ""
  const s = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(entries: AuditEntry[]): string {
  const header = [
    "id", "created_at", "request_id", "tenant_id", "actor_user_id", "actor_name", "actor_email",
    "actor_role", "session_id", "ip_address", "user_agent", "action", "entity_type", "entity_id",
    "entity_label", "result", "before", "after", "metadata", "integrity_hash",
  ]
  const lines = [header.join(",")]
  for (const e of entries) {
    lines.push(
      [
        e.id, e.createdAt, e.requestId, e.tenantId, e.actorUserId, e.actorName, e.actorEmail,
        e.actorRole, e.sessionId, e.ipAddress, e.userAgent, e.action, e.entityType, e.entityId,
        e.entityLabel, e.result, e.before, e.after, e.metadata, e.integrityHash,
      ].map(csvCell).join(","),
    )
  }
  return lines.join("\n")
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const batchId = Number(id)
  if (!Number.isFinite(batchId)) return NextResponse.json({ error: "Invalid archive id" }, { status: 400 })

  const format = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "json"

  try {
    const exported = await getArchiveExport(tenantId, batchId)
    if (!exported) return NextResponse.json({ error: "Archive not found" }, { status: 404 })

    await recordAuditLogFromRequest(req, {
      action: "audit_retention.archive_export",
      result: "success",
      entityType: "audit_archive_batch",
      entityId: exported.batch.id,
      entityLabel: `Archive ${exported.batch.batchUuid}`,
      metadata: { format, entryCount: exported.batch.entryCount, sealValid: exported.sealValid },
      context: {
        tenantId,
        actorUserId: guard.session.userId,
        actorName: guard.session.name,
        actorEmail: guard.session.email,
      },
    })

    const stamp = new Date().toISOString().slice(0, 10)
    if (format === "csv") {
      return new NextResponse(toCsv(exported.entries), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-archive-${exported.batch.id}-${stamp}.csv"`,
          "X-Audit-Seal-Valid": String(exported.sealValid),
        },
      })
    }

    return new NextResponse(
      JSON.stringify({ batch: exported.batch, sealValid: exported.sealValid, entries: exported.entries }, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-archive-${exported.batch.id}-${stamp}.json"`,
          "X-Audit-Seal-Valid": String(exported.sealValid),
        },
      },
    )
  } catch (error) {
    console.error("[audit-retention] export failed", error)
    return NextResponse.json({ error: "Unable to export archive" }, { status: 500 })
  }
}
