import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

const HEALTH_SCORE: Record<string, number> = {
  New: 5,
  Qualified: 25,
  "Follow Up 1": 20,
  "Follow Up 2": 35,
  "Follow Up 3": 40,
  "Follow Up 4": 45,
  "Follow Up 5": 50,
  "Follow Up 6": 55,
  "Follow Up 7": 60,
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
    "source_url",
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
    const invalidStatusEnum =
      (error?.code === "WARN_DATA_TRUNCATED" || error?.code === "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD") &&
      "status" in body

    if (!missingColumn && !invalidStatusEnum) throw error

    if (missingColumn) {
      await query(
        "ALTER TABLE sales_leads ADD COLUMN lead_status ENUM('Open','Won','Lost','Follow Up') NOT NULL DEFAULT 'Open' AFTER status",
      ).catch(() => {})
      await query("ALTER TABLE sales_leads ADD KEY idx_leads_lead_status (lead_status)").catch(() => {})
      await query("UPDATE sales_leads SET lead_status = 'Won' WHERE status = 'Won'").catch(() => {})
      await query("UPDATE sales_leads SET lead_status = 'Lost' WHERE status = 'Lost'").catch(() => {})
      await query(
        "UPDATE sales_leads SET lead_status = 'Follow Up' WHERE status IN ('Follow Up 1', 'Follow Up 2')",
      ).catch(() => {})
    }

    if (invalidStatusEnum) {
      await query(
        "ALTER TABLE sales_leads MODIFY `status` ENUM('New','Qualified','Follow Up 1','Follow Up 2','Follow Up 3','Follow Up 4','Follow Up 5','Follow Up 6','Follow Up 7','In Discussion','Proposal Sent','Ready','Won','Lost') NOT NULL DEFAULT 'New'",
      ).catch(() => {})
    }

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
