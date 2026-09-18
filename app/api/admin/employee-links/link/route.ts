import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { LinkError, linkEmployeeToUser, unlinkEmployee } from "@/lib/employee-user-link"

/**
 * SPEC 15 — Link / unlink an employee to a login user.
 *
 * POST   { employeePk, userId } → create the one employee → one user link,
 *                                 then synchronize the user's access status.
 * DELETE { employeePk }         → remove the link, re-deriving access from any
 *                                 remaining employment records.
 */
async function resolve() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return { error: NextResponse.json({ error: guard.reason }, { status: guard.status }) }
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return { error: NextResponse.json({ error: "No tenant in context" }, { status: 403 }) }
  return { tenantId }
}

export async function POST(req: NextRequest) {
  const ctx = await resolve()
  if ("error" in ctx) return ctx.error

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const employeePk = Number(body?.employeePk)
  const userId = Number(body?.userId)
  if (!Number.isInteger(employeePk) || !Number.isInteger(userId)) {
    return NextResponse.json({ error: "employeePk and userId are required" }, { status: 400 })
  }

  try {
    await linkEmployeeToUser(ctx.tenantId, employeePk, userId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LinkError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/employee-links] link failed:", err)
    return NextResponse.json({ error: "Failed to link employee" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const ctx = await resolve()
  if ("error" in ctx) return ctx.error

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const employeePk = Number(body?.employeePk)
  if (!Number.isInteger(employeePk)) {
    return NextResponse.json({ error: "employeePk is required" }, { status: 400 })
  }

  try {
    await unlinkEmployee(ctx.tenantId, employeePk)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LinkError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/employee-links] unlink failed:", err)
    return NextResponse.json({ error: "Failed to unlink employee" }, { status: 500 })
  }
}
