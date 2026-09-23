import "server-only"
/**
 * Multi-entity support.
 * ---------------------------------------------------------------------------
 * Lets a SINGLE tenant operate multiple legal / business entities, each with
 * its own tax identity (GST/VAT), bank accounts, accounting book, and address,
 * while still rolling everything up into consolidated reporting.
 *
 * Model:
 *   - `legal_entities`            : the entity master (tax ids, address, book,
 * base currency, optional link to a
 *                                   `org_units` legal_entity node).
 *   - `legal_entity_bank_accounts`: per-entity bank/cash identities.
 *   - `intercompany_transactions` : transfers between two of the tenant's own
 *                                   entities, eliminated on consolidation.
 *
 * Entity CONTEXT is threaded through finance transactions via an additive,
 * nullable `entity_id` column on the ledger + document tables (added by
 * ensureEntitySchema()). Existing rows keep working (entity_id NULL → shown as
 * "Unassigned"); nothing that already posted is rewritten.
 *
 * Isolation: all three tables are registered tenant-owned (lib/tenant-tables.ts)
 * so every read/write flows through the tenant-scoped helpers and the
 * fail-closed guard.
 *
 * "Separate accounting books" = the posted `general_ledger` sliced by
 * `entity_id`. Entity-level reporting filters by one entity; consolidated
 * reporting sums every entity and then removes inter-company movements so the
 * group is not double-counted.
 */
import { query } from "@/lib/db"
import {
  currentTenantId,
  tenantSelect,
  tenantInsert,
  tenantUpdate,
  tenantDelete,
  requireOwnedRow,
} from "@/lib/tenant-scope"
import { nextRecordId } from "@/lib/record-ids"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class EntityValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EntityValidationError"
  }
}
export class EntityNotFoundError extends Error {
  constructor(message = "Entity not found") {
    super(message)
    this.name = "EntityNotFoundError"
  }
}

export type Actor = { userId: number | null; name: string | null }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type LegalEntity = {
  id: number
  tenant_id: number
  entity_code: string
  name: string
  legal_name: string | null
  entity_type: string
  registration_no: string | null
  tax_name: string | null
  tax_number: string | null
  secondary_tax_name: string | null
  secondary_tax_number: string | null
  base_currency: string
  book_name: string | null
  email: string | null
  phone: string | null
  address_line: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  org_unit_id: number | null
  is_default: number
  status: "active" | "inactive"
  created_by: number | null
  created_at: string
  updated_at: string
}

export type EntityBankAccount = {
  id: number
  tenant_id: number
  entity_id: number
  account_name: string
  bank_name: string | null
  account_no: string | null
  ifsc_swift: string | null
  branch: string | null
  currency: string
  account_type: string | null
  is_primary: number
  status: "active" | "inactive"
  created_at: string
  updated_at: string
}

export type IntercompanyTxn = {
  id: number
  tenant_id: number
  txn_code: string
  from_entity_id: number
  to_entity_id: number
  txn_date: string | null
  amount: number
  currency: string
  category: string | null
  description: string | null
  reference_no: string | null
  status: "draft" | "posted" | "settled" | "cancelled"
  created_by: number | null
  created_at: string
  updated_at: string
}

export const ENTITY_TYPES = [
  "private_limited",
  "public_limited",
  "llp",
  "partnership",
  "proprietorship",
  "branch",
  "subsidiary",
  "joint_venture",
  "trust",
  "other",
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  private_limited: "Private Limited",
  public_limited: "Public Limited",
  llp: "LLP",
  partnership: "Partnership",
  proprietorship: "Proprietorship",
  branch: "Branch",
  subsidiary: "Subsidiary",
  joint_venture: "Joint Venture",
  trust: "Trust",
  other: "Other",
}

// Finance tables that gain an additive, nullable `entity_id` so posted rows and
// documents can be attributed to one legal entity (separate books + reporting).
const ENTITY_LINKED_TABLES = [
  "journal_entries",
  "general_ledger",
  "finance_accounts",
  "finance_records",
  "sales_invoices",
  "purchase_bills",
  "expenses",
] as const

