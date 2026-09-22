import "server-only"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"

/**
 * Shopkeeper customers.
 *
 * A "customer" in the shop app is the tenant's existing WhatsApp contact
 * (marketing_whatsapp_contacts) — already tenant-scoped, already linked to
 * conversations and message history. A parallel customer table would fork that
 * history, so this extends the existing record instead.
 *
 * Deletion is ARCHIVE, not DELETE: shopkeeper_orders references contacts, and
 * removing a row would blank the customer off past orders.
 */

export type ShopkeeperContact = {
  id: number
  phone: string
  name: string | null
  email: string | null
  notes: string | null
  tags: string[]
  city: string | null
  state: string | null
  country: string | null
  leadId: number | null
  archivedAt: string | null
  lastInteractionAt: string | null
  createdAt: string | null
}

export class ContactError extends Error {
  constructor(message: string, readonly status = 400, readonly fields?: Record<string, string>) {
    super(message)
    this.name = "ContactError"
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

/** Digits only, keeping a leading +, so "+91 98765 43210" matches "919876543210". */
function normalizePhone(raw: string): string {
  return raw.trim().replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "")
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean).slice(0, 25)
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean)
    } catch {
      return raw.split(",").map((t) => t.trim()).filter(Boolean)
    }
  }
  return []
}

