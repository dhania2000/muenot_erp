import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { syncAccessStatusForUser, syncAllAccessStatuses } from "@/lib/employee-user-link"

/**
 * Access-status synchronization.
 *
 * POST { userId } → re-derive one login's access status from its employment.
 * POST {}         → re-derive every employment-governed login in the tenant.
 * Service accounts and employee-less logins are always left untouched.
 */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  try {
    if (body?.userId != null) {
      const userId = Number(body.userId)
      if (!Number.isInteger(userId)) {
        return NextResponse.json({ error: "userId must be an integer" }, { status: 400 })
      }
      const result = await syncAccessStatusForUser(tenantId, userId)
      return NextResponse.json({ ok: true, result })
    }
    const summary = await syncAllAccessStatuses(tenantId)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error("[admin/employee-links] sync failed:", err)
    return NextResponse.json({ error: "Failed to synchronize access status" }, { status: 500 })
  }
}
