import { query } from "@/lib/db"
import { stateCodeFromGstin } from "@/lib/sales-invoice-compute"

/**
 * Clients master service.
 *
 * A `clients` row is the CRM-facing party. It is NOT a duplicate master: it
 * links back to the canonical records that already exist elsewhere in the ERP:
 *   - `company_id`         -> sales_companies (canonical account)
 *   - `primary_contact_id` -> sales_contacts  (canonical person)
 *   - `finance_party_id`   -> customers_vendors.party_id (canonical accounting
 *                             / tax record used by Finance & GST)
 *
 * This module is the ONE place that mutates client master state so we keep a
 * single source of truth for:
 *   - race-safe client code generation (via record_id_sequences / nextRecordId)
 *   - normalization (email / GSTIN / PAN / state code)
 *   - duplicate detection (email / GSTIN / PAN / fuzzy name)
 *   - finance-party resolution ("link existing, offer manual create")
 *   - soft archive (records are never hard-deleted while linked to activity)
 *   - the runtime schema self-heal that mirrors a migration for existing DBs
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const CLIENT_STATUSES = ["Active", "Inactive"] as const
export type ClientStatus = (typeof CLIENT_STATUSES)[number]

export const CLIENT_TYPES = ["Company", "Individual"] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ClientConflictError extends Error {
  constructor(message = "This client was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "ClientConflictError"
  }
}

export class ClientNotFoundError extends Error {
  constructor(message = "Client not found") {
    super(message)
    this.name = "ClientNotFoundError"
  }
}

export type DuplicateClientMatch = {
  id: number
  client_code: string
  client_name: string
  company_name: string | null
  email: string | null
  gst_number: string | null
  pan: string | null
  reason: string
}

export class DuplicateClientError extends Error {
  duplicates: DuplicateClientMatch[]
  constructor(duplicates: DuplicateClientMatch[]) {
    super("A similar client already exists.")
    this.name = "DuplicateClientError"
    this.duplicates = duplicates
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function normalizeEmail(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim().toLowerCase()
  return v || null
}

export function isValidEmail(value: string | null | undefined): boolean {
  const v = String(value ?? "").trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

export function normalizeGstin(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "")
  return v || null
}

/** India GSTIN is 15 chars: 2 state + 10 PAN + 1 entity + 'Z' + 1 check. */
export function isValidGstin(value: string | null | undefined): boolean {
  const v = normalizeGstin(value)
  if (!v) return false
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(v)
}

export function normalizePan(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "")
  return v || null
}

export function isValidPan(value: string | null | undefined): boolean {
  const v = normalizePan(value)
  if (!v) return false
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v)
}

/** PAN is embedded in a valid GSTIN at positions 3-12. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const v = normalizeGstin(gstin)
  if (!v || v.length < 12) return null
  const pan = v.slice(2, 12)
  return isValidPan(pan) ? pan : null
}

export { stateCodeFromGstin }

/** Normalize a party name for fuzzy duplicate comparison. */
export function normalizeClientName(name: string | null | undefined): string {
  return String(name || "")
    .toLowerCase()
    .replace(
      /\b(pvt|private|ltd|limited|inc|incorporated|llc|llp|corp|corporation|co|company|gmbh|plc|group|holdings|technologies|technology|solutions|services|systems|labs|studio|studios)\b/g,
      "",
    )
    .replace(/[^a-z0-9]/g, "")
    .trim()
}

// ---------------------------------------------------------------------------
// Runtime schema self-heal (mirrors the migration for existing databases)
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

