import "server-only"
import { query } from "@/lib/db"
import { normalizeEmail, isValidEmail } from "@/lib/clients-db"

/**
 * Marketing Contacts master service.
 *
 * A `marketing_contacts` row is the marketing-facing person: the audience of
 * email / WhatsApp / SMS campaigns. It is NOT a duplicate master. When a
 * contact represents someone the ERP already knows it links back to the
 * canonical record instead of copying it:
 *   - `client_id` -> clients.id        (an existing CRM client / their people)
 *   - `lead_id`   -> sales_leads.id    (an inbound / prospecting lead)
 *   - `owner_id`  -> users.id          (the marketer responsible for it)
 *
 * This module is the ONE place that mutates contact state so we keep a single
 * source of truth for:
 *   - race-safe contact code generation (record_id_sequences / nextRecordId)
 *   - normalization (email / phone) and validation
 *   - duplicate detection (email / phone)
 *   - consent + subscription + deliverability bookkeeping
 *   - append-only activity / audit timeline
 *   - campaign eligibility (the single rule the whole module trusts)
 *   - the runtime schema self-heal that mirrors a migration for existing DBs
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const CONTACT_STATUSES = ["Active", "Inactive"] as const
export type ContactStatus = (typeof CONTACT_STATUSES)[number]

export const CONTACT_SOURCES = [
  "Manual",
  "Import",
  "Client Sync",
  "Lead Sync",
  "Website",
  "WhatsApp",
  "Event",
  "Referral",
  "Other",
] as const
export type ContactSource = (typeof CONTACT_SOURCES)[number]

export const LIFECYCLE_STAGES = [
  "Subscriber",
  "Lead",
  "MQL",
  "SQL",
  "Opportunity",
  "Customer",
  "Evangelist",
  "Other",
] as const
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]

export const SUBSCRIPTION_STATES = ["Subscribed", "Unsubscribed", "Pending"] as const
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]

export const DELIVERABILITY_STATES = ["Unknown", "Deliverable", "Risky", "Bounced", "Complained"] as const
export type Deliverability = (typeof DELIVERABILITY_STATES)[number]

export const SEGMENT_TYPES = ["Static", "Dynamic"] as const
export type SegmentType = (typeof SEGMENT_TYPES)[number]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ContactConflictError extends Error {
  constructor(message = "This contact was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "ContactConflictError"
  }
}

export class ContactNotFoundError extends Error {
  constructor(message = "Contact not found") {
    super(message)
    this.name = "ContactNotFoundError"
  }
}

export type DuplicateContactMatch = {
  id: number
  contact_code: string
  full_name: string
  email: string | null
  phone: string | null
  reason: string
}

// ---------------------------------------------------------------------------
// Normalization + validation helpers
// ---------------------------------------------------------------------------

export { normalizeEmail, isValidEmail }

/** Reduce a phone number to digits (keeping a leading +) for dedupe + storage. */
export function normalizePhone(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  const hasPlus = raw.startsWith("+")
  const digits = raw.replace(/[^0-9]/g, "")
  if (!digits) return null
  return (hasPlus ? "+" : "") + digits
}

export function fullNameOf(first?: string | null, last?: string | null): string {
  return [String(first ?? "").trim(), String(last ?? "").trim()].filter(Boolean).join(" ").trim()
}

/** Split a single free-text name into first / last (best effort). */
export function splitName(name: string | null | undefined): { first: string; last: string } {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: "", last: "" }
  if (parts.length === 1) return { first: parts[0], last: "" }
  return { first: parts[0], last: parts.slice(1).join(" ") }
}

// ---------------------------------------------------------------------------
// Campaign eligibility — the single rule the whole module trusts
// ---------------------------------------------------------------------------

export type EligibilityChannel = "email" | "whatsapp" | "sms"

/**
 * Can this contact receive a campaign on the given channel right now?
 * Centralized so list badges, bulk sends, and segment previews all agree.
 */
export function isEligible(contact: Record<string, any>, channel: EligibilityChannel = "email"): boolean {
  if (contact.archived_at) return false
  if (contact.status !== "Active") return false
  if (channel === "email") {
    if (!contact.email) return false
    if (contact.email_subscription !== "Subscribed") return false
    if (contact.deliverability === "Bounced" || contact.deliverability === "Complained") return false
    return true
  }
  if (channel === "whatsapp") {
    return Boolean(contact.phone) && contact.whatsapp_subscription === "Subscribed"
  }
  // sms
  return Boolean(contact.phone) && contact.sms_subscription === "Subscribed"
}

