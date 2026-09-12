import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { recordAudit } from "@/lib/sales/lead-lifecycle"

/**
 * Central Sales Company (Account) master service.
 *
 * The company is the CANONICAL account record. Every other Sales entity
 * (leads, meetings, quotations, contracts, onboarding, contacts) references a
 * company by its numeric `company_id`. The free-text `company_name` columns on
 * those tables are kept for backwards compatibility / display only.
 *
 * This module is the ONE place that mutates company master state so we keep a
 * single source of truth for:
 *   - race-safe company code generation (via record_id_sequences)
 *   - duplicate detection (name / domain / email)
 *   - status / owner / priority change history (append-only via sales_audit_log)
 *   - soft archive + merge (records are never hard-deleted to represent a state)
 *   - the 360° account view (all linked activity in one place)
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const COMPANY_STATUSES = ["New", "Contacted", "Qualified", "Customer", "Inactive", "Lost"] as const
export type CompanyStatus = (typeof COMPANY_STATUSES)[number]

export const COMPANY_PRIORITIES = ["Low", "Medium", "High", "Critical"] as const
export type CompanyPriority = (typeof COMPANY_PRIORITIES)[number]

export const COMPANY_TYPES = ["Prospect", "Client", "Partner", "Vendor", "Competitor", "Other"] as const

/** Tables whose free-text company_name should be linked back to a company_id. */
const LINKED_TABLES = [
  "sales_leads",
  "sales_meetings",
  "sales_quotations",
  "sales_contracts",
  "sales_onboarding",
] as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CompanyConflictError extends Error {
  constructor(message = "This company was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "CompanyConflictError"
  }
}

export class CompanyNotFoundError extends Error {
  constructor(message = "Company not found") {
    super(message)
    this.name = "CompanyNotFoundError"
  }
}

export class DuplicateCompanyError extends Error {
  duplicates: DuplicateMatch[]
  constructor(duplicates: DuplicateMatch[]) {
    super("A similar company already exists.")
    this.name = "DuplicateCompanyError"
    this.duplicates = duplicates
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run<T = any>(conn: PoolConnection | null, sql: string, params: any[] = []): Promise<T> {
  if (conn) {
    const [rows] = await conn.query(sql, params)
    return rows as T
  }
  return query<T>(sql, params)
}

/** Normalize a company name for fuzzy duplicate comparison. */
export function normalizeCompanyName(name: string | null | undefined): string {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|incorporated|llc|llp|corp|corporation|co|company|gmbh|plc|group|holdings|technologies|technology|solutions|services|systems|labs|studio|studios)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim()
}

/** Extract a bare domain from a website URL or email. */
export function extractDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const raw = String(value).trim().toLowerCase()
  if (!raw) return null
  if (raw.includes("@")) return raw.split("@")[1] || null
  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0] || null
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors the migration for existing databases)
// ---------------------------------------------------------------------------

let schemaEnsured = false

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

/**
 * Idempotently ensures every company master column/table exists and links
 * existing rows. Runs once per server process; safe to call at the top of any
 * company operation.
 */
