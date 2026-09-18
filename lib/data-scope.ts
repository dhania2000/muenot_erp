import "server-only"
import { getCurrentTenant } from "./tenant-context"
import {
  buildDataScopeSql,
  getDataDomain,
  recordInDataScope,
  type DataScopeContext,
  type DataScopeKind,
} from "./data-scope-model"
import {
  getUserDomainScope,
  resolveDataScopeContext,
  tableColumns,
} from "./data-scope-store"
import type { SessionPayload } from "./auth"

/**
 * SPEC 10 — the bridge between the pure data-scope engine and a live request.
 * ---------------------------------------------------------------------------
 * A route/report calls `dataScopeWhere(session, "hr.employees", alias)` to get
 * a SQL predicate to AND into its query, and `canAccessRecord(...)` to gate a
 * single loaded row (detail / update / delete).
 *
 * Design guarantees that keep this non-breaking:
 *   - A user with NO configured grant for the domain, or a grant of "all",
 *     yields `null` (no predicate) / `true` (record allowed), so existing
 *     tenants and admins are unaffected until scopes are explicitly assigned.
 *   - A missing tenant (system / pre-auth path) short-circuits to unscoped.
 *   - Relational scopes fail CLOSED inside the pure engine (a missing column
 *     or empty assignment denies rather than leaking rows), and resolution
 *     failures here degrade to unscoped only when the grant itself can't be
 *     read — the grant lookup is the single source of "is scoping on?".
 *
 * This layers ON TOP of the RBAC record scope (permission-enforce.ts) and the
 * ABAC restriction layer: a caller applies both, so the effective visibility is
 * the AND of every enabled layer.
 */

export type DataScopeWhere = { kind: DataScopeKind; sql: string; params: (string | number)[] } | null

/**
 * Resolve the acting user's scope for a domain and return a SQL predicate to
 * merge into a list/report query, or `null` when nothing should be applied.
 */
export async function dataScopeWhere(
  session: SessionPayload,
  domainKey: string,
  alias?: string,
): Promise<DataScopeWhere> {
  const domain = getDataDomain(domainKey)
  if (!domain) return null

  const tenant = getCurrentTenant()
  const tenantId = tenant?.tenantId ?? session.tenantId
  if (tenantId == null) return null

  const kind = await getUserDomainScope(tenantId, session.userId, domainKey)
  if (kind == null || kind === "all") return null

  const [ctx, cols] = await Promise.all([
    resolveDataScopeContext(tenantId, session.userId),
    tableColumns(domain.table).catch(() => new Set<string>()),
  ])

  const built = buildDataScopeSql(kind, domain, ctx, cols, alias)
  if (!built) return null
  return { kind, sql: built.sql, params: built.params }
}

/**
 * Merge a data-scope predicate into an existing WHERE clause built elsewhere.
 * `where` is either "" or a string beginning with "WHERE ".
 */
export function mergeDataScope(
  where: string,
  args: any[],
  scoped: DataScopeWhere,
): { where: string; args: any[] } {
  if (!scoped) return { where, args }
  const merged = where ? `${where} AND ${scoped.sql}` : `WHERE ${scoped.sql}`
  return { where: merged, args: [...args, ...scoped.params] }
}

/**
 * Whether an already-loaded `row` is visible to the acting user under their
 * data scope for `domainKey`. Returns `true` for unconfigured users, "all"
 * grants, missing tenant or unknown domain (non-breaking pass-through).
 */
export async function canAccessRecord(
  session: SessionPayload,
  domainKey: string,
  row: Record<string, any>,
): Promise<boolean> {
  const domain = getDataDomain(domainKey)
  if (!domain) return true

  const tenant = getCurrentTenant()
  const tenantId = tenant?.tenantId ?? session.tenantId
  if (tenantId == null) return true

  const kind = await getUserDomainScope(tenantId, session.userId, domainKey)
  if (kind == null || kind === "all") return true

  const ctx: DataScopeContext = await resolveDataScopeContext(tenantId, session.userId)
  return recordInDataScope(kind, domain, ctx, row)
}
