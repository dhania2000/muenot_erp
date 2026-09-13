import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { expireOverdueQuotations, getQuotationAnalytics } from "@/lib/sales/quotation-service"

export async function GET() {
  const session = await requireFeature("sales.view_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Keep derived expiry accurate before summarising.
  await expireOverdueQuotations().catch(() => {})
  const analytics = await getQuotationAnalytics()
  return NextResponse.json(analytics)
}
