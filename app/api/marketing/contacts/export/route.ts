import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema, getTagsForContacts } from "@/lib/marketing/contacts-db"

function csvCell(value: any): string {
  const s = value === null || value === undefined ? "" : String(value)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const COLUMNS: [string, (r: any) => any][] = [
  ["Contact Code", (r) => r.contact_code],
  ["First Name", (r) => r.first_name],
  ["Last Name", (r) => r.last_name],
  ["Full Name", (r) => r.full_name],
  ["Email", (r) => r.email],
  ["Phone", (r) => r.phone],
  ["Company", (r) => r.company_name],
  ["Job Title", (r) => r.job_title],
  ["Source", (r) => r.source],
  ["Lifecycle Stage", (r) => r.lifecycle_stage],
  ["Status", (r) => r.status],
  ["Email Subscription", (r) => r.email_subscription],
  ["Deliverability", (r) => r.deliverability],
  ["Consent", (r) => (r.consent ? "Yes" : "No")],
  ["Owner", (r) => r.owner_name],
  ["City", (r) => r.city],
  ["State", (r) => r.state],
  ["Country", (r) => r.country],
  ["Tags", (r) => (r.tags || []).join("; ")],
  ["Created", (r) => (r.created_at ? new Date(r.created_at).toISOString() : "")],
]

export async function GET(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return new Response("Forbidden", { status: 403 })

  const url = new URL(request.url)
  const segmentId = url.searchParams.get("segment")

  const where: string[] = ["c.archived_at IS NULL"]
  const args: any[] = []
  if (segmentId) {
    where.push("EXISTS (SELECT 1 FROM marketing_segment_members m WHERE m.contact_id = c.id AND m.segment_id = ?)")
    args.push(Number(segmentId))
  }

  const rows = await query<any[]>(
    `SELECT c.*, u.name AS owner_name FROM marketing_contacts c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT 50000`,
    args,
  )
  const tagMap = await getTagsForContacts(rows.map((r) => r.id))
  const withTags = rows.map((r) => ({ ...r, tags: tagMap[r.id] || [] }))

  const header = COLUMNS.map(([label]) => csvCell(label)).join(",")
  const body = withTags.map((r) => COLUMNS.map(([, fn]) => csvCell(fn(r))).join(",")).join("\n")
  const csv = `${header}\n${body}`

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="marketing-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
