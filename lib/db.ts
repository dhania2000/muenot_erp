import mysql from "mysql2/promise"

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
  const [rows] = await pool.query(sql, params)
  return rows as T
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
