import "server-only"
import { query } from "./db"
import { getScope, getActionScope } from "./permission-store"
import {
  getPermissionModule,
  PERMISSION_MODULES,
  type PermissionAction,
  type PermissionScope,
} from "./permission-model"
import type { SessionPayload } from "./auth"

/**
 * Record-level permission enforcement.
 * -------------------------------------
 * The permission matrix (Add/View/Update/Delete × none/all/added/owned/both)
 * only governed page/menu visibility until now — the list/detail queries never
 * consulted it, so every employee saw every record. This module turns the
 * matrix scope into an actual SQL filter (for list/view queries) and a
 * per-record check (for update/delete), so an employee configured with
 * "added" only sees/edits records they created, "owned" only the ones assigned
 * to them, "both" either, "all" everything and "none" nothing.
 *
 * Admins and users without a configured matrix keep full access (getScope
 * returns "all"), so this is a no-op for them and never changes existing
 * behaviour for the accounts that were working before.
 */

const NON_RESTRICTED: PermissionScope[] = ["all"]

/**
 * Maps a config-driven CRUD module key (the hyphenated key used by the Finance
 * / Recruitment / Support factories) onto its permission-catalog module key.
 * Modules with no meaningful record-level owner (e.g. read-only ledgers,
 * settings) are intentionally omitted so they stay unscoped.
 */
export const FINANCE_PERMISSION_KEYS: Record<string, string> = {
  "purchase-bills": "finance.purchase_bills",
  expenses: "finance.expenses",
  "fte-invoices": "finance.fte_invoices",
  "freelance-invoices": "finance.freelance_invoices",
  "bank-transactions": "finance.bank_transactions",
  "bank-cash": "finance.bank_cash",
  "chart-of-accounts": "finance.chart_of_accounts",
  "fixed-assets": "finance.fixed_assets",
  "loans-advances": "finance.loans_advances",
  investments: "finance.investments",
  "provisions-accruals": "finance.provisions_accruals",
  "capital-equity": "finance.capital_equity",
  "related-parties": "finance.related_parties",
  "customers-vendors": "finance.customers_vendors",
  "gst-filing": "finance.gst_filing",
  "tds-filing": "finance.tds_filing",
  "journal-entries": "finance.journal",
  "general-ledger": "finance.journal",
}

export const SUPPORT_PERMISSION_KEYS: Record<string, string> = {
  tickets: "tickets.tickets",
  orders: "orders.orders",
}

export const RECRUITMENT_PERMISSION_KEYS: Record<string, string> = {
  "job-requisitions": "recruitment.requisitions",
  "recruitment-campaigns": "recruitment.requisitions",
  screening: "recruitment.candidates",
  "recruitment-sources": "recruitment.candidates",
  "interview-tracker": "recruitment.interviews",
  "assessment-tracker": "recruitment.interviews",
  "selection-offers": "recruitment.offers",
  "candidate-activities": "recruitment.candidates",
  "candidate-documents": "recruitment.candidates",
  "employee-referrals": "recruitment.candidates",
  "recruitment-tasks": "recruitment.candidates",
  "recruitment-followups": "recruitment.candidates",
  "recruitment-vendors": "recruitment.requisitions",
  "recruitment-costs": "recruitment.requisitions",
  "interview-feedback": "recruitment.interviews",
  "background-verification": "recruitment.candidates",
  "reference-check": "recruitment.candidates",
  "pre-joining": "recruitment.offers",
  "talent-pool": "recruitment.candidates",
  }

/** In-process cache of table -> existing column names (information_schema). */
const columnCache = new Map<string, Set<string>>()

async function tableColumns(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table)
  if (cached) return cached
  const rows = await query<{ c: string }[]>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  )
  const set = new Set(rows.map((r) => r.c))
  columnCache.set(table, set)
  return set
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  )
  return (rows[0]?.n ?? 0) > 0
}

