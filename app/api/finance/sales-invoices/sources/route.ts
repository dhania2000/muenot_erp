import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { listSourcesForClient, resolveSource, creditProfile, type SourceKind } from "@/lib/sales-invoice-sources"

/**
 * Source-document + credit lookups for the Sales Invoice form.
 *
 *   GET ?client_name=Acme                 → { contracts, quotations, projects, credit }
 *   GET ?resolve=1&kind=contract&id=12     → { source } (auto-fill + billing status)
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const p = req.nextUrl.searchParams

  if (p.get("resolve")) {
    const kind = p.get("kind") as SourceKind
    const id = p.get("id") || ""
    if (!["contract", "quotation", "project"].includes(kind) || !id) {
      return NextResponse.json({ error: "kind and id are required" }, { status: 400 })
    }
    const excludeParam = p.get("exclude_invoice_pk")
    const source = await resolveSource(kind, id, excludeParam ? Number(excludeParam) : undefined)
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 })
    return NextResponse.json({ source })
  }

  const clientName = p.get("client_name") || ""
  if (!clientName) return NextResponse.json({ contracts: [], quotations: [], projects: [], credit: null })

  const [sources, limitRow] = await Promise.all([
    listSourcesForClient(clientName),
    query(
      `SELECT credit_limit FROM customers_vendors WHERE customer_name = ? OR legal_name = ? LIMIT 1`,
      [clientName, clientName],
    ).catch(() => [] as any[]) as Promise<any[]>,
  ])

  const limit = limitRow?.[0]?.credit_limit != null ? Number(limitRow[0].credit_limit) : null
  const credit = await creditProfile(clientName, limit)

  return NextResponse.json({ ...sources, credit })
}
