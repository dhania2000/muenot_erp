import "server-only"
import { query } from "./db"
import { getScope } from "./permission-store"
import { getPermissionModule, type PermissionAction, type PermissionScope } from "./permission-model"
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
  "candidate-master": "recruitment.candidates",
  screening: "recruitment.candidates",
  "recruitment-sources": "recruitment.candidates",
  "interview-tracker": "recruitment.interviews",
  "assessment-tracker": "recruitment.interviews",
  "selection-offers": "recruitment.offers",
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
