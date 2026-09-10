import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getSettings } from "@/lib/settings/server"
import {
  buildSalesInvoicePdf,
  companyFromSettings,
  type InvoiceBank,
  type PartyLike,
} from "@/lib/finance-invoice-pdf"

export const runtime = "nodejs"

/** Load the primary (or first) bank account to print on the invoice. */
async function loadBank(): Promise<InvoiceBank> {
  try {
    const rows = (await query(
      `SELECT account_name, bank_name, account_number, ifsc, branch
         FROM finance_accounts
         ORDER BY primary_account DESC, id ASC
         LIMIT 1`,
    )) as any[]
    const b = rows[0]
    if (!b) return null
    return {
      accountName: b.account_name || "",
      bankName: b.bank_name || "",
      accountNumber: b.account_number || "",
      ifsc: b.ifsc || "",
      branch: b.branch || "",
    }
  } catch {
    return null
  }
}

/** Resolve the buyer (client) address/GST block from the clients table. */
async function loadBuyer(inv: Record<string, any>): Promise<PartyLike> {
  try {
    const rows = (await query(
      `SELECT client_name, company_name, tax_name, gst_number, address, city, state, country, postal_code
         FROM clients
         WHERE client_code = ? OR client_name = ?
         LIMIT 1`,
      [inv.client_id || "", inv.client_name || ""],
    )) as any[]
    const c = rows[0]
    if (!c) return { name: inv.client_name }
    return {
      name: c.company_name || c.client_name || inv.client_name,
      gstNumber: c.gst_number,
      taxLabel: c.tax_name || "GSTIN",
      addressLines: [
        c.address,
        [c.city, c.state, c.postal_code].filter(Boolean).join(", "),
        c.country,
      ],
    }
  } catch {
    return { name: inv.client_name }
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const [inv] = (await query(`SELECT * FROM sales_invoices WHERE id = ? LIMIT 1`, [Number(id)])) as any[]
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  const [settings, bank, buyer] = await Promise.all([getSettings(), loadBank(), loadBuyer(inv)])
  const pdf = buildSalesInvoicePdf(inv, companyFromSettings(settings), buyer, bank)

  const filename = `${inv.invoice_id || "invoice"}.pdf`
  const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
