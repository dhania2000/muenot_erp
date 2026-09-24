import "server-only"
/**
 * SPEC 108 — Contact Management: data layer (Phase 2 & 3).
 * ---------------------------------------------------------------------------
 * The ONE place that mutates centralized contact state. Mirrors the
 * self-healing approach used by lib/clients-db.ts and lib/sales/company-master.ts:
 * the schema is created / upgraded at runtime so existing databases converge
 * without a manual migration, then every read/write is tenant-scoped.
 *
 * A contact is the canonical person/company record and LINKS back to the
 * modules it appears in (clients, customers_vendors, sales_companies,
 * sales_contacts, marketing_contacts) rather than duplicating them — see
 * model.ts for the Phase 1 audit and the reasoning.
 */

import { query, pool } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { currentTenantId } from "@/lib/tenant-scope"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import {
  buildContactColumns,
  CONTACT_WRITABLE,
  ContactConflictError,
  ContactNotFoundError,
  findContactDuplicateMatches,
  normalizeGstin,
  normalizePan,
  panFromGstin,
  sanitizeAddresses,
  sanitizeChannels,
  sanitizeEmails,
  sanitizePhones,
  type ContactAddressInput,
  type ContactChannelInput,
} from "@/lib/contacts/model"

let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}
async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  return rows.length > 0
}
async function addKeyIfMissing(table: string, index: string, ddl: string): Promise<void> {
  if (!(await indexExists(table, index))) {
    await query(`ALTER TABLE \`${table}\` ADD ${ddl}`).catch(() => {})
  }
}

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS \`contacts\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`contact_code\` VARCHAR(40) NOT NULL,
    \`contact_type\` ENUM('Person','Company') NOT NULL DEFAULT 'Person',
    \`salutation\` VARCHAR(20) DEFAULT NULL,
    \`first_name\` VARCHAR(120) DEFAULT NULL,
    \`last_name\` VARCHAR(120) DEFAULT NULL,
    \`full_name\` VARCHAR(190) NOT NULL,
    \`company_name\` VARCHAR(190) DEFAULT NULL,
    \`role\` VARCHAR(150) DEFAULT NULL,
    \`department\` VARCHAR(150) DEFAULT NULL,
    \`email\` VARCHAR(190) DEFAULT NULL,
    \`email_normalized\` VARCHAR(190) DEFAULT NULL,
    \`phone\` VARCHAR(40) DEFAULT NULL,
    \`phone_normalized\` VARCHAR(40) DEFAULT NULL,
    \`is_customer\` TINYINT(1) NOT NULL DEFAULT 0,
    \`is_vendor\` TINYINT(1) NOT NULL DEFAULT 0,
    \`gstin\` VARCHAR(20) DEFAULT NULL,
    \`pan\` VARCHAR(20) DEFAULT NULL,
    \`client_id\` INT UNSIGNED DEFAULT NULL,
    \`finance_party_id\` VARCHAR(40) DEFAULT NULL,
    \`sales_company_id\` INT UNSIGNED DEFAULT NULL,
    \`sales_contact_id\` INT UNSIGNED DEFAULT NULL,
    \`marketing_contact_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`owner_id\` INT UNSIGNED DEFAULT NULL,
    \`status\` ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
    \`notes\` TEXT DEFAULT NULL,
    \`merged_into_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`archived_at\` DATETIME DEFAULT NULL,
    \`archived_by\` INT UNSIGNED DEFAULT NULL,
    \`row_version\` INT UNSIGNED NOT NULL DEFAULT 1,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`tenant_id\` INT UNSIGNED DEFAULT NULL,
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uq_contacts_code\` (\`contact_code\`),
    KEY \`idx_contacts_type\` (\`contact_type\`),
    KEY \`idx_contacts_email\` (\`email_normalized\`),
    KEY \`idx_contacts_phone\` (\`phone_normalized\`),
    KEY \`idx_contacts_gstin\` (\`gstin\`),
    KEY \`idx_contacts_archived\` (\`archived_at\`),
    KEY \`idx_contacts_client\` (\`client_id\`),
    KEY \`idx_contacts_party\` (\`finance_party_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS \`contact_emails\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`contact_id\` BIGINT UNSIGNED NOT NULL,
    \`email\` VARCHAR(190) NOT NULL,
    \`email_normalized\` VARCHAR(190) NOT NULL,
    \`label\` VARCHAR(60) DEFAULT NULL,
    \`is_primary\` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (\`id\`),
    KEY \`idx_contact_emails_contact\` (\`contact_id\`),
    KEY \`idx_contact_emails_norm\` (\`email_normalized\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS \`contact_phones\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`contact_id\` BIGINT UNSIGNED NOT NULL,
    \`phone\` VARCHAR(40) NOT NULL,
    \`phone_normalized\` VARCHAR(40) NOT NULL,
    \`label\` VARCHAR(60) DEFAULT NULL,
    \`is_primary\` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (\`id\`),
    KEY \`idx_contact_phones_contact\` (\`contact_id\`),
    KEY \`idx_contact_phones_norm\` (\`phone_normalized\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS \`contact_channels\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`contact_id\` BIGINT UNSIGNED NOT NULL,
    \`channel_type\` VARCHAR(40) NOT NULL,
    \`value\` VARCHAR(255) NOT NULL,
    \`label\` VARCHAR(60) DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    KEY \`idx_contact_channels_contact\` (\`contact_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS \`contact_addresses\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`contact_id\` BIGINT UNSIGNED NOT NULL,
    \`address_type\` VARCHAR(40) DEFAULT NULL,
    \`line1\` VARCHAR(255) DEFAULT NULL,
    \`line2\` VARCHAR(255) DEFAULT NULL,
    \`city\` VARCHAR(120) DEFAULT NULL,
    \`state\` VARCHAR(120) DEFAULT NULL,
    \`country\` VARCHAR(120) DEFAULT NULL,
    \`postal_code\` VARCHAR(30) DEFAULT NULL,
    \`is_primary\` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (\`id\`),
    KEY \`idx_contact_addresses_contact\` (\`contact_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Register the module features so the permission matrix can grant them.
  await registerContactFeatures()
  // Ensure tenant_id column/index/FK on the new tables.
  await ensureTenantIsolation()
}

/**
 * Insert the two contact features into the feature registry if the table exists
 * and they are missing. Non-fatal: a fresh DB that seeds features elsewhere
 * still works, and permission checks fall back safely.
 */
async function registerContactFeatures(): Promise<void> {
  const hasFeatures = await query<any[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'features' LIMIT 1`,
  ).catch(() => [] as any[])
  if (hasFeatures.length === 0) return
  const cols = await query<any[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'features'`,
  ).catch(() => [] as any[])
  const names = new Set(cols.map((c: any) => String(c.column_name || c.COLUMN_NAME)))
  if (!names.has("feature_key") && !names.has("key")) return
  const keyCol = names.has("feature_key") ? "feature_key" : "key"
  const rows: Array<[string, string, string]> = [
    ["clients.view_contacts", "View Contacts", "clients"],
    ["clients.manage_contacts", "Manage Contacts", "clients"],
  ]
  for (const [key, label, moduleSlug] of rows) {
    const fields = [keyCol]
    const values: any[] = [key]
    if (names.has("name")) {
      fields.push("name")
      values.push(label)
    } else if (names.has("label")) {
      fields.push("label")
      values.push(label)
    }
    if (names.has("module")) {
      fields.push("module")
      values.push(moduleSlug)
    } else if (names.has("module_slug")) {
      fields.push("module_slug")
      values.push(moduleSlug)
    }
    await query(
      `INSERT IGNORE INTO \`features\` (${fields.map((f) => `\`${f}\``).join(",")}) VALUES (${fields
        .map(() => "?")
        .join(",")})`,
      values,
    ).catch(() => {})
  }
}

export async function ensureContactTables(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactRow = Record<string, any> & {
  id: number
  contact_code: string
  contact_type: "Person" | "Company"
  full_name: string
  row_version: number
}

export type ContactWriteInput = Record<string, any> & {
  emails?: unknown
  phones?: unknown
  channels?: unknown
  addresses?: unknown
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type ContactDuplicate = {
  id: number
  contact_code: string
  full_name: string
  company_name: string | null
  email: string | null
  phone: string | null
  gstin: string | null
  pan: string | null
  classification: string
  score: number
  reason: string
}

/**
 * Find likely duplicates of a target contact within the caller's tenant. Uses
 * the pure model to score DB candidates; `excludeId` skips the record itself on
 * update so it never matches against itself.
 */
export async function findContactDuplicates(
  target: {
    full_name?: string | null
    first_name?: string | null
    last_name?: string | null
    company_name?: string | null
    email?: string | null
    phone?: string | null
    gstin?: string | null
    pan?: string | null
  },
  excludeId?: number | null,
): Promise<ContactDuplicate[]> {
  const tenantId = currentTenantId()
  // Narrow the candidate set at the DB with cheap indexed predicates, then let
  // the model do the authoritative fuzzy scoring.
  const gstin = normalizeGstin(target.gstin)
  const pan = normalizePan(target.pan) || panFromGstin(gstin)
  const email = (target.email ?? "").trim().toLowerCase() || null
  const name = (target.full_name || [target.first_name, target.last_name].filter(Boolean).join(" ")).trim()
  const nameToken = name.split(/\s+/)[0] || ""

  const candidates = await query<any[]>(
    `SELECT id, contact_code, contact_type, full_name, company_name, email, phone, gstin, pan
       FROM contacts
      WHERE tenant_id = ? AND archived_at IS NULL
        AND (
          (? IS NOT NULL AND email IS NOT NULL AND LOWER(email) = ?)
          OR (? IS NOT NULL AND gstin = ?)
          OR (? IS NOT NULL AND pan = ?)
          OR (? <> '' AND (full_name LIKE ? OR company_name LIKE ?))
        )
      LIMIT 400`,
    [tenantId, email, email, gstin, gstin, pan, pan, nameToken, `%${nameToken}%`, `%${nameToken}%`],
  ).catch(() => [] as any[])

  const matches = findContactDuplicateMatches(
    { ...target, full_name: name, gstin, pan },
    candidates.map((c) => ({
      ...c,
      // Map DB columns into the config's field names for scoring.
      name: c.full_name,
      company: c.company_name,
    })),
    { excludeId: excludeId ?? null, minClassification: "possible", limit: 25 },
  )

  return matches.map((m) => ({
    id: Number(m.candidate.id),
    contact_code: String((m.candidate as any).contact_code),
    full_name: (m.candidate as any).full_name,
    company_name: (m.candidate as any).company_name ?? null,
    email: (m.candidate as any).email ?? null,
    phone: (m.candidate as any).phone ?? null,
    gstin: (m.candidate as any).gstin ?? null,
    pan: (m.candidate as any).pan ?? null,
    classification: m.classification,
    score: m.score,
    reason: m.matchedFields.join(", ") || m.classification,
  }))
}

// ---------------------------------------------------------------------------
// Link resolution — connect a contact to canonical module records (Phase 3)
// ---------------------------------------------------------------------------

export type ContactLinkResolution = {
  client_id: number | null
  finance_party_id: string | null
  sales_company_id: number | null
  sales_contact_id: number | null
  marketing_contact_id: number | null
}

/**
 * Resolve which existing module records this contact represents WITHOUT ever
 * creating them. Honors any explicit ids the caller passed, then fills the
 * blanks from an unambiguous email / GSTIN / PAN / name match. This is how the
 * central contact stays connected to CRM, Finance, Sales and Marketing without
 * becoming yet another duplicate.
 */
export async function resolveContactLinks(input: {
  client_id?: number | null
  finance_party_id?: string | null
  sales_company_id?: number | null
  sales_contact_id?: number | null
  marketing_contact_id?: number | null
  email?: string | null
  gstin?: string | null
  pan?: string | null
  company_name?: string | null
  full_name?: string | null
}): Promise<ContactLinkResolution> {
  const out: ContactLinkResolution = {
    client_id: input.client_id ?? null,
    finance_party_id: input.finance_party_id ?? null,
    sales_company_id: input.sales_company_id ?? null,
    sales_contact_id: input.sales_contact_id ?? null,
    marketing_contact_id: input.marketing_contact_id ?? null,
  }
  const email = (input.email ?? "").trim().toLowerCase() || null
  const gstin = normalizeGstin(input.gstin)
  const pan = normalizePan(input.pan) || panFromGstin(gstin)

  // Finance party (customers_vendors) — unambiguous GSTIN then PAN.
  if (!out.finance_party_id && (gstin || pan)) {
    const rows = await query<any[]>(
      `SELECT party_id FROM customers_vendors
        WHERE (? IS NOT NULL AND UPPER(gstin) = ?) OR (? IS NOT NULL AND UPPER(pan) = ?)
        LIMIT 2`,
      [gstin, gstin, pan, pan],
    ).catch(() => [] as any[])
    if (rows.length === 1) out.finance_party_id = String(rows[0].party_id)
  }

  // Client (CRM party) — unambiguous email.
  if (!out.client_id && email) {
    const rows = await query<any[]>(
      `SELECT id FROM clients WHERE LOWER(email) = ? AND archived_at IS NULL LIMIT 2`,
      [email],
    ).catch(() => [] as any[])
    if (rows.length === 1) out.client_id = Number(rows[0].id)
  }

  // Sales contact — unambiguous email; also carry its parent company.
  if (!out.sales_contact_id && email) {
    const rows = await query<any[]>(
      `SELECT id, company_id FROM sales_contacts WHERE LOWER(email) = ? LIMIT 2`,
      [email],
    ).catch(() => [] as any[])
    if (rows.length === 1) {
      out.sales_contact_id = Number(rows[0].id)
      if (!out.sales_company_id && rows[0].company_id) out.sales_company_id = Number(rows[0].company_id)
    }
  }

  // Marketing contact — unambiguous email.
  if (!out.marketing_contact_id && email) {
    const rows = await query<any[]>(
      `SELECT id FROM marketing_contacts WHERE LOWER(email) = ? LIMIT 2`,
      [email],
    ).catch(() => [] as any[])
    if (rows.length === 1) out.marketing_contact_id = Number(rows[0].id)
  }

  return out
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listContacts(opts: {
  includeArchived?: boolean
  search?: string | null
  type?: string | null
  relationship?: "customer" | "vendor" | null
} = {}): Promise<ContactRow[]> {
  const tenantId = currentTenantId()
  const clauses = ["c.tenant_id = ?"]
  const args: any[] = [tenantId]
  if (!opts.includeArchived) clauses.push("c.archived_at IS NULL")
  if (opts.type === "Person" || opts.type === "Company") {
    clauses.push("c.contact_type = ?")
    args.push(opts.type)
  }
  if (opts.relationship === "customer") clauses.push("c.is_customer = 1")
  if (opts.relationship === "vendor") clauses.push("c.is_vendor = 1")
  if (opts.search) {
    clauses.push("(c.full_name LIKE ? OR c.company_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.contact_code LIKE ?)")
    const like = `%${opts.search}%`
    args.push(like, like, like, like, like)
  }
  return query<ContactRow[]>(
    `SELECT c.*, cl.client_code, cv.customer_name AS finance_party_name,
            sc.company_name AS sales_company_name, u.name AS owner_name
       FROM contacts c
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN customers_vendors cv ON cv.party_id = c.finance_party_id
       LEFT JOIN sales_companies sc ON sc.id = c.sales_company_id
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.created_at DESC`,
    args,
  )
}

export async function getContact(id: number): Promise<(ContactRow & {
  emails: any[]
  phones: any[]
  channels: any[]
  addresses: any[]
}) | null> {
  const tenantId = currentTenantId()
  const rows = await query<ContactRow[]>(
    `SELECT c.*, cl.client_code, cv.customer_name AS finance_party_name,
            sc.company_name AS sales_company_name, u.name AS owner_name
       FROM contacts c
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN customers_vendors cv ON cv.party_id = c.finance_party_id
       LEFT JOIN sales_companies sc ON sc.id = c.sales_company_id
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = ? AND c.tenant_id = ? LIMIT 1`,
    [id, tenantId],
  )
  if (rows.length === 0) return null
  const [emails, phones, channels, addresses] = await Promise.all([
    query<any[]>(`SELECT * FROM contact_emails WHERE contact_id = ? ORDER BY is_primary DESC, id ASC`, [id]),
    query<any[]>(`SELECT * FROM contact_phones WHERE contact_id = ? ORDER BY is_primary DESC, id ASC`, [id]),
    query<any[]>(`SELECT * FROM contact_channels WHERE contact_id = ? ORDER BY id ASC`, [id]),
    query<any[]>(`SELECT * FROM contact_addresses WHERE contact_id = ? ORDER BY is_primary DESC, id ASC`, [id]),
  ])
  return { ...rows[0], emails, phones, channels, addresses }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function replaceChildren(conn: any, contactId: number, input: ContactWriteInput): Promise<void> {
  const emails = sanitizeEmails(input.emails)
  const phones = sanitizePhones(input.phones)
  const channels: ContactChannelInput[] = sanitizeChannels(input.channels)
  const addresses: ContactAddressInput[] = sanitizeAddresses(input.addresses)

  await conn.query(`DELETE FROM contact_emails WHERE contact_id = ?`, [contactId])
  await conn.query(`DELETE FROM contact_phones WHERE contact_id = ?`, [contactId])
  await conn.query(`DELETE FROM contact_channels WHERE contact_id = ?`, [contactId])
  await conn.query(`DELETE FROM contact_addresses WHERE contact_id = ?`, [contactId])

  for (const e of emails) {
    await conn.query(
      `INSERT INTO contact_emails (contact_id, email, email_normalized, label, is_primary) VALUES (?,?,?,?,?)`,
      [contactId, e.email, e.email_normalized, e.label ?? null, e.is_primary ? 1 : 0],
    )
  }
  for (const p of phones) {
    await conn.query(
      `INSERT INTO contact_phones (contact_id, phone, phone_normalized, label, is_primary) VALUES (?,?,?,?,?)`,
      [contactId, p.phone, p.phone_normalized, p.label ?? null, p.is_primary ? 1 : 0],
    )
  }
  for (const ch of channels) {
    await conn.query(
      `INSERT INTO contact_channels (contact_id, channel_type, value, label) VALUES (?,?,?,?)`,
      [contactId, ch.channel_type, ch.value, ch.label ?? null],
    )
  }
  for (const a of addresses) {
    await conn.query(
      `INSERT INTO contact_addresses (contact_id, address_type, line1, line2, city, state, country, postal_code, is_primary)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [contactId, a.address_type ?? null, a.line1 ?? null, a.line2 ?? null, a.city ?? null, a.state ?? null, a.country ?? null, a.postal_code ?? null, a.is_primary ? 1 : 0],
    )
  }
}

