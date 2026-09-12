import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"

export async function GET(request: Request) {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()
  const url = new URL(request.url)
  const scope = url.searchParams.get("scope") || "all" // all | mine

  const params: any[] = []
  let where = "f.status = 'Open'"
  if (scope === "mine") {
    where += " AND f.assigned_to = ?"
    params.push(session.userId)
  }

  const followups = await query<any[]>(
    `SELECT f.*, l.lead_code, l.company_name, l.contact_person, l.contact_number, l.email,
            l.lead_status, u.name AS assigned_to_name,
            (f.due_at < NOW()) AS is_overdue
     FROM sales_lead_followups f
     JOIN sales_leads l ON l.id = f.lead_id
     LEFT JOIN users u ON u.id = f.assigned_to
     WHERE ${where}
     ORDER BY f.due_at ASC`,
    params,
  )
  return NextResponse.json({ followups })
}
