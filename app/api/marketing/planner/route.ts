import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { createItem, listItems, type ListParams } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

function csv(v: string | null): string[] | undefined {
  if (!v) return undefined
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}

export async function GET(request: Request) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const q = url.searchParams
  const params: ListParams = {
    search: q.get("search") || undefined,
    status: csv(q.get("status")),
    priority: csv(q.get("priority")),
    channel: csv(q.get("channel")),
    content_type: csv(q.get("content_type")),
    campaign_id: q.get("campaign_id") ? Number(q.get("campaign_id")) : undefined,
    journey_id: q.get("journey_id") ? Number(q.get("journey_id")) : undefined,
    owner_id: q.get("owner_id") ? Number(q.get("owner_id")) : undefined,
    assignee_id: q.get("assignee_id") ? Number(q.get("assignee_id")) : undefined,
    from: q.get("from") || undefined,
    to: q.get("to") || undefined,
    includeArchived: q.get("includeArchived") === "1",
    overdueOnly: q.get("overdueOnly") === "1",
    sort: q.get("sort") || undefined,
    dir: (q.get("dir") as "asc" | "desc") || undefined,
    page: q.get("page") ? Number(q.get("page")) : undefined,
    pageSize: q.get("pageSize") ? Number(q.get("pageSize")) : undefined,
  }
  // Non-admins only see items within their scope (Phase 74).
  if (session.role !== "admin" && q.get("scope") === "mine") params.scopeUserId = session.userId

  try {
    const result = await listItems(params)
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to load planner" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await requireFeature("marketing.planner.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const item = await createItem(body, session.userId)
    return NextResponse.json({ item }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to create item" }, { status: 400 })
  }
}
