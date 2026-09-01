import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

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

  const result = await query<any>(
    `INSERT INTO sales_quotations
     (quote_code, quote_date, company_name, contact_person, opportunity_name, total_amount,
      valid_until, status, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      quoteCode,
      new Date().toISOString().slice(0, 10),
      body.company_name,
      body.contact_person || null,
      body.opportunity_name || null,
      body.total_amount,
      body.valid_until || null,
      body.status || "Draft",
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, quote_code: quoteCode })
}
