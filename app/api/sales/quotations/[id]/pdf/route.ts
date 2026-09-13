import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { getSettings } from "@/lib/settings/server"
import { companyFromSettings, type InvoiceBank } from "@/lib/finance-invoice-pdf"
import { buildQuotationPdf } from "@/lib/sales/quotation-pdf"
import { getQuotationDetail } from "@/lib/sales/quotation-service"

export const runtime = "nodejs"

/** Load the primary (or first) bank account to print on the quotation. */
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
  const session = await requireFeature("sales.view_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await ctx.params
  const detail = await getQuotationDetail(Number(id))
  if (!detail) return NextResponse.json({ error: "Quotation not found" }, { status: 404 })

  const [settings, bank] = await Promise.all([getSettings(), loadBank()])
  const pdf = buildQuotationPdf(detail.quotation as any, detail.items as any, companyFromSettings(settings), bank)

  const q = detail.quotation
  const suffix = q.version && q.version > 1 ? `-v${q.version}` : ""
  const filename = `${q.quote_code || "quotation"}${suffix}.pdf`
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
