import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureContactSchema,
  buildContactColumns,
  validateContact,
  setContactTags,
  getTagsForContacts,
  recordContactActivity,
  isEligible,
  eligibilityReason,
  ContactConflictError,
} from "@/lib/marketing/contacts-db"

async function loadContact(id: number) {
  const rows = await query<any[]>(
    `SELECT c.*, u.name AS owner_name,
            cl.client_code, cl.client_name AS linked_client_name,
            l.lead_code, l.contact_person AS linked_lead_name,
            creator.name AS created_by_name
       FROM marketing_contacts c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN sales_leads l ON l.id = c.lead_id
       LEFT JOIN users creator ON creator.id = c.created_by
      WHERE c.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] || null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contact = await loadContact(Number(id))
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const tagMap = await getTagsForContacts([contact.id])
  const activity = await query<any[]>(
    `SELECT a.*, u.name AS actor_name FROM marketing_contact_activity a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.contact_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    [contact.id],
  ).catch(() => [])
  const segments = await query<any[]>(
    `SELECT s.id, s.name, s.color FROM marketing_segment_members m
       JOIN marketing_segments s ON s.id = m.segment_id
      WHERE m.contact_id = ? AND s.archived_at IS NULL ORDER BY s.name`,
    [contact.id],
  ).catch(() => [])

  return NextResponse.json({
    contact: {
      ...contact,
      tags: tagMap[contact.id] || [],
      eligible: isEligible(contact, "email"),
      eligibility_reason: eligibilityReason(contact, "email"),
    },
    activity,
    segments,
  })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contactId = Number(id)
  const current = await loadContact(contactId)
  if (!current) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const body = await request.json()
  const errors = validateContact({ ...current, ...body })
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })
  }

  // Optimistic lock.
  if (body.row_version !== undefined && Number(body.row_version) !== Number(current.row_version)) {
    return NextResponse.json({ error: new ContactConflictError().message }, { status: 409 })
  }

  const columns = buildContactColumns({ ...current, ...body })

  // Consent transition bookkeeping.
  if (body.consent !== undefined) {
    const grantingNow = body.consent && !current.consent
    if (grantingNow) {
      columns.consent_at = new Date()
      columns.consent_source = body.consent_source || columns.consent_source || "Manual update"
    }
  }

  const keys = Object.keys(columns)
  await query(
    `UPDATE marketing_contacts SET ${keys.map((k) => `${k} = ?`).join(", ")}, row_version = row_version + 1 WHERE id = ?`,
    [...keys.map((k) => columns[k]), contactId],
  )

  if (Array.isArray(body.tags)) await setContactTags(contactId, body.tags)

  // Note meaningful changes on the timeline.
  const changed: string[] = []
  if (body.email_subscription && body.email_subscription !== current.email_subscription)
    changed.push(`email ${body.email_subscription.toLowerCase()}`)
  if (body.status && body.status !== current.status) changed.push(`status → ${body.status}`)
  if (body.lifecycle_stage && body.lifecycle_stage !== current.lifecycle_stage)
    changed.push(`stage → ${body.lifecycle_stage}`)
  await recordContactActivity({
    contactId,
    contactCode: current.contact_code,
    type: "updated",
    summary: changed.length ? `Updated: ${changed.join(", ")}` : "Contact details updated",
    actorId: session.userId,
  })

  const updated = await loadContact(contactId)
  const tagMap = await getTagsForContacts([contactId])
  return NextResponse.json({
    ok: true,
    contact: { ...updated, tags: tagMap[contactId] || [] },
  })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contactId = Number(id)
  const current = await loadContact(contactId)
  if (!current) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const permanent = new URL(request.url).searchParams.get("permanent") === "true"

  if (permanent) {
    // Hard delete — remove the contact and its dependent rows entirely.
    await query(`DELETE FROM marketing_segment_members WHERE contact_id = ?`, [contactId]).catch(() => {})
    await query(`DELETE FROM marketing_contact_tags WHERE contact_id = ?`, [contactId]).catch(() => {})
    await query(`DELETE FROM marketing_contact_activity WHERE contact_id = ?`, [contactId]).catch(() => {})
    await query(`DELETE FROM marketing_contacts WHERE id = ?`, [contactId])
    return NextResponse.json({ ok: true, permanent: true })
  }

  await query(
    `UPDATE marketing_contacts SET archived_at = NOW(), archived_by = ?, row_version = row_version + 1 WHERE id = ?`,
    [session.userId, contactId],
  )
  await recordContactActivity({
    contactId,
    contactCode: current.contact_code,
    type: "archived",
    summary: "Contact archived",
    actorId: session.userId,
  })
  return NextResponse.json({ ok: true })
}
