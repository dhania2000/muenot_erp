import { requireFeature } from "@/lib/api-auth"
import { listItems, type ListParams } from "@/lib/marketing/planner-db"
import { NextResponse } from "next/server"

export const runtime = "nodejs"

function csv(v: string | null): string[] | undefined {
  if (!v) return undefined
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}

function field(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(request: Request) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const q = url.searchParams
  const base: ListParams = {
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
    pageSize: 200,
  }
  if (session.role !== "admin" && q.get("scope") === "mine") base.scopeUserId = session.userId

  // Paginate through the full filtered result set (capped for safety).
  const rows: any[] = []
  for (let page = 1; page <= 25; page++) {
    const { items, total } = await listItems({ ...base, page })
    rows.push(...items)
    if (rows.length >= total || items.length === 0) break
  }

  const headers = [
    "ID",
    "Title",
    "Status",
    "Priority",
    "Channel",
    "Content Type",
    "Owner",
    "Assignee",
    "Campaign",
    "Journey",
    "Scheduled At",
    "Published At",
    "Due Date",
    "Created At",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.title,
        r.status,
        r.priority,
        r.channel,
        r.content_type,
        r.owner_name,
        r.assignee_name,
        r.campaign_name,
        r.journey_name,
        r.scheduled_at,
        r.published_at,
        r.due_date,
        r.created_at,
      ]
        .map(field)
        .join(","),
    )
  }
  const body = lines.join("\n")

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="marketing-planner-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
