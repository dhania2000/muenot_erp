import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { inviteUser, listLifecycleUsers, listLifecycleEvents, LifecycleError } from "@/lib/user-lifecycle"

/**
 * Tenant user directory + invitation entry point.
 *
 * GET  → the full lifecycle directory for the caller's tenant, plus the most
 *        recent lifecycle audit events (for the console's activity tab).
 * POST → invite a new user (creates an `invited` account + single-use token).
 *
 * Both are gated by tenant-admin authority over the caller's EFFECTIVE tenant,
 * so a platform operator only reaches a customer's users while impersonating.
 */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const [users, events] = await Promise.all([
    listLifecycleUsers(tenantId),
    listLifecycleEvents(tenantId, { limit: 100 }),
  ])
  return NextResponse.json({ users, events })
}

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const result = await inviteUser(
      tenantId,
      {
        email: String(body?.email ?? ""),
        name: String(body?.name ?? ""),
        role: body?.role === "admin" ? "admin" : "employee",
        tenantRole: body?.tenantRole,
        designation: body?.designation ?? null,
        expiresInHours: body?.expiresInHours != null ? Number(body.expiresInHours) : undefined,
      },
      { userId: guard.session.userId, email: guard.session.email },
    )
    // The raw token is returned ONCE so the admin can hand off / copy the
    // invite link; only its hash is stored. In production this is also emailed.
    return NextResponse.json({ ok: true, user: result.user, inviteToken: result.token, expiresAt: result.expiresAt })
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/users] invite failed:", err)
    return NextResponse.json({ error: "Failed to invite user" }, { status: 500 })
  }
}
