import "server-only"
import { query } from "./db"
import {
  DATA_DOMAINS,
  getDataDomain,
  isDataScopeKind,
  type DataScopeContext,
  type DataScopeKind,
} from "./data-scope-model"

/**
 * SPEC 10 — data-scope persistence + context resolution (tenant-scoped).
 * ---------------------------------------------------------------------------
 * Two tenant-scoped tables:
 *   - user_data_scope_grants   : which scope kind a user has per data domain
 *   - user_scope_assignments   : which entities / branches a user is assigned
 *
 * Plus DB resolution of the relational context the pure engine needs: the
 * user's subordinate report-chain (team) and their assigned entities/branches.
 * Everything derives the tenant from the verified session context — never from
 * client input — exactly like the RBAC / ABAC stores.
 *
 * Non-breaking by construction: a user with NO grant for a domain resolves to
 * `null`, and the request bridge treats that as "no restriction", so tenants
 * that never configure data scopes keep their current behaviour.
 */

let schemaEnsured = false

export async function ensureDataScopeSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS user_data_scope_grants (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      domain_key VARCHAR(80) NOT NULL,
      scope_kind ENUM('none','self','team','entity','branch','all') NOT NULL DEFAULT 'self',
      granted_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_domain (tenant_id, user_id, domain_key),
      KEY idx_dsg_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS user_scope_assignments (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      assignment_type ENUM('entity','branch') NOT NULL,
      assignment_value VARCHAR(190) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_assignment (tenant_id, user_id, assignment_type, assignment_value),
      KEY idx_dsa_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** The scope kind a user has for a domain, or `null` when unconfigured. */
export async function getUserDomainScope(
  tenantId: number,
  userId: number,
  domainKey: string,
): Promise<DataScopeKind | null> {
  await ensureDataScopeSchema()
  const rows = await query<{ scope_kind: string }[]>(
    `SELECT scope_kind FROM user_data_scope_grants
      WHERE tenant_id = ? AND user_id = ? AND domain_key = ? LIMIT 1`,
    [tenantId, userId, domainKey],
  )
  const k = rows[0]?.scope_kind
  return isDataScopeKind(k) ? k : null
}

/** Every domain grant for a user, as a `{ domainKey: kind }` map. */
export async function getUserScopeMap(tenantId: number, userId: number): Promise<Record<string, DataScopeKind>> {
  await ensureDataScopeSchema()
  const rows = await query<{ domain_key: string; scope_kind: string }[]>(
    `SELECT domain_key, scope_kind FROM user_data_scope_grants WHERE tenant_id = ? AND user_id = ?`,
    [tenantId, userId],
  )
  const map: Record<string, DataScopeKind> = {}
  for (const r of rows) if (isDataScopeKind(r.scope_kind)) map[r.domain_key] = r.scope_kind
  return map
}

/**
 * Replace a user's domain grants. Only known domains are persisted; a domain
 * omitted from `grants` clears its (any) existing grant, so passing `{}` fully
 * resets the user back to unrestricted (legacy) behaviour.
 */
export async function setUserScopeGrants(
  tenantId: number,
  userId: number,
  grants: Record<string, DataScopeKind>,
  grantedBy: number,
): Promise<void> {
  await ensureDataScopeSchema()
  const rows: [number, number, string, DataScopeKind, number][] = []
  for (const domain of DATA_DOMAINS) {
    const kind = grants[domain.key]
    if (kind && isDataScopeKind(kind)) rows.push([tenantId, userId, domain.key, kind, grantedBy])
  }
  await query(`DELETE FROM user_data_scope_grants WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId])
  if (rows.length > 0) {
    await query(
      `INSERT INTO user_data_scope_grants (tenant_id, user_id, domain_key, scope_kind, granted_by)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      rows.flat(),
    )
  }
}

// ---------------------------------------------------------------------------
// Entity / branch assignments
// ---------------------------------------------------------------------------

export type UserAssignments = { entities: string[]; branches: string[] }

export async function getUserAssignments(tenantId: number, userId: number): Promise<UserAssignments> {
  await ensureDataScopeSchema()
  const rows = await query<{ assignment_type: "entity" | "branch"; assignment_value: string }[]>(
    `SELECT assignment_type, assignment_value FROM user_scope_assignments WHERE tenant_id = ? AND user_id = ?`,
    [tenantId, userId],
  )
  const out: UserAssignments = { entities: [], branches: [] }
  for (const r of rows) {
    if (r.assignment_type === "entity") out.entities.push(r.assignment_value)
    else out.branches.push(r.assignment_value)
  }
  return out
}

export async function setUserAssignments(
  tenantId: number,
  userId: number,
  assignments: Partial<UserAssignments>,
): Promise<void> {
  await ensureDataScopeSchema()
  const clean = (arr: unknown): string[] =>
    Array.isArray(arr)
      ? [...new Set(arr.map((v) => String(v).trim()).filter((v) => v.length > 0 && v.length <= 190))]
      : []
  const entities = clean(assignments.entities)
  const branches = clean(assignments.branches)

  const rows: [number, number, "entity" | "branch", string][] = [
    ...entities.map((v) => [tenantId, userId, "entity", v] as [number, number, "entity", string]),
    ...branches.map((v) => [tenantId, userId, "branch", v] as [number, number, "branch", string]),
  ]
  await query(`DELETE FROM user_scope_assignments WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId])
  if (rows.length > 0) {
    await query(
      `INSERT INTO user_scope_assignments (tenant_id, user_id, assignment_type, assignment_value)
       VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}`,
      rows.flat(),
    )
  }
}

// ---------------------------------------------------------------------------
// Context resolution (subordinates + assignments) for the pure engine.
// ---------------------------------------------------------------------------

const columnCache = new Map<string, Set<string>>()

export async function tableColumns(table: string): Promise<Set<string>> {
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

/**
 * User-ids reporting (directly or transitively) to `managerUserId`, read from
 * hr_employees(manager_id → employee_id) breadth-first with a depth cap and
 * cycle guard. Mirrors the ABAC report-chain resolver. Returns [] when the
 * linking columns don't exist.
 */
export async function resolveSubordinateUserIds(managerUserId: number, maxDepth = 6): Promise<number[]> {
  const cols = await tableColumns("hr_employees").catch(() => new Set<string>())
  if (!cols.has("user_id") || !cols.has("manager_id") || !cols.has("employee_id")) return []

  const seen = new Set<number>()
  let frontier: number[] = [managerUserId]
  const collected = new Set<number>()

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const placeholders = frontier.map(() => "?").join(",")
    const rows = await query<{ user_id: number }[]>(
      `SELECT DISTINCT e.user_id
         FROM hr_employees e
         JOIN hr_employees m ON e.manager_id = m.employee_id
        WHERE m.user_id IN (${placeholders}) AND e.user_id IS NOT NULL`,
      frontier,
    )
    const next: number[] = []
    for (const r of rows) {
      const uid = Number(r.user_id)
      if (!Number.isFinite(uid) || seen.has(uid) || uid === managerUserId) continue
      seen.add(uid)
      collected.add(uid)
      next.push(uid)
    }
    frontier = next
  }
  return [...collected]
}

/**
 * Resolve the full data-scope context for a user: subordinate user-ids (team)
 * and assigned entities/branches. Resolution is best-effort; a failure yields
 * an empty facet so the relational scopes fail CLOSED rather than throwing.
 */
export async function resolveDataScopeContext(tenantId: number, userId: number): Promise<DataScopeContext> {
  const [subordinateUserIds, assignments] = await Promise.all([
    resolveSubordinateUserIds(userId).catch(() => []),
    getUserAssignments(tenantId, userId).catch(() => ({ entities: [], branches: [] }) as UserAssignments),
  ])
  return {
    userId,
    subordinateUserIds,
    assignedEntities: assignments.entities,
    assignedBranches: assignments.branches,
  }
}

/**
 * Distinct entity / branch values found across the domain tables, offered to
 * the admin UI so assignments can be picked rather than typed. Best-effort and
 * capped; unknown tables/columns are skipped.
 */
export async function suggestAssignmentValues(): Promise<UserAssignments> {
  const entities = new Set<string>()
  const branches = new Set<string>()
  for (const domain of DATA_DOMAINS) {
    let cols: Set<string>
    try {
      cols = await tableColumns(domain.table)
    } catch {
      continue
    }
    if (cols.size === 0) continue
    for (const c of domain.entityColumns) {
      if (!cols.has(c)) continue
      await collectDistinct(domain.table, c, entities)
      break
    }
    for (const c of domain.branchColumns) {
      if (!cols.has(c)) continue
      await collectDistinct(domain.table, c, branches)
      break
    }
  }
  return { entities: [...entities].slice(0, 200), branches: [...branches].slice(0, 200) }
}

async function collectDistinct(table: string, column: string, into: Set<string>): Promise<void> {
  try {
    const rows = await query<{ v: string | number }[]>(
      `SELECT DISTINCT \`${column}\` AS v FROM \`${table}\`
        WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> '' LIMIT 100`,
    )
    for (const r of rows) if (r.v != null) into.add(String(r.v))
  } catch {
    // ignore — table/column may not be readable in this tenant.
  }
}
