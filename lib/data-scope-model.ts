// =============================================================
// Data-level permissions: model + pure scope engine
// -------------------------------------------------------------
// RBAC (permission-model.ts) already scopes records by SELF ownership
// (none/all/added/owned/both). adds the RELATIONAL data scopes an
// enterprise needs — the visibility a position grants over OTHER people's
// records:
//
//   none    -> no records
//   self    -> only the acting user's own records            (Employee)
//   team    -> own + everyone reporting up through them       (Manager)
//   entity  -> records belonging to the user's assigned legal entities
//              (HR / Finance see employees & data in their entities)
//   branch  -> records belonging to the user's assigned branches
//              (Regional manager sees their branches)
//   all     -> every record in the tenant                     (Super Admin)
//
// This file is PURE (no DB, no server-only): it declares the sensitive data
// domains and turns a resolved "scope context" into either a SQL predicate
// (for list/report queries) or a boolean (for a single already-loaded row).
// The DB resolution of the context (subordinates, assigned entities/branches)
// lives in data-scope-store.ts; the request bridge lives in data-scope.ts.
// Keeping the decision logic pure makes Phase-4 unauthorized-access tests
// possible without a database.
// =============================================================

export const DATA_SCOPE_KINDS = ["none", "self", "team", "entity", "branch", "all"] as const
export type DataScopeKind = (typeof DATA_SCOPE_KINDS)[number]

export function isDataScopeKind(v: unknown): v is DataScopeKind {
  return typeof v === "string" && (DATA_SCOPE_KINDS as readonly string[]).includes(v)
}

export const DATA_SCOPE_KIND_META: Record<DataScopeKind, { label: string; description: string; example: string }> = {
  none: { label: "No access", description: "Cannot see any records in this domain.", example: "—" },
  self: { label: "Own records", description: "Only records the user created, owns or that are their own.", example: "Employee sees only own records" },
  team: { label: "Team records", description: "Own records plus everyone reporting up through this user.", example: "Manager sees team records" },
  entity: { label: "Assigned entities", description: "Records belonging to the legal entities assigned to this user.", example: "HR / Finance see their assigned entities" },
  branch: { label: "Assigned branches", description: "Records belonging to the branches assigned to this user.", example: "Regional manager sees assigned branches" },
  all: { label: "Platform (all)", description: "Every record across the whole tenant.", example: "Super Admin sees platform data" },
}

/**
 * A sensitive data domain that can be scoped. Column lists are CANDIDATES:
 * the engine only ever references the ones that actually exist on the table
 * (schema varies per tenant), so a missing column degrades to "deny" for that
 * scope rather than leaking rows.
 */
export type DataDomain = {
  key: string
  label: string
  /** Primary table the domain reads from. */
  table: string
  /** User-id columns that make a row belong to a user (self / team). */
  ownerColumns: string[]
  /** Columns holding the legal-entity identifier (entity scope). */
  entityColumns: string[]
  /** Columns holding the branch identifier (branch scope). */
  branchColumns: string[]
}

/**
 * The catalog of scopeable domains. `hr.employees` is wired end-to-end into
 * enforcement in this pass; the others are configurable here and enforced as
 * each route adopts the `dataScopeWhere` / `canAccessRecord` helpers.
 */
export const DATA_DOMAINS: DataDomain[] = [
  {
    key: "hr.employees",
    label: "Employees (HR)",
    table: "hr_employees",
    ownerColumns: ["user_id", "created_by"],
    entityColumns: ["entity", "legal_entity", "entity_id", "legal_entity_id"],
    branchColumns: ["branch", "branch_name", "branch_id", "work_location"],
  },
  {
    key: "finance.entities",
    label: "Legal entities (Finance)",
    table: "legal_entities",
    ownerColumns: ["created_by", "owner_id"],
    entityColumns: ["id", "entity_id"],
    branchColumns: ["branch", "branch_id"],
  },
  {
    key: "sales.leads",
    label: "Sales leads",
    table: "sales_leads",
    ownerColumns: ["assigned_to", "created_by", "owner_id"],
    entityColumns: ["entity", "entity_id", "legal_entity_id"],
    branchColumns: ["branch", "branch_id"],
  },
]

const DOMAIN_BY_KEY = new Map(DATA_DOMAINS.map((d) => [d.key, d]))
export function getDataDomain(key: string): DataDomain | undefined {
  return DOMAIN_BY_KEY.get(key)
}

/**
 * The resolved facts about the acting user that the relational scopes need.
 * Produced by data-scope-store.ts from the DB; consumed purely here.
 */
export type DataScopeContext = {
  userId: number
  /** User-ids reporting (directly or transitively) to the acting user. */
  subordinateUserIds: number[]
  /** Legal-entity identifiers assigned to the acting user. */
  assignedEntities: (string | number)[]
  /** Branch identifiers assigned to the acting user. */
  assignedBranches: (string | number)[]
}

export type DataScopeSql = { sql: string; params: (string | number)[] }

