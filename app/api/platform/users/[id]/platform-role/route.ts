import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { assignPlatformRole, RoleAssignmentError } from "@/lib/platform-roles"
import { isPlatformRole } from "@/lib/role-model"

/**
 * SPEC 3 — Assign a PLATFORM role to a user. Platform axis only.
 *
 * The escalation rules live in `canAssignPlatformRole` (enforced inside
 * `assignPlatformRole`): a caller can never grant above their own platform
 * level, and only a platform_super_admin can mint another super admin. A
 * customer tenant_admin can never reach this route because the guard consults
 * the platform axis exclusively.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

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
  if (!isPlatformRole(role)) {
    return NextResponse.json({ error: "Invalid platform role" }, { status: 400 })
  }

  try {
    await assignPlatformRole({ ...guard.ctx, email: guard.session.email }, targetUserId, role)
    return NextResponse.json({ ok: true, platformRole: role })
  } catch (err) {
    if (err instanceof RoleAssignmentError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: "Failed to assign platform role" }, { status: 500 })
  }
}
