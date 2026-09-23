import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deleteIpAllowlistEntry } from "@/lib/ip-allowlist-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  return { session, tenantId: tenant?.tenantId ?? null }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  await deleteIpAllowlistEntry(ctx.tenantId, Number(id))
  await recordSecurityEvent({
    tenantId: ctx.tenantId,
    category: "ip_allowlist",
    action: "range_removed",
    outcome: "deleted",
    actorUserId: ctx.session.userId,
    actorName: ctx.session.name,
    detail: { id: Number(id) },
  })
  return NextResponse.json({ ok: true })
}