export async function ensureCompanyMasterSchema(): Promise<void> {
  if (schemaEnsured) return

  const companyColumns: [string, string][] = [
    ["legal_name", "`legal_name` VARCHAR(190) DEFAULT NULL"],
    ["domain", "`domain` VARCHAR(150) DEFAULT NULL"],
    ["phone", "`phone` VARCHAR(40) DEFAULT NULL"],
    ["alt_phone", "`alt_phone` VARCHAR(40) DEFAULT NULL"],
    ["address_line", "`address_line` VARCHAR(255) DEFAULT NULL"],
    ["city", "`city` VARCHAR(120) DEFAULT NULL"],
    ["state", "`state` VARCHAR(120) DEFAULT NULL"],
    ["postal_code", "`postal_code` VARCHAR(30) DEFAULT NULL"],
    ["segment", "`segment` VARCHAR(80) DEFAULT NULL"],
    ["annual_revenue", "`annual_revenue` DECIMAL(16,2) DEFAULT NULL"],
    ["tags", "`tags` VARCHAR(500) DEFAULT NULL"],
    ["source", "`source` VARCHAR(120) DEFAULT NULL"],
    ["description", "`description` TEXT DEFAULT NULL"],
    ["account_health", "`account_health` TINYINT UNSIGNED DEFAULT NULL"],
    ["first_contact_date", "`first_contact_date` DATE DEFAULT NULL"],
    ["last_activity_at", "`last_activity_at` DATETIME DEFAULT NULL"],
    ["archived_at", "`archived_at` DATETIME DEFAULT NULL"],
    ["archived_by", "`archived_by` INT UNSIGNED DEFAULT NULL"],
    ["merged_into_id", "`merged_into_id` INT UNSIGNED DEFAULT NULL"],
    ["row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1"],
  ]

  try {
    for (const [col, ddl] of companyColumns) await addColumnIfMissing("sales_companies", col, ddl)

    // Widen enums additively (existing values are preserved).
    await query(
      `ALTER TABLE sales_companies MODIFY \`status\` ENUM(${COMPANY_STATUSES.map((s) => `'${s}'`).join(",")}) NOT NULL DEFAULT 'New'`,
    ).catch(() => {})
    await query(
      `ALTER TABLE sales_companies MODIFY \`priority\` ENUM(${COMPANY_PRIORITIES.map((p) => `'${p}'`).join(",")}) DEFAULT NULL`,
    ).catch(() => {})

    await addKeyIfMissing("sales_companies", "idx_companies_priority", "KEY `idx_companies_priority` (`priority`)")
    await addKeyIfMissing("sales_companies", "idx_companies_domain", "KEY `idx_companies_domain` (`domain`)")
    await addKeyIfMissing("sales_companies", "idx_companies_archived", "KEY `idx_companies_archived` (`archived_at`)")
    await addKeyIfMissing("sales_companies", "idx_companies_assigned", "KEY `idx_companies_assigned` (`assigned_to`)")

    // Relational contacts parented to a company.
    await query(`CREATE TABLE IF NOT EXISTS \`sales_contacts\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`company_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(150) NOT NULL,
      \`title\` VARCHAR(150) DEFAULT NULL,
      \`email\` VARCHAR(190) DEFAULT NULL,
      \`phone\` VARCHAR(40) DEFAULT NULL,
      \`linkedin_url\` VARCHAR(190) DEFAULT NULL,
      \`is_primary\` TINYINT(1) NOT NULL DEFAULT 0,
      \`notes\` VARCHAR(500) DEFAULT NULL,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_contacts_company\` (\`company_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    // company_id linkage columns on downstream tables.
    for (const table of LINKED_TABLES) {
      await addColumnIfMissing(table, "company_id", "`company_id` INT UNSIGNED DEFAULT NULL")
      await addKeyIfMissing(table, `idx_${table}_company_id`, `KEY \`idx_${table}_company_id\` (\`company_id\`)`)
    }

    await backfillCompanyLinks()

    schemaEnsured = true
  } catch (error) {
    console.error("[company-master] ensureSchema failed", error)
  }
}

/**
 * Best-effort backfill: link existing downstream rows to a company by an exact
 * company_name match, but ONLY when that name resolves to exactly one company
 * (never guess between ambiguous duplicates).
 */
export async function backfillCompanyLinks(): Promise<void> {
  for (const table of LINKED_TABLES) {
    await query(
      `UPDATE \`${table}\` t
       JOIN (
         SELECT company_name, MIN(id) AS cid, COUNT(*) AS n
         FROM sales_companies
         WHERE archived_at IS NULL AND company_name IS NOT NULL AND company_name <> ''
         GROUP BY company_name
       ) c ON c.company_name = t.company_name AND c.n = 1
       SET t.company_id = c.cid
       WHERE t.company_id IS NULL AND t.company_name IS NOT NULL AND t.company_name <> ''`,
    ).catch((e) => console.error(`[company-master] backfill ${table} failed`, e))
  }
}

