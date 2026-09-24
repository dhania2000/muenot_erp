import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getSettings } from "@/lib/settings/server"
import { companyFromSettings } from "@/lib/finance-invoice-pdf"
import { buildContractPdf } from "@/lib/sales/contract-pdf"
import { getContract } from "@/lib/sales/contract-service"

export const runtime = "nodejs"

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await ctx.params
  const contract = await getContract(Number(id))
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 })

  const settings = await getSettings()
  const pdf = buildContractPdf(contract as any, await companyFromSettings(settings))

  const filename = `${contract.contract_code || "contract"}.pdf`
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