function map(row: any): ShopkeeperContact {
  return {
    id: Number(row.id),
    phone: row.phone_number,
    name: row.profile_name,
    email: row.email ?? null,
    notes: row.notes ?? null,
    tags: parseTags(row.tags),
    city: row.city ?? null,
    state: row.state ?? null,
    country: row.country ?? null,
    leadId: row.lead_id === null ? null : Number(row.lead_id),
    archivedAt: row.archived_at ?? null,
    lastInteractionAt: row.last_interaction_at ?? null,
    createdAt: row.created_at ?? null,
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ListContactsOptions = {
  search?: string
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export async function listShopkeeperContacts(options: ListContactsOptions = {}) {
  const tenantId = currentTenantId()
  const where: string[] = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]

  if (!options.includeArchived) where.push("archived_at IS NULL")

  const search = text(options.search, 100)
  if (search) {
    where.push("(phone_number LIKE ? OR profile_name LIKE ? OR email LIKE ?)")
    const like = `%${search}%`
    args.push(like, like, like)
  }

  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
  const offset = Math.max(0, Number(options.offset) || 0)
  const clause = where.join(" AND ")

  const rows = await query<any[]>(
    `SELECT * FROM \`marketing_whatsapp_contacts\` WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )
  const [count] = await query<any[]>(
    `SELECT COUNT(*) AS total FROM \`marketing_whatsapp_contacts\` WHERE ${clause}`,
    args,
  )
  return { contacts: rows.map(map), pagination: { limit, offset, total: Number(count?.total ?? 0) } }
}

export async function getShopkeeperContact(id: number): Promise<ShopkeeperContact | null> {
  if (!Number.isInteger(id) || id < 1) return null
  const rows = await query<any[]>(
    "SELECT * FROM `marketing_whatsapp_contacts` WHERE id = ? AND tenant_id = ? LIMIT 1",
    [id, currentTenantId()],
  )
  return rows[0] ? map(rows[0]) : null
}

export async function createShopkeeperContact(input: Record<string, unknown>): Promise<ShopkeeperContact> {
  const tenantId = currentTenantId()
  const fields: Record<string, string> = {}

  const rawPhone = text(input.phone, 40)
  const phone = rawPhone ? normalizePhone(rawPhone) : null
  if (!phone || phone.replace(/\D/g, "").length < 6) fields.phone = "A valid phone number is required."

  const email = text(input.email, 190)
  if (email && !EMAIL.test(email)) fields.email = "Enter a valid email address."

  if (Object.keys(fields).length) throw new ContactError("The customer could not be saved.", 422, fields)

  // One contact per phone per tenant: the WhatsApp pipeline keys conversations
  // on this pair, so a duplicate would split a customer's message history.
  const existing = await query<any[]>(
    "SELECT * FROM `marketing_whatsapp_contacts` WHERE tenant_id = ? AND phone_number = ? LIMIT 1",
    [tenantId, phone],
  )
  if (existing[0]) {
    // Re-adding an archived customer restores them rather than erroring.
    if (existing[0].archived_at) {
      await query("UPDATE `marketing_whatsapp_contacts` SET archived_at = NULL WHERE id = ? AND tenant_id = ?", [
        existing[0].id,
        tenantId,
      ])
      return (await getShopkeeperContact(Number(existing[0].id)))!
    }
    throw new ContactError("A customer with that phone number already exists.", 409, { phone: "Already in use." })
  }

  const result = (await query(
    `INSERT INTO \`marketing_whatsapp_contacts\`
       (tenant_id, phone_number, profile_name, email, notes, tags, city, state, country)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      tenantId,
      phone,
      text(input.name, 190),
      email,
      text(input.notes, 2000),
      JSON.stringify(parseTags(input.tags)),
      text(input.city, 120),
      text(input.state, 120),
      text(input.country, 120),
    ],
  )) as any
  const created = await getShopkeeperContact(Number(result.insertId))
  if (!created) throw new ContactError("The customer could not be read back after creation.", 500)
  return created
}

export async function updateShopkeeperContact(id: number, input: Record<string, unknown>): Promise<ShopkeeperContact> {
  const tenantId = currentTenantId()
  const existing = await getShopkeeperContact(id)
  if (!existing) throw new ContactError("Customer not found.", 404)

  const fields: Record<string, string> = {}
  const sets: string[] = []
  const args: unknown[] = []

  if (input.phone !== undefined) {
    const phone = normalizePhone(String(input.phone ?? ""))
    if (!phone || phone.replace(/\D/g, "").length < 6) fields.phone = "A valid phone number is required."
    else {
      const clash = await query<any[]>(
        "SELECT id FROM `marketing_whatsapp_contacts` WHERE tenant_id = ? AND phone_number = ? AND id <> ? LIMIT 1",
        [tenantId, phone, id],
      )
      if (clash.length) fields.phone = "Already in use."
      else { sets.push("phone_number = ?"); args.push(phone) }
    }
  }
  if (input.email !== undefined) {
    const email = text(input.email, 190)
    if (email && !EMAIL.test(email)) fields.email = "Enter a valid email address."
    else { sets.push("email = ?"); args.push(email) }
  }
  if (input.name !== undefined) { sets.push("profile_name = ?"); args.push(text(input.name, 190)) }
  if (input.notes !== undefined) { sets.push("notes = ?"); args.push(text(input.notes, 2000)) }
  if (input.tags !== undefined) { sets.push("tags = ?"); args.push(JSON.stringify(parseTags(input.tags))) }
  if (input.city !== undefined) { sets.push("city = ?"); args.push(text(input.city, 120)) }
  if (input.state !== undefined) { sets.push("state = ?"); args.push(text(input.state, 120)) }
  if (input.country !== undefined) { sets.push("country = ?"); args.push(text(input.country, 120)) }

  if (Object.keys(fields).length) throw new ContactError("The customer could not be updated.", 422, fields)
  if (sets.length) {
    await query(`UPDATE \`marketing_whatsapp_contacts\` SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [
      ...args,
      id,
      tenantId,
    ])
  }
  return (await getShopkeeperContact(id))!
}

/**
 * Archive rather than delete. Conversations, messages and orders keep pointing
 * at the row; the customer simply stops appearing in the default list.
 */
export async function archiveShopkeeperContact(id: number): Promise<boolean> {
  const tenantId = currentTenantId()
  const existing = await getShopkeeperContact(id)
  if (!existing) return false
  await query(
    "UPDATE `marketing_whatsapp_contacts` SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    [id, tenantId],
  )
  return true
}