export function eligibilityReason(contact: Record<string, any>, channel: EligibilityChannel = "email"): string {
  if (contact.archived_at) return "Archived"
  if (contact.status !== "Active") return "Inactive"
  if (channel === "email") {
    if (!contact.email) return "No email"
    if (contact.email_subscription === "Unsubscribed") return "Unsubscribed"
    if (contact.email_subscription === "Pending") return "Consent pending"
    if (contact.deliverability === "Bounced") return "Hard bounced"
    if (contact.deliverability === "Complained") return "Marked spam"
    return "Eligible"
  }
  if (channel === "whatsapp") {
    if (!contact.phone) return "No phone"
    if (contact.whatsapp_subscription !== "Subscribed") return "Not opted in"
    return "Eligible"
  }
  if (!contact.phone) return "No phone"
  if (contact.sms_subscription !== "Subscribed") return "Not opted in"
  return "Eligible"
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors a migration for existing databases)
// ---------------------------------------------------------------------------

let ensured = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumnIfMissing(table: string, column: string, ddl: string) {
  if (await columnExists(table, column)) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {})
}

async function addKeyIfMissing(table: string, keyName: string, ddl: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, keyName],
  )
  if (rows.length > 0) return
  await query(`ALTER TABLE \`${table}\` ADD ${ddl}`).catch(() => {})
}

