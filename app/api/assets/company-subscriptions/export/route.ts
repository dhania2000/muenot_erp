import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import { exportCsv, type ListFilters } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireModuleAction("assets.company_subscriptions", "export")
  if (!session) return NextResponse.json({ error: "You do not have permission to export." }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const filters: ListFilters = {
    search: sp.get("search"),
    status: sp.get("status"),
    category: sp.get("category"),
    vendor: sp.get("vendor"),
    department: sp.get("department"),
    billing_cycle: sp.get("billing_cycle"),
    expiring: sp.get("expiring") === "1",
  }
  const csv = await exportCsv(filters)
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="company-subscriptions-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
