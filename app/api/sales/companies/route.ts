import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { createCompany, ensureCompanyMasterSchema, DuplicateCompanyError } from "@/lib/sales/company-master"
import { scopeWhereForModule, canCreateInModule } from "@/lib/permission-enforce"

export async function GET(request: Request) {
  const session = await requireFeature("sales.view_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureCompanyMasterSchema()
  const includeArchived = new URL(request.url).searchParams.get("archived") === "1"

  const where: string[] = [includeArchived ? "1=1" : "c.archived_at IS NULL"]
  const args: any[] = []
  // Record-level scope: an employee with "added"/"owned" only sees their rows.
  const scoped = await scopeWhereForModule(session, "sales.companies", "view", "sales_companies", "c")
  if (scoped) {
    where.push(scoped.sql)
    args.push(...scoped.params)
  }

  const companies = await query(
    `SELECT c.*, u.name AS assigned_to_name,
            (SELECT COUNT(*) FROM sales_leads l
              WHERE l.archived_at IS NULL AND (l.company_id = c.id OR (l.company_id IS NULL AND l.company_name = c.company_name))) AS lead_count
     FROM sales_companies c
     LEFT JOIN users u ON u.id = c.assigned_to
     WHERE ${where.join(" AND ")}
     ORDER BY c.created_at DESC`,
    args,
  )
  return NextResponse.json({ companies })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!(await canCreateInModule(session, "sales.companies"))) {
    return NextResponse.json({ error: "You do not have permission to add companies." }, { status: 403 })
  }

  const body = await request.json()
  if (!body.company_name) {
    return NextResponse.json({ error: "Company name is required" }, { status: 400 })
  }

  try {
    const created = await createCompany(body, session.userId, { allowDuplicate: body.allow_duplicate === true })
    return NextResponse.json(created)
  } catch (error) {
    if (error instanceof DuplicateCompanyError) {
      return NextResponse.json({ error: error.message, duplicates: error.duplicates }, { status: 409 })
    }
    console.error("[company-save] insert failed", error)
    return NextResponse.json({ error: "Unable to save company." }, { status: 500 })
  }
}
