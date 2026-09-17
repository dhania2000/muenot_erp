import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import {
  ensureContactSchema,
  buildContactColumns,
  validateContact,
  findContactDuplicates,
  setContactTags,
  getTagsForContacts,
  recordContactActivity,
  isEligible,
  eligibilityReason,
} from "@/lib/marketing/contacts-db"

const SORTABLE: Record<string, string> = {
  created_at: "c.created_at",
  full_name: "c.full_name",
  company_name: "c.company_name",
  lifecycle_stage: "c.lifecycle_stage",
  last_activity_at: "c.last_activity_at",
  lead_score: "c.lead_score",
}

export async function GET(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const p = url.searchParams
  const search = (p.get("search") || "").trim()
  const status = p.get("status") || ""
  const source = p.get("source") || ""
  const stage = p.get("stage") || ""
  const subscription = p.get("subscription") || ""
  const deliverability = p.get("deliverability") || ""
  const ownerId = p.get("owner") || ""
  const tag = p.get("tag") || ""
  const segmentId = p.get("segment") || ""
  const eligibleOnly = p.get("eligible") === "1"
  const includeArchived = p.get("includeArchived") === "1"
  const sort = SORTABLE[p.get("sort") || "created_at"] || "c.created_at"
  const dir = (p.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC"
  const page = Math.max(1, Number(p.get("page") || 1))
  const pageSize = Math.min(200, Math.max(1, Number(p.get("pageSize") || 50)))
  const offset = (page - 1) * pageSize

  const where: string[] = []
  const args: any[] = []
  if (!includeArchived) where.push("c.archived_at IS NULL")
  if (search) {
    where.push("(c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.company_name LIKE ? OR c.contact_code LIKE ?)")
    const like = `%${search}%`
    args.push(like, like, like, like, like)
  }
  if (status) {
    where.push("c.status = ?")
    args.push(status)
  }
  if (source) {
    where.push("c.source = ?")
    args.push(source)
  }
  if (stage) {
    where.push("c.lifecycle_stage = ?")
    args.push(stage)
  }
  if (subscription) {
    where.push("c.email_subscription = ?")
    args.push(subscription)
  }
  if (deliverability) {
    where.push("c.deliverability = ?")
    args.push(deliverability)
  }
  if (ownerId) {
    where.push("c.owner_id = ?")
    args.push(Number(ownerId))
  }
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM marketing_contact_tags t WHERE t.contact_id = c.id AND t.tag = ?)")
    args.push(tag)
  }
  if (segmentId) {
    where.push("EXISTS (SELECT 1 FROM marketing_segment_members sm WHERE sm.contact_id = c.id AND sm.segment_id = ?)")
    args.push(Number(segmentId))
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const totalRows = await query<any[]>(`SELECT COUNT(*) AS n FROM marketing_contacts c ${whereSql}`, args)
  const total = Number(totalRows?.[0]?.n ?? 0)

  const rows = await query<any[]>(
    `SELECT c.*, u.name AS owner_name,
            cl.client_code, cl.client_name AS linked_client_name,
            l.lead_code
       FROM marketing_contacts c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN sales_leads l ON l.id = c.lead_id
       ${whereSql}
       ORDER BY ${sort} ${dir}, c.id DESC
       LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )

  const tagMap = await getTagsForContacts(rows.map((r) => r.id))
  let contacts = rows.map((r) => ({
    ...r,
    tags: tagMap[r.id] || [],
    eligible: isEligible(r, "email"),
    eligibility_reason: eligibilityReason(r, "email"),
  }))
  if (eligibleOnly) contacts = contacts.filter((c) => c.eligible)

  // Facets for the filter bar (cheap, guarded).
  const [owners, tags, segments] = await Promise.all([
    query<any[]>(
      `SELECT DISTINCT u.id, u.name FROM marketing_contacts c JOIN users u ON u.id = c.owner_id WHERE c.archived_at IS NULL ORDER BY u.name`,
    ).catch(() => []),
    query<any[]>(
      `SELECT t.tag, COUNT(*) AS count FROM marketing_contact_tags t JOIN marketing_contacts c ON c.id = t.contact_id AND c.archived_at IS NULL GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 100`,
    ).catch(() => []),
    query<any[]>(
      `SELECT s.id, s.name, s.type, s.color, COUNT(m.id) AS member_count
         FROM marketing_segments s
         LEFT JOIN marketing_segment_members m ON m.segment_id = s.id
        WHERE s.archived_at IS NULL GROUP BY s.id ORDER BY s.name`,
    ).catch(() => []),
  ])

  return NextResponse.json({
    contacts,
    total,
    page,
    pageSize,
    facets: { owners, tags, segments },
  })
}

export async function POST(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const errors = validateContact(body)
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })
  }

  const columns = buildContactColumns(body)

  if (!body.force) {
    const duplicates = await findContactDuplicates({ email: columns.email, phone: columns.phone })
    if (duplicates.length > 0) {
      return NextResponse.json({ error: "Possible duplicate contact", duplicates }, { status: 409 })
    }
  }

  // Consent bookkeeping: if consent is granted now, stamp when + source.
  if (columns.consent) {
    columns.consent_at = new Date()
    columns.consent_source = columns.consent_source || "Manual entry"
  }

  const code = await nextRecordId("MKC", { allowCustom: true, digits: 6 })
  const fields = ["contact_code", ...Object.keys(columns)]
  const values = [code, ...Object.keys(columns).map((k) => columns[k])]

  const res = await query<any>(
    `INSERT INTO marketing_contacts (${fields.join(",")},created_by) VALUES (${fields.map(() => "?").join(",")},?)`,
    [...values, session.userId],
  )
  const newId = Number((res as any).insertId)

  if (Array.isArray(body.tags)) await setContactTags(newId, body.tags)

  await recordContactActivity({
    contactId: newId,
    contactCode: code,
    type: "created",
    summary: `Contact ${columns.full_name} created`,
    meta: { source: columns.source },
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true, id: newId, contact_code: code }, { status: 201 })
}
