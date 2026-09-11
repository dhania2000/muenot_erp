import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmployeeEventsSchema } from "@/lib/hr-employee-events"

// Recent bulk-import runs, newest first, for the import-history panel.
export async function GET() {
  const session = await requireFeature("hr.view_employees")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureEmployeeEventsSchema()

  const rows = await query<any[]>(
    `SELECT id, file_name, total_rows, imported, failed, skipped, errors, actor_name, created_at
       FROM hr_employee_imports ORDER BY created_at DESC, id DESC LIMIT 50`,
  )

  const runs = rows.map((row) => ({
    ...row,
    errors: typeof row.errors === "string" ? safeParse(row.errors) : (row.errors ?? null),
  }))

  return NextResponse.json({ runs })
}

function safeParse(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
