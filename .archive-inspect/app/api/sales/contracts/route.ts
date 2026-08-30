import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const contracts = await query(
    `SELECT c.*, u.name AS added_by_name
     FROM sales_contracts c
     LEFT JOIN users u ON u.id = c.added_by
     ORDER BY c.created_at DESC`,
  )
  return NextResponse.json({ contracts })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.company_name || !body.value) {
    return NextResponse.json({ error: "Company name and value are required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(contract_code, 4) AS UNSIGNED)), 0) + 1 AS next FROM sales_contracts",
  )
  const contractCode = `CT-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_contracts
     (contract_code, contract_date, company_name, start_date, end_date, value, contract_type,
      status, signed_by_client, signed_by_company, notes, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      contractCode,
      new Date().toISOString().slice(0, 10),
      body.company_name,
      body.start_date || null,
      body.end_date || null,
      body.value,
      body.contract_type || null,
      body.status || "Draft",
      body.signed_by_client || null,
      body.signed_by_company || null,
      body.notes || null,
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, contract_code: contractCode })
}