// ---------------------------------------------------------------------------
// Schema self-heal (mirrors database/migrations/2026-11-13-multi-entity.sql).
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  )
  return rows.length > 0
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS legal_entities (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED DEFAULT NULL,
      entity_code VARCHAR(40) NOT NULL,
      name VARCHAR(190) NOT NULL,
      legal_name VARCHAR(190) DEFAULT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'private_limited',
      registration_no VARCHAR(80) DEFAULT NULL,
      tax_name VARCHAR(40) DEFAULT NULL,
      tax_number VARCHAR(60) DEFAULT NULL,
      secondary_tax_name VARCHAR(40) DEFAULT NULL,
      secondary_tax_number VARCHAR(60) DEFAULT NULL,
      base_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      book_name VARCHAR(120) DEFAULT NULL,
      email VARCHAR(190) DEFAULT NULL,
      phone VARCHAR(40) DEFAULT NULL,
      address_line VARCHAR(255) DEFAULT NULL,
      city VARCHAR(120) DEFAULT NULL,
      state VARCHAR(120) DEFAULT NULL,
      postal_code VARCHAR(30) DEFAULT NULL,
      country VARCHAR(120) DEFAULT NULL,
      org_unit_id INT UNSIGNED DEFAULT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_legal_entities_tenant_code (tenant_id, entity_code),
      KEY idx_legal_entities_tenant (tenant_id),
      KEY idx_legal_entities_org_unit (org_unit_id),
      KEY idx_legal_entities_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS legal_entity_bank_accounts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED DEFAULT NULL,
      entity_id INT UNSIGNED NOT NULL,
      account_name VARCHAR(190) NOT NULL,
      bank_name VARCHAR(190) DEFAULT NULL,
      account_no VARCHAR(60) DEFAULT NULL,
      ifsc_swift VARCHAR(40) DEFAULT NULL,
      branch VARCHAR(190) DEFAULT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      account_type VARCHAR(40) DEFAULT NULL,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_entity_bank_tenant (tenant_id),
      KEY idx_entity_bank_entity (entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS intercompany_transactions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED DEFAULT NULL,
      txn_code VARCHAR(40) NOT NULL,
      from_entity_id INT UNSIGNED NOT NULL,
      to_entity_id INT UNSIGNED NOT NULL,
      txn_date DATE DEFAULT NULL,
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      category VARCHAR(80) DEFAULT NULL,
      description VARCHAR(500) DEFAULT NULL,
      reference_no VARCHAR(120) DEFAULT NULL,
      status ENUM('draft','posted','settled','cancelled') NOT NULL DEFAULT 'draft',
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_intercompany_tenant_code (tenant_id, txn_code),
      KEY idx_intercompany_tenant (tenant_id),
      KEY idx_intercompany_from (from_entity_id),
      KEY idx_intercompany_to (to_entity_id),
      KEY idx_intercompany_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Thread entity context onto finance ledgers + documents. Additive + nullable.
  for (const t of ENTITY_LINKED_TABLES) {
    if ((await tableExists(t)) && !(await columnExists(t, "entity_id"))) {
      await query(`ALTER TABLE \`${t}\` ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL`).catch(() => {})
      await query(`ALTER TABLE \`${t}\` ADD KEY idx_${t}_entity (entity_id)`).catch(() => {})
    }
  }
}

export async function ensureEntitySchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Entity reads
// ---------------------------------------------------------------------------
export async function listEntities(
  scope?: { sql: string; params: (string | number)[] } | null,
): Promise<Array<LegalEntity & { bank_account_count: number; org_unit_name: string | null }>> {
  await ensureEntitySchema()
  const tenantId = currentTenantId()
  // optional data-level scope predicate (finance.entities). ANDed
  // into the tenant filter so a Finance user only sees their assigned entities.
  // The predicate is built with the "e" alias by the caller (dataScopeWhere).
  const scopeSql = scope ? ` AND ${scope.sql}` : ""
  const scopeParams = scope ? scope.params : []
  const rows = await query<any[]>(
    `SELECT e.*,
            (SELECT COUNT(*) FROM legal_entity_bank_accounts b
              WHERE b.entity_id = e.id AND b.tenant_id = e.tenant_id) AS bank_account_count,
            (SELECT name FROM org_units u
              WHERE u.id = e.org_unit_id AND u.tenant_id = e.tenant_id LIMIT 1) AS org_unit_name
       FROM legal_entities e
      WHERE e.tenant_id = ?${scopeSql}
      ORDER BY e.is_default DESC, e.status ASC, e.name ASC`,
    [tenantId, ...scopeParams],
  )
  return rows as any
}

export async function getEntity(id: number): Promise<LegalEntity | null> {
  await ensureEntitySchema()
  const rows = await tenantSelect<any[]>("legal_entities", { where: "id = ?", params: [id], tail: "LIMIT 1" })
  return (rows[0] as LegalEntity) ?? null
}

// ---------------------------------------------------------------------------
// Entity writes
// ---------------------------------------------------------------------------
export type CreateEntityInput = {
  name: string
  legal_name?: string | null
  entity_type?: string
  registration_no?: string | null
  tax_name?: string | null
  tax_number?: string | null
  secondary_tax_name?: string | null
  secondary_tax_number?: string | null
  base_currency?: string
  book_name?: string | null
  email?: string | null
  phone?: string | null
  address_line?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string | null
  org_unit_id?: number | null
  is_default?: boolean
  status?: "active" | "inactive"
}

const trimOrNull = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : ""
  return s ? s : null
}

