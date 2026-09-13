import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import {
  ensureClientTables,
  findClientDuplicates,
  resolveFinanceParty,
  getClientLinkCounts,
  isValidEmail,
  isValidGstin,
  isValidPan,
  normalizeEmail,
  normalizeGstin,
  normalizePan,
  panFromGstin,
  stateCodeFromGstin,
} from "@/lib/clients-db"

const ALLOWED = new Set([
  "salutation","client_name","email","login_allowed","email_notifications","gender","language",
  "mobile","company_name","website","tax_name","gst_number","office_phone","address","city","state",
  "country","postal_code","category","sub_category","currency","status","notes",
  "client_type","company_id","primary_contact_id","finance_party_id","account_manager_id",
  "payment_terms_days","credit_limit","legal_name",
])

async function loadClient(id: string) {
  const rows = await query<any[]>("SELECT * FROM clients WHERE id=? LIMIT 1", [id])
  return rows[0] ?? null
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()

  const existing = await loadClient(id)
  if (!existing) return NextResponse.json({ error: "Client not found" }, { status: 404 })

  // The effective record after applying the patch — used for validation and
  // deriving normalized identity/tax fields.
  const merged = { ...existing, ...body }

  const errors: Record<string, string> = {}
  if (!String(merged.client_name ?? "").trim()) errors.client_name = "Client name is required"
  if (!String(merged.email ?? "").trim()) errors.email = "Email is required"
  else if (!isValidEmail(merged.email)) errors.email = "Enter a valid email address"
  if (merged.gst_number && !isValidGstin(merged.gst_number)) errors.gst_number = "Enter a valid 15-character GSTIN"
  if (merged.pan && !isValidPan(merged.pan)) errors.pan = "Enter a valid 10-character PAN"
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })
  }

  const gstin = normalizeGstin(merged.gst_number)
  const pan = normalizePan(merged.pan) || panFromGstin(gstin)
  const companyName = String(merged.company_name ?? "").trim() || null

  if (!body.force) {
    const duplicates = await findClientDuplicates({
      client_name: merged.client_name,
      company_name: merged.company_name,
      email: merged.email,
      gst_number: gstin,
      pan,
      excludeId: Number(id),
    })
    if (duplicates.length > 0) {
      return NextResponse.json({ error: "Possible duplicate client", duplicates }, { status: 409 })
    }
  }

  const fields = Object.keys(body).filter((key) => ALLOWED.has(key))

  const updates: Record<string, any> = {}
  for (const key of fields) updates[key] = body[key] === "" ? null : body[key]

  // Re-derive normalized / dependent fields whenever their source changes.
  if ("gst_number" in body) {
    updates.gst_number = gstin
    updates.pan = pan
    updates.state_code = stateCodeFromGstin(gstin) || existing.state_code || null
  }
  if ("email" in body) updates.email = normalizeEmail(merged.email)
  if ("company_name" in body || "client_name" in body || "display_name" in body) {
    updates.display_name =
      String(merged.display_name ?? "").trim() || companyName || String(merged.client_name ?? "").trim() || null
  }

  // Re-link finance party if it was cleared/changed or GSTIN/PAN moved.
  if ("finance_party_id" in body || "gst_number" in body) {
    const resolved = await resolveFinanceParty({
      finance_party_id: body.finance_party_id ?? existing.finance_party_id,
      gst_number: gstin,
      pan,
      company_name: merged.company_name,
      client_name: merged.client_name,
    })
    updates.finance_party_id = resolved.party_id
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 })
  }

  const setKeys = Object.keys(updates)
  const setSql = [...setKeys.map((f) => `${f}=?`), "row_version=row_version+1"].join(",")
  const values = setKeys.map((k) => updates[k])

  // Optimistic lock: only update if the caller's row_version still matches.
  const expectedVersion = Number(body.row_version)
  const useLock = Number.isFinite(expectedVersion) && expectedVersion > 0
  const res = await query<any>(
    `UPDATE clients SET ${setSql} WHERE id=? ${useLock ? "AND row_version=?" : ""}`,
    useLock ? [...values, id, expectedVersion] : [...values, id],
  )

  if (useLock && res.affectedRows === 0) {
    return NextResponse.json(
      { error: "This client was modified by someone else. Refresh and try again." },
      { status: 409 },
    )
  }

  await recordAudit(null, {
    entityType: "client",
    entityId: existing.client_code,
    action: "updated",
    summary: `Client ${updates.display_name || existing.display_name || existing.client_name} updated`,
    meta: { changed: setKeys },
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true, finance_party_id: updates.finance_party_id ?? existing.finance_party_id })
}

/**
 * Archive-instead-of-delete. A client linked to financial records is never
 * hard-deleted (that would orphan invoices); it is soft-archived so history
 * stays intact. Use ?hard=1 to force a hard delete only when there are no links.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const existing = await loadClient(id)
  if (!existing) return NextResponse.json({ error: "Client not found" }, { status: 404 })

  const url = new URL(request.url)
  const hard = url.searchParams.get("hard") === "1"

  const links = await getClientLinkCounts({
    finance_party_id: existing.finance_party_id,
    company_id: existing.company_id,
  })

  if (hard && links.total === 0) {
    await query("DELETE FROM clients WHERE id=?", [id])
    await recordAudit(null, {
      entityType: "client",
      entityId: existing.client_code,
      action: "deleted",
      summary: `Client ${existing.display_name || existing.client_name} permanently deleted`,
      actorId: session.userId,
    })
    return NextResponse.json({ ok: true, deleted: true })
  }

  await query(
    "UPDATE clients SET archived_at=NOW(), archived_by=?, status='Inactive', row_version=row_version+1 WHERE id=?",
    [session.userId, id],
  )
  await recordAudit(null, {
    entityType: "client",
    entityId: existing.client_code,
    action: "archived",
    summary: `Client ${existing.display_name || existing.client_name} archived`,
    meta: { linked_invoices: links.invoices },
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true, archived: true, links })
}
