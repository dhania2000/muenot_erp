import { type NextRequest, NextResponse } from "next/server"
import { getSession, createSessionToken, setSessionCookie, type SessionPayload } from "@/lib/auth"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getStoredRoles, recordPlatformAudit } from "@/lib/platform-roles"
import { getTenantById } from "@/lib/tenant-service"
import { getNum } from "@/lib/settings/server"
import {
  IMPERSONATION_LIMITS,
  computeImpersonationExpiry,
  isImpersonationWindowOpen,
  resolveImpersonationMinutes,
  validateImpersonationReason,
} from "@/lib/impersonation-window"

/**
 * Tenant impersonation (the ONLY audited path by which a Muenot
 * platform operator may act on a customer tenant's data).
 *
 * Design invariants that keep the platform/tenant boundary intact:
 *   - Only a platform operator (platform_staff or platform_super_admin) may
 *     start an impersonation; roles are re-resolved from the DB, never trusted
 *     from the token.
 *   - An operator can never impersonate their OWN home tenant and can only
 *     enter a tenant that exists and is active.
 *   - Spec47: every impersonation is time-boxed (5-120 min, default 30) and
 *     requires a written justification. The expiry is signed into the token;
 *     `getSession()` / `resolveRoleContext()` drop an elapsed window, so an
 *     operator can never linger inside a customer tenant.
 *   - Start, stop, denial and re-entry are written to `platform_admin_audit`
 *     (projected into the security audit stream).
 */

async function remintSession(
  session: SessionPayload,
  impersonatedTenantId: number | null,
  impersonationExpiresAt: number | null,
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
      tenantRole: roles?.tenantRole ?? session.tenantRole ?? "employee",
      impersonatedTenantId,
      impersonationExpiresAt,
      sid: session.sid,
    },
    durationSeconds,
  )
  await setSessionCookie(token, durationSeconds)
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  // getSession() has already cleared an elapsed window.
  const active = session.impersonatedTenantId != null
  return NextResponse.json({
    impersonating: active ? { tenantId: session.impersonatedTenantId } : null,
    expiresAt: active && session.impersonationExpiresAt ? new Date(session.impersonationExpiresAt).toISOString() : null,
  })
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
  const reason = validateImpersonationReason(body?.reason)
  if (!reason) {
    return NextResponse.json(
      {
        error: `A justification of ${IMPERSONATION_LIMITS.MIN_REASON}-${IMPERSONATION_LIMITS.MAX_REASON} characters is required`,
      },
      { status: 400 },
    )
  }
  const minutes = resolveImpersonationMinutes(body?.durationMinutes)

  const roles = await getStoredRoles(guard.ctx.userId)
  const deny = async (error: string, status: number, code: string) => {
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "impersonation_denied",
      targetTenantId: tenantId,
      detail: { code, reason },
    })
    return NextResponse.json({ error }, { status })
  }

  if (tenantId === roles?.tenantId) return deny("You cannot impersonate your own home tenant", 400, "own_tenant")

  const target = await getTenantById(tenantId)
  if (!target) return deny("Tenant not found", 404, "not_found")
  if (target.status !== "active") return deny("That tenant is not active", 409, "inactive")

  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const now = Date.now()
  // Idempotent: repeating the same start while the window is open does not
  // extend it (extension requires stopping and re-justifying).
  if (session.impersonatedTenantId === target.id && isImpersonationWindowOpen(session.impersonationExpiresAt, now)) {
    return NextResponse.json({
      ok: true,
      replayed: true,
      impersonating: { id: target.id, name: target.name, slug: target.slug },
      expiresAt: new Date(session.impersonationExpiresAt as number).toISOString(),
    })
  }

  const expiresAt = computeImpersonationExpiry(now, minutes)
  const previous = session.impersonatedTenantId ?? null
  await remintSession(session, target.id, expiresAt)
  if (previous != null && previous !== target.id) {
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "impersonation_stop",
      targetTenantId: previous,
      detail: { cause: "switched_tenant" },
    })
  }
  await recordPlatformAudit({
    actorUserId: guard.ctx.userId,
    actorEmail: guard.session.email,
    action: "impersonation_start",
    targetTenantId: target.id,
    detail: {
      tenant: target.name,
      slug: target.slug,
      reason,
      durationMinutes: minutes,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  })

  return NextResponse.json({
    ok: true,
    impersonating: { id: target.id, name: target.name, slug: target.slug },
    expiresAt: new Date(expiresAt).toISOString(),
  })
}

export async function DELETE() {
  // Leaving a customer tenant is never blocked; a no-op when not impersonating.
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const previous = session.impersonatedTenantId ?? null
  await remintSession(session, null, null)

  if (previous != null) {
    await recordPlatformAudit({
      actorUserId: session.userId,
      actorEmail: session.email,
      action: "impersonation_stop",
      targetTenantId: previous,
      detail: { cause: "operator_exit" },
    })
  }

  return NextResponse.json({ ok: true })
}
