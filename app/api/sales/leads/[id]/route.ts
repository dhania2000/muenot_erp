import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

const HEALTH_SCORE: Record<string, number> = {
  New: 5,
  "Follow Up 1": 20,
  "Follow Up 2": 35,
  "In Discussion": 50,
  "Proposal Sent": 70,
  Ready: 85,
  Won: 100,
  Lost: 0,
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()

  const fields: string[] = []
  const values: any[] = []

  const allowed = [
    "contact_person",
    "contact_number",
    "email",
    "designation",
    "lead_source",
    "company_name",
    "industry",
    "website",
    "company_email",
    "country",
    "assigned_to",
    "status",
    "lead_status",
    "follow_up_date",
    "remarks",
    "lead_date",
  ]

  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = ?`)
      values.push(body[key] === "" ? null : body[key])
    }
  }

  if (body.status && body.status in HEALTH_SCORE) {
    fields.push("lead_health_score = ?")
    values.push(HEALTH_SCORE[body.status])
    fields.push("last_contact_date = NOW()")
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }

  const sql = `UPDATE sales_leads SET ${fields.join(", ")} WHERE id = ?`
  const sqlValues = [...values, id]

  try {
    await query(sql, sqlValues)
  } catch (error: any) {
    // Self-heal: older databases created before the `lead_status` migration
    // was run don't have the column yet, which throws ER_BAD_FIELD_ERROR
    // ("Unknown column 'lead_status'"). Add it on the fly and retry once
    // instead of failing the request.
    const missingColumn = error?.code === "ER_BAD_FIELD_ERROR" && "lead_status" in body
    if (!missingColumn) throw error

    await query(
      "ALTER TABLE sales_leads ADD COLUMN lead_status ENUM('Open','Won','Lost','Follow Up') NOT NULL DEFAULT 'Open' AFTER status",
    ).catch(() => {})
    await query("ALTER TABLE sales_leads ADD KEY idx_leads_lead_status (lead_status)").catch(() => {})
    await query("UPDATE sales_leads SET lead_status = 'Won' WHERE status = 'Won'").catch(() => {})
    await query("UPDATE sales_leads SET lead_status = 'Lost' WHERE status = 'Lost'").catch(() => {})
    await query(
      "UPDATE sales_leads SET lead_status = 'Follow Up' WHERE status IN ('Follow Up 1', 'Follow Up 2')",
    ).catch(() => {})

    await query(sql, sqlValues)
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await query("DELETE FROM sales_leads WHERE id = ?", [id])
  return NextResponse.json({ success: true })
}