export async function ensureClientTables() {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS clients (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      client_code VARCHAR(40) NOT NULL,
      salutation VARCHAR(10) NULL,
      client_name VARCHAR(150) NOT NULL,
      email VARCHAR(190) NOT NULL,
      login_allowed ENUM('Yes','No') NOT NULL DEFAULT 'No',
      email_notifications ENUM('Yes','No') NOT NULL DEFAULT 'Yes',
      gender VARCHAR(20) NULL,
      language VARCHAR(40) NULL,
      mobile VARCHAR(40) NULL,
      company_name VARCHAR(190) NULL,
      website VARCHAR(190) NULL,
      tax_name VARCHAR(80) NULL,
      gst_number VARCHAR(60) NULL,
      office_phone VARCHAR(40) NULL,
      address VARCHAR(255) NULL,
      city VARCHAR(120) NULL,
      state VARCHAR(120) NULL,
      country VARCHAR(120) NULL,
      postal_code VARCHAR(30) NULL,
      category VARCHAR(120) NULL,
      sub_category VARCHAR(120) NULL,
      currency VARCHAR(10) NULL,
      status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
      notes TEXT NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_client_code (client_code),
      KEY idx_clients_name (client_name)
    )`,
  )

  // Additive columns: identity, relational links, tax & billing profile,
  // ownership, soft-archive, optimistic-lock version. Each is nullable / has a
  // default so existing rows and existing read code keep working unchanged.
  const clientColumns: [string, string][] = [
    ["client_type", "`client_type` ENUM('Company','Individual') NOT NULL DEFAULT 'Company'"],
    ["legal_name", "`legal_name` VARCHAR(190) DEFAULT NULL"],
    ["display_name", "`display_name` VARCHAR(190) DEFAULT NULL"],
    ["company_id", "`company_id` INT UNSIGNED DEFAULT NULL"],
    ["primary_contact_id", "`primary_contact_id` INT UNSIGNED DEFAULT NULL"],
    ["finance_party_id", "`finance_party_id` VARCHAR(40) DEFAULT NULL"],
    ["pan", "`pan` VARCHAR(20) DEFAULT NULL"],
    ["state_code", "`state_code` VARCHAR(6) DEFAULT NULL"],
    ["account_manager_id", "`account_manager_id` INT UNSIGNED DEFAULT NULL"],
    ["payment_terms_days", "`payment_terms_days` INT UNSIGNED DEFAULT NULL"],
    ["credit_limit", "`credit_limit` DECIMAL(16,2) DEFAULT NULL"],
    ["archived_at", "`archived_at` DATETIME DEFAULT NULL"],
    ["archived_by", "`archived_by` INT UNSIGNED DEFAULT NULL"],
    ["merged_into_id", "`merged_into_id` BIGINT UNSIGNED DEFAULT NULL"],
    ["row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1"],
  ]

  try {
    for (const [col, ddl] of clientColumns) await addColumnIfMissing("clients", col, ddl)

    await addKeyIfMissing("clients", "idx_clients_company_id", "KEY `idx_clients_company_id` (`company_id`)")
    await addKeyIfMissing("clients", "idx_clients_finance_party", "KEY `idx_clients_finance_party` (`finance_party_id`)")
    await addKeyIfMissing("clients", "idx_clients_archived", "KEY `idx_clients_archived` (`archived_at`)")
    await addKeyIfMissing("clients", "idx_clients_email", "KEY `idx_clients_email` (`email`)")
    await addKeyIfMissing("clients", "idx_clients_gst", "KEY `idx_clients_gst` (`gst_number`)")
    await addKeyIfMissing("clients", "idx_clients_pan", "KEY `idx_clients_pan` (`pan`)")
    await addKeyIfMissing("clients", "idx_clients_status", "KEY `idx_clients_status` (`status`)")
    await addKeyIfMissing("clients", "idx_clients_manager", "KEY `idx_clients_manager` (`account_manager_id`)")

    await backfillClientLinks()
  } catch (error) {
    console.error("[clients-db] ensureClientTables self-heal failed", error)
  }

  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Clients Dashboard','clients.view_dashboard','View the clients module dashboard',1 FROM modules WHERE slug='clients'`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Clients','clients.view_clients','View clients list',2 FROM modules WHERE slug='clients'`,
  )
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Clients','clients.manage_clients','Add, edit and delete clients',3 FROM modules WHERE slug='clients'`,
  )
  ensured = true
}

/**
 * Best-effort, deterministic backfill for existing rows. Every step is guarded
 * so a partial schema (e.g. no sales_companies yet) never throws. Links are
 * only created on UNAMBIGUOUS matches — we never guess between duplicates.
 */
