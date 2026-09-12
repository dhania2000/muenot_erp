import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { attachLeadEvent } from "@/lib/sales/lead-lifecycle"
import { resolveCompanyId } from "@/lib/sales/company-master"

async function resolveLeadId(body: any): Promise<number | null> {
  if (body.lead_id) return Number(body.lead_id)
  if (!body.company_name) return null
  const rows = await query<any[]>(
    `SELECT id FROM sales_leads WHERE company_name = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [body.company_name],
  ).catch(() => [] as any[])
  return rows[0]?.id ?? null
}

export async function GET() {
  const session = await requireFeature("sales.view_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const quotations = await query(
    `SELECT q.*, u.name AS added_by_name
     FROM sales_quotations q
     LEFT JOIN users u ON u.id = q.added_by
     ORDER BY q.created_at DESC`,
  )
  return NextResponse.json({ quotations })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.company_name || !body.total_amount) {
    return NextResponse.json({ error: "Company name and amount are required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(quote_code, 4) AS UNSIGNED)), 0) + 1 AS next FROM sales_quotations",
  )
  const quoteCode = `MQ-${String(next).padStart(3, "0")}`

  const companyId = await resolveCompanyId({ company_id: body.company_id, company_name: body.company_name })

  const result = await query<any>(
    `INSERT INTO sales_quotations
     (quote_code, quote_date, company_name, company_id, contact_person, opportunity_name, total_amount,
      valid_until, status, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      quoteCode,
      new Date().toISOString().slice(0, 10),
      body.company_name,
      companyId,
      body.contact_person || null,
      body.opportunity_name || null,
      body.total_amount,
      body.valid_until || null,
      body.status || "Draft",
      session.userId,
    ],
  )

  const leadId = await resolveLeadId(body)
  if (leadId) {
    await attachLeadEvent({
      leadId,
      type: "quotation",
      title: `Quotation ${quoteCode} created`,
      body: `Amount ${body.total_amount}${body.status ? ` · ${body.status}` : ""}`,
      refType: "quotation",
      refId: result.insertId,
      actorId: session.userId,
    }).catch(() => {})
  }

  return NextResponse.json({ id: result.insertId, quote_code: quoteCode })
}
