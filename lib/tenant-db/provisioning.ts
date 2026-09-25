import "server-only"
/**
 * Independent per-tenant database provisioning, migration and health-check.
 * ---------------------------------------------------------------------------
 * Each tenant on `separate_schema` or `dedicated_database` owns its own MySQL
 * schema/instance whose lifecycle is managed here, INDEPENDENTLY of every other
 * tenant and of the shared platform database:
 *
 *   provision   — create the tenant's schema (idempotent CREATE DATABASE / USE).
 *   migrate     — unavailable for isolated databases until the complete ERP
 *                 schema can be independently migrated and verified.
 *   healthCheck — probe the tenant's own connection (SELECT 1 + version) and
 *                 assert the region it resolves to matches its configuration
 *                 (region-drift defense), recording a real health verdict.
 *   backup      — explicitly unavailable until a restorable backup provider
 *                 and restore verification are in place.
 *
 * Everything runs through the router, so a dedicated tenant's operations can
 * only ever touch that tenant's connection. `shared_database` tenants need no
 * physical provisioning — their isolation is row-level — so these operations
 * resolve to no-ops that simply mark the registry `active`/`healthy`.
 *
 * Provisioning uses the tenant DB audit ledger for idempotency.
 */
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
import { classifyTenantDbFailure } from "./errors"
import {
  type TenantDbRecord,
  ensureRegistryRow,
  getRegionSettings,
  getTenantDbRecord,
  isDuplicateAction,
  recordHealth,
  recordTenantDbAudit,
  setProvisionStatus,
} from "./store"

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
  errorCode?: string
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
    if (await isDuplicateAction(tenantId, "provision", idempotencyKey)) {
      const current = (await getTenantDbRecord(tenantId))!
      if (current.status === "active" || current.status === "provisioning") {
        return { ok: true, action: "provision", status: current.status, detail: "Provisioning result already recorded (idempotent replay).", record: current, deduplicated: true }
      }
    }
  }

  if (!isolatesConnection(deploymentModel)) {
    await setProvisionStatus(tenantId, "active", null)
    if (idempotencyKey) await recordTenantDbAudit({
      tenantId, action: "provision", idempotencyKey,
      actorUserId: actor.userId, actorEmail: actor.email,
      detail: { deploymentModel, status: "active" },
    })
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
      if (cfg.database !== schema) throw new TenantRoutingError("Dedicated database name does not match the tenant routing profile.", 409)
      const admin = mysql.createPool({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        ssl: cfg.ssl,
        waitForConnections: true, connectionLimit: 2, dateStrings: true,
      })
      try {
        await admin.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      } finally {
        await admin.end().catch(() => {})
      }
    }

    // Schema creation is not ERP readiness. Full business migrations and data
    // routing are still blocked, so never mark an isolated target active here.
    await setProvisionStatus(tenantId, "provisioning", null)
    if (idempotencyKey) await recordTenantDbAudit({
      tenantId, action: "provision", idempotencyKey,
      actorUserId: actor.userId, actorEmail: actor.email,
      detail: { deploymentModel, status: "provisioning" },
    })
    const current = (await getTenantDbRecord(tenantId))!
    return { ok: true, action: "provision", status: "provisioning", detail: "Database schema created; ERP data hosting is not ready for activation.", record: current, deduplicated: false }
  } catch (err: unknown) {
    const failure = classifyTenantDbFailure(err)
    await setProvisionStatus(tenantId, "failed", failure.code)
    const current = (await getTenantDbRecord(tenantId)) ?? record
    return { ok: false, action: "provision", status: "failed", detail: failure.message, errorCode: failure.code, record: current, deduplicated: false }
  }
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

export async function migrateTenantDatabase(
  tenantId: number,
  _actor: ProvisionActor,
  _idempotencyKey?: string | null,
): Promise<OperationResult> {
  const { record } = await loadProfile(tenantId)
  return {
    ok: false,
    action: "migrate",
    status: record.status,
    detail: "A complete, verified tenant ERP schema migration is not available.",
    errorCode: "SCHEMA_MIGRATIONS_UNAVAILABLE",
    record,
    deduplicated: false,
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
  } catch (err: unknown) {
    const failure = classifyTenantDbFailure(err)
    await recordHealth(tenantId, "unhealthy", failure.code)
    const current = (await getTenantDbRecord(tenantId)) ?? record
    return { ok: false, action: "health", status: "unhealthy", detail: failure.message, errorCode: failure.code, record: current, deduplicated: false }
  }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Fail closed until a restorable backup provider and restore verification are
 * implemented. The previous row-count manifest contained no customer data and
 * could not be restored, yet marked last_backup_at; that was not a backup.
 */
export async function backupTenantDatabase(
  tenantId: number,
  _actor: ProvisionActor,
  _idempotencyKey?: string | null,
): Promise<OperationResult & { manifestRef?: string }> {
  const { record } = await loadProfile(tenantId)
  return {
    ok: false,
    action: "backup",
    status: record.status,
    detail: "A restorable tenant database backup is not available from this endpoint.",
    errorCode: "BACKUP_UNAVAILABLE",
    record,
    deduplicated: false,
  }
}
