import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureClientTables, getClient360, type ClientRecord } from "@/lib/clients-db"

/**
 * Client 360 read model. Aggregates the client's live Finance and Sales
 * footprint from the canonical source tables — nothing here is duplicated onto
 * the client record. Guarded by the Clients view feature.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureClientTables()
  const session = await requireFeature("clients.view_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const rows = await query<any[]>(
    `SELECT c.*, sc.company_name AS linked_company_name, sc.company_code,
            cv.customer_name AS finance_party_name, cv.invoice_email AS finance_invoice_email,
            am.name AS account_manager_name
       FROM clients c
       LEFT JOIN sales_companies sc ON sc.id = c.company_id
       LEFT JOIN customers_vendors cv ON cv.party_id = c.finance_party_id
       LEFT JOIN users am ON am.id = c.account_manager_id
      WHERE c.id = ? LIMIT 1`,
    [id],
  )
  const client = rows[0]
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

  const summary = await getClient360(client as ClientRecord)
  return NextResponse.json({ client, ...summary })
}
