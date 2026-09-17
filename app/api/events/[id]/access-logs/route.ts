import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureEventsAccessSchema } from "@/lib/events-access"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEventsAccessSchema()

  const id = Number((await params).id)
  const sp = request.nextUrl.searchParams
  const where = ["event_id = ?"]
  const args: unknown[] = [id]

  const result = sp.get("result")?.trim()
  if (result) {
    where.push("result = ?")
    args.push(result)
  }
  const q = sp.get("q")?.trim()
  if (q) {
    where.push("(employee_name LIKE ? OR reason LIKE ?)")
    args.push(`%${q}%`, `%${q}%`)
  }
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 200))

  const logs = await query<any[]>(
    `SELECT * FROM event_access_logs WHERE ${where.join(" AND ")} ORDER BY scan_time DESC LIMIT ${limit}`,
    args,
  )
  return NextResponse.json({ logs })
}
