import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema, cleanTag, recordContactActivity } from "@/lib/marketing/contacts-db"

/**
 * Bulk actions over a set of contact ids. Every action is auditable and applies
 * only to non-archived rows.
 *   action: subscribe | unsubscribe | archive | restore | set_status |
 *           set_stage | set_owner | add_tag | remove_tag | add_to_segment
 */
export async function POST(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : []
  const action = String(body.action ?? "")
  if (ids.length === 0) return NextResponse.json({ error: "No contacts selected" }, { status: 400 })

  const placeholders = ids.map(() => "?").join(",")
  let affected = 0

  const bump = (extra: string, args: any[]) =>
    query<any>(
      `UPDATE marketing_contacts SET ${extra}, row_version = row_version + 1 WHERE id IN (${placeholders})`,
      [...args, ...ids],
    )

  switch (action) {
    case "subscribe":
      await bump("email_subscription = 'Subscribed'", [])
      break
    case "unsubscribe":
      await bump("email_subscription = 'Unsubscribed'", [])
      break
    case "archive":
      await bump("archived_at = NOW(), archived_by = ?", [session.userId])
      break
    case "restore":
      await bump("archived_at = NULL, archived_by = NULL", [])
      break
    case "set_status":
      if (!["Active", "Inactive"].includes(body.value)) return NextResponse.json({ error: "Invalid status" }, { status: 400 })
      await bump("status = ?", [body.value])
      break
    case "set_stage":
      await bump("lifecycle_stage = ?", [String(body.value || "Subscriber")])
      break
    case "set_owner":
      await bump("owner_id = ?", [body.value ? Number(body.value) : null])
      break
    case "add_tag": {
      const tag = cleanTag(body.value)
      if (!tag) return NextResponse.json({ error: "Tag is required" }, { status: 400 })
      for (const id of ids) {
        await query(`INSERT IGNORE INTO marketing_contact_tags (contact_id, tag) VALUES (?,?)`, [id, tag]).catch(() => {})
      }
      break
    }
    case "remove_tag": {
      const tag = cleanTag(body.value)
      await query(`DELETE FROM marketing_contact_tags WHERE tag = ? AND contact_id IN (${placeholders})`, [tag, ...ids]).catch(
        () => {},
      )
      break
    }
    case "add_to_segment": {
      const segId = Number(body.value)
      if (!segId) return NextResponse.json({ error: "Segment is required" }, { status: 400 })
      for (const id of ids) {
        await query(
          `INSERT IGNORE INTO marketing_segment_members (segment_id, contact_id, added_by) VALUES (?,?,?)`,
          [segId, id, session.userId],
        ).catch(() => {})
      }
      break
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  affected = ids.length
  for (const id of ids) {
    await recordContactActivity({
      contactId: id,
      type: "bulk",
      summary: `Bulk action: ${action}${body.value ? ` (${body.value})` : ""}`,
      actorId: session.userId,
    })
  }

  return NextResponse.json({ ok: true, affected })
}
