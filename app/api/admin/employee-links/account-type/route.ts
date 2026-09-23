import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { LinkError, setUserAccountType } from "@/lib/employee-user-link"

/**
 * Flag a login as a `service` account (intentionally employee-less)
 * or back to a `person`. Marking a login with linked employees as a service
 * account is rejected by the DB layer.
 */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const userId = Number(body?.userId)
  const accountType = body?.accountType === "service" ? "service" : body?.accountType === "person" ? "person" : null
  if (!Number.isInteger(userId) || !accountType) {
    return NextResponse.json({ error: "userId and a valid accountType are required" }, { status: 400 })
  }

  try {
    await setUserAccountType(tenantId, userId, accountType)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LinkError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/employee-links] account-type failed:", err)
    return NextResponse.json({ error: "Failed to update account type" }, { status: 500 })
  }
}