export async function createContact(
  input: ContactWriteInput,
  actorId: number | null,
): Promise<{ id: number; contact_code: string; links: ContactLinkResolution }> {
  const cols = buildContactColumns(input)
  const links = await resolveContactLinks({
    client_id: cols.client_id,
    finance_party_id: cols.finance_party_id,
    sales_company_id: cols.sales_company_id,
    sales_contact_id: cols.sales_contact_id,
    marketing_contact_id: cols.marketing_contact_id,
    email: cols.email,
    gstin: cols.gstin,
    pan: cols.pan,
    company_name: cols.company_name,
    full_name: cols.full_name,
  })
  Object.assign(cols, links)

  const contactCode = await nextRecordId("CON", { allowCustom: true })
  const tenantId = currentTenantId()

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const fields = ["contact_code", ...Object.keys(cols), "created_by", "tenant_id"]
    const values = [contactCode, ...Object.keys(cols).map((k) => cols[k]), actorId, tenantId]
    const [res] = await conn.query<any>(
      `INSERT INTO contacts (${fields.map((f) => `\`${f}\``).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
      values,
    )
    const id = Number(res.insertId)
    // Seed the child collections; also fold in the primary email/phone so the
    // collection is never empty when only the top-level fields were provided.
    const emails = Array.isArray(input.emails) ? [...input.emails] : []
    if (cols.email && !emails.some((e: any) => (typeof e === "string" ? e : e?.email)?.toLowerCase?.() === cols.email))
      emails.unshift({ email: cols.email, label: "Work", is_primary: true })
    const phones = Array.isArray(input.phones) ? [...input.phones] : []
    if (cols.phone && !phones.some((p: any) => (typeof p === "string" ? p : p?.phone) === cols.phone))
      phones.unshift({ phone: cols.phone, label: "Work", is_primary: true })
    await replaceChildren(conn, id, { ...input, emails, phones })
    await conn.commit()
    return { id, contact_code: contactCode, links }
  } catch (err) {
    await conn.rollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }
}

