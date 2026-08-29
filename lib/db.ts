import mysql from "mysql2/promise"

// A single shared connection pool, cached across hot reloads in dev.
const globalForDb = globalThis as unknown as { _mysqlPool?: mysql.Pool }

export function getPool(): mysql.Pool {
  if (!globalForDb._mysqlPool) {
    const url = process.env.DATABASE_URL
    if (!url) {
      throw new Error("DATABASE_URL is not set. Add your MySQL connection string in Project Settings > Vars.")
    }
    globalForDb._mysqlPool = mysql.createPool({
      uri: url,
      connectionLimit: 10,
      namedPlaceholders: true,
      dateStrings: true,
      // Allow multiple statements for the schema setup script.
      multipleStatements: true,
    })
  }
  return globalForDb._mysqlPool
}

// Typed query helper returning an array of rows.
export async function query<T = any>(sql: string, params?: any): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params)
  return rows as T[]
}

// Execute helper for inserts/updates, returns the OkPacket.
export async function execute(sql: string, params?: any): Promise<mysql.ResultSetHeader> {
  const [result] = await getPool().execute(sql, params)
  return result as mysql.ResultSetHeader
}