/** Quote a column with an optional table alias/qualifier. */
function col(name: string, alias?: string): string {
  return alias ? `${alias}.\`${name}\`` : `\`${name}\``
}

/**
 * Build the SQL WHERE predicate enforcing `kind` for `domain`, given the
 * resolved context and the set of columns that ACTUALLY exist on the table.
 *
 * Returns:
 *   - `null`            -> no restriction (kind === "all"); caller appends nothing
 *   - `{ sql: "1=0" }`  -> deny everything (kind "none", or a relational scope
 *                          whose column/values are unavailable — fail CLOSED)
 *   - a real predicate  -> e.g. `(user_id IN (?,?) )` / `entity IN (?)`
 */
export function buildDataScopeSql(
  kind: DataScopeKind,
  domain: DataDomain,
  ctx: DataScopeContext,
  existingColumns: Set<string>,
  alias?: string,
): DataScopeSql | null {
  const DENY: DataScopeSql = { sql: "1=0", params: [] }

  if (kind === "all") return null
  if (kind === "none") return DENY

  const owners = domain.ownerColumns.filter((c) => existingColumns.has(c))
  const entityCols = domain.entityColumns.filter((c) => existingColumns.has(c))
  const branchCols = domain.branchColumns.filter((c) => existingColumns.has(c))

  if (kind === "self") {
    if (owners.length === 0) return DENY
    const parts = owners.map((c) => `${col(c, alias)} = ?`)
    return { sql: orWrap(parts), params: owners.map(() => ctx.userId) }
  }

  if (kind === "team") {
    if (owners.length === 0) return DENY
    const ids = uniqueNumbers([ctx.userId, ...ctx.subordinateUserIds])
    const placeholders = ids.map(() => "?").join(",")
    const parts = owners.map((c) => `${col(c, alias)} IN (${placeholders})`)
    // Each owner column needs its own copy of the id list.
    const params: (string | number)[] = []
    for (let i = 0; i < owners.length; i++) params.push(...ids)
    return { sql: orWrap(parts), params }
  }

  if (kind === "entity") {
    if (entityCols.length === 0 || ctx.assignedEntities.length === 0) return DENY
    const values = dedupe(ctx.assignedEntities)
    const placeholders = values.map(() => "?").join(",")
    const parts = entityCols.map((c) => `${col(c, alias)} IN (${placeholders})`)
    const params: (string | number)[] = []
    for (let i = 0; i < entityCols.length; i++) params.push(...values)
    return { sql: orWrap(parts), params }
  }

  if (kind === "branch") {
    if (branchCols.length === 0 || ctx.assignedBranches.length === 0) return DENY
    const values = dedupe(ctx.assignedBranches)
    const placeholders = values.map(() => "?").join(",")
    const parts = branchCols.map((c) => `${col(c, alias)} IN (${placeholders})`)
    const params: (string | number)[] = []
    for (let i = 0; i < branchCols.length; i++) params.push(...values)
    return { sql: orWrap(parts), params }
  }

  return DENY
}

/**
 * Whether an already-loaded `row` satisfies `kind` for `domain`. Used to gate
 * detail reads, updates and deletes on a single record. Fails CLOSED: a
 * relational scope whose anchoring column is absent from the row denies.
 */
export function recordInDataScope(
  kind: DataScopeKind,
  domain: DataDomain,
  ctx: DataScopeContext,
  row: Record<string, any>,
): boolean {
  if (kind === "all") return true
  if (kind === "none") return false
  if (!row || typeof row !== "object") return false

  if (kind === "self") {
    return domain.ownerColumns.some((c) => c in row && sameNumber(row[c], ctx.userId))
  }

  if (kind === "team") {
    const ids = new Set(uniqueNumbers([ctx.userId, ...ctx.subordinateUserIds]))
    return domain.ownerColumns.some((c) => c in row && row[c] != null && ids.has(Number(row[c])))
  }

  if (kind === "entity") {
    if (ctx.assignedEntities.length === 0) return false
    const set = new Set(dedupe(ctx.assignedEntities).map(String))
    return domain.entityColumns.some((c) => c in row && row[c] != null && set.has(String(row[c])))
  }

  if (kind === "branch") {
    if (ctx.assignedBranches.length === 0) return false
    const set = new Set(dedupe(ctx.assignedBranches).map(String))
    return domain.branchColumns.some((c) => c in row && row[c] != null && set.has(String(row[c])))
  }

  return false
}

// --- small pure helpers -------------------------------------------------

function orWrap(parts: string[]): string {
  if (parts.length === 0) return "1=0"
  return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0]
}

function sameNumber(a: any, b: number): boolean {
  return a != null && Number(a) === b
}

function uniqueNumbers(values: (string | number)[]): number[] {
  const out = new Set<number>()
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) out.add(n)
  }
  return [...out]
}

function dedupe(values: (string | number)[]): (string | number)[] {
  const seen = new Set<string>()
  const out: (string | number)[] = []
  for (const v of values) {
    const k = String(v)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(v)
    }
  }
  return out
}
