import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { assignTenantRole, RoleAssignmentError } from "@/lib/platform-roles"
import { isTenantRole } from "@/lib/role-model"
import { revokeAllCredentials } from "@/lib/webauthn-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import {
  adminResetPassword,
  assignDepartment,
  deactivateUser,
  disableMfa,
  getLifecycleUser,
  grantTemporaryAccess,
  listLifecycleEvents,
  reactivateUser,
  rehireUser,
  revokeTemporaryAccess,
  suspendUser,
  LifecycleError,
} from "@/lib/user-lifecycle"

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** GET → one user's lifecycle record plus that user's audit trail. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const userId = parseId(id)
  if (userId == null) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })

  const user = await getLifecycleUser(tenantId, userId)
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  const events = await listLifecycleEvents(tenantId, { userId, limit: 100 })
  return NextResponse.json({ user, events })
}

/**
 * PATCH → run one lifecycle action on the user. The `action` discriminator maps
 * to a workflow in lib/user-lifecycle.ts; every branch re-checks tenant-admin
 * authority (via the guard above) and is tenant-scoped inside the lib.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const userId = parseId(id)
  if (userId == null) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const actor = { userId: guard.session.userId, email: guard.session.email }
  const action = String(body?.action ?? "")

  try {
    switch (action) {
      case "suspend": {
        const user = await suspendUser(tenantId, userId, body?.reason ?? null, actor)
        return NextResponse.json({ ok: true, user })
      }
      case "reactivate": {
        const user = await reactivateUser(tenantId, userId, actor)
        return NextResponse.json({ ok: true, user })
      }
      case "grant_temp_access": {
        const when = new Date(String(body?.expiresAt ?? ""))
        const user = await grantTemporaryAccess(tenantId, userId, when, actor)
        return NextResponse.json({ ok: true, user })
      }
      case "revoke_temp_access": {
        const user = await revokeTemporaryAccess(tenantId, userId, actor)
        return NextResponse.json({ ok: true, user })
      }
      case "deactivate": {
        const { user, transfer } = await deactivateUser(
          tenantId,
          userId,
          { reason: body?.reason ?? null, transferToUserId: body?.transferToUserId ?? null },
          actor,
        )
        return NextResponse.json({ ok: true, user, transfer })
      }
      case "rehire": {
        const user = await rehireUser(tenantId, userId, actor)
        return NextResponse.json({ ok: true, user })
      }
      case "reset_password": {
        const { tempPassword } = await adminResetPassword(tenantId, userId, actor)
        return NextResponse.json({ ok: true, tempPassword })
      }
      case "reset_mfa": {
        await disableMfa(tenantId, userId, actor)
        return NextResponse.json({ ok: true })
      }
      case "reset_security_keys": {
        // Admin recovery control: wipe every WebAuthn credential a user has
        // enrolled in THIS tenant (e.g. lost/stolen authenticator). Scoped to
        // (tenant, user) inside the store so it can never touch another
        // tenant's rows, and audited so the reset is attributable.
        const removed = await revokeAllCredentials(tenantId, userId)
        await recordSecurityEvent({
          tenantId,
          category: "access_policy",
          action: "webauthn_admin_reset",
          outcome: "revoked",
          actorUserId: guard.session.userId,
          actorName: guard.session.name,
          detail: { removed, subjectUserId: userId },
        })
        return NextResponse.json({ ok: true, removed })
      }
      case "assign_department": {
        const orgUnitId = Number(body?.orgUnitId)
        if (!Number.isInteger(orgUnitId) || orgUnitId <= 0) {
          return NextResponse.json({ error: "A valid department (org unit) id is required" }, { status: 400 })
        }
        await assignDepartment(
          tenantId,
          userId,
          orgUnitId,
          { title: body?.title ?? null, isPrimary: Boolean(body?.isPrimary) },
          actor,
        )
        const user = await getLifecycleUser(tenantId, userId)
        return NextResponse.json({ ok: true, user })
      }
      case "assign_role": {
        const role = body?.tenantRole
        if (!isTenantRole(role)) return NextResponse.json({ error: "Invalid tenant role" }, { status: 400 })
        await assignTenantRole({ ...guard.ctx, email: guard.session.email }, userId, tenantId, role)
        const user = await getLifecycleUser(tenantId, userId)
        return NextResponse.json({ ok: true, user })
      }
      default:
        return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    if (err instanceof RoleAssignmentError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/users] action failed:", action, err)
    return NextResponse.json({ error: "Failed to complete the requested action" }, { status: 500 })
  }
}
