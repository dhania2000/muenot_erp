import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import { presenceForUsers } from "@/lib/calls-core"

export const dynamic = "force-dynamic"

/**
 * GET /api/calls/presence?employeeIds=1,2,3 — live presence for a set of HR
 * Employee Master records (Phase 3/78). Online/offline is derived from the
 * heartbeat, in_call from active sessions, dnd from the opt-in flag. Employees
 * without a login account resolve to "offline". No independent employee status
 * master is maintained (Phase 41).
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const raw = new URL(request.url).searchParams.get("employeeIds") || ""
  const employeeIds = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 200)
  if (!employeeIds.length) return NextResponse.json({ presence: {} })

  // Map employee ids -> login user ids (HR Employee Master is the source).
  const rows = await query<any[]>(
    `SELECT id, user_id FROM hr_employees WHERE id IN (${employeeIds.map(() => "?").join(",")})`,
    employeeIds,
  )
  const empToUser = new Map<number, number>()
  const userIds: number[] = []
  for (const r of rows) {
    if (r.user_id) {
      empToUser.set(Number(r.id), Number(r.user_id))
      userIds.push(Number(r.user_id))
    }
  }
  const byUser = await presenceForUsers(userIds)

  const presence: Record<string, string> = {}
  for (const empId of employeeIds) {
    const uid = empToUser.get(empId)
    presence[empId] = uid ? byUser.get(uid) || "offline" : "offline"
  }
  return NextResponse.json({ presence })
}
