import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { createLead, ensureLeadLifecycleSchema } from "@/lib/sales/lead-lifecycle"
import { resolveCompanyId } from "@/lib/sales/company-master"
import { scopeWhereForModule, mergeScopeIntoWhere, canCreateInModule } from "@/lib/permission-enforce"
import { dataScopeWhere, mergeDataScope } from "@/lib/data-scope"

export async function GET() {
  const session = await requireFeature("sales.view_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureLeadLifecycleSchema()

  // Record-level scope: an employee configured with "added" sees only leads
  // they created, "owned" only leads assigned to them, "both" either. Merged
  // into the base archived-filter WHERE clause.
  const scoped = await scopeWhereForModule(session, "sales.leads", "view", "sales_leads", "l")
  const base = mergeScopeIntoWhere("WHERE l.archived_at IS NULL", [], scoped)

  // data-level scope (self / team / entity / branch / all). ANDed on
  // top of the RBAC record scope: a rep sees only their own / their team's /
  // their assigned entity's leads. Unconfigured users / admins are unaffected.
  const dataScope = await dataScopeWhere(session, "sales.leads", "l")
  const { where, args } = mergeDataScope(base.where, base.args, dataScope)

  const leads = await query(
    `SELECT l.*, u.name AS assigned_to_name
     FROM sales_leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     ${where}
     ORDER BY l.created_at DESC`,
    args,
  )
  return NextResponse.json({ leads })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_leads")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  if (!(await canCreateInModule(session, "sales.leads"))) {
    return NextResponse.json({ error: "You do not have permission to create leads." }, { status: 403 })
  }

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
