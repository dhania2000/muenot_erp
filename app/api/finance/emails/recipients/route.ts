import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"

/**
 * Slim customer/vendor list for the finance email composer's recipient picker.
 * Only returns parties that have a usable email address (official, invoice, or
 * alternate). Gated by the same feature that guards the emails page.
 */
export async function GET(request: NextRequest) {
  const session = await requireFeature("finance.emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const q = (request.nextUrl.searchParams.get("q") || "").trim()
  const where: string[] = [
    "(official_email IS NOT NULL AND official_email <> '' OR invoice_email IS NOT NULL AND invoice_email <> '' OR alternate_email IS NOT NULL AND alternate_email <> '')",
  ]
  const args: any[] = []
  if (q) {
    const like = `%${q}%`
    where.push(
      "(customer_name LIKE ? OR legal_name LIKE ? OR party_id LIKE ? OR official_email LIKE ? OR party_type LIKE ?)",
    )
    args.push(like, like, like, like, like)
  }

  const rows = await query<any[]>(
    `SELECT id, party_id, COALESCE(NULLIF(customer_name,''), legal_name) AS party_name,
            COALESCE(NULLIF(official_email,''), NULLIF(invoice_email,''), alternate_email) AS email,
            party_type, party_category, gstin
     FROM customers_vendors
     WHERE ${where.join(" AND ")}
     ORDER BY party_name ASC
     LIMIT 500`,
    args,
  )
  return NextResponse.json({ recipients: rows })
}
