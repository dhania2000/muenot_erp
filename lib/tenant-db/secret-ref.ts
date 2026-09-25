import "server-only"
/**
 * Managed-secret resolution for tenant database connections.
 * ---------------------------------------------------------------------------
 * SECURITY: a tenant's database credentials are NEVER stored in the application
 * database and NEVER accepted from a request body. The tenant record holds only
 * a REFERENCE (`db_connection_ref`) — the NAME of a deployment-managed secret
 * (an environment variable at the deployment boundary) that contains the DSN.
 *
 * This mirrors how the app already sources DB_HOST / DB_PASSWORD etc.: the
 * operator sets the value in the hosting panel / .env, and the app only ever
 * knows the name. Resolution therefore reads exclusively from `process.env`.
 *
 * A DSN is a standard MySQL URI:
 *   mysql://user:password@host:3306/dbname?region=eu-west-1
 * The optional `region` query param lets the operator declare which region the
 * instance physically lives in, which the router cross-checks for drift.
 */

import { toDataRegion } from "./regions"

export type DbConnectionConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string | undefined
  /** Region the connection physically resolves to (from DSN or shared config). */
  region: string | null
  /** Explicitly verified TLS for mysqls://; never use rejectUnauthorized:false. */
  ssl?: { rejectUnauthorized: true; verifyIdentity: true; minVersion: "TLSv1.2" }
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) ? Math.trunc(raw) : fallback
}

/**
 * The shared-server connection config, sourced from the same DB_* env the
 * default pool uses. Used for `shared_database` (as-is) and `separate_schema`
 * (same server, overridden database). Region comes from DB_REGION when set.
 */
export function resolveSharedDbConfig(overrides?: { database?: string | null }): DbConnectionConfig {
  return {
    host: process.env.DB_HOST ?? "",
    port: envInt("DB_PORT", 3306),
    user: process.env.DB_USER ?? "",
    password: process.env.DB_PASSWORD ?? "",
    database: overrides?.database ?? process.env.DB_NAME,
    region: toDataRegion(process.env.DB_REGION) ?? null,
  }
}

export class ConnectionSecretError extends Error {
  status: number
  constructor(message: string, status = 500) {
    super(message)
    this.name = "ConnectionSecretError"
    this.status = status
  }
}

/** Reference names are constrained so a ref can never be crafted to read an unrelated env var pattern. */
const REF_RE = /^[A-Za-z0-9_.-]{1,190}$/

/**
 * Resolve a dedicated-database DSN from the managed secret named by `ref` and
 * parse it into a connection config. Throws (fail-closed) when the reference is
 * malformed, the secret is absent, or the DSN cannot be parsed — a dedicated
 * tenant must never silently fall through to the shared database.
 */
export function resolveDedicatedDbConfig(ref: string): DbConnectionConfig {
  if (!REF_RE.test(ref)) {
    throw new ConnectionSecretError(`Invalid connection reference "${ref}".`, 400)
  }
  const dsn = process.env[ref]
  if (!dsn) {
    throw new ConnectionSecretError(
      `Managed secret "${ref}" is not configured in this environment. Set it to the tenant database DSN.`,
      503,
    )
  }
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new ConnectionSecretError(`Managed secret "${ref}" is not a valid connection URI.`, 500)
  }
  if (url.protocol !== "mysql:" && url.protocol !== "mysqls:") {
    throw new ConnectionSecretError(`Managed secret "${ref}" must be a MySQL connection URI.`, 500)
  }
  const database = url.pathname.replace(/^\//, "") || undefined
  const port = url.port ? Number(url.port) : 3306
  if (!url.hostname || !url.username || !database || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionSecretError(`Managed secret "${ref}" has incomplete connection details.`, 500)
  }
  const declaredRegion = toDataRegion(url.searchParams.get("region"))
  return {
    host: decodeURIComponent(url.hostname),
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    region: declaredRegion,
    ...(url.protocol === "mysqls:" ? {
      ssl: { rejectUnauthorized: true as const, verifyIdentity: true as const, minVersion: "TLSv1.2" as const },
    } : {}),
  }
}