export async function updateContact(
  id: number,
  input: ContactWriteInput,
  expectedVersion: number | null,
  actorId: number | null,
): Promise<{ ok: true }> {
  const tenantId = currentTenantId()
  const existing = await query<any[]>(`SELECT id, row_version FROM contacts WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    id,
    tenantId,
  ])
  if (existing.length === 0) throw new ContactNotFoundError()
  if (expectedVersion != null && Number(existing[0].row_version) !== Number(expectedVersion)) {
    throw new ContactConflictError()
  }

  const cols = buildContactColumns(input)
  const links = await resolveContactLinks({
    client_id: cols.client_id,
    finance_party_id: cols.finance_party_id,
    sales_company_id: cols.sales_company_id,
    sales_contact_id: cols.sales_contact_id,
    marketing_contact_id: cols.marketing_contact_id,
    email: cols.email,
    gstin: cols.gstin,
    pan: cols.pan,
    company_name: cols.company_name,
    full_name: cols.full_name,
  })
  Object.assign(cols, links)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const setKeys = Object.keys(cols)
    await conn.query(
      `UPDATE contacts SET ${setKeys.map((k) => `\`${k}\` = ?`).join(", ")}, row_version = row_version + 1 WHERE id = ? AND tenant_id = ?`,
      [...setKeys.map((k) => cols[k]), id, tenantId],
    )
    const emails = Array.isArray(input.emails) ? [...input.emails] : []
    if (cols.email && !emails.some((e: any) => (typeof e === "string" ? e : e?.email)?.toLowerCase?.() === cols.email))
      emails.unshift({ email: cols.email, label: "Work", is_primary: true })
    const phones = Array.isArray(input.phones) ? [...input.phones] : []
    if (cols.phone && !phones.some((p: any) => (typeof p === "string" ? p : p?.phone) === cols.phone))
      phones.unshift({ phone: cols.phone, label: "Work", is_primary: true })
    await replaceChildren(conn, id, { ...input, emails, phones })
    await conn.commit()
    return { ok: true }
  } catch (err) {
    await conn.rollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }
}

export async function archiveContact(id: number, actorId: number | null): Promise<{ ok: true }> {
  const tenantId = currentTenantId()
  const res = await query<any>(
    `UPDATE contacts SET archived_at = NOW(), archived_by = ?, row_version = row_version + 1
      WHERE id = ? AND tenant_id = ? AND archived_at IS NULL`,
    [actorId, id, tenantId],
  )
  if (!res || res.affectedRows === 0) throw new ContactNotFoundError()
  return { ok: true }
}

/**
 * Merge a duplicate contact into a survivor. Child collections are re-parented,
 * blank survivor fields are filled from the loser, then the loser is archived
 * and pointed at the survivor. Both must belong to the caller's tenant.
 */
export async function mergeContacts(
  survivorId: number,
  loserId: number,
  actorId: number | null,
): Promise<{ ok: true }> {
  if (survivorId === loserId) throw new Error("Cannot merge a contact into itself")
  const tenantId = currentTenantId()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT * FROM contacts WHERE id IN (?, ?) AND tenant_id = ? FOR UPDATE`,
      [survivorId, loserId, tenantId],
    )
    if (rows.length !== 2) throw new ContactNotFoundError()
    const survivor = rows.find((r: any) => Number(r.id) === survivorId)
    const loser = rows.find((r: any) => Number(r.id) === loserId)
    if (!survivor || !loser) throw new ContactNotFoundError()

    // Fill survivor blanks from the loser for the scalar, linkable fields.
    const fillable = [
      "salutation", "first_name", "last_name", "company_name", "role", "department",
      "email", "email_normalized", "phone", "phone_normalized", "gstin", "pan", "notes",
      "client_id", "finance_party_id", "sales_company_id", "sales_contact_id", "marketing_contact_id", "owner_id",
    ]
    const updates: Record<string, any> = {}
    for (const f of fillable) {
      const cur = survivor[f]
      if ((cur == null || cur === "") && loser[f] != null && loser[f] !== "") updates[f] = loser[f]
    }
    // Relationship flags are OR-ed: a merged party is a customer/vendor if either was.
    if (loser.is_customer) updates.is_customer = 1
    if (loser.is_vendor) updates.is_vendor = 1

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates)
      await conn.query(
        `UPDATE contacts SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}, row_version = row_version + 1 WHERE id = ?`,
        [...keys.map((k) => updates[k]), survivorId],
      )
    }

    // Re-parent child collections, then dedupe by normalized value.
    await conn.query(`UPDATE contact_emails SET contact_id = ?, is_primary = 0 WHERE contact_id = ?`, [survivorId, loserId])
    await conn.query(`UPDATE contact_phones SET contact_id = ?, is_primary = 0 WHERE contact_id = ?`, [survivorId, loserId])
    await conn.query(`UPDATE contact_channels SET contact_id = ? WHERE contact_id = ?`, [survivorId, loserId])
    await conn.query(`UPDATE contact_addresses SET contact_id = ?, is_primary = 0 WHERE contact_id = ?`, [survivorId, loserId])
    await dedupeChildren(conn, survivorId)

    await conn.query(
      `UPDATE contacts SET archived_at = NOW(), archived_by = ?, merged_into_id = ?, status = 'Inactive', row_version = row_version + 1 WHERE id = ?`,
      [actorId, survivorId, loserId],
    )
    await conn.commit()
    return { ok: true }
  } catch (err) {
    await conn.rollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }
}

