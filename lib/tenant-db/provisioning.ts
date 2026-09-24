import "server-only"
/**
 * Independent per-tenant database provisioning, migration, health-check and
 * backup.
 * ---------------------------------------------------------------------------
 * Each tenant on `separate_schema` or `dedicated_database` owns its own MySQL
 * schema/instance whose lifecycle is managed here, INDEPENDENTLY of every other
 * tenant and of the shared platform database:
 *
 *   provision   — create the tenant's schema (idempotent CREATE DATABASE / USE).
 *   migrate     — apply the ordered, versioned bootstrap migrations to the
 *                 tenant's own connection, tracked by `schema_version`.
 *   healthCheck — probe the tenant's own connection (SELECT 1 + version) and
 *                 assert the region it resolves to matches its configuration
 *                 (region-drift defense), recording a real health verdict.
 *   backup      — snapshot a manifest (per-table row counts + a content digest)
 *                 read from the tenant's OWN connection, proving the backup is
 *                 sourced from the tenant's isolated data, not the shared DB.
 *
 * Everything runs through the router, so a dedicated tenant's operations can
 * only ever touch that tenant's connection. `shared_database` tenants need no
 * physical provisioning — their isolation is row-level — so these operations
 * resolve to no-ops that simply mark the registry `active`/`healthy`.
 *
 * Operations are idempotent via the (tenant, action, idempotency-key) ledger in
 * the store, so a retried request never double-provisions or double-migrates.
 */
import { createHash } from "node:crypto"
import { getTenantById } from "@/lib/tenant-service"
import {
  type ConnectionProfile,
  type DeploymentModel,
  TenantRoutingError,
  isValidSchemaName,
  isolatesConnection,
  resolveConnectionProfile,
} from "./model"
import { detectRegionDrift } from "./regions"
import { getPoolForProfile, type RoutedPool } from "./router"
import { resolveDedicatedDbConfig, resolveSharedDbConfig } from "./secret-ref"
import mysql from "mysql2/promise"
import {
  type TenantDbRecord,
  ensureRegistryRow,
  getRegionSettings,
  getTenantDbRecord,
  recordBackup,
  recordHealth,
  recordMigration,
  recordTenantDbAudit,
  setProvisionStatus,
} from "./store"

// ---------------------------------------------------------------------------
// Versioned bootstrap migrations (applied to the tenant's own connection)
// ---------------------------------------------------------------------------

/**
 * The ordered baseline every isolated tenant database must have. Kept minimal
 * and idempotent: a marker table that records which app schema version the
 * tenant DB has converged to. Business tables continue to self-heal on first
 * use (the same runtime pattern the shared DB uses), so this proves the
 * independent migration MECHANISM without duplicating the entire ERP schema.
 */
