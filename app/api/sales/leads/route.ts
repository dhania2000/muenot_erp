import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { createLead, ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"
import { resolveCompanyId } from "@/lib/sales/company-master"

export async function GET() {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()
  const leads = await query(
    `SELECT l.*, u.name AS assigned_to_name
     FROM sales_leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.archived_at IS NULL
     ORDER BY l.created_at DESC`,
  )
  return NextResponse.json({ leads })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const { contact_person, company_name } = body
  if (!contact_person || !company_name) {
    return NextResponse.json({ error: "Contact person and company name are required" }, { status: 400 })
  }

  try {
    if (!body.company_id) {
      body.company_id = await resolveCompanyId({ company_name })
    }
    const created = await createLead(body, session.userId)
    return NextResponse.json(created)
  } catch (error) {
    console.error("[lead-save] database insert failed", error)
    return NextResponse.json(
      { error: "Unable to save lead. Please verify the database migration is applied." },
      { status: 500 },
    )
  }
}