export async function createEntity(input: CreateEntityInput, actor: Actor): Promise<LegalEntity> {
  await ensureEntitySchema()
  const name = String(input.name || "").trim()
  if (!name) throw new EntityValidationError("Entity name is required")

  const entityCode = await nextRecordId("LE", { allowCustom: true })
  const tenantId = currentTenantId()

  // First entity for a tenant becomes the default automatically.
  const existing = await query<any[]>(`SELECT COUNT(*) AS c FROM legal_entities WHERE tenant_id = ?`, [tenantId])
  const isFirst = Number(existing[0]?.c || 0) === 0
  const makeDefault = input.is_default === true || isFirst

  if (makeDefault) {
    await query(`UPDATE legal_entities SET is_default = 0 WHERE tenant_id = ?`, [tenantId])
  }

  const { insertId } = await tenantInsert("legal_entities", {
    entity_code: entityCode,
    name,
    legal_name: trimOrNull(input.legal_name),
    entity_type: input.entity_type || "private_limited",
    registration_no: trimOrNull(input.registration_no),
    tax_name: trimOrNull(input.tax_name),
    tax_number: trimOrNull(input.tax_number),
    secondary_tax_name: trimOrNull(input.secondary_tax_name),
    secondary_tax_number: trimOrNull(input.secondary_tax_number),
    base_currency: (input.base_currency || "INR").toUpperCase().slice(0, 8),
    book_name: trimOrNull(input.book_name) || `${name} — Primary Book`,
    email: trimOrNull(input.email),
    phone: trimOrNull(input.phone),
    address_line: trimOrNull(input.address_line),
    city: trimOrNull(input.city),
    state: trimOrNull(input.state),
    postal_code: trimOrNull(input.postal_code),
    country: trimOrNull(input.country),
    org_unit_id: input.org_unit_id ?? null,
    is_default: makeDefault ? 1 : 0,
    status: input.status === "inactive" ? "inactive" : "active",
    created_by: actor.userId,
  })

  return (await getEntity(insertId))!
}

export type UpdateEntityInput = Partial<CreateEntityInput>

export async function updateEntity(id: number, input: UpdateEntityInput, _actor: Actor): Promise<LegalEntity> {
  await ensureEntitySchema()
  const current = await getEntity(id)
  if (!current) throw new EntityNotFoundError()
  const tenantId = currentTenantId()

  const set: Record<string, any> = {}
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw new EntityValidationError("Entity name is required")
    set.name = name
  }
  if (input.legal_name !== undefined) set.legal_name = trimOrNull(input.legal_name)
  if (input.entity_type !== undefined) set.entity_type = input.entity_type || "private_limited"
  if (input.registration_no !== undefined) set.registration_no = trimOrNull(input.registration_no)
  if (input.tax_name !== undefined) set.tax_name = trimOrNull(input.tax_name)
  if (input.tax_number !== undefined) set.tax_number = trimOrNull(input.tax_number)
  if (input.secondary_tax_name !== undefined) set.secondary_tax_name = trimOrNull(input.secondary_tax_name)
  if (input.secondary_tax_number !== undefined) set.secondary_tax_number = trimOrNull(input.secondary_tax_number)
  if (input.base_currency !== undefined) set.base_currency = (input.base_currency || "INR").toUpperCase().slice(0, 8)
  if (input.book_name !== undefined) set.book_name = trimOrNull(input.book_name)
  if (input.email !== undefined) set.email = trimOrNull(input.email)
  if (input.phone !== undefined) set.phone = trimOrNull(input.phone)
  if (input.address_line !== undefined) set.address_line = trimOrNull(input.address_line)
  if (input.city !== undefined) set.city = trimOrNull(input.city)
  if (input.state !== undefined) set.state = trimOrNull(input.state)
  if (input.postal_code !== undefined) set.postal_code = trimOrNull(input.postal_code)
  if (input.country !== undefined) set.country = trimOrNull(input.country)
  if (input.org_unit_id !== undefined) set.org_unit_id = input.org_unit_id ?? null
  if (input.status !== undefined) set.status = input.status === "inactive" ? "inactive" : "active"

  if (input.is_default === true) {
    await query(`UPDATE legal_entities SET is_default = 0 WHERE tenant_id = ?`, [tenantId])
    set.is_default = 1
  }

  if (Object.keys(set).length > 0) {
    await tenantUpdate("legal_entities", set, "id = ?", [id])
  }
  return (await getEntity(id))!
}