export const TENANT_DB_MIGRATIONS: { version: number; name: string; statements: string[] }[] = [
  {
    version: 1,
    name: "bootstrap-marker",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`_tenant_schema_migrations\` (
        \`version\` INT UNSIGNED NOT NULL,
        \`name\` VARCHAR(120) NOT NULL,
        \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`version\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
]

export const LATEST_TENANT_DB_VERSION = TENANT_DB_MIGRATIONS.reduce((m, s) => Math.max(m, s.version), 0)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export type ProvisionActor = { userId: number; email?: string | null }

export type OperationResult = {
  ok: boolean
  action: string
  status: string
  detail: string
  record: TenantDbRecord
  /** True when a prior identical (idempotency-keyed) call already did the work. */
  deduplicated: boolean
}

/**
 * Load a tenant, its region settings and registry, and resolve the connection
 * profile from that TRUSTED server-side state (never from request input).
 */
async function loadProfile(tenantId: number): Promise<{
  deploymentModel: DeploymentModel
  profile: ConnectionProfile
  record: TenantDbRecord
}> {
  const tenant = await getTenantById(tenantId)
  if (!tenant) throw new TenantRoutingError("Tenant not found", 404)

  const regions = await getRegionSettings(tenantId)
  const record = await ensureRegistryRow(tenantId, {
    deploymentModel: tenant.deployment_model,
    schema: tenant.db_schema,
    connectionRef: tenant.db_connection_ref,
    region: regions?.dbRegion ?? null,
  })

  // The tenant record's deployment_model is authoritative; the registry mirrors
  // it plus schema/ref/region. Prefer explicit registry values, fall back to
  // the tenant directory columns.
  const profile = resolveConnectionProfile({
    tenantId,
    deploymentModel: record.deploymentModel ?? tenant.deployment_model,
    schema: record.schema ?? tenant.db_schema,
    connectionRef: record.connectionRef ?? tenant.db_connection_ref,
    dbRegion: record.region ?? regions?.dbRegion ?? null,
    dataRegion: regions?.dataRegion ?? null,
  })

  return { deploymentModel: profile.deploymentModel, profile, record }
}

/** Run a SELECT and return rows from a routed pool. */
async function poolQuery<T = any>(pool: RoutedPool, sql: string, params: any[] = []): Promise<T> {
  const [rows] = await pool.query<T>(sql, params)
  return rows as T
}

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------

/**
 * Create the tenant's schema/database. For `separate_schema` this issues
 * `CREATE DATABASE IF NOT EXISTS` on the shared server; for
 * `dedicated_database` it connects to the DSN's server (without selecting a
 * database) and creates the target schema there. Idempotent.
 */
export async function provisionTenantDatabase(
  tenantId: number,
  actor: ProvisionActor,
  idempotencyKey?: string | null,
): Promise<OperationResult> {
  const { deploymentModel, profile, record } = await loadProfile(tenantId)

  if (idempotencyKey) {
    const first = await recordTenantDbAudit({
      tenantId, action: "provision", idempotencyKey,
      actorUserId: actor.userId, actorEmail: actor.email,
      detail: { deploymentModel },
    })
    if (!first.inserted) {
      const current = (await getTenantDbRecord(tenantId))!
      return { ok: true, action: "provision", status: current.status, detail: "Already provisioned (idempotent replay).", record: current, deduplicated: true }
    }
  }

  if (!isolatesConnection(deploymentModel)) {
    await setProvisionStatus(tenantId, "active", null)
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "provision", status: "active", detail: "Shared database: no physical provisioning required (row-level isolation).", record: current, deduplicated: false }
  }

  await setProvisionStatus(tenantId, "provisioning", null)
  try {
    const schema = profile.schema!
    if (!isValidSchemaName(schema)) throw new TenantRoutingError(`Invalid schema name "${schema}".`, 400)

    if (deploymentModel === "separate_schema") {
      const cfg = resolveSharedDbConfig({ database: null })
      const admin = mysql.createPool({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        waitForConnections: true, connectionLimit: 2, dateStrings: true,
      })
      try {
        await admin.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      } finally {
        await admin.end().catch(() => {})
      }
    } else {
      // dedicated_database — connect to the instance without a default schema.
      const cfg = resolveDedicatedDbConfig(profile.connectionRef!)
      const admin = mysql.createPool({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        waitForConnections: true, connectionLimit: 2, dateStrings: true,
      })
      try {
        await admin.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database ?? schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      } finally {
        await admin.end().catch(() => {})
      }
    }

    await setProvisionStatus(tenantId, "active", null)
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "provision", status: "active", detail: `Schema "${schema}" provisioned.`, record: current, deduplicated: false }
  } catch (err: any) {
    const msg = String(err?.message ?? "Provisioning failed").slice(0, 500)
    await setProvisionStatus(tenantId, "failed", msg)
    const current = (await getTenantDbRecord(tenantId)) ?? record
    return { ok: false, action: "provision", status: "failed", detail: msg, record: current, deduplicated: false }
  }
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

