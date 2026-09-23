import { type NextRequest, NextResponse } from "next/server"
import { getSession, createSessionToken, setSessionCookie, type SessionPayload } from "@/lib/auth"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getStoredRoles, recordPlatformAudit } from "@/lib/platform-roles"
import { getTenantById } from "@/lib/tenant-service"
import { getNum } from "@/lib/settings/server"

/**
 * Tenant impersonation (the ONLY audited path by which a Muenot
 * platform operator may act on a customer tenant's data).
 *
 * Design invariants that keep the platform/tenant boundary intact:
 *   - Only a platform operator (platform_staff or platform_super_admin) may
 *     start an impersonation; roles are re-resolved from the DB, never trusted
 *     from the token.
 *   - An operator can never impersonate their OWN home tenant (that would be a
 *     no-op that only muddies the audit trail) and can only enter a tenant that
 *     exists and is active.
 *   - The impersonation is carried ONLY in the freshly-minted, signed session
 *     cookie. `resolveRoleContext`/`canActOnTenant` then cap the operator at
 *     delegated tenant_admin authority — never tenant_owner — so impersonation
 *     can never delete a tenant or transfer ownership.
 *   - Both entering and leaving are written to `platform_admin_audit`.
 */

/** Re-mint the caller's session cookie with a new impersonation target. */
async function remintSession(session: SessionPayload, impersonatedTenantId: number | null) {
  // Re-read the role axes from the source of truth so the new token reflects
  // the operator's current authority, not whatever a stale token carried.
  const roles = await getStoredRoles(session.userId)
  const timeoutMinutes = await getNum("security.session_timeout", 480)
  const durationSeconds = Math.max(60, Math.round(timeoutMinutes * 60))
  const token = await createSessionToken(
    {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      tenantId: session.tenantId,
      platformRole: roles?.platformRole ?? session.platformRole ?? "none",
      tenantRole: roles?.tenantRole ?? session.tenantRole ?? "employee",
      impersonatedTenantId,
    },
    durationSeconds,
  )
  await setSessionCookie(token, durationSeconds)
}

export async function POST(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const tenantId = Number(body?.tenantId)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "A valid tenantId is required" }, { status: 400 })
  }

  // Re-resolving roles here (not trusting the token) is what enforces that only
  // a genuine platform operator can enter a tenant.
  const roles = await getStoredRoles(guard.ctx.userId)
  if (tenantId === roles?.tenantId) {
    return NextResponse.json(
      { error: "You cannot impersonate your own home tenant" },
      { status: 400 },
    )
  }

  const target = await getTenantById(tenantId)
  if (!target) return NextResponse.json({ error: "Tenant not found" }, { status: 404 })
  if (target.status !== "active") {
    return NextResponse.json({ error: "That tenant is not active" }, { status: 409 })
  }

  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  await remintSession(session, target.id)
  await recordPlatformAudit({
    actorUserId: guard.ctx.userId,
    actorEmail: guard.session.email,
    action: "impersonation_start",
    targetTenantId: target.id,
    detail: { tenant: target.name, slug: target.slug },
  })

  return NextResponse.json({
    ok: true,
    impersonating: { id: target.id, name: target.name, slug: target.slug },
  })
}

export async function DELETE() {
  // Anyone with a session may drop an impersonation (fail-safe: leaving a
  // customer tenant should never be blocked). If the caller is not actually
  // impersonating, this is an idempotent no-op.
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const previous = session.impersonatedTenantId ?? null
  await remintSession(session, null)

  if (previous != null) {
    await recordPlatformAudit({
      actorUserId: session.userId,
      actorEmail: session.email,
      action: "impersonation_stop",
      targetTenantId: previous,
    })
  }

  return NextResponse.json({ ok: true })
}
