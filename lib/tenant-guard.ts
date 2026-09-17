/**
 * SPEC 2 — Fail-closed tenant data-access guard.
 * ---------------------------------------------------------------------------
 * MySQL has no row-level security, so isolation is enforced in the application
 * data layer. Every SQL statement that reaches lib/db.ts#query is inspected
 * here: if it touches a tenant-scoped table (lib/tenant-tables.ts) while a
 * tenant is in context, it MUST also constrain `tenant_id`. Otherwise it is a
 * potential cross-tenant leak.
 *
 * Rollout follows the same report-only -> enforce pattern the project uses for
 * CSP, so it can be switched on without a risky big-bang:
 *
 *   TENANT_ISOLATION_MODE = "off"     : guard disabled (not recommended).
 *   TENANT_ISOLATION_MODE = "report"  : (default) log violations, allow query.
 *   TENANT_ISOLATION_MODE = "enforce" : throw on violation, block the query.
 *
 * The inspection is deliberately conservative and heuristic (no full SQL
 * parser): it only ever flags a query that references a known tenant-scoped
 * table without a `tenant_id` predicate. Our own scoped helpers
 * (lib/tenant-scope.ts) always emit `tenant_id`, so correct code never trips
 * the guard. Statements with no tenant in context (system/boot/cron before a
 * tenant is selected) are not flagged — cron must opt in via runForTenant().
 */
import { getCurrentTenant } from "@/lib/tenant-context"
import { ALL_TENANT_SCOPED_TABLES, TENANT_COLUMN, isTenantScopedTable } from "@/lib/tenant-tables"

export type IsolationMode = "off" | "report" | "enforce"

export function isolationMode(): IsolationMode {
  const raw = String(process.env.TENANT_ISOLATION_MODE || "report").toLowerCase()
  if (raw === "off" || raw === "enforce") return raw
  return "report"
}

// Pull table references out of a statement. Matches FROM / JOIN / INTO /
// UPDATE / DELETE FROM targets, with optional backticks. Not a full parser, but
// covers the query shapes used across the app and never yields false negatives
// for the registered tables (any mention of the bare table name is caught by
// the membership scan below as a backstop).
const TABLE_REF_RE =
  /(?:\bfrom\b|\bjoin\b|\binto\b|\bupdate\b|\bdelete\s+from\b)\s+`?([a-z0-9_]+)`?/gi

/** All distinct table names referenced by a statement (lowercased). */
export function referencedTables(sql: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  TABLE_REF_RE.lastIndex = 0
  while ((m = TABLE_REF_RE.exec(sql))) out.add(m[1].toLowerCase())
  return [...out]
}

/** The tenant-scoped tables a statement touches. */
export function scopedTablesTouched(sql: string): string[] {
  // Fast bail: skip DDL, information_schema, and the tenant directory itself.
  const lower = sql.toLowerCase()
  if (
    lower.includes("information_schema") ||
    /^\s*(alter|create|drop|truncate|rename|set|show|describe|explain|start|commit|rollback|begin)\b/.test(
      lower,
    )
  ) {
    return []
  }
  const refs = referencedTables(sql)
  const touched = refs.filter((t) => isTenantScopedTable(t))
  // Backstop: catch bare references the regex above might miss (e.g. table
  // named only inside a subquery form we didn't anticipate).
  for (const t of ALL_TENANT_SCOPED_TABLES) {
    if (touched.includes(t)) continue
    const re = new RegExp(`(?:^|[^a-z0-9_\`])\`?${t}\`?(?:[^a-z0-9_\`]|$)`, "i")
    if (re.test(lower)) touched.push(t)
  }
  return touched
}

/** True when the statement constrains the tenant discriminator column. */
export function hasTenantPredicate(sql: string): boolean {
  return new RegExp(`\\b${TENANT_COLUMN}\\b`, "i").test(sql)
}

export type Violation = {
  mode: IsolationMode
  tenantId: number
  tables: string[]
  sql: string
}

/**
 * Inspect one statement. Returns a Violation description when the query touches
 * a tenant-scoped table without a tenant predicate AND a tenant is in context;
 * otherwise null. Pure — does not throw or log — so it is trivially testable.
 */
export function inspect(sql: string): Violation | null {
  if (isolationMode() === "off") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null // system / pre-auth / cron-before-runForTenant
  const tables = scopedTablesTouched(sql)
  if (tables.length === 0) return null
  if (hasTenantPredicate(sql)) return null
  return { mode: isolationMode(), tenantId: tenant.tenantId, tables, sql }
}

export class TenantIsolationError extends Error {
  tables: string[]
  constructor(tables: string[]) {
    super(
      `Tenant isolation violation: query touches tenant-scoped table(s) [${tables.join(
        ", ",
      )}] without a ${TENANT_COLUMN} filter. Use the helpers in lib/tenant-scope.ts.`,
    )
    this.name = "TenantIsolationError"
    this.tables = tables
  }
}

/**
 * Enforcement entry point called by lib/db.ts#query before executing. In
 * "report" mode it logs and allows; in "enforce" mode it throws.
 */
export function guardQuery(sql: string): void {
  const violation = inspect(sql)
  if (!violation) return
  if (violation.mode === "enforce") {
    console.error(
      `[tenant-guard] BLOCKED (tenant ${violation.tenantId}) tables=[${violation.tables.join(
        ", ",
      )}] :: ${trimSql(violation.sql)}`,
    )
    throw new TenantIsolationError(violation.tables)
  }
  console.warn(
    `[tenant-guard] REPORT (tenant ${violation.tenantId}) unscoped access to [${violation.tables.join(
      ", ",
    )}] :: ${trimSql(violation.sql)}`,
  )
}

function trimSql(sql: string): string {
  const one = sql.replace(/\s+/g, " ").trim()
  return one.length > 240 ? `${one.slice(0, 240)}…` : one
}