async function dedupeChildren(conn: any, contactId: number): Promise<void> {
  await conn.query(
    `DELETE e1 FROM contact_emails e1
      JOIN contact_emails e2 ON e1.contact_id = e2.contact_id AND e1.email_normalized = e2.email_normalized AND e1.id > e2.id
     WHERE e1.contact_id = ?`,
    [contactId],
  )
  await conn.query(
    `DELETE p1 FROM contact_phones p1
      JOIN contact_phones p2 ON p1.contact_id = p2.contact_id AND p1.phone_normalized = p2.phone_normalized AND p1.id > p2.id
     WHERE p1.contact_id = ?`,
    [contactId],
  )
  // Guarantee exactly one primary in each collection.
  for (const tbl of ["contact_emails", "contact_phones", "contact_addresses"]) {
    const [primaries] = await conn.query<any[]>(
      `SELECT id FROM \`${tbl}\` WHERE contact_id = ? AND is_primary = 1 ORDER BY id ASC`,
      [contactId],
    )
    if (primaries.length === 0) {
      await conn.query(`UPDATE \`${tbl}\` SET is_primary = 1 WHERE contact_id = ? ORDER BY id ASC LIMIT 1`, [contactId])
    } else if (primaries.length > 1) {
      const keep = primaries[0].id
      await conn.query(`UPDATE \`${tbl}\` SET is_primary = 0 WHERE contact_id = ? AND id <> ?`, [contactId, keep])
    }
  }
}

export { CONTACT_WRITABLE }
