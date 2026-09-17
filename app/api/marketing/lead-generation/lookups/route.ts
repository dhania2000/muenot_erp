import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { FIELD_MAPPINGS, FIELD_TYPES, FORM_TYPES } from "@/lib/marketing/leadgen-db"

export async function GET() {
  const session = await requireFeature("marketing.lead_generation.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Employees who can own captured leads.
  const employees = await query<any[]>(
    `SELECT id, name FROM users WHERE status = 'active' ORDER BY name ASC`,
  ).catch(() => [] as any[])

  return NextResponse.json({
    employees,
    fieldMappings: FIELD_MAPPINGS,
    fieldTypes: FIELD_TYPES,
    formTypes: FORM_TYPES,
  })
}