/** Promote one entity to be the tenant's default (demoting any current default). */
export async function setDefaultEntity(id: number): Promise<void> {
  await ensureEntitySchema()
  const entity = await getEntity(id)
  if (!entity) throw new EntityNotFoundError()
  const tenantId = currentTenantId()
  await query(`UPDATE legal_entities SET is_default = 0 WHERE tenant_id = ?`, [tenantId])
  await tenantUpdate("legal_entities", { is_default: 1 }, "id = ?", [id])
}

export async function deleteEntity(id: number): Promise<void> {
  await ensureEntitySchema()
  const entity = await getEntity(id)
  if (!entity) throw new EntityNotFoundError()

  // Refuse to delete an entity that still owns posted ledger rows — those books
  // must be reassigned first so history is never silently orphaned.
  const tenantId = currentTenantId()
  const gl = await query<any[]>(
    `SELECT COUNT(*) AS c FROM general_ledger WHERE tenant_id = ? AND entity_id = ?`,
    [tenantId, id],
  ).catch(() => [{ c: 0 }])
  if (Number(gl[0]?.c || 0) > 0) {
    throw new EntityValidationError(
      "This entity has posted ledger entries. Reassign or archive its books before deleting.",
    )
  }

  await tenantDelete("legal_entity_bank_accounts", "entity_id = ?", [id])
  await tenantDelete("intercompany_transactions", "from_entity_id = ? OR to_entity_id = ?", [id, id])
  await tenantDelete("legal_entities", "id = ?", [id])

  // If we removed the default, promote another active entity so one always exists.
  if (entity.is_default) {
    const next = await query<any[]>(
      `SELECT id FROM legal_entities WHERE tenant_id = ? ORDER BY status ASC, name ASC LIMIT 1`,
      [tenantId],
    )
    if (next[0]?.id) await tenantUpdate("legal_entities", { is_default: 1 }, "id = ?", [next[0].id])
  }
}

// ---------------------------------------------------------------------------
// Bank accounts (per entity)
// ---------------------------------------------------------------------------
export async function listBankAccounts(entityId: number): Promise<EntityBankAccount[]> {
  await ensureEntitySchema()
  await requireOwnedRow("legal_entities", entityId) // IDOR guard
  const rows = await tenantSelect<any[]>("legal_entity_bank_accounts", {
    where: "entity_id = ?",
    params: [entityId],
    tail: "ORDER BY is_primary DESC, account_name ASC",
  })
  return rows as EntityBankAccount[]
}

export type BankAccountInput = {
  account_name: string
  bank_name?: string | null
  account_no?: string | null
  ifsc_swift?: string | null
  branch?: string | null
  currency?: string
  account_type?: string | null
  is_primary?: boolean
  status?: "active" | "inactive"
}

export async function addBankAccount(entityId: number, input: BankAccountInput): Promise<EntityBankAccount> {
  await ensureEntitySchema()
  await requireOwnedRow("legal_entities", entityId)
  const name = String(input.account_name || "").trim()
  if (!name) throw new EntityValidationError("Account name is required")
  const tenantId = currentTenantId()

  if (input.is_primary) {
    await query(`UPDATE legal_entity_bank_accounts SET is_primary = 0 WHERE tenant_id = ? AND entity_id = ?`, [
      tenantId,
      entityId,
    ])
  }
  const { insertId } = await tenantInsert("legal_entity_bank_accounts", {
    entity_id: entityId,
    account_name: name,
    bank_name: trimOrNull(input.bank_name),
    account_no: trimOrNull(input.account_no),
    ifsc_swift: trimOrNull(input.ifsc_swift),
    branch: trimOrNull(input.branch),
    currency: (input.currency || "INR").toUpperCase().slice(0, 8),
    account_type: trimOrNull(input.account_type),
    is_primary: input.is_primary ? 1 : 0,
    status: input.status === "inactive" ? "inactive" : "active",
  })
  const rows = await tenantSelect<any[]>("legal_entity_bank_accounts", {
    where: "id = ?",
    params: [insertId],
    tail: "LIMIT 1",
  })
  return rows[0] as EntityBankAccount
}

