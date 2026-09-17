import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// GET /api/notice-board/export — CSV of the notice register (manager only).
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const url = new URL(request.url)
  const status = url.searchParams.get("status") || ""
  const where: string[] = ["1=1"]
  const params: any[] = []
  if (status) { where.push("n.status = ?"); params.push(status) }

  const rows = await query<any[]>(
    `SELECT n.notice_code, n.heading, n.category, n.priority, n.status,
            n.audience_type, n.department, n.created_by_name, n.created_at, n.published_at, n.end_date,
            (SELECT COUNT(*) FROM notice_recipients r WHERE r.notice_id = n.id) AS recipients,
            (SELECT COUNT(*) FROM notice_reads rd WHERE rd.notice_id = n.id) AS reads,
            (SELECT COUNT(*) FROM notice_acknowledgements a WHERE a.notice_id = n.id) AS acks
     FROM notices n WHERE ${where.join(" AND ")}
     ORDER BY n.created_at DESC`,
    params,
  )

  const header = [
    "Notice Code", "Heading", "Category", "Priority", "Status", "Audience", "Department",
    "Created By", "Created At", "Published At", "End Date", "Recipients", "Reads", "Acknowledgements",
  ]
  const lines = [header.join(",")]
  for (const r of rows) {
    lines.push([
      r.notice_code, r.heading, r.category, r.priority, r.status, r.audience_type, r.department,
      r.created_by_name, r.created_at, r.published_at, r.end_date, r.recipients, r.reads, r.acks,
    ].map(csvCell).join(","))
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="notice-register-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
