import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { recordAudit, notify } from "@/lib/sales/lead-lifecycle"
import { resolveCompanyId } from "@/lib/sales/company-master"
import { nextDocumentId } from "@/lib/settings/numbering"
import { getSettings } from "@/lib/settings/server"

/**
 * Central Sales Contract service.
 *
 * This module is the ONE place that mutates contract state. API routes,
 * imports, the quotation→contract conversion and the expiry scheduler all call
 * these functions instead of writing to `sales_contracts` directly. That keeps
 * a single source of truth for:
 *   - safe, atomic document numbering (via settings-driven nextDocumentId)
 *   - canonical company linkage (via resolveCompanyId)
 *   - status transition rules + auto-expiry
 *   - append-only event timeline + global audit log + in-app notifications
 *   - restricted delete / soft archive
 *   - e-signature workflow (send → sign → countersign)
 *   - renewals and amendments with source traceability
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const CONTRACT_STATUSES = [
  "Draft",
  "Pending Signature",
  "Active",
  "Expired",
  "Terminated",
  "Cancelled",
  "Renewed",
] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]

/** Allowed status transitions. Auto-expiry (Active→Expired) is applied by the scheduler. */
const TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  Draft: ["Pending Signature", "Active", "Cancelled"],
  "Pending Signature": ["Active", "Draft", "Cancelled"],
  Active: ["Expired", "Terminated", "Renewed"],
  Expired: ["Renewed", "Active"],
  Terminated: [],
  Cancelled: [],
  Renewed: [],
}

export function canTransition(from: string, to: ContractStatus): boolean {
  const allowed = TRANSITIONS[from as ContractStatus]
  return Array.isArray(allowed) && allowed.includes(to)
}

export class ContractError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "ContractError"
    this.status = status
  }
}

export type Actor = number | null | undefined

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

