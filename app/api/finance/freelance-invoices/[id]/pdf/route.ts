import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getSettings } from "@/lib/settings/server"
import { ensureFreelanceInvoiceColumns } from "@/lib/finance-ensure"
import { buildFreelanceInvoicePdf, companyFromSettings, type InvoiceBank } from "@/lib/finance-invoice-pdf"

export const runtime = "nodejs"

/** Load the primary (or first active) bank account to print on the invoice. */
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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureFreelanceInvoiceColumns()
  const { id } = await ctx.params
  const [inv] = (await query(`SELECT * FROM freelance_invoices WHERE id = ? LIMIT 1`, [Number(id)])) as any[]
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  const [settings, bank] = await Promise.all([getSettings(), loadBank()])
  const pdf = buildFreelanceInvoicePdf(inv, companyFromSettings(settings), bank)

  const filename = `${inv.freelance_invoice_id || "invoice"}.pdf`
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
