import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureLeadGenSchema, listSubmissions } from "@/lib/marketing/leadgen-db"

export async function GET(request: Request) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const p = new URL(request.url).searchParams
  const result = await listSubmissions({
    formId: p.get("formId") ? Number(p.get("formId")) : null,
    status: p.get("status") || "",
    search: (p.get("search") || "").trim(),
    page: Number(p.get("page") || 1),
    pageSize: Number(p.get("pageSize") || 50),
  })
  return NextResponse.json(result)
}
