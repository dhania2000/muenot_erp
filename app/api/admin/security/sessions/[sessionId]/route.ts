import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { revokeSession, listActiveSessions } from "@/lib/session-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { sessionId } = await params

  // Scope the target to the caller's tenant so an admin can't blind-revoke a
  // session id belonging to another tenant.
  const sessions = await listActiveSessions(ctx.tenantId)
  const target = sessions.find((s) => s.sessionId === sessionId)
  if (!target) return NextResponse.json({ error: "Session not found" }, { status: 404 })

  await revokeSession(sessionId, ctx.session.sid === sessionId ? "self_logout" : "admin_revoked")
  return NextResponse.json({ ok: true })
}
