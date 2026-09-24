import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { approveChangeRequest, rejectChangeRequest } from "@/lib/master-data"

/**
 * SPEC 91 — checker decision on a pending change request.
 * POST { decision: "approved" | "rejected", comment? }.
 *
 * The maker/checker split is enforced in the service: the requester can never
 * approve their own request, and approval applies the change to the canonical
 * SPEC 90 master only when it is effective now. Reaching this route already
 * proves tenant-admin authority, which satisfies the approver authority check.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await ctx.params
  const changeRequestId = Number(id)
  if (!Number.isFinite(changeRequestId)) {
    return NextResponse.json({ error: "Invalid change request id." }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const decision = String(body?.decision ?? "")
  const comment = body?.comment ? String(body.comment) : null
  const approver = { userId: guard.session.userId, isAdmin: true }

  try {
    if (decision === "approved") {
      const result = await approveChangeRequest(tenantId, changeRequestId, approver, comment)
      return NextResponse.json({ ok: true, ...result })
    }
    if (decision === "rejected") {
      const result = await rejectChangeRequest(tenantId, changeRequestId, approver, comment)
      return NextResponse.json({ ok: true, ...result })
    }
    return NextResponse.json({ error: 'decision must be "approved" or "rejected".' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