/** Idempotently ensures every contract column/table exists. Runs once per process. */
export async function ensureContractSchema(): Promise<void> {
  if (schemaEnsured) return

  const newColumns: [string, string][] = [
    ["title", "`title` VARCHAR(190) DEFAULT NULL AFTER `contract_code`"],
    ["company_id", "`company_id` INT UNSIGNED DEFAULT NULL"],
    ["source_quotation_id", "`source_quotation_id` INT UNSIGNED DEFAULT NULL"],
    ["parent_contract_id", "`parent_contract_id` INT UNSIGNED DEFAULT NULL"],
    ["root_contract_id", "`root_contract_id` INT UNSIGNED DEFAULT NULL"],
    ["version_no", "`version_no` INT UNSIGNED NOT NULL DEFAULT 1"],
    ["relation", "`relation` ENUM('Original','Renewal','Amendment') NOT NULL DEFAULT 'Original'"],
    ["signed_client_at", "`signed_client_at` DATETIME DEFAULT NULL"],
    ["signed_company_at", "`signed_company_at` DATETIME DEFAULT NULL"],
    ["esign_status", "`esign_status` ENUM('None','Sent','Partially Signed','Completed','Declined') NOT NULL DEFAULT 'None'"],
    ["esign_sent_at", "`esign_sent_at` DATETIME DEFAULT NULL"],
    ["activated_at", "`activated_at` DATETIME DEFAULT NULL"],
    ["expired_at", "`expired_at` DATETIME DEFAULT NULL"],
    ["terminated_at", "`terminated_at` DATETIME DEFAULT NULL"],
    ["terminated_reason", "`terminated_reason` VARCHAR(500) DEFAULT NULL"],
    ["auto_renew", "`auto_renew` TINYINT(1) NOT NULL DEFAULT 0"],
    ["renewal_term_months", "`renewal_term_months` INT UNSIGNED DEFAULT NULL"],
    ["notice_period_days", "`notice_period_days` INT UNSIGNED DEFAULT NULL"],
    ["terms", "`terms` TEXT DEFAULT NULL"],
    ["archived_at", "`archived_at` DATETIME DEFAULT NULL"],
    ["row_version", "`row_version` INT UNSIGNED NOT NULL DEFAULT 1"],
  ]

  try {
    for (const [col, ddl] of newColumns) await addColumnIfMissing("sales_contracts", col, ddl)

    await addKeyIfMissing("sales_contracts", "idx_contracts_company_id", "KEY `idx_contracts_company_id` (`company_id`)")
    await addKeyIfMissing("sales_contracts", "idx_contracts_status", "KEY `idx_contracts_status` (`status`)")
    await addKeyIfMissing("sales_contracts", "idx_contracts_end_date", "KEY `idx_contracts_end_date` (`end_date`)")
    await addKeyIfMissing("sales_contracts", "idx_contracts_parent", "KEY `idx_contracts_parent` (`parent_contract_id`)")

    // Widen the status ENUM so all lifecycle states persist.
    await query(
      `ALTER TABLE sales_contracts MODIFY \`status\` ENUM(${CONTRACT_STATUSES.map((s) => `'${s}'`).join(",")}) NOT NULL DEFAULT 'Draft'`,
    ).catch(() => {})

    await query(`CREATE TABLE IF NOT EXISTS \`sales_contract_events\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`contract_id\` INT UNSIGNED NOT NULL,
      \`type\` VARCHAR(40) NOT NULL DEFAULT 'note',
      \`description\` VARCHAR(500) DEFAULT NULL,
      \`meta\` JSON DEFAULT NULL,
      \`actor_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_contract_events\` (\`contract_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await query(`CREATE TABLE IF NOT EXISTS \`sales_contract_signatures\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`contract_id\` INT UNSIGNED NOT NULL,
      \`party\` ENUM('Client','Company') NOT NULL,
      \`signer_name\` VARCHAR(190) DEFAULT NULL,
      \`signer_email\` VARCHAR(190) DEFAULT NULL,
      \`role\` VARCHAR(80) DEFAULT NULL,
      \`status\` ENUM('Pending','Signed','Declined') NOT NULL DEFAULT 'Pending',
      \`signed_at\` DATETIME DEFAULT NULL,
      \`signed_ip\` VARCHAR(64) DEFAULT NULL,
      \`sort_order\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_contract_sig\` (\`contract_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    schemaEnsured = true
  } catch (error) {
    console.error("[contract-service] ensureSchema failed", error)
  }
}

// ---------------------------------------------------------------------------
// Shared write primitives
// ---------------------------------------------------------------------------

async function run<T = any>(conn: PoolConnection | null, sql: string, params: any[] = []): Promise<T> {
  if (conn) {
    const [rows] = await conn.query(sql, params)
    return rows as T
  }
  return query<T>(sql, params)
}

/** Append a contract-specific timeline event AND mirror it to the global audit log. */
export async function logEvent(
  conn: PoolConnection | null,
  input: {
    contractId: number
    type: string
    description?: string | null
    meta?: Record<string, unknown> | null
    actorId?: Actor
  },
): Promise<void> {
  await run(
    conn,
    `INSERT INTO sales_contract_events (contract_id, type, description, meta, actor_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.contractId,
      input.type,
      input.description ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.actorId ?? null,
    ],
  ).catch((e) => console.error("[contract-service] event insert failed", e))

  await recordAudit(conn, {
    entityType: "contract",
    entityId: input.contractId,
    action: input.type,
    summary: input.description ?? null,
    meta: input.meta ?? null,
    actorId: input.actorId,
  })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractRecord = {
  id: number
  contract_code: string
  title: string | null
  contract_date: string | null
  company_name: string | null
  company_id: number | null
  start_date: string | null
  end_date: string | null
  value: number
  contract_type: string | null
  status: ContractStatus
  signed_by_client: string | null
  signed_by_company: string | null
  signed_client_at: string | null
  signed_company_at: string | null
  esign_status: string
  esign_sent_at: string | null
  activated_at: string | null
  expired_at: string | null
  terminated_at: string | null
  terminated_reason: string | null
  auto_renew: number
  renewal_term_months: number | null
  notice_period_days: number | null
  terms: string | null
  notes: string | null
  source_quotation_id: number | null
  parent_contract_id: number | null
  root_contract_id: number | null
  version_no: number
  relation: string
  archived_at: string | null
  row_version: number
  added_by: number | null
  added_by_name: string | null
  created_at: string
  updated_at: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SELECT_FIELDS = `c.*, u.name AS added_by_name,
  sq.quote_code AS source_quotation_code,
  pc.contract_code AS parent_contract_code`

export async function getContract(id: number): Promise<ContractRecord | null> {
  await ensureContractSchema()
  const rows = await query<any[]>(
    `SELECT ${SELECT_FIELDS}
     FROM sales_contracts c
     LEFT JOIN users u ON u.id = c.added_by
     LEFT JOIN sales_quotations sq ON sq.id = c.source_quotation_id
     LEFT JOIN sales_contracts pc ON pc.id = c.parent_contract_id
     WHERE c.id = ? LIMIT 1`,
    [id],
  )
  return (rows[0] as ContractRecord) ?? null
}

export type ListFilters = {
  search?: string
  status?: string
  contract_type?: string
  company_id?: number
  from?: string
  to?: string
  expiringInDays?: number
  includeArchived?: boolean
  sort?: string
  dir?: "asc" | "desc"
}

const SORTABLE: Record<string, string> = {
  contract_code: "c.contract_code",
  company_name: "c.company_name",
  value: "c.value",
  start_date: "c.start_date",
  end_date: "c.end_date",
  status: "c.status",
  created_at: "c.created_at",
}

export async function listContracts(filters: ListFilters = {}): Promise<ContractRecord[]> {
  await ensureContractSchema()
  const where: string[] = []
  const params: any[] = []

  if (!filters.includeArchived) where.push("c.archived_at IS NULL")
  if (filters.search) {
    where.push("(c.company_name LIKE ? OR c.contract_code LIKE ? OR c.title LIKE ? OR c.contract_type LIKE ?)")
    const like = `%${filters.search}%`
    params.push(like, like, like, like)
  }
  if (filters.status && filters.status !== "all") {
    where.push("c.status = ?")
    params.push(filters.status)
  }
  if (filters.contract_type && filters.contract_type !== "all") {
    where.push("c.contract_type = ?")
    params.push(filters.contract_type)
  }
  if (filters.company_id) {
    where.push("c.company_id = ?")
    params.push(filters.company_id)
  }
  if (filters.from) {
    where.push("c.start_date >= ?")
    params.push(filters.from)
  }
  if (filters.to) {
    where.push("c.end_date <= ?")
    params.push(filters.to)
  }
  if (filters.expiringInDays != null) {
    where.push("c.status = 'Active' AND c.end_date IS NOT NULL AND c.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)")
    params.push(filters.expiringInDays)
  }

  const sortCol = SORTABLE[filters.sort || "created_at"] || "c.created_at"
  const sortDir = filters.dir === "asc" ? "ASC" : "DESC"

  const rows = await query<any[]>(
    `SELECT ${SELECT_FIELDS}
     FROM sales_contracts c
     LEFT JOIN users u ON u.id = c.added_by
     LEFT JOIN sales_quotations sq ON sq.id = c.source_quotation_id
     LEFT JOIN sales_contracts pc ON pc.id = c.parent_contract_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${sortCol} ${sortDir}, c.id DESC`,
    params,
  )
  return rows as ContractRecord[]
}

export type ContractAnalytics = {
  total: number
  active: number
  draft: number
  pending_signature: number
  expired: number
  terminated: number
  expiring_soon: number
  total_active_value: number
}

export async function getContractAnalytics(): Promise<ContractAnalytics> {
  await ensureContractSchema()
  const [row] = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'Active') AS active,
       SUM(status = 'Draft') AS draft,
       SUM(status = 'Pending Signature') AS pending_signature,
       SUM(status = 'Expired') AS expired,
       SUM(status = 'Terminated') AS terminated,
       SUM(status = 'Active' AND end_date IS NOT NULL AND end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS expiring_soon,
       COALESCE(SUM(CASE WHEN status = 'Active' THEN value ELSE 0 END), 0) AS total_active_value
     FROM sales_contracts
     WHERE archived_at IS NULL`,
  )
  return {
    total: Number(row?.total || 0),
    active: Number(row?.active || 0),
    draft: Number(row?.draft || 0),
    pending_signature: Number(row?.pending_signature || 0),
    expired: Number(row?.expired || 0),
    terminated: Number(row?.terminated || 0),
    expiring_soon: Number(row?.expiring_soon || 0),
    total_active_value: Number(row?.total_active_value || 0),
  }
}

export async function getContractEvents(id: number) {
  await ensureContractSchema()
  return query<any[]>(
    `SELECT e.*, u.name AS actor_name
     FROM sales_contract_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.contract_id = ?
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT 200`,
    [id],
  )
}

export async function getContractSignatures(id: number) {
  await ensureContractSchema()
  return query<any[]>(
    `SELECT * FROM sales_contract_signatures WHERE contract_id = ? ORDER BY sort_order ASC, id ASC`,
    [id],
  )
}

/**
 * Read-only relations for the 360° view: source quotation, invoices linked by
 * company, onboarding by contract_code, amendments/renewals, and the company
 * (client) record.
 */
export async function getContractRelations(contract: ContractRecord) {
  await ensureContractSchema()

  const [invoices, onboarding, children, company] = await Promise.all([
    contract.company_id
      ? query<any[]>(
          `SELECT id, invoice_id, invoice_date, invoice_total, outstanding_amount, payment_status, invoice_status
           FROM sales_invoices
           WHERE (source_quotation_id IS NOT NULL AND source_quotation_id = ?)
              OR client_name = ?
           ORDER BY invoice_date DESC LIMIT 50`,
          [contract.source_quotation_id ?? 0, contract.company_name],
        ).catch(() => [])
      : query<any[]>(
          `SELECT id, invoice_id, invoice_date, invoice_total, outstanding_amount, payment_status, invoice_status
           FROM sales_invoices WHERE client_name = ? ORDER BY invoice_date DESC LIMIT 50`,
          [contract.company_name],
        ).catch(() => []),
    query<any[]>(
      `SELECT id, onboarding_code, onboarding_date, current_stage, status
       FROM sales_onboarding WHERE contract_code = ? ORDER BY created_at DESC`,
      [contract.contract_code],
    ).catch(() => []),
    query<any[]>(
      `SELECT id, contract_code, relation, version_no, status, value, start_date, end_date
       FROM sales_contracts
       WHERE parent_contract_id = ? OR (root_contract_id = ? AND id <> ?)
       ORDER BY version_no ASC, id ASC`,
      [contract.id, contract.root_contract_id ?? contract.id, contract.id],
    ).catch(() => []),
    contract.company_id
      ? query<any[]>(
          `SELECT id, company_code, company_name AS name, status, priority, assigned_to AS owner_id, industry, website
           FROM sales_companies WHERE id = ? LIMIT 1`,
          [contract.company_id],
        ).catch(() => [])
      : Promise.resolve([]),
  ])

  return {
    invoices,
    onboarding,
    amendments: children,
    company: (company as any[])[0] ?? null,
  }
}

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

export async function createContract(
  input: Record<string, any>,
  actorId: Actor,
): Promise<{ id: number; contract_code: string }> {
  await ensureContractSchema()
  if (!input.company_name) throw new ContractError("Company name is required")

  const contractCode = await nextDocumentId("contract")
  const companyId = await resolveCompanyId({ company_id: input.company_id, company_name: input.company_name })
  const settings = await getSettings()
  const defaultTerms = (settings["contract.default_terms"] || "").trim() || null

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [res] = await conn.query<any>(
      `INSERT INTO sales_contracts
       (contract_code, title, contract_date, company_name, company_id, start_date, end_date, value,
        contract_type, status, signed_by_client, signed_by_company, terms, notes, auto_renew,
        renewal_term_months, notice_period_days, relation, version_no, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Original', 1, ?)`,
      [
        contractCode,
        input.title || null,
        input.contract_date || new Date().toISOString().slice(0, 10),
        input.company_name,
        companyId,
        input.start_date || null,
        input.end_date || null,
        Number(input.value) || 0,
        input.contract_type || null,
        CONTRACT_STATUSES.includes(input.status) ? input.status : "Draft",
        input.signed_by_client || null,
        input.signed_by_company || null,
        input.terms ?? defaultTerms,
        input.notes || null,
        input.auto_renew ? 1 : 0,
        input.renewal_term_months || null,
        input.notice_period_days || null,
        actorId ?? null,
      ],
    )
    const id = res.insertId as number
    await conn.query("UPDATE sales_contracts SET root_contract_id = ? WHERE id = ?", [id, id])
    await logEvent(conn, {
      contractId: id,
      type: "created",
      description: `Contract ${contractCode} created`,
      actorId,
    })
    await conn.commit()
    return { id, contract_code: contractCode }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Canonical creation of a contract FROM an accepted quotation. This is the ONE
 * place quotation→contract conversion happens so it shares the same safe,
 * settings-driven numbering (CON-0001), company linkage, root/version tracking,
 * and append-only timeline as every other contract. `quotation` is a loaded
 * `sales_quotations` row.
 */
export async function createContractFromQuotation(
  quotation: Record<string, any>,
  actorId: Actor,
  opts: { start_date?: string; end_date?: string; contract_type?: string } = {},
): Promise<{ id: number; contract_code: string }> {
  await ensureContractSchema()
  if (!quotation?.company_name) throw new ContractError("Quotation has no company to contract with")

  const contractCode = await nextDocumentId("contract")
  const companyId = await resolveCompanyId({
    company_id: quotation.company_id,
    company_name: quotation.company_name,
  })

  // Carry the quotation's commercial terms into the contract body.
  const termsParts = [
    quotation.payment_terms ? `Payment terms: ${quotation.payment_terms}` : null,
    quotation.delivery_terms ? `Delivery terms: ${quotation.delivery_terms}` : null,
    quotation.terms_text || null,
  ].filter(Boolean)
  const terms = termsParts.length ? termsParts.join("\n\n") : null

  const value = Number(quotation.grand_total ?? quotation.value ?? 0) || 0

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [res] = await conn.query<any>(
      `INSERT INTO sales_contracts
       (contract_code, title, contract_date, company_name, company_id, start_date, end_date, value,
        contract_type, status, signed_by_client, terms, notes, source_quotation_id,
        relation, version_no, added_by)
       VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?, 'Original', 1, ?)`,
      [
        contractCode,
        quotation.opportunity_name || quotation.reference || null,
        quotation.company_name,
        companyId,
        opts.start_date || null,
        opts.end_date || null,
        value,
        opts.contract_type || quotation.opportunity_name || "Service",
        quotation.contact_person || null,
        terms,
        `Generated from quotation ${quotation.quote_code}`,
        quotation.id,
        actorId ?? null,
      ],
    )
    const id = res.insertId as number
    await conn.query("UPDATE sales_contracts SET root_contract_id = ? WHERE id = ?", [id, id])
    await logEvent(conn, {
      contractId: id,
      type: "created_from_quotation",
      description: `Contract ${contractCode} created from quotation ${quotation.quote_code}`,
      meta: {
        quotation_id: quotation.id,
        quote_code: quotation.quote_code,
        currency: quotation.currency,
        value,
      },
      actorId,
    })
    await conn.commit()
    return { id, contract_code: contractCode }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Editable fields. Locked once the contract leaves Draft/Pending Signature. */
const EDITABLE_FIELDS = [
  "title",
  "company_name",
  "start_date",
  "end_date",
  "value",
  "contract_type",
  "signed_by_client",
  "signed_by_company",
  "terms",
  "notes",
  "auto_renew",
  "renewal_term_months",
  "notice_period_days",
] as const

export async function updateContract(
  id: number,
  input: Record<string, any>,
  actorId: Actor,
  expectedVersion?: number,
): Promise<void> {
  await ensureContractSchema()
  const current = await getContract(id)
  if (!current) throw new ContractError("Contract not found", 404)
  if (expectedVersion != null && Number(expectedVersion) !== Number(current.row_version)) {
    throw new ContractError("This contract was modified by someone else. Refresh and try again.", 409)
  }
  const editable = current.status === "Draft" || current.status === "Pending Signature"
  if (!editable) {
    // Once active/closed, only notes and renewal settings may change.
    const restricted = Object.keys(input).filter(
      (k) => !["notes", "auto_renew", "renewal_term_months", "notice_period_days"].includes(k),
    )
    if (restricted.length) {
      throw new ContractError(`A ${current.status} contract's terms are locked. Only notes and renewal settings can change.`, 409)
    }
  }

  const sets: string[] = []
  const params: any[] = []
  for (const field of EDITABLE_FIELDS) {
    if (field in input) {
      sets.push(`\`${field}\` = ?`)
      if (field === "value") params.push(Number(input[field]) || 0)
      else if (field === "auto_renew") params.push(input[field] ? 1 : 0)
      else params.push(input[field] === "" ? null : input[field])
    }
  }
  if (!sets.length) return

  if ("company_name" in input) {
    const companyId = await resolveCompanyId({ company_id: input.company_id, company_name: input.company_name })
    sets.push("`company_id` = ?")
    params.push(companyId)
  }
  sets.push("`row_version` = `row_version` + 1")

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`UPDATE sales_contracts SET ${sets.join(", ")} WHERE id = ?`, [...params, id])
    await logEvent(conn, { contractId: id, type: "updated", description: "Contract details updated", actorId })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

async function transition(
  conn: PoolConnection,
  id: number,
  to: ContractStatus,
  extraSets: string[] = [],
  extraParams: any[] = [],
) {
  await conn.query(
    `UPDATE sales_contracts SET status = ?, row_version = row_version + 1${extraSets.length ? ", " + extraSets.join(", ") : ""} WHERE id = ?`,
    [to, ...extraParams, id],
  )
}

export async function activateContract(id: number, actorId: Actor): Promise<void> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!canTransition(c.status, "Active")) throw new ContractError(`Cannot activate a ${c.status} contract.`, 409)

  const settings = await getSettings()
  const requireSig = (settings["contract.require_signature"] || "Enabled") !== "Disabled"
  if (requireSig) {
    const sigs = await getContractSignatures(id)
    const unsigned = sigs.filter((s) => s.status !== "Signed")
    if (sigs.length && unsigned.length) {
      throw new ContractError("All parties must sign before this contract can be activated.", 409)
    }
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await transition(conn, id, "Active", ["activated_at = NOW()"])
    await logEvent(conn, { contractId: id, type: "activated", description: "Contract activated", actorId })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function terminateContract(id: number, reason: string, actorId: Actor): Promise<void> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!canTransition(c.status, "Terminated")) throw new ContractError(`Cannot terminate a ${c.status} contract.`, 409)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await transition(conn, id, "Terminated", ["terminated_at = NOW()", "terminated_reason = ?"], [reason || null])
    await logEvent(conn, {
      contractId: id,
      type: "terminated",
      description: reason ? `Terminated: ${reason}` : "Contract terminated",
      actorId,
    })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function cancelContract(id: number, actorId: Actor): Promise<void> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!canTransition(c.status, "Cancelled")) throw new ContractError(`Cannot cancel a ${c.status} contract.`, 409)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await transition(conn, id, "Cancelled")
    await logEvent(conn, { contractId: id, type: "cancelled", description: "Contract cancelled", actorId })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// Restricted delete / archive
// ---------------------------------------------------------------------------

/** Only Draft/Cancelled contracts can be hard-deleted; everything else must be archived. */
export async function deleteContract(id: number, actorId: Actor): Promise<void> {
  await ensureContractSchema()
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!["Draft", "Cancelled"].includes(c.status)) {
    throw new ContractError(
      `A ${c.status} contract cannot be deleted. Archive it instead to preserve the audit trail.`,
      409,
    )
  }
  await recordAudit(null, {
    entityType: "contract",
    entityId: id,
    action: "deleted",
    summary: `Contract ${c.contract_code} deleted`,
    actorId,
  })
  await query("DELETE FROM sales_contracts WHERE id = ?", [id])
}

export async function archiveContract(id: number, actorId: Actor): Promise<void> {
  await ensureContractSchema()
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (c.archived_at) return
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query("UPDATE sales_contracts SET archived_at = NOW(), row_version = row_version + 1 WHERE id = ?", [id])
    await logEvent(conn, { contractId: id, type: "archived", description: "Contract archived", actorId })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function restoreContract(id: number, actorId: Actor): Promise<void> {
  await ensureContractSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query("UPDATE sales_contracts SET archived_at = NULL, row_version = row_version + 1 WHERE id = ?", [id])
    await logEvent(conn, { contractId: id, type: "restored", description: "Contract restored", actorId })
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------------
// E-signature workflow (send → sign → countersign)
// ---------------------------------------------------------------------------

export async function sendForSignature(
  id: number,
  input: {
    client_name?: string
    client_email?: string
    company_name?: string
    company_email?: string
  },
  actorId: Actor,
): Promise<void> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!canTransition(c.status, "Pending Signature") && c.status !== "Pending Signature") {
    throw new ContractError(`Cannot send a ${c.status} contract for signature.`, 409)
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Reset any existing signature rows so re-sending starts a clean round.
    await conn.query("DELETE FROM sales_contract_signatures WHERE contract_id = ?", [id])
    await conn.query(
      `INSERT INTO sales_contract_signatures (contract_id, party, signer_name, signer_email, role, sort_order)
       VALUES (?, 'Client', ?, ?, 'Client Signatory', 0), (?, 'Company', ?, ?, 'Company Signatory', 1)`,
      [
        id,
        input.client_name || c.signed_by_client || c.company_name,
        input.client_email || null,
        id,
        input.company_name || c.signed_by_company || null,
        input.company_email || null,
      ],
    )
    await transition(conn, id, "Pending Signature", ["esign_status = 'Sent'", "esign_sent_at = NOW()"])
    await logEvent(conn, {
      contractId: id,
      type: "sent_for_signature",
      description: "Contract sent for e-signature",
      meta: { client_email: input.client_email, company_email: input.company_email },
      actorId,
    })
    await conn.commit()
    await notify(null, {
      userId: c.added_by,
      type: "contract",
      title: `Contract ${c.contract_code} sent for signature`,
      body: `Awaiting signatures from ${c.company_name}.`,
      link: `/modules/sales/contracts`,
      entityType: "contract",
      entityId: id,
    })
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function applySignature(
  id: number,
  party: "Client" | "Company",
  signerName: string | undefined,
  ip: string | null,
  actorId: Actor,
): Promise<void> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (c.status !== "Pending Signature") {
    throw new ContractError("This contract is not awaiting signatures.", 409)
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const nameCol = party === "Client" ? "signed_by_client" : "signed_by_company"
    const atCol = party === "Client" ? "signed_client_at" : "signed_company_at"
    await conn.query(
      `UPDATE sales_contract_signatures SET status = 'Signed', signed_at = NOW(), signed_ip = ?, signer_name = COALESCE(?, signer_name)
       WHERE contract_id = ? AND party = ?`,
      [ip, signerName || null, id, party],
    )
    await conn.query(
      `UPDATE sales_contracts SET \`${nameCol}\` = COALESCE(?, \`${nameCol}\`), \`${atCol}\` = NOW(), row_version = row_version + 1 WHERE id = ?`,
      [signerName || null, id],
    )
    await logEvent(conn, {
      contractId: id,
      type: party === "Client" ? "signed_client" : "signed_company",
      description: `${party} signed the contract${signerName ? ` (${signerName})` : ""}`,
      actorId,
    })

    // Determine remaining signatures.
    const [rows] = await conn.query<any[]>(
      "SELECT status FROM sales_contract_signatures WHERE contract_id = ?",
      [id],
    )
    const remaining = rows.filter((r) => r.status !== "Signed").length
    if (remaining === 0) {
      await transition(conn, id, "Active", ["esign_status = 'Completed'", "activated_at = NOW()"])
      await logEvent(conn, {
        contractId: id,
        type: "activated",
        description: "All parties signed — contract activated",
        actorId,
      })
    } else {
      await conn.query("UPDATE sales_contracts SET esign_status = 'Partially Signed' WHERE id = ?", [id])
    }
    await conn.commit()

    if (remaining === 0) {
      await notify(null, {
        userId: c.added_by,
        type: "contract",
        title: `Contract ${c.contract_code} fully signed`,
        body: "The contract is now active.",
        link: `/modules/sales/contracts`,
        entityType: "contract",
        entityId: id,
      })
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function signAsClient(id: number, signerName: string | undefined, ip: string | null, actorId: Actor) {
  return applySignature(id, "Client", signerName, ip, actorId)
}

export async function countersign(id: number, signerName: string | undefined, ip: string | null, actorId: Actor) {
  return applySignature(id, "Company", signerName, ip, actorId)
}

// ---------------------------------------------------------------------------
// Renewals & amendments (successor contracts with source traceability)
// ---------------------------------------------------------------------------

function addMonths(dateStr: string | null, months: number | null | undefined): string | null {
  if (!dateStr || !months) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

async function createSuccessor(
  parent: ContractRecord,
  relation: "Renewal" | "Amendment",
  overrides: Record<string, any>,
  actorId: Actor,
): Promise<{ id: number; contract_code: string }> {
  const contractCode = await nextDocumentId("contract")
  const root = parent.root_contract_id ?? parent.id
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [maxRows] = await conn.query<any[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS mx FROM sales_contracts WHERE root_contract_id = ? OR id = ?",
      [root, root],
    )
    const nextVersion = Number(maxRows[0]?.mx || parent.version_no || 1) + 1
    const [res] = await conn.query<any>(
      `INSERT INTO sales_contracts
       (contract_code, title, contract_date, company_name, company_id, start_date, end_date, value,
        contract_type, status, terms, notes, auto_renew, renewal_term_months, notice_period_days,
        source_quotation_id, parent_contract_id, root_contract_id, version_no, relation, added_by)
       VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contractCode,
        overrides.title ?? parent.title,
        parent.company_name,
        parent.company_id,
        overrides.start_date ?? null,
        overrides.end_date ?? null,
        overrides.value != null ? Number(overrides.value) : parent.value,
        overrides.contract_type ?? parent.contract_type,
        overrides.terms ?? parent.terms,
        overrides.notes ?? `${relation} of ${parent.contract_code}`,
        parent.auto_renew,
        parent.renewal_term_months,
        parent.notice_period_days,
        parent.source_quotation_id,
        parent.id,
        root,
        nextVersion,
        relation,
        actorId ?? null,
      ],
    )
    const id = res.insertId as number
    await logEvent(conn, {
      contractId: id,
      type: relation === "Renewal" ? "renewal_created" : "amendment_created",
      description: `${relation} created from ${parent.contract_code}`,
      meta: { parent_id: parent.id, parent_code: parent.contract_code },
      actorId,
    })
    await logEvent(conn, {
      contractId: parent.id,
      type: relation === "Renewal" ? "renewed" : "amended",
      description: `${relation} ${contractCode} created`,
      meta: { child_id: id, child_code: contractCode },
      actorId,
    })
    if (relation === "Renewal" && parent.status !== "Expired") {
      await transition(conn, parent.id, "Renewed")
    }
    await conn.commit()
    return { id, contract_code: contractCode }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function renewContract(
  id: number,
  overrides: Record<string, any>,
  actorId: Actor,
): Promise<{ id: number; contract_code: string }> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!["Active", "Expired"].includes(c.status)) {
    throw new ContractError("Only an active or expired contract can be renewed.", 409)
  }
  const start = overrides.start_date || c.end_date || new Date().toISOString().slice(0, 10)
  const end = overrides.end_date || addMonths(start, c.renewal_term_months || 12)
  return createSuccessor(c, "Renewal", { ...overrides, start_date: start, end_date: end }, actorId)
}

export async function amendContract(
  id: number,
  overrides: Record<string, any>,
  actorId: Actor,
): Promise<{ id: number; contract_code: string }> {
  const c = await getContract(id)
  if (!c) throw new ContractError("Contract not found", 404)
  if (!["Active", "Draft", "Pending Signature"].includes(c.status)) {
    throw new ContractError("Only an active or draft contract can be amended.", 409)
  }
  return createSuccessor(
    c,
    "Amendment",
    {
      ...overrides,
      start_date: overrides.start_date ?? c.start_date,
      end_date: overrides.end_date ?? c.end_date,
    },
    actorId,
  )
}

// ---------------------------------------------------------------------------
// Auto-expiry scheduler
// ---------------------------------------------------------------------------

/**
 * Auto-expires active contracts whose end_date has passed and notifies owners
 * of contracts expiring within `warnDays`. Idempotent and safe to run daily.
 */
export async function runExpiryScheduler(warnDays = 30): Promise<{ expired: number; warned: number }> {
  await ensureContractSchema()

  const toExpire = await query<any[]>(
    `SELECT id, contract_code, added_by, auto_renew, renewal_term_months, end_date, start_date,
            company_name, company_id, value, contract_type, terms, notice_period_days, version_no, root_contract_id
     FROM sales_contracts
     WHERE status = 'Active' AND end_date IS NOT NULL AND end_date < CURDATE() AND archived_at IS NULL`,
  )

  let expired = 0
  for (const row of toExpire) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await transition(conn, row.id, "Expired", ["expired_at = NOW()"])
      await logEvent(conn, {
        contractId: row.id,
        type: "expired",
        description: "Contract auto-expired (end date passed)",
      })
      await conn.commit()
      expired++
      await notify(null, {
        userId: row.added_by,
        type: "contract",
        title: `Contract ${row.contract_code} expired`,
        body: `The contract with ${row.company_name} reached its end date.`,
        link: `/modules/sales/contracts`,
        entityType: "contract",
        entityId: row.id,
      })
      if (row.auto_renew) {
        await renewContract(row.id, {}, row.added_by).catch((e) =>
          console.error("[contract-service] auto-renew failed", e),
        )
      }
    } catch (e) {
      await conn.rollback()
      console.error("[contract-service] expire failed", e)
    } finally {
      conn.release()
    }
  }

  const expiring = await query<any[]>(
    `SELECT id, contract_code, added_by, company_name, end_date
     FROM sales_contracts
     WHERE status = 'Active' AND end_date IS NOT NULL
       AND end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
       AND archived_at IS NULL`,
    [warnDays],
  )

  let warned = 0
  for (const row of expiring) {
    await notify(null, {
      userId: row.added_by,
      type: "contract",
      title: `Contract ${row.contract_code} expiring soon`,
      body: `Expires on ${new Date(row.end_date).toLocaleDateString()} — review renewal for ${row.company_name}.`,
      link: `/modules/sales/contracts`,
      entityType: "contract",
      entityId: row.id,
    })
    warned++
  }

  return { expired, warned }
}