export async function deleteBankAccount(bankAccountId: number): Promise<void> {
  await ensureEntitySchema()
  await requireOwnedRow("legal_entity_bank_accounts", bankAccountId)
  await tenantDelete("legal_entity_bank_accounts", "id = ?", [bankAccountId])
}

// ---------------------------------------------------------------------------
// Inter-company transactions
// ---------------------------------------------------------------------------
export async function listIntercompany(): Promise<
  Array<IntercompanyTxn & { from_name: string | null; to_name: string | null }>
> {
  await ensureEntitySchema()
  const tenantId = currentTenantId()
  const rows = await query<any[]>(
    `SELECT t.*,
            (SELECT name FROM legal_entities e WHERE e.id = t.from_entity_id AND e.tenant_id = t.tenant_id LIMIT 1) AS from_name,
            (SELECT name FROM legal_entities e WHERE e.id = t.to_entity_id AND e.tenant_id = t.tenant_id LIMIT 1) AS to_name
       FROM intercompany_transactions t
      WHERE t.tenant_id = ?
      ORDER BY t.txn_date DESC, t.id DESC`,
    [tenantId],
  )
  return rows as any
}

export type IntercompanyInput = {
  from_entity_id: number
  to_entity_id: number
  txn_date?: string | null
  amount: number
  currency?: string
  category?: string | null
  description?: string | null
  reference_no?: string | null
  status?: IntercompanyTxn["status"]
}

export async function createIntercompany(input: IntercompanyInput, actor: Actor): Promise<IntercompanyTxn> {
  await ensureEntitySchema()
  const from = Number(input.from_entity_id)
  const to = Number(input.to_entity_id)
  if (!from || !to) throw new EntityValidationError("Both a source and destination entity are required")
  if (from === to) throw new EntityValidationError("Inter-company transactions must be between two different entities")
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new EntityValidationError("Amount must be greater than zero")

  // Both entities must belong to this tenant (IDOR guard).
  await requireOwnedRow("legal_entities", from)
  await requireOwnedRow("legal_entities", to)

  const txnCode = await nextRecordId("ICT", { allowCustom: true })
  const { insertId } = await tenantInsert("intercompany_transactions", {
    txn_code: txnCode,
    from_entity_id: from,
    to_entity_id: to,
    txn_date: input.txn_date || null,
    amount,
    currency: (input.currency || "INR").toUpperCase().slice(0, 8),
    category: trimOrNull(input.category),
    description: trimOrNull(input.description),
    reference_no: trimOrNull(input.reference_no),
    status: input.status || "draft",
    created_by: actor.userId,
  })
  const rows = await tenantSelect<any[]>("intercompany_transactions", {
    where: "id = ?",
    params: [insertId],
    tail: "LIMIT 1",
  })
  return rows[0] as IntercompanyTxn
}

export async function updateIntercompanyStatus(id: number, status: IntercompanyTxn["status"]): Promise<void> {
  await ensureEntitySchema()
  await requireOwnedRow("intercompany_transactions", id)
  const allowed: IntercompanyTxn["status"][] = ["draft", "posted", "settled", "cancelled"]
  if (!allowed.includes(status)) throw new EntityValidationError("Invalid status")
  await tenantUpdate("intercompany_transactions", { status }, "id = ?", [id])
}