// ---------------------------------------------------------------------------
// Company code generation (race-safe via sequence table)
// ---------------------------------------------------------------------------

export async function nextCompanyCode(conn: PoolConnection): Promise<string> {
  // Seed the sequence to the current max so we never collide with legacy
  // MAX+1 generated codes, then atomically increment.
  const [maxRows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(company_code, 6) AS UNSIGNED)), 0) AS max_num FROM sales_companies`,
  )
  const currentMax = Number(maxRows[0]?.max_num || 0)
  await conn.query(
    `INSERT INTO record_id_sequences (prefix, next_number) VALUES ('MCLD', ?)
     ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, ?) + 1`,
    [currentMax + 1, currentMax],
  )
  const [rows] = await conn.query<any[]>(
    `SELECT next_number FROM record_id_sequences WHERE prefix = 'MCLD' FOR UPDATE`,
  )
  const num = Number(rows[0]?.next_number || currentMax + 1)
  return `MCLD-${String(num).padStart(3, "0")}`
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type DuplicateMatch = {
  id: number
  company_code: string
  company_name: string
  domain: string | null
  company_email: string | null
  reason: string
}

export async function findDuplicates(input: {
  company_name?: string | null
  domain?: string | null
  website?: string | null
  company_email?: string | null
  excludeId?: number | null
}): Promise<DuplicateMatch[]> {
  const name = normalizeCompanyName(input.company_name)
  const domain = extractDomain(input.domain || input.website)
  const email = (input.company_email || "").trim().toLowerCase()
  if (!name && !domain && !email) return []

  const rows = await query<any[]>(
    `SELECT id, company_code, company_name, domain, website, company_email
     FROM sales_companies
     WHERE archived_at IS NULL ${input.excludeId ? "AND id <> ?" : ""}`,
    input.excludeId ? [input.excludeId] : [],
  ).catch(() => [] as any[])

  const matches: DuplicateMatch[] = []
  for (const r of rows) {
    const reasons: string[] = []
    if (name && normalizeCompanyName(r.company_name) === name) reasons.push("same name")
    if (domain && extractDomain(r.domain || r.website) === domain) reasons.push("same domain")
    if (email && String(r.company_email || "").trim().toLowerCase() === email) reasons.push("same email")
    if (reasons.length > 0) {
      matches.push({
        id: r.id,
        company_code: r.company_code,
        company_name: r.company_name,
        domain: r.domain || extractDomain(r.website),
        company_email: r.company_email,
        reason: reasons.join(", "),
      })
    }
  }
  return matches
}

/**
 * Resolve a company_id for a downstream record. Prefers an explicit id, then an
 * unambiguous exact-name match. Returns null when the name is empty or matches
 * more than one company (never guesses between duplicates).
 */
export async function resolveCompanyId(input: {
  company_id?: number | string | null
  company_name?: string | null
}): Promise<number | null> {
  if (input.company_id) {
    const idNum = Number(input.company_id)
    if (Number.isFinite(idNum) && idNum > 0) return idNum
  }
  const name = String(input.company_name || "").trim()
  if (!name) return null
  const rows = await query<any[]>(
    `SELECT id FROM sales_companies WHERE company_name = ? AND archived_at IS NULL LIMIT 2`,
    [name],
  ).catch(() => [] as any[])
  if (rows.length === 1) return Number(rows[0].id)
  return null
}

/** Record a contact-related change against the company timeline. */
export async function recordCompanyContactAudit(
  companyId: number,
  action: string,
  summary: string,
  actorId: number | null | undefined,
): Promise<void> {
  await recordAudit(null, { entityType: "company", entityId: companyId, action, summary, actorId })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCompany(id: number) {
  const rows = await query<any[]>(
    `SELECT c.*, u.name AS assigned_to_name, cb.name AS created_by_name, m.company_name AS merged_into_name
     FROM sales_companies c
     LEFT JOIN users u ON u.id = c.assigned_to
     LEFT JOIN users cb ON cb.id = c.created_by
     LEFT JOIN sales_companies m ON m.id = c.merged_into_id
     WHERE c.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** Fetch the full 360° account view: company + every linked record + timeline. */