/**
 * Ownership columns for a few module tables are user-id foreign keys that hold
 * the assignee. They didn't always exist, and a missing "owned" column makes
 * that scope deny every row. This best-effort, run-once self-heal adds the
 * declared owner/creator columns (as nullable user-id ints) to any table that
 * is missing them — mirroring the ALTER pattern used elsewhere (clients-db).
 * It only ever touches the specific columns named in the permission catalog,
 * never invents new ones, and swallows errors (e.g. no ALTER privilege) so an
 * unhealable schema simply falls back to the existing deny behaviour.
 */
let ownerColumnsEnsured: Promise<void> | null = null

/** Owner/creator columns we are willing to auto-create as user-id ints. */
const AUTO_OWNER_COLUMNS = new Set([
  "created_by",
  "added_by",
  "assigned_to",
  "account_manager_id",
  "owner_id",
  "user_id",
])

async function ensureOwnerColumnsOnce(): Promise<void> {
  // Collect the distinct (table, column) pairs the catalog wants to scope on.
  const wanted = new Map<string, Set<string>>()
  for (const m of PERMISSION_MODULES) {
    for (const col of [m.scope.addedBy, m.scope.ownedBy]) {
      if (!col || !AUTO_OWNER_COLUMNS.has(col)) continue
      if (!wanted.has(m.scope.table)) wanted.set(m.scope.table, new Set())
      wanted.get(m.scope.table)!.add(col)
    }
  }

  for (const [table, cols] of wanted) {
    try {
      if (!(await tableExists(table))) continue
      const existing = await tableColumns(table)
      const missing = [...cols].filter((c) => !existing.has(c))
      if (missing.length === 0) continue
      for (const col of missing) {
        try {
          await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` INT UNSIGNED DEFAULT NULL`)
          existing.add(col)
        } catch {
          // ignore — column may already exist under a race, or ALTER denied.
        }
      }
      columnCache.set(table, existing)
    } catch {
      // ignore per-table failures; scoping falls back to deny for this table.
    }
  }
}

function ensureOwnerColumns(): Promise<void> {
  if (!ownerColumnsEnsured) ownerColumnsEnsured = ensureOwnerColumnsOnce()
  return ownerColumnsEnsured
}

export type ScopeSql = { scope: PermissionScope; sql: string; params: number[] }

/**
 * Build a SQL WHERE fragment (referencing only columns that actually exist on
 * `table`) enforcing the viewer's scope for a module/action. Returns:
 *   - `null`           -> no restriction should be applied (unknown module or
 *                         full access); callers append nothing.
 *   - `{ sql: "1=0" }` -> scope is "none" (or an ownership scope with no usable
 *                         column) — caller should show nothing.
 *   - a real fragment  -> `created_by = ?` / `assigned_to = ?` style filter.
 */
export async function scopeWhereForModule(
  session: SessionPayload,
  permissionKey: string,
  action: PermissionAction,
  table: string,
  alias?: string,
): Promise<ScopeSql | null> {
  const mod = getPermissionModule(permissionKey)
  if (!mod) return null // module not in the catalog -> leave unscoped

  const scope = await getScope(session.userId, session.role, permissionKey, action)
  if (NON_RESTRICTED.includes(scope)) return null
  if (scope === "none") return { scope, sql: "1=0", params: [] }

  await ensureOwnerColumns()
  const cols = await tableColumns(table)
  const q = alias ? `${alias}.` : ""
  const added = mod.scope.addedBy && cols.has(mod.scope.addedBy) ? `${q}${mod.scope.addedBy}` : null
  const owned = mod.scope.ownedBy && cols.has(mod.scope.ownedBy) ? `${q}${mod.scope.ownedBy}` : null

  const parts: string[] = []
  const params: number[] = []
  if ((scope === "added" || scope === "both") && added) {
    parts.push(`${added} = ?`)
    params.push(session.userId)
  }
  if ((scope === "owned" || scope === "both") && owned) {
    parts.push(`${owned} = ?`)
    params.push(session.userId)
  }
  // Scope demands ownership but the table has no matching column -> deny rather
  // than silently exposing every row.
  if (parts.length === 0) return { scope, sql: "1=0", params: [] }
  return { scope, sql: parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0], params }
}

