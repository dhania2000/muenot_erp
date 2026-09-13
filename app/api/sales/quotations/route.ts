import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  createQuotation,
  expireOverdueQuotations,
  listQuotations,
  type QuotationInput,
} from "@/lib/sales/quotation-service"

export async function GET(request: Request) {
  const session = await requireFeature("sales.view_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Opportunistically expire lapsed quotations so the list is always accurate.
  await expireOverdueQuotations().catch(() => {})

  const url = new URL(request.url)
  const quotations = await listQuotations({
    status: url.searchParams.get("status") || undefined,
    search: url.searchParams.get("search") || undefined,
    companyId: url.searchParams.get("companyId") ? Number(url.searchParams.get("companyId")) : undefined,
    includeArchived: url.searchParams.get("includeArchived") === "1",
    onlyCurrent: url.searchParams.get("allVersions") !== "1",
  })
  return NextResponse.json({ quotations })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_quotations")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json()) as QuotationInput
  if (!body.company_name) {
    return NextResponse.json({ error: "Company name is required" }, { status: 400 })
  }
  const items = Array.isArray(body.items) ? body.items.filter((i) => i && i.name) : []
  if (items.length === 0) {
    return NextResponse.json({ error: "Add at least one line item" }, { status: 400 })
  }

  try {
    const result = await createQuotation({ ...body, items }, session.userId)
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unable to create quotation" }, { status: 500 })
  }
}
