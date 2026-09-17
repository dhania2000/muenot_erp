import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { assignTenantRole, RoleAssignmentError } from "@/lib/platform-roles"
import { isTenantRole } from "@/lib/role-model"

/**
 * SPEC 3 — Assign a TENANT role to a user within the caller's own tenant.
 *
 * The role is always applied to the caller's EFFECTIVE tenant (their home
 * tenant, or the customer tenant they are actively impersonating). The
 * escalation rules live in `canAssignTenantRole` (enforced inside
 * `assignTenantRole`): a caller can never grant above their own tenant role,
 * `assignTenantRole` refuses to move a user across tenants, and tenant_owner
 * can only be conferred by a real owner — never via impersonation. A platform
 * operator who is NOT impersonating has no tenant authority here at all.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const target = effectiveTenantId(guard.ctx)
  if (target == null) {
    return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  }

  const { id } = await params
  const targetUserId = Number(id)
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const role = body?.role
  if (!isTenantRole(role)) {
    return NextResponse.json({ error: "Invalid tenant role" }, { status: 400 })
  }

  try {
    await assignTenantRole({ ...guard.ctx, email: guard.session.email }, targetUserId, target, role)
    return NextResponse.json({ ok: true, tenantRole: role })
  } catch (err) {
    if (err instanceof RoleAssignmentError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: "Failed to assign tenant role" }, { status: 500 })
  }
}
