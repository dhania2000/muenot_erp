import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getSettings } from "@/lib/settings/server"
import { buildPurchaseBillPdf, companyFromSettings } from "@/lib/finance-invoice-pdf"

export const runtime = "nodejs"

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const [bill] = (await query(`SELECT * FROM purchase_bills WHERE id = ? LIMIT 1`, [Number(id)])) as any[]
  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 })

  const settings = await getSettings()
  const pdf = buildPurchaseBillPdf(bill, companyFromSettings(settings))

  const filename = `${bill.po_number || "purchase-bill"}.pdf`
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
