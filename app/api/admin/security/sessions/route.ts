import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listActiveSessions, revokeAllSessionsForUser } from "@/lib/session-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sessions = await listActiveSessions(ctx.tenantId, ctx.session.sid)
  return NextResponse.json({ sessions })
}

/** "Sign out all sessions" — revokes every active session in the tenant except the caller's own. */
export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { userId?: number }
  if (body.userId) {
    const count = await revokeAllSessionsForUser(body.userId, {
      exceptSessionId: ctx.session.sid,
      reason: "admin_signed_out_user",
    })
    return NextResponse.json({ revoked: count })
  }

  const sessions = await listActiveSessions(ctx.tenantId)
  let revoked = 0
  const seen = new Set<number>()
  for (const s of sessions) {
    if (seen.has(s.userId)) continue
    seen.add(s.userId)
    revoked += await revokeAllSessionsForUser(s.userId, {
      exceptSessionId: ctx.session.sid,
      reason: "admin_signed_out_all",
    })
  }
  return NextResponse.json({ revoked })
}
