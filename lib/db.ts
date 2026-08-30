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