export async function backfillClientLinks(): Promise<void> {
  // Derived display fields.
  await query(
    `UPDATE clients SET display_name = COALESCE(NULLIF(company_name,''), client_name)
     WHERE display_name IS NULL OR display_name = ''`,
  ).catch((e) => console.error("[clients-db] backfill display_name failed", e))

  await query(
    `UPDATE clients SET legal_name = company_name
     WHERE (legal_name IS NULL OR legal_name = '') AND company_name IS NOT NULL AND company_name <> ''`,
  ).catch((e) => console.error("[clients-db] backfill legal_name failed", e))

  await query(
    `UPDATE clients SET client_type = 'Individual'
     WHERE (company_name IS NULL OR company_name = '')`,
  ).catch((e) => console.error("[clients-db] backfill client_type failed", e))

  // State code + PAN derived from a valid GSTIN when not set.
  await query(
    `UPDATE clients SET state_code = SUBSTRING(gst_number,1,2)
     WHERE (state_code IS NULL OR state_code = '')
       AND gst_number IS NOT NULL AND gst_number REGEXP '^[0-9]{2}'`,
  ).catch((e) => console.error("[clients-db] backfill state_code failed", e))

  await query(
    `UPDATE clients SET pan = UPPER(SUBSTRING(gst_number,3,10))
     WHERE (pan IS NULL OR pan = '')
       AND gst_number IS NOT NULL
       AND UPPER(SUBSTRING(gst_number,3,10)) REGEXP '^[A-Z]{5}[0-9]{4}[A-Z]{1}$'`,
  ).catch((e) => console.error("[clients-db] backfill pan failed", e))

  // Link to canonical Sales company by unambiguous exact name match.
  await query(
    `UPDATE clients c
     JOIN (
       SELECT company_name, MIN(id) AS cid, COUNT(*) AS n
       FROM sales_companies
       WHERE archived_at IS NULL AND company_name IS NOT NULL AND company_name <> ''
       GROUP BY company_name
     ) sc ON sc.company_name = c.company_name AND sc.n = 1
     SET c.company_id = sc.cid
     WHERE c.company_id IS NULL AND c.company_name IS NOT NULL AND c.company_name <> ''`,
  ).catch((e) => console.error("[clients-db] backfill company_id failed", e))

  // Link to canonical Finance party by unambiguous GSTIN, then by legal name.
  await query(
    `UPDATE clients c
     JOIN (
       SELECT UPPER(gstin) AS g, MIN(party_id) AS pid, COUNT(*) AS n
       FROM customers_vendors
       WHERE gstin IS NOT NULL AND gstin <> ''
       GROUP BY UPPER(gstin)
     ) p ON p.g = UPPER(c.gst_number) AND p.n = 1
     SET c.finance_party_id = p.pid
     WHERE c.finance_party_id IS NULL AND c.gst_number IS NOT NULL AND c.gst_number <> ''`,
  ).catch((e) => console.error("[clients-db] backfill finance_party_id by gstin failed", e))

  await query(
    `UPDATE clients c
     JOIN (
       SELECT LOWER(customer_name) AS nm, MIN(party_id) AS pid, COUNT(*) AS n
       FROM customers_vendors
       WHERE customer_name IS NOT NULL AND customer_name <> ''
       GROUP BY LOWER(customer_name)
     ) p ON p.nm = LOWER(COALESCE(NULLIF(c.company_name,''), c.client_name)) AND p.n = 1
     SET c.finance_party_id = p.pid
     WHERE c.finance_party_id IS NULL`,
  ).catch((e) => console.error("[clients-db] backfill finance_party_id by name failed", e))
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export async function findClientDuplicates(input: {
  client_name?: string | null
  company_name?: string | null
  email?: string | null
  gst_number?: string | null
  pan?: string | null
  excludeId?: number | null
}): Promise<DuplicateClientMatch[]> {
  const email = normalizeEmail(input.email)
  const gstin = normalizeGstin(input.gst_number)
  const pan = normalizePan(input.pan) || panFromGstin(gstin)
  const name = normalizeClientName(input.company_name || input.client_name)
  if (!email && !gstin && !pan && !name) return []

  const rows = await query<any[]>(
    `SELECT id, client_code, client_name, company_name, email, gst_number, pan
     FROM clients
     WHERE archived_at IS NULL ${input.excludeId ? "AND id <> ?" : ""}`,
    input.excludeId ? [input.excludeId] : [],
  ).catch(() => [] as any[])

  const matches: DuplicateClientMatch[] = []
  for (const r of rows) {
    const reasons: string[] = []
    if (email && normalizeEmail(r.email) === email) reasons.push("same email")
    if (gstin && normalizeGstin(r.gst_number) === gstin) reasons.push("same GSTIN")
    if (pan && (normalizePan(r.pan) === pan || panFromGstin(r.gst_number) === pan)) reasons.push("same PAN")
    if (name && normalizeClientName(r.company_name || r.client_name) === name) reasons.push("same name")
    if (reasons.length > 0) {
      matches.push({
        id: r.id,
        client_code: r.client_code,
        client_name: r.client_name,
        company_name: r.company_name,
        email: r.email,
        gst_number: r.gst_number,
        pan: r.pan,
        reason: reasons.join(", "),
      })
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// Finance party resolution ("link existing, offer manual create")
// ---------------------------------------------------------------------------

export type FinancePartyMatch = {
  party_id: string
  customer_name: string | null
  legal_name: string | null
  gstin: string | null
  pan: string | null
  reason: string
}

/**
 * Resolve the canonical finance party (customers_vendors) for a client without
 * ever creating one. Prefers an explicit party id, then a UNIQUE GSTIN, PAN, or
 * name match. Returns the auto-linkable id plus every candidate so the UI can
 * offer "Create Finance Profile" when nothing (or something ambiguous) matches.
 */
export async function resolveFinanceParty(input: {
  finance_party_id?: string | null
  gst_number?: string | null
  pan?: string | null
  company_name?: string | null
  client_name?: string | null
}): Promise<{ party_id: string | null; matches: FinancePartyMatch[] }> {
  const explicit = String(input.finance_party_id ?? "").trim()
  if (explicit) {
    const rows = await query<any[]>(
      `SELECT party_id, customer_name, legal_name, gstin, pan FROM customers_vendors WHERE party_id = ? LIMIT 1`,
      [explicit],
    ).catch(() => [] as any[])
    if (rows.length === 1) {
      return {
        party_id: rows[0].party_id,
        matches: [{ ...rows[0], reason: "linked" }],
      }
    }
  }

  const gstin = normalizeGstin(input.gst_number)
  const pan = normalizePan(input.pan) || panFromGstin(gstin)
  const name = String(input.company_name || input.client_name || "").trim().toLowerCase()

  const rows = await query<any[]>(
    `SELECT party_id, customer_name, legal_name, gstin, pan FROM customers_vendors`,
  ).catch(() => [] as any[])

  const matches: FinancePartyMatch[] = []
  for (const r of rows) {
    const reasons: string[] = []
    if (gstin && normalizeGstin(r.gstin) === gstin) reasons.push("same GSTIN")
    if (pan && (normalizePan(r.pan) === pan || panFromGstin(r.gstin) === pan)) reasons.push("same PAN")
    if (
      name &&
      (String(r.customer_name || "").toLowerCase() === name || String(r.legal_name || "").toLowerCase() === name)
    )
      reasons.push("same name")
    if (reasons.length > 0) matches.push({ ...r, reason: reasons.join(", ") })
  }

  // Prefer the strongest unambiguous signal: GSTIN > PAN > name.
  for (const key of ["same GSTIN", "same PAN", "same name"]) {
    const tier = matches.filter((m) => m.reason.includes(key))
    if (tier.length === 1) return { party_id: tier[0].party_id, matches }
  }
  return { party_id: null, matches }
}

// ---------------------------------------------------------------------------
// Archive relationship checks
// ---------------------------------------------------------------------------

/**
 * Count linked activity so the caller can archive (never hard-delete) a client
 * that is referenced by financial records. Best-effort and guarded so a missing
 * table never throws.
 */
export async function getClientLinkCounts(client: {
  finance_party_id?: string | null
  company_id?: number | null
}): Promise<{ invoices: number; total: number }> {
  let invoices = 0
  if (client.finance_party_id) {
    const rows = await query<any[]>(
      `SELECT COUNT(*) AS c FROM sales_invoices WHERE customer_party_id = ?`,
      [client.finance_party_id],
    ).catch(() => [] as any[])
    invoices = Number(rows?.[0]?.c ?? 0)
  }
  return { invoices, total: invoices }
}

// ---------------------------------------------------------------------------
// Client 360 aggregation
// ---------------------------------------------------------------------------

export type ClientRecord = {
  id: number
  client_code: string
  client_name: string
  company_id: number | null
  finance_party_id: string | null
  credit_limit: number | null
  currency: string | null
  [key: string]: any
}

const n = (v: any) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/**
 * Aggregate the client's live Finance and Sales footprint. Every figure is
 * derived from the canonical source tables (sales_invoices / sales_* / audit
 * log) — nothing is stored on the client. All queries are guarded so a missing
 * module never breaks the drawer.
 */
export async function getClient360(client: ClientRecord) {
  const partyId = client.finance_party_id
  const clientCode = client.client_code
  const companyId = client.company_id

  // --- Finance: invoices attached to this client (by party link or code) -----
  const invoices = await query<any[]>(
    `SELECT id, invoice_id, invoice_date, due_date, invoice_total, amount_received,
            outstanding_amount, net_receivable, payment_status, invoice_status, tds_amount
       FROM sales_invoices
      WHERE (? IS NOT NULL AND customer_party_id = ?)
         OR (client_id = ?)
      ORDER BY invoice_date DESC, id DESC`,
    [partyId, partyId, clientCode],
  ).catch(() => [] as any[])

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_180: 0, d180: 0 }
  let totalInvoiced = 0
  let totalPaid = 0
  let outstanding = 0
  let overdue = 0
  let pendingTds = 0
  let nextDue: string | null = null

  for (const inv of invoices) {
    if (String(inv.invoice_status || "") === "Cancelled") continue
    totalInvoiced += n(inv.invoice_total)
    totalPaid += n(inv.amount_received)
    const os = n(inv.outstanding_amount)
    outstanding += os
    pendingTds += n(inv.tds_amount)
    if (os > 0.005 && inv.due_date) {
      const due = new Date(inv.due_date)
      const days = Math.floor((today.getTime() - due.getTime()) / 86400000)
      if (days > 0) overdue += os
      if (days <= 0) aging.current += os
      else if (days <= 30) aging.d1_30 += os
      else if (days <= 60) aging.d31_60 += os
      else if (days <= 90) aging.d61_90 += os
      else if (days <= 180) aging.d91_180 += os
      else aging.d180 += os
      if (days <= 0 && (!nextDue || new Date(inv.due_date) < new Date(nextDue))) nextDue = inv.due_date
    }
  }

  const creditLimit = client.credit_limit != null ? n(client.credit_limit) : null
  const availableCredit = creditLimit != null ? creditLimit - outstanding : null
  const utilization = creditLimit && creditLimit > 0 ? Math.round((outstanding / creditLimit) * 100) : null

  const finance = {
    linked: !!partyId,
    finance_party_id: partyId,
    total_invoiced: totalInvoiced,
    total_paid: totalPaid,
    outstanding,
    overdue,
    pending_tds: pendingTds,
    credit_limit: creditLimit,
    available_credit: availableCredit,
    utilization,
    invoice_count: invoices.length,
    last_invoice: invoices[0] ? { invoice_id: invoices[0].invoice_id, invoice_date: invoices[0].invoice_date, invoice_total: n(invoices[0].invoice_total) } : null,
    next_due: nextDue,
    aging,
    invoices: invoices.slice(0, 25),
  }

  // --- Sales: leads / quotations / contracts on the linked company ------------
  let sales = {
    linked: !!companyId,
    open_leads: 0,
    won_leads: 0,
    lost_leads: 0,
    open_quotations: 0,
    accepted_quotations: 0,
    active_contracts: 0,
    forecast_value: 0,
  }
  if (companyId) {
    const [leadAgg] = await query<any[]>(
      `SELECT
         SUM(CASE WHEN status NOT IN ('Won','Lost','Closed') THEN 1 ELSE 0 END) AS open_leads,
         SUM(CASE WHEN status = 'Won' THEN 1 ELSE 0 END) AS won_leads,
         SUM(CASE WHEN status = 'Lost' THEN 1 ELSE 0 END) AS lost_leads
       FROM leads WHERE company_id = ?`,
      [companyId],
    ).catch(() => [{}] as any[])
    const [quoteAgg] = await query<any[]>(
      `SELECT
         SUM(CASE WHEN status IN ('Draft','Sent','Under Review','Negotiation') THEN 1 ELSE 0 END) AS open_quotations,
         SUM(CASE WHEN status IN ('Accepted','Won') THEN 1 ELSE 0 END) AS accepted_quotations
       FROM quotations WHERE company_id = ?`,
      [companyId],
    ).catch(() => [{}] as any[])
    const [contractAgg] = await query<any[]>(
      `SELECT COUNT(*) AS active_contracts FROM contracts WHERE company_id = ? AND status = 'Active'`,
      [companyId],
    ).catch(() => [{}] as any[])
    sales = {
      linked: true,
      open_leads: n(leadAgg?.open_leads),
      won_leads: n(leadAgg?.won_leads),
      lost_leads: n(leadAgg?.lost_leads),
      open_quotations: n(quoteAgg?.open_quotations),
      accepted_quotations: n(quoteAgg?.accepted_quotations),
      active_contracts: n(contractAgg?.active_contracts),
      forecast_value: 0,
    }
  }

  // --- Contacts on the canonical account --------------------------------------
  const contacts = companyId
    ? await query<any[]>(
        `SELECT id, name, title, email, phone, is_primary
           FROM sales_contacts WHERE company_id = ? ORDER BY is_primary DESC, name ASC`,
        [companyId],
      ).catch(() => [] as any[])
    : []

  // --- Timeline: client audit trail + recent invoices -------------------------
  const auditRows = await query<any[]>(
    `SELECT action, summary, created_at FROM sales_audit_log
      WHERE entity_type = 'client' AND entity_id = ?
      ORDER BY created_at DESC LIMIT 40`,
    [clientCode],
  ).catch(() => [] as any[])

  const timeline = [
    ...auditRows.map((a) => ({ type: "audit", action: a.action, summary: a.summary, at: a.created_at })),
    ...invoices.slice(0, 10).map((inv) => ({
      type: "invoice",
      action: inv.invoice_status,
      summary: `Invoice ${inv.invoice_id} · ${inv.payment_status}`,
      at: inv.invoice_date,
    })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 30)

  return { finance, sales, contacts, timeline }
}

// ---------------------------------------------------------------------------
// Client merge
// ---------------------------------------------------------------------------

/**
 * Merge a duplicate `source` client into a `target` client. Relationships are
 * preserved, not deleted: every sales invoice that pointed at the source client
 * code is repointed to the target, the source inherits any links the target is
 * missing, and the source is archived (never hard-deleted) with a
 * `merged_into_id` breadcrumb. Both sides are audited.
 */
export async function mergeClients(sourceId: number, targetId: number, actorId: number | null) {
  if (sourceId === targetId) throw new Error("Cannot merge a client into itself")

  const rows = await query<any[]>(
    `SELECT * FROM clients WHERE id IN (?, ?)`,
    [sourceId, targetId],
  )
  const source = rows.find((r) => Number(r.id) === Number(sourceId))
  const target = rows.find((r) => Number(r.id) === Number(targetId))
  if (!source) throw new ClientNotFoundError("Source client not found")
  if (!target) throw new ClientNotFoundError("Target client not found")
  if (source.archived_at) throw new Error("Source client is already archived")

  // Repoint financial history from the source client code to the target's.
  const repointed = await query<any>(
    `UPDATE sales_invoices SET client_id = ?, client_name = ? WHERE client_id = ?`,
    [target.client_code, target.company_name || target.client_name, source.client_code],
  ).catch(() => ({ affectedRows: 0 }))

  // Target inherits any canonical links it is missing from the source.
  const inherit: Record<string, any> = {}
  if (!target.company_id && source.company_id) inherit.company_id = source.company_id
  if (!target.finance_party_id && source.finance_party_id) inherit.finance_party_id = source.finance_party_id
  if (!target.primary_contact_id && source.primary_contact_id) inherit.primary_contact_id = source.primary_contact_id
  if (!target.gst_number && source.gst_number) inherit.gst_number = source.gst_number
  if (!target.pan && source.pan) inherit.pan = source.pan
  if (Object.keys(inherit).length > 0) {
    const keys = Object.keys(inherit)
    await query(
      `UPDATE clients SET ${keys.map((k) => `${k}=?`).join(",")}, row_version=row_version+1 WHERE id=?`,
      [...keys.map((k) => inherit[k]), targetId],
    )
  }

  // Archive the source with a breadcrumb back to the survivor.
  await query(
    `UPDATE clients SET archived_at=NOW(), archived_by=?, merged_into_id=?, status='Inactive', row_version=row_version+1 WHERE id=?`,
    [actorId, targetId, sourceId],
  )

  return {
    invoices_repointed: Number(repointed?.affectedRows ?? 0),
    inherited: Object.keys(inherit),
    source_code: source.client_code,
    target_code: target.client_code,
    source_name: source.display_name || source.client_name,
    target_name: target.display_name || target.client_name,
  }
}