export async function deleteIntercompany(id: number): Promise<void> {
  await ensureEntitySchema()
  await requireOwnedRow("intercompany_transactions", id)
  await tenantDelete("intercompany_transactions", "id = ?", [id])
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

export type EntityReportRow = {
  entity_id: number | null
  entity_code: string | null
  entity_name: string
  base_currency: string
  debit: number
  credit: number
  net: number
  entries: number
}

export type ConsolidatedReport = {
  entities: EntityReportRow[]
  unassigned: EntityReportRow | null
  totals: { debit: number; credit: number; net: number; entries: number }
  intercompany: { count: number; eliminated: number; byPair: Array<{ from: string; to: string; amount: number }> }
  consolidated: { debit: number; credit: number; net: number }
}

/**
 * Per-entity roll-up of the posted General Ledger, plus a consolidated total
 * with inter-company movements eliminated. Filters are optional (financial
 * year / date range) so the same shape drives the whole report screen.
 */
export async function getConsolidatedReport(filters: {
  financial_year?: string
  date_from?: string
  date_to?: string
} = {}): Promise<ConsolidatedReport> {
  await ensureEntitySchema()
  const tenantId = currentTenantId()

  const conds: string[] = ["g.tenant_id = ?"]
  const args: any[] = [tenantId]
  if (filters.financial_year) {
    conds.push("g.financial_year = ?")
    args.push(filters.financial_year)
  }
  if (filters.date_from) {
    conds.push("g.transaction_date >= ?")
    args.push(filters.date_from)
  }
  if (filters.date_to) {
    conds.push("g.transaction_date <= ?")
    args.push(filters.date_to)
  }
  const where = conds.join(" AND ")

  // Group posted ledger by entity. LEFT JOIN so entity metadata comes along and
  // NULL entity_id rows collapse into the "Unassigned" bucket.
  const grouped = await query<any[]>(
    `SELECT g.entity_id,
            e.entity_code, e.name AS entity_name, e.base_currency,
            SUM(g.debit) AS debit, SUM(g.credit) AS credit, COUNT(*) AS entries
       FROM general_ledger g
       LEFT JOIN legal_entities e ON e.id = g.entity_id AND e.tenant_id = g.tenant_id
      WHERE ${where}
      GROUP BY g.entity_id, e.entity_code, e.name, e.base_currency
      ORDER BY entity_name ASC`,
    args,
  ).catch(() => [])

  const entities: EntityReportRow[] = []
  let unassigned: EntityReportRow | null = null
  const totals = { debit: 0, credit: 0, net: 0, entries: 0 }

  for (const r of grouped) {
    const debit = round2(num(r.debit))
    const credit = round2(num(r.credit))
    const row: EntityReportRow = {
      entity_id: r.entity_id ?? null,
      entity_code: r.entity_code ?? null,
      entity_name: r.entity_name || (r.entity_id ? `Entity #${r.entity_id}` : "Unassigned"),
      base_currency: r.base_currency || "INR",
      debit,
      credit,
      net: round2(debit - credit),
      entries: num(r.entries),
    }
    totals.debit = round2(totals.debit + debit)
    totals.credit = round2(totals.credit + credit)
    totals.entries += num(r.entries)
    if (row.entity_id == null) unassigned = row
    else entities.push(row)
  }
  totals.net = round2(totals.debit - totals.credit)

  // Inter-company eliminations: posted/settled transfers between own entities.
  const icConds: string[] = ["t.tenant_id = ?", "t.status IN ('posted','settled')"]
  const icArgs: any[] = [tenantId]
  if (filters.financial_year) {
    // Reuse the FY window on txn_date when a FY filter is supplied.
    const m = String(filters.financial_year).match(/(\d{4})/)
    if (m) {
      const y = Number(m[1])
      icConds.push("t.txn_date >= ? AND t.txn_date <= ?")
      icArgs.push(`${y}-04-01`, `${y + 1}-03-31`)
    }
  }
  if (filters.date_from) {
    icConds.push("t.txn_date >= ?")
    icArgs.push(filters.date_from)
  }
  if (filters.date_to) {
    icConds.push("t.txn_date <= ?")
    icArgs.push(filters.date_to)
  }
  const icRows = await query<any[]>(
    `SELECT t.amount,
            (SELECT name FROM legal_entities e WHERE e.id = t.from_entity_id AND e.tenant_id = t.tenant_id LIMIT 1) AS from_name,
            (SELECT name FROM legal_entities e WHERE e.id = t.to_entity_id AND e.tenant_id = t.tenant_id LIMIT 1) AS to_name
       FROM intercompany_transactions t
      WHERE ${icConds.join(" AND ")}`,
    icArgs,
  ).catch(() => [])

  let eliminated = 0
  const byPair: Array<{ from: string; to: string; amount: number }> = []
  for (const r of icRows) {
    const amt = round2(num(r.amount))
    eliminated = round2(eliminated + amt)
    byPair.push({ from: r.from_name || "—", to: r.to_name || "—", amount: amt })
  }

  return {
    entities,
    unassigned,
    totals,
    intercompany: { count: icRows.length, eliminated, byPair },
    // Consolidated position nets out the intra-group transfers from both sides.
    consolidated: {
      debit: round2(totals.debit - eliminated),
      credit: round2(totals.credit - eliminated),
      net: totals.net,
    },
  }
}
