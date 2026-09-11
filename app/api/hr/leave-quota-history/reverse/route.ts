import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, reverseQuotaEvent, type Actor } from "@/lib/hr-leave"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_quota_history"))
  if (!canManage) return NextResponse.json({ error: "You do not have permission to reverse ledger events." }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const eventRef = String(body.event || body.quota_event_id || "").trim()
  if (!eventRef) return NextResponse.json({ error: "A ledger event id is required." }, { status: 400 })

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  try {
    const result = await reverseQuotaEvent(eventRef, actor, body.reason)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 })
    return NextResponse.json({ ok: true, quota_event_id: result.quotaEventId, reversal_of: result.reversalOf }, { status: 201 })
  } catch (error) {
    console.log("[v0] leave quota reversal failed", (error as Error).message)
    return NextResponse.json({ error: "Could not reverse the event." }, { status: 500 })
  }
}