/**
 * Merge a scope fragment into an existing WHERE clause built elsewhere.
 * `where` is either "" or a string beginning with "WHERE ".
 */
export function mergeScopeIntoWhere(
  where: string,
  args: any[],
  scoped: ScopeSql | null,
): { where: string; args: any[] } {
  if (!scoped) return { where, args }
  const merged = where ? `${where} AND ${scoped.sql}` : `WHERE ${scoped.sql}`
  return { where: merged, args: [...args, ...scoped.params] }
}

/**
 * Whether a specific already-loaded record satisfies the viewer's scope for an
 * action. Used to gate update/delete on individual rows. Admins / unconfigured
 * users return true (scope "all").
 */
export async function canActOnRecord(
  session: SessionPayload,
  permissionKey: string,
  action: PermissionAction,
  row: Record<string, any>,
): Promise<boolean> {
  const mod = getPermissionModule(permissionKey)
  if (!mod) return true // unscoped module

  const scope = await getScope(session.userId, session.role, permissionKey, action)
  if (scope === "all") return true
  if (scope === "none") return false

  const uid = String(session.userId)
  const matchAdded = mod.scope.addedBy ? String(row[mod.scope.addedBy]) === uid : false
  const matchOwned = mod.scope.ownedBy ? String(row[mod.scope.ownedBy]) === uid : false

  if (scope === "added") return matchAdded
  if (scope === "owned") return matchOwned
  if (scope === "both") return matchAdded || matchOwned
  return false
}

/**
 * Whether the viewer may create a record in this module. Creation only checks
 * the coarse Add scope: "none" blocks, anything else allows (the new row's
 * creator is the viewer, so it always satisfies an "added" scope).
 */
export async function canCreateInModule(
  session: SessionPayload,
  permissionKey: string,
): Promise<boolean> {
  const mod = getPermissionModule(permissionKey)
  if (!mod) return true
  const scope = await getScope(session.userId, session.role, permissionKey, "add")
  return scope !== "none"
}

/**
 * Phase 53 — coarse gate for a module-specific EXTENDED action (e.g. an
 * interview "schedule_interview" or an offer "send_offer") at create time,
 * before a target record exists. Any non-"none" scope allows; "none" blocks.
 * Unconfigured accounts / unknown modules keep full access, exactly like the
 * base CRUD gates, so this never changes behaviour for accounts without a
 * matrix.
 */
export async function canPerformAction(
  session: SessionPayload,
  permissionKey: string,
  actionKey: string,
): Promise<boolean> {
  const mod = getPermissionModule(permissionKey)
  if (!mod) return true
  const scope = await getActionScope(session.userId, session.role, permissionKey, actionKey)
  return scope !== "none"
}

/**
 * Phase 53 — whether an already-loaded record satisfies the viewer's scope for
 * a module-specific EXTENDED action. Mirrors `canActOnRecord` but resolves the
 * scope through the extended-action grant (which itself derives from the
 * action's declared CRUD fallback when not set explicitly).
 */
export async function canActOnRecordAction(
  session: SessionPayload,
  permissionKey: string,
  actionKey: string,
  row: Record<string, any>,
): Promise<boolean> {
  const mod = getPermissionModule(permissionKey)
  if (!mod) return true
  const scope = await getActionScope(session.userId, session.role, permissionKey, actionKey)
  if (scope === "all") return true
  if (scope === "none") return false

  const uid = String(session.userId)
  const matchAdded = mod.scope.addedBy ? String(row[mod.scope.addedBy]) === uid : false
  const matchOwned = mod.scope.ownedBy ? String(row[mod.scope.ownedBy]) === uid : false

  if (scope === "added") return matchAdded
  if (scope === "owned") return matchOwned
  if (scope === "both") return matchAdded || matchOwned
  return false
}