export async function getCompany360(id: number) {
  const company = await getCompany(id)
  if (!company) return null

  const name = company.company_name

  const [contacts, leads, meetings, quotations, contracts, onboarding, timeline] = await Promise.all([
    query<any[]>(`SELECT * FROM sales_contacts WHERE company_id = ? ORDER BY is_primary DESC, name ASC`, [id]),
    query<any[]>(
      `SELECT l.id, l.lead_code, l.contact_person, l.status, l.lead_status, l.estimated_value, l.currency,
              l.lead_health_score, l.assigned_to, u.name AS assigned_to_name, l.created_at
       FROM sales_leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.archived_at IS NULL AND (l.company_id = ? OR (l.company_id IS NULL AND l.company_name = ?))
       ORDER BY l.created_at DESC`,
      [id, name],
    ),
    query<any[]>(
      `SELECT id, meeting_code, meeting_date, meeting_time, meeting_type, contact_person, agenda, outcome_notes
       FROM sales_meetings
       WHERE company_id = ? OR (company_id IS NULL AND company_name = ?)
       ORDER BY meeting_date DESC, id DESC`,
      [id, name],
    ),
    query<any[]>(
      `SELECT id, quote_code, quote_date, opportunity_name, total_amount, valid_until, status
       FROM sales_quotations
       WHERE company_id = ? OR (company_id IS NULL AND company_name = ?)
       ORDER BY quote_date DESC, id DESC`,
      [id, name],
    ),
    query<any[]>(
      `SELECT id, contract_code, contract_date, start_date, end_date, value, contract_type, status
       FROM sales_contracts
       WHERE company_id = ? OR (company_id IS NULL AND company_name = ?)
       ORDER BY contract_date DESC, id DESC`,
      [id, name],
    ),
    query<any[]>(
      `SELECT id, onboarding_code, onboarding_date, contract_code, current_stage, status, start_date
       FROM sales_onboarding
       WHERE company_id = ? OR (company_id IS NULL AND company_name = ?)
       ORDER BY onboarding_date DESC, id DESC`,
      [id, name],
    ),
    query<any[]>(
      `SELECT a.*, u.name AS actor_name
       FROM sales_audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.entity_type = 'company' AND a.entity_id = ?
       ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [String(id)],
    ),
  ])

  const wonValue = leads
    .filter((l) => l.lead_status === "Won")
    .reduce((sum, l) => sum + Number(l.estimated_value || 0), 0)
  const openPipeline = leads
    .filter((l) => l.lead_status === "Open" || l.lead_status === "Follow Up")
    .reduce((sum, l) => sum + Number(l.estimated_value || 0), 0)
  const contractValue = contracts.reduce((sum, c) => sum + Number(c.value || 0), 0)

  return {
    company,
    contacts,
    leads,
    meetings,
    quotations,
    contracts,
    onboarding,
    timeline,
    stats: {
      contacts: contacts.length,
      leads: leads.length,
      openLeads: leads.filter((l) => l.lead_status === "Open" || l.lead_status === "Follow Up").length,
      wonLeads: leads.filter((l) => l.lead_status === "Won").length,
      meetings: meetings.length,
      quotations: quotations.length,
      contracts: contracts.length,
      onboarding: onboarding.length,
      wonValue,
      openPipeline,
      contractValue,
    },
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCompany(
  input: Record<string, any>,
  actorId: number | null | undefined,
  opts: { allowDuplicate?: boolean } = {},
): Promise<{ id: number; company_code: string }> {
  await ensureCompanyMasterSchema()

  const companyName = String(input.company_name || "").trim()
  if (!companyName) throw new Error("Company name is required")

  if (!opts.allowDuplicate) {
    const dupes = await findDuplicates({
      company_name: companyName,
      domain: input.domain,
      website: input.website,
      company_email: input.company_email,
    })
    if (dupes.length > 0) throw new DuplicateCompanyError(dupes)
  }

  const domain = extractDomain(input.domain || input.website)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const companyCode = await nextCompanyCode(conn)

    const [result] = await conn.query<any>(
      `INSERT INTO sales_companies
       (company_code, company_date, company_name, legal_name, industry, website, domain, linkedin_url,
        company_email, phone, alt_phone, address_line, city, state, postal_code, country, assigned_to,
        company_type, segment, source, tags, description, status, priority, founded_year, employee_count,
        annual_revenue, first_contact_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyCode,
        input.company_date ? new Date(input.company_date) : new Date(),
        companyName,
        input.legal_name || null,
        input.industry || null,
        input.website || null,
        domain,
        input.linkedin_url || null,
        input.company_email || null,
        input.phone || null,
        input.alt_phone || null,
        input.address_line || null,
        input.city || null,
        input.state || null,
        input.postal_code || null,
        input.country || null,
        input.assigned_to || null,
        input.company_type || null,
        input.segment || null,
        input.source || null,
        input.tags || null,
        input.description || null,
        input.status || "New",
        input.priority || null,
        input.founded_year || null,
        input.employee_count || null,
        input.annual_revenue || null,
        input.first_contact_date ? new Date(input.first_contact_date) : null,
        actorId ?? null,
      ],
    )
    const companyId = Number(result.insertId)

    await recordAudit(conn, {
      entityType: "company",
      entityId: companyId,
      action: "created",
      summary: `Company ${companyCode} created`,
      meta: { company_name: companyName, status: input.status || "New" },
      actorId,
    })

    await conn.commit()
    return { id: companyId, company_code: companyCode }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Update (with change history for owner / status / priority)
// ---------------------------------------------------------------------------

const UPDATABLE_FIELDS = [
  "company_name",
  "legal_name",
  "industry",
  "website",
  "linkedin_url",
  "company_email",
  "phone",
  "alt_phone",
  "address_line",
  "city",
  "state",
  "postal_code",
  "country",
  "assigned_to",
  "company_type",
  "segment",
  "source",
  "tags",
  "description",
  "status",
  "priority",
  "founded_year",
  "employee_count",
  "annual_revenue",
  "account_health",
  "first_contact_date",
] as const

export async function updateCompany(
  id: number,
  patch: Record<string, any>,
  actorId: number | null | undefined,
): Promise<void> {
  await ensureCompanyMasterSchema()
  const existing = await getCompany(id)
  if (!existing) throw new CompanyNotFoundError()

  const fields: string[] = []
  const values: any[] = []
  const changes: Record<string, { from: unknown; to: unknown }> = {}

  for (const key of UPDATABLE_FIELDS) {
    if (!(key in patch)) continue
    const next = patch[key] === "" ? null : patch[key]
    if (String(existing[key] ?? "") === String(next ?? "")) continue
    fields.push(`\`${key}\` = ?`)
    values.push(next)
    changes[key] = { from: existing[key] ?? null, to: next }
  }

  // Keep domain in sync when website/domain changes.
  if ("website" in patch || "domain" in patch) {
    const domain = extractDomain(patch.domain || patch.website)
    if (domain && domain !== existing.domain) {
      fields.push("`domain` = ?")
      values.push(domain)
    }
  }

  if (fields.length === 0) return

  fields.push("`row_version` = `row_version` + 1")
  await query(`UPDATE sales_companies SET ${fields.join(", ")} WHERE id = ?`, [...values, id])

  // Notable status / owner / priority transitions get their own audit line.
  const conn = null
  if (changes.status) {
    await recordAudit(conn, {
      entityType: "company",
      entityId: id,
      action: "status_changed",
      summary: `Status: ${changes.status.from ?? "—"} → ${changes.status.to ?? "—"}`,
      meta: changes.status,
      actorId,
    })
  }
  if (changes.assigned_to) {
    await recordAudit(conn, {
      entityType: "company",
      entityId: id,
      action: "owner_changed",
      summary: "Account owner changed",
      meta: changes.assigned_to,
      actorId,
    })
  }
  if (changes.priority) {
    await recordAudit(conn, {
      entityType: "company",
      entityId: id,
      action: "priority_changed",
      summary: `Priority: ${changes.priority.from ?? "—"} → ${changes.priority.to ?? "—"}`,
      meta: changes.priority,
      actorId,
    })
  }
  const otherKeys = Object.keys(changes).filter((k) => !["status", "assigned_to", "priority"].includes(k))
  if (otherKeys.length > 0) {
    await recordAudit(conn, {
      entityType: "company",
      entityId: id,
      action: "updated",
      summary: `Updated ${otherKeys.join(", ")}`,
      meta: Object.fromEntries(otherKeys.map((k) => [k, changes[k]])),
      actorId,
    })
  }
}

// ---------------------------------------------------------------------------
// Archive / restore (soft delete)
// ---------------------------------------------------------------------------

export async function archiveCompany(id: number, actorId: number | null | undefined): Promise<void> {
  await ensureCompanyMasterSchema()
  const existing = await getCompany(id)
  if (!existing) throw new CompanyNotFoundError()
  await query(
    `UPDATE sales_companies SET archived_at = NOW(), archived_by = ?, row_version = row_version + 1 WHERE id = ?`,
    [actorId ?? null, id],
  )
  await recordAudit(null, {
    entityType: "company",
    entityId: id,
    action: "archived",
    summary: `Company ${existing.company_code} archived`,
    actorId,
  })
}

export async function restoreCompany(id: number, actorId: number | null | undefined): Promise<void> {
  await ensureCompanyMasterSchema()
  const existing = await getCompany(id)
  if (!existing) throw new CompanyNotFoundError()
  await query(
    `UPDATE sales_companies SET archived_at = NULL, archived_by = NULL, row_version = row_version + 1 WHERE id = ?`,
    [id],
  )
  await recordAudit(null, {
    entityType: "company",
    entityId: id,
    action: "restored",
    summary: `Company ${existing.company_code} restored`,
    actorId,
  })
}

/**
 * Merge `sourceId` into `targetId`: re-point every linked record, then archive
 * the source and stamp it with merged_into_id. Never deletes data.
 */
export async function mergeCompanies(
  sourceId: number,
  targetId: number,
  actorId: number | null | undefined,
): Promise<void> {
  await ensureCompanyMasterSchema()
  if (sourceId === targetId) throw new Error("Cannot merge a company into itself")
  const [source, target] = await Promise.all([getCompany(sourceId), getCompany(targetId)])
  if (!source || !target) throw new CompanyNotFoundError()

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const table of LINKED_TABLES) {
      await conn.query(
        `UPDATE \`${table}\` SET company_id = ?, company_name = ? WHERE company_id = ? OR (company_id IS NULL AND company_name = ?)`,
        [targetId, target.company_name, sourceId, source.company_name],
      )
    }
    await conn.query(`UPDATE sales_contacts SET company_id = ? WHERE company_id = ?`, [targetId, sourceId])
    await conn.query(
      `UPDATE sales_companies SET archived_at = NOW(), archived_by = ?, merged_into_id = ?, row_version = row_version + 1 WHERE id = ?`,
      [actorId ?? null, targetId, sourceId],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  await recordAudit(null, {
    entityType: "company",
    entityId: targetId,
    action: "merged_in",
    summary: `Merged ${source.company_code} into this account`,
    meta: { source_id: sourceId, source_code: source.company_code },
    actorId,
  })
  await recordAudit(null, {
    entityType: "company",
    entityId: sourceId,
    action: "merged_out",
    summary: `Merged into ${target.company_code}`,
    meta: { target_id: targetId, target_code: target.company_code },
    actorId,
  })
}
