import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmployeeEventsSchema } from "@/lib/hr-employee-events"

// Returns the unified event log for one employee — powers both the activity
// Timeline and the Audit trail on the profile.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("hr.view_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const { id } = await params
  const rows = await query<any[]>(
    `SELECT id, event_type, summary, changes, actor_id, actor_name, created_at
       FROM hr_employee_events
      WHERE employee_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 500`,
    [id],
  )

  // JSON columns come back parsed from mysql2, but tolerate string form too.
  const events = rows.map((row) => ({
    ...row,
    changes:
      typeof row.changes === "string" ? safeParse(row.changes) : (row.changes ?? null),
  }))

  return NextResponse.json({ events })
}

function safeParse(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