export async function ensureContactSchema() {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_contacts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contact_code VARCHAR(40) NOT NULL,
      first_name VARCHAR(120) NULL,
      last_name VARCHAR(120) NULL,
      full_name VARCHAR(190) NOT NULL,
      email VARCHAR(190) NULL,
      email_normalized VARCHAR(190) NULL,
      phone VARCHAR(40) NULL,
      phone_normalized VARCHAR(40) NULL,
      company_name VARCHAR(190) NULL,
      job_title VARCHAR(150) NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'Manual',
      lifecycle_stage VARCHAR(30) NOT NULL DEFAULT 'Subscriber',
      status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
      owner_id INT UNSIGNED NULL,
      client_id BIGINT UNSIGNED NULL,
      lead_id BIGINT UNSIGNED NULL,
      email_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Subscribed',
      whatsapp_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending',
      sms_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending',
      consent TINYINT(1) NOT NULL DEFAULT 0,
      consent_source VARCHAR(120) NULL,
      consent_at DATETIME NULL,
      deliverability ENUM('Unknown','Deliverable','Risky','Bounced','Complained') NOT NULL DEFAULT 'Unknown',
      bounce_count INT UNSIGNED NOT NULL DEFAULT 0,
      lead_score INT NOT NULL DEFAULT 0,
      address VARCHAR(255) NULL,
      city VARCHAR(120) NULL,
      state VARCHAR(120) NULL,
      country VARCHAR(120) NULL,
      postal_code VARCHAR(30) NULL,
      language VARCHAR(40) NULL,
      timezone VARCHAR(60) NULL,
      last_activity_at DATETIME NULL,
      last_campaign_at DATETIME NULL,
      notes TEXT NULL,
      archived_at DATETIME NULL,
      archived_by INT UNSIGNED NULL,
      merged_into_id BIGINT UNSIGNED NULL,
      row_version INT UNSIGNED NOT NULL DEFAULT 1,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_contact_code (contact_code),
      KEY idx_mc_name (full_name),
      KEY idx_mc_email (email_normalized),
      KEY idx_mc_phone (phone_normalized),
      KEY idx_mc_status (status),
      KEY idx_mc_stage (lifecycle_stage),
      KEY idx_mc_owner (owner_id),
      KEY idx_mc_client (client_id),
      KEY idx_mc_lead (lead_id),
      KEY idx_mc_archived (archived_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Additive columns so an older marketing_contacts (if any) is upgraded in
  // place. Each is nullable / defaulted so existing rows keep working.
  const cols: [string, string][] = [
    ["email_normalized", "`email_normalized` VARCHAR(190) DEFAULT NULL"],
    ["phone_normalized", "`phone_normalized` VARCHAR(40) DEFAULT NULL"],
    ["lifecycle_stage", "`lifecycle_stage` VARCHAR(30) NOT NULL DEFAULT 'Subscriber'"],
    ["owner_id", "`owner_id` INT UNSIGNED DEFAULT NULL"],
    ["client_id", "`client_id` BIGINT UNSIGNED DEFAULT NULL"],
    ["lead_id", "`lead_id` BIGINT UNSIGNED DEFAULT NULL"],
    ["whatsapp_subscription", "`whatsapp_subscription` ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending'"],
    ["sms_subscription", "`sms_subscription` ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending'"],
    ["consent", "`consent` TINYINT(1) NOT NULL DEFAULT 0"],
    ["consent_source", "`consent_source` VARCHAR(120) DEFAULT NULL"],
    ["consent_at", "`consent_at` DATETIME DEFAULT NULL"],
    ["deliverability", "`deliverability` ENUM('Unknown','Deliverable','Risky','Bounced','Complained') NOT NULL DEFAULT 'Unknown'"],
    ["bounce_count", "`bounce_count` INT UNSIGNED NOT NULL DEFAULT 0"],
    ["lead_score", "`lead_score` INT NOT NULL DEFAULT 0"],
    ["last_activity_at", "`last_activity_at` DATETIME DEFAULT NULL"],
    ["last_campaign_at", "`last_campaign_at` DATETIME DEFAULT NULL"],
    ["archived_at", "`archived_at` DATETIME DEFAULT NULL"],
    ["archived_by", "`archived_by` INT UNSIGNED DEFAULT NULL"],
    ["merged_into_id", "`merged_into_id` BIGINT UNSIGNED DEFAULT NULL"],
    ["row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1"],
  ]

  try {
    for (const [c, ddl] of cols) await addColumnIfMissing("marketing_contacts", c, ddl)
    await addKeyIfMissing("marketing_contacts", "idx_mc_email", "KEY `idx_mc_email` (`email_normalized`)")
    await addKeyIfMissing("marketing_contacts", "idx_mc_phone", "KEY `idx_mc_phone` (`phone_normalized`)")
    await addKeyIfMissing("marketing_contacts", "idx_mc_client", "KEY `idx_mc_client` (`client_id`)")
    await addKeyIfMissing("marketing_contacts", "idx_mc_lead", "KEY `idx_mc_lead` (`lead_id`)")
  } catch (error) {
    console.error("[contacts-db] marketing_contacts self-heal failed", error)
  }

  // Tags (many per contact, filterable).
  await query(
    `CREATE TABLE IF NOT EXISTS marketing_contact_tags (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contact_id BIGINT UNSIGNED NOT NULL,
      tag VARCHAR(80) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_contact_tag (contact_id, tag),
      KEY idx_mct_tag (tag)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Append-only activity + audit timeline.
  await query(
    `CREATE TABLE IF NOT EXISTS marketing_contact_activity (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contact_id BIGINT UNSIGNED NOT NULL,
      contact_code VARCHAR(40) NULL,
      type VARCHAR(40) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      meta JSON NULL,
      actor_id INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mca_contact (contact_id),
      KEY idx_mca_type (type),
      KEY idx_mca_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Segments (static lists or dynamic saved filters).
  await query(
    `CREATE TABLE IF NOT EXISTS marketing_segments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      segment_code VARCHAR(40) NOT NULL,
      name VARCHAR(150) NOT NULL,
      description VARCHAR(255) NULL,
      type ENUM('Static','Dynamic') NOT NULL DEFAULT 'Static',
      rules JSON NULL,
      color VARCHAR(20) NULL,
      created_by INT UNSIGNED NULL,
      archived_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_segment_code (segment_code),
      KEY idx_seg_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_segment_members (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      segment_id BIGINT UNSIGNED NOT NULL,
      contact_id BIGINT UNSIGNED NOT NULL,
      added_by INT UNSIGNED NULL,
      added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_segment_member (segment_id, contact_id),
      KEY idx_sm_contact (contact_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Register module features so the permission matrix can gate this screen.
  // No-op when the marketing module row does not exist.
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Contacts','marketing.contacts.view','View marketing contacts and segments',70 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Contacts','marketing.contacts.manage','Add, edit, import and merge marketing contacts',71 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})

  ensured = true
}

// ---------------------------------------------------------------------------
// Activity / audit
// ---------------------------------------------------------------------------

export async function recordContactActivity(input: {
  contactId: number
  contactCode?: string | null
  type: string
  summary: string
  meta?: Record<string, any> | null
  actorId?: number | null
}): Promise<void> {
  await query(
    `INSERT INTO marketing_contact_activity (contact_id, contact_code, type, summary, meta, actor_id)
     VALUES (?,?,?,?,?,?)`,
    [
      input.contactId,
      input.contactCode ?? null,
      input.type,
      input.summary.slice(0, 255),
      input.meta ? JSON.stringify(input.meta) : null,
      input.actorId ?? null,
    ],
  ).catch((e) => console.error("[contacts-db] recordContactActivity failed", e))
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export async function findContactDuplicates(input: {
  email?: string | null
  phone?: string | null
  excludeId?: number | null
}): Promise<DuplicateContactMatch[]> {
  const email = normalizeEmail(input.email)
  const phone = normalizePhone(input.phone)
  if (!email && !phone) return []

  const clauses: string[] = []
  const args: any[] = []
  if (email) {
    clauses.push("email_normalized = ?")
    args.push(email)
  }
  if (phone) {
    clauses.push("phone_normalized = ?")
    args.push(phone)
  }
  let sql = `SELECT id, contact_code, full_name, email, phone, email_normalized, phone_normalized
             FROM marketing_contacts
             WHERE archived_at IS NULL AND (${clauses.join(" OR ")})`
  if (input.excludeId) {
    sql += " AND id <> ?"
    args.push(input.excludeId)
  }
  const rows = await query<any[]>(sql, args).catch(() => [] as any[])

  return rows.map((r) => {
    const reasons: string[] = []
    if (email && r.email_normalized === email) reasons.push("same email")
    if (phone && r.phone_normalized === phone) reasons.push("same phone")
    return {
      id: r.id,
      contact_code: r.contact_code,
      full_name: r.full_name,
      email: r.email,
      phone: r.phone,
      reason: reasons.join(", "),
    }
  })
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function cleanTag(tag: string): string {
  return String(tag ?? "").trim().replace(/\s+/g, " ").slice(0, 80)
}

export async function setContactTags(contactId: number, tags: string[]): Promise<void> {
  const clean = Array.from(new Set(tags.map(cleanTag).filter(Boolean)))
  await query(`DELETE FROM marketing_contact_tags WHERE contact_id = ?`, [contactId]).catch(() => {})
  for (const tag of clean) {
    await query(`INSERT IGNORE INTO marketing_contact_tags (contact_id, tag) VALUES (?,?)`, [contactId, tag]).catch(
      () => {},
    )
  }
}

export async function getTagsForContacts(ids: number[]): Promise<Record<number, string[]>> {
  if (ids.length === 0) return {}
  const rows = await query<any[]>(
    `SELECT contact_id, tag FROM marketing_contact_tags WHERE contact_id IN (${ids.map(() => "?").join(",")}) ORDER BY tag`,
    ids,
  ).catch(() => [] as any[])
  const out: Record<number, string[]> = {}
  for (const r of rows) {
    ;(out[r.contact_id] ||= []).push(r.tag)
  }
  return out
}

export async function getAllTags(): Promise<{ tag: string; count: number }[]> {
  return query<any[]>(
    `SELECT t.tag, COUNT(*) AS count
       FROM marketing_contact_tags t
       JOIN marketing_contacts c ON c.id = t.contact_id AND c.archived_at IS NULL
      GROUP BY t.tag ORDER BY count DESC, t.tag ASC`,
  ).catch(() => [] as any[])
}

// ---------------------------------------------------------------------------
// Field allow-list + derivation
// ---------------------------------------------------------------------------

/** Columns a request may set directly. Derived/owned fields are never trusted. */
export const CONTACT_WRITABLE = new Set([
  "first_name",
  "last_name",
  "email",
  "phone",
  "company_name",
  "job_title",
  "source",
  "lifecycle_stage",
  "status",
  "owner_id",
  "client_id",
  "lead_id",
  "email_subscription",
  "whatsapp_subscription",
  "sms_subscription",
  "consent",
  "consent_source",
  "deliverability",
  "lead_score",
  "address",
  "city",
  "state",
  "country",
  "postal_code",
  "language",
  "timezone",
  "notes",
])

/** Build a normalized, server-owned column map from a request body. */
export function buildContactColumns(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of Object.keys(body)) {
    if (CONTACT_WRITABLE.has(key)) out[key] = body[key] === "" ? null : body[key]
  }
  const first = String(body.first_name ?? "").trim() || null
  const last = String(body.last_name ?? "").trim() || null
  const derivedName = fullNameOf(first, last)
  out.first_name = first
  out.last_name = last
  out.full_name = derivedName || String(body.full_name ?? "").trim() || String(body.email ?? "").trim() || "Unnamed"
  out.email = normalizeEmail(body.email)
  out.email_normalized = out.email
  out.phone = normalizePhone(body.phone)
  out.phone_normalized = out.phone
  if (body.consent !== undefined) out.consent = body.consent ? 1 : 0
  return out
}

export function validateContact(body: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {}
  const hasName = String(body.first_name ?? "").trim() || String(body.last_name ?? "").trim() || String(body.full_name ?? "").trim()
  if (!hasName) errors.first_name = "A name is required"
  const email = String(body.email ?? "").trim()
  const phone = String(body.phone ?? "").trim()
  if (!email && !phone) errors.email = "An email or phone number is required"
  if (email && !isValidEmail(email)) errors.email = "Enter a valid email address"
  return errors
}

// ---------------------------------------------------------------------------
// Sync from canonical masters (Clients / Leads) — never duplicates
// ---------------------------------------------------------------------------

/**
 * Upsert a marketing contact from a canonical source row. Matches an existing
 * contact by the source link first, then by email, then by phone, so a person
 * already imported by email is linked rather than duplicated. Returns
 * "created" | "updated" | "skipped".
 */
async function upsertFromSource(input: {
  linkField: "client_id" | "lead_id"
  linkId: number
  source: ContactSource
  first_name: string | null
  last_name: string | null
  full_name: string
  email: string | null
  phone: string | null
  company_name: string | null
  job_title: string | null
  owner_id: number | null
  city?: string | null
  state?: string | null
  country?: string | null
  actorId?: number | null
}): Promise<"created" | "updated" | "skipped"> {
  const email = normalizeEmail(input.email)
  const phone = normalizePhone(input.phone)
  if (!email && !phone) return "skipped"

  // Find an existing contact: source link > email > phone.
  const found = await query<any[]>(
    `SELECT id, contact_code FROM marketing_contacts
      WHERE ${input.linkField} = ?
         ${email ? "OR email_normalized = ?" : ""}
         ${phone ? "OR phone_normalized = ?" : ""}
      ORDER BY (${input.linkField} = ?) DESC
      LIMIT 1`,
    [
      input.linkId,
      ...(email ? [email] : []),
      ...(phone ? [phone] : []),
      input.linkId,
    ],
  ).catch(() => [] as any[])

  if (found.length > 0) {
    const id = found[0].id
    await query(
      `UPDATE marketing_contacts
          SET ${input.linkField} = ?,
              company_name = COALESCE(NULLIF(company_name,''), ?),
              job_title = COALESCE(NULLIF(job_title,''), ?),
              owner_id = COALESCE(owner_id, ?),
              row_version = row_version + 1
        WHERE id = ?`,
      [input.linkId, input.company_name, input.job_title, input.owner_id, id],
    ).catch(() => {})
    return "updated"
  }

  const { nextRecordId } = await import("@/lib/record-ids")
  const code = await nextRecordId("MKC", { allowCustom: true, digits: 6 })
  const res = await query<any>(
    `INSERT INTO marketing_contacts
       (contact_code, first_name, last_name, full_name, email, email_normalized, phone, phone_normalized,
        company_name, job_title, source, lifecycle_stage, ${input.linkField}, owner_id, city, state, country,
        email_subscription, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code,
      input.first_name,
      input.last_name,
      input.full_name || email || phone,
      email,
      email,
      phone,
      phone,
      input.company_name,
      input.job_title,
      input.source,
      input.linkField === "client_id" ? "Customer" : "Lead",
      input.linkId,
      input.owner_id,
      input.city ?? null,
      input.state ?? null,
      input.country ?? null,
      "Pending",
      input.actorId ?? null,
    ],
  ).catch((e) => {
    console.error("[contacts-db] upsertFromSource insert failed", e)
    return null
  })
  if (!res) return "skipped"
  const newId = Number((res as any).insertId)
  if (newId) {
    await recordContactActivity({
      contactId: newId,
      contactCode: code,
      type: "sync",
      summary: `Imported from ${input.source}`,
      meta: { [input.linkField]: input.linkId },
      actorId: input.actorId ?? null,
    })
  }
  return "created"
}

export async function syncFromClients(actorId?: number | null): Promise<{ created: number; updated: number; skipped: number }> {
  const stats = { created: 0, updated: 0, skipped: 0 }
  const rows = await query<any[]>(
    `SELECT id, client_name, email, mobile, company_name, city, state, country, account_manager_id
       FROM clients WHERE archived_at IS NULL`,
  ).catch(() => [] as any[])
  for (const r of rows) {
    const { first, last } = splitName(r.client_name)
    const outcome = await upsertFromSource({
      linkField: "client_id",
      linkId: r.id,
      source: "Client Sync",
      first_name: first || null,
      last_name: last || null,
      full_name: r.client_name || "",
      email: r.email,
      phone: r.mobile,
      company_name: r.company_name,
      job_title: null,
      owner_id: r.account_manager_id ?? null,
      city: r.city,
      state: r.state,
      country: r.country,
      actorId,
    })
    stats[outcome]++
  }
  return stats
}

export async function syncFromLeads(actorId?: number | null): Promise<{ created: number; updated: number; skipped: number }> {
  const stats = { created: 0, updated: 0, skipped: 0 }
  const rows = await query<any[]>(
    `SELECT id, contact_person, email, contact_number, company_name, designation, country, assigned_to
       FROM sales_leads WHERE archived_at IS NULL`,
  ).catch(() => [] as any[])
  for (const r of rows) {
    const { first, last } = splitName(r.contact_person)
    const outcome = await upsertFromSource({
      linkField: "lead_id",
      linkId: r.id,
      source: "Lead Sync",
      first_name: first || null,
      last_name: last || null,
      full_name: r.contact_person || "",
      email: r.email,
      phone: r.contact_number,
      company_name: r.company_name,
      job_title: r.designation,
      owner_id: r.assigned_to ?? null,
      country: r.country,
      actorId,
    })
    stats[outcome]++
  }
  return stats
}

// ---------------------------------------------------------------------------
// Merge (fold a duplicate into a survivor, never lose links or history)
// ---------------------------------------------------------------------------

export async function mergeContacts(input: {
  survivorId: number
  duplicateId: number
  actorId?: number | null
}): Promise<void> {
  const { survivorId, duplicateId } = input
  if (survivorId === duplicateId) return

  const rows = await query<any[]>(
    `SELECT id, contact_code, full_name FROM marketing_contacts WHERE id IN (?,?)`,
    [survivorId, duplicateId],
  )
  const survivor = rows.find((r) => r.id === survivorId)
  const dup = rows.find((r) => r.id === duplicateId)
  if (!survivor || !dup) throw new ContactNotFoundError()

  // Move tags, activity, and segment memberships onto the survivor.
  await query(
    `UPDATE IGNORE marketing_contact_tags SET contact_id = ? WHERE contact_id = ?`,
    [survivorId, duplicateId],
  ).catch(() => {})
  await query(`DELETE FROM marketing_contact_tags WHERE contact_id = ?`, [duplicateId]).catch(() => {})
  await query(`UPDATE marketing_contact_activity SET contact_id = ? WHERE contact_id = ?`, [survivorId, duplicateId]).catch(
    () => {},
  )
  await query(
    `UPDATE IGNORE marketing_segment_members SET contact_id = ? WHERE contact_id = ?`,
    [survivorId, duplicateId],
  ).catch(() => {})
  await query(`DELETE FROM marketing_segment_members WHERE contact_id = ?`, [duplicateId]).catch(() => {})

  // Backfill any empty survivor field from the duplicate + inherit links.
  await query(
    `UPDATE marketing_contacts s
       JOIN marketing_contacts d ON d.id = ?
        SET s.email = COALESCE(s.email, d.email),
            s.email_normalized = COALESCE(s.email_normalized, d.email_normalized),
            s.phone = COALESCE(s.phone, d.phone),
            s.phone_normalized = COALESCE(s.phone_normalized, d.phone_normalized),
            s.company_name = COALESCE(NULLIF(s.company_name,''), d.company_name),
            s.job_title = COALESCE(NULLIF(s.job_title,''), d.job_title),
            s.client_id = COALESCE(s.client_id, d.client_id),
            s.lead_id = COALESCE(s.lead_id, d.lead_id),
            s.owner_id = COALESCE(s.owner_id, d.owner_id),
            s.row_version = s.row_version + 1
      WHERE s.id = ?`,
    [duplicateId, survivorId],
  ).catch(() => {})

  // Tombstone the duplicate (archived + pointer to survivor).
  await query(
    `UPDATE marketing_contacts SET archived_at = NOW(), archived_by = ?, merged_into_id = ?, row_version = row_version + 1 WHERE id = ?`,
    [input.actorId ?? null, survivorId, duplicateId],
  )

  await recordContactActivity({
    contactId: survivorId,
    contactCode: survivor.contact_code,
    type: "merge",
    summary: `Merged ${dup.contact_code} (${dup.full_name}) into this contact`,
    meta: { merged_from: dup.contact_code },
    actorId: input.actorId ?? null,
  })
}
