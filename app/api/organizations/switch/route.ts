import { type NextRequest, NextResponse } from "next/server"
import { getSession, createSessionToken, setSessionCookie, type SessionPayload } from "@/lib/auth"
import {
  isActiveMembership,
  getMembershipRole,
} from "@/lib/tenant-membership"
import { getStoredRoles, recordPlatformAudit } from "@/lib/platform-roles"
import { resolveTenantIdForUser } from "@/lib/tenant-service"
import { getNum } from "@/lib/settings/server"
import { type TenantRole } from "@/lib/role-model"

/**
 * Server-validated organization switcher.
 * ---------------------------------------------------------------------------
 * Sets (POST) / clears (DELETE) the `activeTenantId` carried in the user's
 * signed session token. This is the ONLY writer of that field, mirroring the
 * platform impersonation endpoint's re-mint pattern.
 *
 * SECURITY invariants:
 *   - A user can only switch into a tenant they hold a LIVE, ACTIVE membership
 *     in (`isActiveMembership`, re-checked here from the DB — never trusting the
 *     token or the request body's implied access).
 *   - Switching back to the home tenant clears `activeTenantId` entirely.
 *   - The new token's `tenantRole` hint reflects the membership role for the
 *     target org, but authorization is always re-resolved server-side; the hint
 *     is purely cosmetic.
 *   - `getSession()` independently re-validates `activeTenantId` against live
 *     membership on every request, so even a valid token falls closed to home
 *     the moment the membership is revoked.
 *   - Every switch/reset is written to the platform audit trail.
 */

async function remintSession(
  session: SessionPayload,
  activeTenantId: number | null,
  tenantRoleHint: TenantRole | null,
) {
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
      tenantRole: tenantRoleHint ?? roles?.tenantRole ?? session.tenantRole ?? "employee",
      // Switching never grants or preserves a platform impersonation.
      impersonatedTenantId: session.impersonatedTenantId ?? null,
      impersonationExpiresAt: session.impersonationExpiresAt ?? null,
      activeTenantId,
      // Preserve the server-side session record so revocation still applies.
      sid: session.sid,
    },
    durationSeconds,
  )
  await setSessionCookie(token, durationSeconds)
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

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

  const homeTenantId = session.tenantId ?? (await resolveTenantIdForUser(session.userId)) ?? null

  // Switching to the home tenant is a reset: clear the active override.
  if (tenantId === homeTenantId) {
    const homeRole = await getMembershipRole(session.userId, tenantId)
    await remintSession(session, null, homeRole)
    await recordPlatformAudit({
      actorUserId: session.userId,
      actorEmail: session.email,
      action: "organization_switch",
      targetTenantId: tenantId,
      detail: { to: "home" },
    })
    return NextResponse.json({ ok: true, activeTenantId: null })
  }

  // Re-validate membership from the DB — the authorization gate for switching.
  const allowed = await isActiveMembership(session.userId, tenantId)
  if (!allowed) {
    return NextResponse.json(
      { error: "You are not an active member of that organization" },
      { status: 403 },
    )
  }

  const tenantRole = await getMembershipRole(session.userId, tenantId)
  await remintSession(session, tenantId, tenantRole)
  await recordPlatformAudit({
    actorUserId: session.userId,
    actorEmail: session.email,
    action: "organization_switch",
    targetTenantId: tenantId,
    detail: { tenantRole },
  })

  return NextResponse.json({ ok: true, activeTenantId: tenantId })
}

export async function DELETE() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const previous = session.activeTenantId ?? null
  const homeTenantId = session.tenantId ?? (await resolveTenantIdForUser(session.userId)) ?? null
  const homeRole = homeTenantId ? await getMembershipRole(session.userId, homeTenantId) : null
  await remintSession(session, null, homeRole)

  if (previous != null && previous !== homeTenantId) {
    await recordPlatformAudit({
      actorUserId: session.userId,
      actorEmail: session.email,
      action: "organization_switch",
      targetTenantId: homeTenantId ?? undefined,
      detail: { to: "home", from: previous },
    })
  }

  return NextResponse.json({ ok: true, activeTenantId: null })
}
