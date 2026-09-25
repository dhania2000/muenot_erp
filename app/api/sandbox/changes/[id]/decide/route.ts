import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { tenantAtLeast, toTenantRole } from "@/lib/role-model"
import { decideChange, SandboxError } from "@/lib/sandbox/service"

/**
 * Approve or reject a pending change through the approval engine. Tenant admins
 * may claim unresolved approval slots (isAdmin), mirroring the approvals inbox.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const changeId = Number(id)
  if (!Number.isInteger(changeId) || changeId <= 0) {
    return NextResponse.json({ error: "Invalid change id" }, { status: 400 })
  }
  const body = await request.json().catch(() => ({}))
  const action = body?.action === "reject" ? "reject" : body?.action === "approve" ? "approve" : null
  if (!action) return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })

  const role = toTenantRole(guard.ctx.tenantRole)
  const isAdmin = tenantAtLeast(role, "tenant_admin")
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const change = await decideChange(changeId, action, actor, { isAdmin, comment: body?.comment ?? null })
    return NextResponse.json({ change })
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error("[v0] sandbox decide error:", err)
    return NextResponse.json({ error: "Failed to decide change" }, { status: 500 })
  }
}