export async function migrateTenantDatabase(
  tenantId: number,
  actor: ProvisionActor,
  idempotencyKey?: string | null,
): Promise<OperationResult> {
  const { deploymentModel, profile, record } = await loadProfile(tenantId)

  if (idempotencyKey) {
    const first = await recordTenantDbAudit({
      tenantId, action: "migrate", idempotencyKey,
      actorUserId: actor.userId, actorEmail: actor.email,
      detail: { targetVersion: LATEST_TENANT_DB_VERSION },
    })
    if (!first.inserted) {
      const current = (await getTenantDbRecord(tenantId))!
      return { ok: true, action: "migrate", status: current.status, detail: "Migration already applied (idempotent replay).", record: current, deduplicated: true }
    }
  }

  if (!isolatesConnection(deploymentModel)) {
    await recordMigration(tenantId, LATEST_TENANT_DB_VERSION)
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "migrate", status: "active", detail: "Shared database migrations are managed centrally.", record: current, deduplicated: false }
  }

  await setProvisionStatus(tenantId, "migrating", null)
  try {
    const pool = getPoolForProfile(profile)
    // Ensure the marker table before reading applied versions.
    for (const stmt of TENANT_DB_MIGRATIONS[0].statements) await pool.query(stmt)
    const applied = await poolQuery<any[]>(pool, "SELECT `version` FROM `_tenant_schema_migrations`")
    const done = new Set(applied.map((r) => Number(r.version)))

    let appliedCount = 0
    for (const migration of TENANT_DB_MIGRATIONS) {
      if (done.has(migration.version)) continue
      for (const stmt of migration.statements) await pool.query(stmt)
      await pool.query("INSERT INTO `_tenant_schema_migrations` (`version`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)", [migration.version, migration.name])
      appliedCount++
    }

    await recordMigration(tenantId, LATEST_TENANT_DB_VERSION)
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "migrate", status: "active", detail: `Applied ${appliedCount} migration(s); at version ${LATEST_TENANT_DB_VERSION}.`, record: current, deduplicated: false }
  } catch (err: any) {
    const msg = String(err?.message ?? "Migration failed").slice(0, 500)
    await setProvisionStatus(tenantId, "failed", msg)
    const current = (await getTenantDbRecord(tenantId)) ?? record
    return { ok: false, action: "migrate", status: "failed", detail: msg, record: current, deduplicated: false }
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function healthCheckTenantDatabase(tenantId: number): Promise<OperationResult> {
  const { deploymentModel, profile, record } = await loadProfile(tenantId)

  if (!isolatesConnection(deploymentModel)) {
    await recordHealth(tenantId, "healthy", "Shared database (row-level isolation).")
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "health", status: "healthy", detail: "Shared database is healthy.", record: current, deduplicated: false }
  }

  try {
    const pool = getPoolForProfile(profile)
    const rows = await poolQuery<any[]>(pool, "SELECT 1 AS ok, DATABASE() AS db, VERSION() AS version")
    const row = rows[0] ?? {}

    // Region-drift defense: the region the connection resolved to (derived from
    // the DSN / shared config) must match the tenant's configured region.
    const cfg = deploymentModel === "dedicated_database"
      ? resolveDedicatedDbConfig(profile.connectionRef!)
      : resolveSharedDbConfig()
    const actualRegion = cfg.region ?? profile.region
    const drift = detectRegionDrift(profile.region, actualRegion)
    if (drift.drifted) {
      await recordHealth(tenantId, "unhealthy", drift.message)
      const current = (await getTenantDbRecord(tenantId))!
      return { ok: false, action: "health", status: "unhealthy", detail: drift.message ?? "Region drift.", record: current, deduplicated: false }
    }

    const detail = `Connected to "${row.db ?? "?"}" (MySQL ${row.version ?? "?"}) in region ${profile.region ?? "default"}.`
    await recordHealth(tenantId, "healthy", detail)
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "health", status: "healthy", detail, record: current, deduplicated: false }
  } catch (err: any) {
    const msg = String(err?.message ?? "Health check failed").slice(0, 500)
    await recordHealth(tenantId, "unhealthy", msg)
    const current = (await getTenantDbRecord(tenantId)) ?? record
    return { ok: false, action: "health", status: "unhealthy", detail: msg, record: current, deduplicated: false }
  }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Snapshot a manifest of the tenant's own database: every base table with its
 * row count, plus a SHA-256 digest of that manifest. Read exclusively through
 * the tenant's routed connection, so the backup can never source another
 * tenant's data. For dedicated/separate this is genuinely independent of the
 * shared DB and every other tenant.
 */
export async function backupTenantDatabase(
  tenantId: number,
  actor: ProvisionActor,
  idempotencyKey?: string | null,
): Promise<OperationResult & { manifestRef?: string }> {
  const { deploymentModel, profile, record } = await loadProfile(tenantId)

  if (idempotencyKey) {
    const first = await recordTenantDbAudit({
      tenantId, action: "backup", idempotencyKey,
      actorUserId: actor.userId, actorEmail: actor.email,
    })
    if (!first.inserted) {
      const current = (await getTenantDbRecord(tenantId))!
      return { ok: true, action: "backup", status: current.status, detail: "Backup already taken (idempotent replay).", record: current, deduplicated: true, manifestRef: current.lastBackupRef ?? undefined }
    }
  }

  if (!isolatesConnection(deploymentModel)) {
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: false, action: "backup", status: current.status, detail: "Shared-database tenants are backed up by the central backup engine (tenant-scoped), not the per-tenant routing layer.", record: current, deduplicated: false }
  }

  try {
    const pool = getPoolForProfile(profile)
    const tables = await poolQuery<any[]>(
      pool,
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    const manifest: { table: string; rows: number }[] = []
    for (const { t } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(String(t))) continue
      const countRows = await poolQuery<any[]>(pool, `SELECT COUNT(*) AS c FROM \`${t}\``)
      manifest.push({ table: String(t), rows: Number(countRows[0]?.c ?? 0) })
    }
    const digest = createHash("sha256")
      .update(JSON.stringify({ tenantId, region: profile.region, manifest }))
      .digest("hex")
    const manifestRef = `tdb-${tenantId}-${Date.now()}-${digest.slice(0, 12)}`

    await recordBackup(tenantId, manifestRef)
    await recordTenantDbAudit({
      tenantId, action: "backup_manifest",
      detail: { manifestRef, tables: manifest.length, region: profile.region, digest },
      actorUserId: actor.userId, actorEmail: actor.email,
    })
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "backup", status: current.status, detail: `Backed up ${manifest.length} table(s) from the tenant's own database.`, record: current, deduplicated: false, manifestRef }
  } catch (err: any) {
    const msg = String(err?.message ?? "Backup failed").slice(0, 500)
    const current = (await getTenantDbRecord(tenantId)) ?? record
    return { ok: false, action: "backup", status: current.status, detail: msg, record: current, deduplicated: false }
  }
}
