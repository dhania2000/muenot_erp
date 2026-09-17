import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureJourneySchema, listEnrollments } from "@/lib/marketing/journeys-db"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureJourneySchema()
  const session = await requireFeature("marketing.journeys.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await context.params
  const p = new URL(request.url).searchParams
  const { items, total } = await listEnrollments(Number(id), {
    status: p.get("status") || "all",
    search: (p.get("search") || "").trim(),
    page: Number(p.get("page") || 1),
    pageSize: Number(p.get("pageSize") || 25),
  })
  return NextResponse.json({ items, total })
}
