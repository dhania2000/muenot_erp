import mysql from "mysql2/promise"
import { guardQuery } from "@/lib/tenant-guard"

// MySQL connection pool.
// Configure these via environment variables (.env.local locally,
// or your Hostinger hosting panel / .env file in production).
//
// Required env vars:
//   DB_HOST     - e.g. localhost or your Hostinger MySQL host
//   DB_PORT     - default 3306
//   DB_USER     - your MySQL username
//   DB_PASSWORD - your MySQL password
//   DB_NAME     - your MySQL database name

declare global {
  // eslint-disable-next-line no-var
  var __mysqlPool: mysql.Pool | undefined
}

function createPool() {
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  })
}

// Reuse the pool across hot-reloads / serverless invocations.
export const pool = globalThis.__mysqlPool ?? createPool()
if (process.env.NODE_ENV !== "production") {
  globalThis.__mysqlPool = pool
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T> {
  // Tenant isolation gate (SPEC 2). Inspects the statement and, in "enforce"
  // mode, throws before execution when it touches a tenant-scoped table without
  // a tenant_id predicate; in "report" mode (default) it only logs. Pure and
  // cheap — see lib/tenant-guard.ts. Never blocks system/pre-auth queries
  // (no tenant in context) or DDL / information_schema lookups.
  guardQuery(sql)
  const [rows] = await pool.query(sql, params)
  // Auto-capture writes as activity notifications (fire-and-forget; never
  // affects the caller's result or latency). See lib/notifications.ts.
  maybeCaptureWrite(sql, rows)
  return rows as T
}

/** Execute a group of statements atomically. Callers still include their normal tenant predicates. */
export async function withTransaction<T>(
  fn: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await fn(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

// ---------------------------------------------------------------------------
// Automatic write capture -> notifications
// ---------------------------------------------------------------------------
// Detect INSERT / UPDATE / DELETE / REPLACE against a permission-mapped module
// table and fan a notification out to the users allowed to see that module.
// Kept deliberately cheap and defensive: any failure is swallowed so the
// primary query is never impacted.

const INSERT_RE = /^\s*insert\s+(?:ignore\s+)?into\s+`?([a-z0-9_]+)`?/i
const REPLACE_RE = /^\s*replace\s+(?:into\s+)?`?([a-z0-9_]+)`?/i
const UPDATE_RE = /^\s*update\s+(?:ignore\s+)?`?([a-z0-9_]+)`?/i
const DELETE_RE = /^\s*delete\s+(?:ignore\s+)?from\s+`?([a-z0-9_]+)`?/i

// Never generate notifications for writes to these infrastructure tables.
const SKIP_TABLES = new Set([
  "notifications",
  "user_module_permissions",
  "user_module_action_permissions",
  "sessions",
])

function maybeCaptureWrite(sql: string, result: any) {
  try {
    let table: string | undefined
    let action: "create" | "update" | "delete" | undefined

    let m = INSERT_RE.exec(sql) || REPLACE_RE.exec(sql)
    if (m) {
      table = m[1]
      action = "create"
    } else if ((m = UPDATE_RE.exec(sql))) {
      table = m[1]
      action = "update"
    } else if ((m = DELETE_RE.exec(sql))) {
      table = m[1]
      action = "delete"
    }

    if (!table || !action) return
    table = table.toLowerCase()
    if (SKIP_TABLES.has(table)) return

    // For UPDATE/DELETE, skip when nothing actually changed.
    const affected = typeof result?.affectedRows === "number" ? result.affectedRows : undefined
    if (action !== "create" && affected === 0) return

    const entityId =
      action === "create" && result?.insertId ? String(result.insertId) : null

    // Defer to the notifications module lazily to avoid an import cycle.
    void import("./notifications")
      .then((mod) => mod.recordDbWrite(table!, action!, entityId))
      .catch((err) => console.error("[v0] notification capture failed:", err))
  } catch {
    // Never let capture interfere with the primary query.
  }
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------
// The production database (Hostinger) can lag behind the app's expected schema
// — e.g. newer classification columns (bs_group, source_module, financial_year)
// may not exist yet on older installs. Selecting a non-existent column makes
// MySQL reject the WHOLE statement (ER_BAD_FIELD_ERROR), which is what was
// breaking every financial statement report. `tableColumns` lets callers build
// defensive, column-adaptive SQL that degrades gracefully instead of crashing.

declare global {
  // eslint-disable-next-line no-var
  var __columnSetCache: Map<string, Set<string>> | undefined
}

const columnCache = globalThis.__columnSetCache ?? new Map<string, Set<string>>()
if (process.env.NODE_ENV !== "production") globalThis.__columnSetCache = columnCache

/**
 * The set of column names that actually exist on `table` in the current
 * database, cached per process. Returns an empty set if the table does not
 * exist (callers then let the real query surface ER_NO_SUCH_TABLE so a missing
 * source is reported as missing, not silently blanked).
 */
export async function tableColumns(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table)
  if (cached) return cached
  const rows = (await query(
    `SELECT COLUMN_NAME AS c
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  )) as { c: string }[]
  const set = new Set(rows.map((r) => String(r.c)))
  columnCache.set(table, set)
  return set
}
