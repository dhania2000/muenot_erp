import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import {
  ensureContactTables,
  listContacts,
  createContact,
  findContactDuplicates,
} from "@/lib/contacts/db"
import { validateContact, displayNameOf } from "@/lib/contacts/model"

export async function GET(request: Request) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.view_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const contacts = await listContacts({
    includeArchived: url.searchParams.get("includeArchived") === "1",
    search: url.searchParams.get("q"),
    type: url.searchParams.get("type"),
    relationship: url.searchParams.get("relationship") as "customer" | "vendor" | null,
  })
  return NextResponse.json({ contacts })
}

export async function POST(request: Request) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.manage_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()

  const errors = validateContact(body)
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })
  }

  // Duplicate detection — the client may override with { force: true } after
  // reviewing the surfaced matches.
  if (!body.force) {
    const duplicates = await findContactDuplicates({
      full_name: body.full_name,
      first_name: body.first_name,
      last_name: body.last_name,
      company_name: body.company_name,
      email: body.email,
      phone: body.phone,
      gstin: body.gstin,
      pan: body.pan,
    })
    if (duplicates.length > 0) {
      return NextResponse.json({ error: "Possible duplicate contact", duplicates }, { status: 409 })
    }
  }

  const { id, contact_code, links } = await createContact(body, session.userId)

  await recordAudit(null, {
    entityType: "contact",
    entityId: contact_code,
    action: "created",
    summary: `Contact ${displayNameOf(body)} created`,
    meta: { links },
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true, id, contact_code, links }, { status: 201 })
}
