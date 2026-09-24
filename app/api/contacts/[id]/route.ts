import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import {
  ensureContactTables,
  getContact,
  updateContact,
  archiveContact,
  findContactDuplicates,
} from "@/lib/contacts/db"
import {
  validateContact,
  displayNameOf,
  ContactConflictError,
  ContactNotFoundError,
} from "@/lib/contacts/model"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.view_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contact = await getContact(Number(id))
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  return NextResponse.json({ contact })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.manage_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()

  const errors = validateContact(body)
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })
  }

  if (!body.force) {
    const duplicates = await findContactDuplicates(
      {
        full_name: body.full_name,
        first_name: body.first_name,
        last_name: body.last_name,
        company_name: body.company_name,
        email: body.email,
        phone: body.phone,
        gstin: body.gstin,
        pan: body.pan,
      },
      Number(id),
    )
    if (duplicates.length > 0) {
      return NextResponse.json({ error: "Possible duplicate contact", duplicates }, { status: 409 })
    }
  }

  const expectedVersion = Number.isFinite(Number(body.row_version)) ? Number(body.row_version) : null
  try {
    await updateContact(Number(id), body, expectedVersion, session.userId)
  } catch (err) {
    if (err instanceof ContactNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof ContactConflictError) return NextResponse.json({ error: err.message }, { status: 409 })
    throw err
  }

  await recordAudit(null, {
    entityType: "contact",
    entityId: id,
    action: "updated",
    summary: `Contact ${displayNameOf(body)} updated`,
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.manage_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  try {
    await archiveContact(Number(id), session.userId)
  } catch (err) {
    if (err instanceof ContactNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    throw err
  }

  await recordAudit(null, {
    entityType: "contact",
    entityId: id,
    action: "archived",
    summary: `Contact ${id} archived`,
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true, archived: true })
}
