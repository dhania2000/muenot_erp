import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { transferDataOwnership, LifecycleError } from "@/lib/user-lifecycle"

/**
 * Standalone data-ownership transfer (also runnable as part of
 * offboarding via PATCH deactivate). Reassigns the source user's owned records
 * to another user in the same tenant. Tenant-scoped and audited.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const fromUserId = Number(id)
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const toUserId = Number(body?.toUserId)
  if (!Number.isInteger(toUserId) || toUserId <= 0) {
    return NextResponse.json({ error: "A valid recipient user id is required" }, { status: 400 })
  }

  try {
    const transfer = await transferDataOwnership(tenantId, fromUserId, toUserId, {
      userId: guard.session.userId,
      email: guard.session.email,
    })
    return NextResponse.json({ ok: true, transfer })
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/users] ownership transfer failed:", err)
    return NextResponse.json({ error: "Failed to transfer ownership" }, { status: 500 })
  }
}
