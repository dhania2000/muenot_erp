import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, runAccrual, type Actor } from "@/lib/hr-leave"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_balances"))
  if (!canManage) return NextResponse.json({ error: "You do not have permission to run accrual." }, { status: 403 })

  await ensureLeaveSchema()
  const body = await request.json().catch(() => ({}))
  const year = Number(body.year) || new Date().getFullYear()

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const summary = await runAccrual(year, actor)
    return NextResponse.json({ ok: true, year, summary })
  } catch (error) {
    console.log("[v0] leave runAccrual failed", (error as Error).message)
    return NextResponse.json({ error: "Could not run accrual." }, { status: 500 })
  }
}
