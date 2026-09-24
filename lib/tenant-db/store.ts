import "server-only"
/**
 * Tenant database routing + region registry (server store).
 * ---------------------------------------------------------------------------
 * The authoritative, PLATFORM-axis record of how each tenant's data is routed
 * and where it may physically live. It is operated by platform super-admins on
 * behalf of ANY tenant, so — like the `tenants` directory itself — it is NOT a
 * tenant-scoped table (it is deliberately excluded from lib/tenant-tables.ts)
 * and every read/write is explicitly keyed by the target tenant id.
 *
 * Two facets:
 *   - REGION residency columns are stamped onto the `tenants` row (data_region,
 *     db_region, storage_region, backup_region) so region lives with the tenant.
 *   - The `tenant_db_connections` registry holds routing settings (schema,
 *     connection ref) and the independent provisioning / migration / health /
 *     backup lifecycle for that tenant's database.
 *
 * Self-heals its schema at runtime (same pattern as the rest of the codebase)
 * so existing installs converge without a manual migration step; a matching SQL
 * migration is also shipped for fresh installs.
 */
import { query, withTransaction } from "@/lib/db"
import {
  type DeploymentModel,
  type HealthStatus,
  type ProvisionStatus,
  toDeploymentModel,
  toHealthStatus,
  toProvisionStatus,
} from "./model"
import { toDataRegion } from "./regions"

const REGISTRY = "tenant_db_connections"
const AUDIT = "tenant_db_audit"

// ---------------------------------------------------------------------------
// Self-healing schema
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function runEnsure(): Promise<void> {
  // Region residency columns on the tenant directory.
  for (const col of ["data_region", "db_region", "storage_region", "backup_region"]) {
    if (!(await columnExists("tenants", col))) {
      await query(`ALTER TABLE \`tenants\` ADD COLUMN \`${col}\` VARCHAR(40) DEFAULT NULL`)
    }
  }

  await query(`
    CREATE TABLE IF NOT EXISTS \`${REGISTRY}\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`deployment_model\` ENUM('shared_database','separate_schema','dedicated_database')
          NOT NULL DEFAULT 'shared_database',
      \`db_schema\` VARCHAR(64) DEFAULT NULL,
      \`connection_ref\` VARCHAR(190) DEFAULT NULL,
      \`region\` VARCHAR(40) DEFAULT NULL,
      \`status\` ENUM('unprovisioned','provisioning','active','migrating','failed')
          NOT NULL DEFAULT 'unprovisioned',
      \`schema_version\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`health_status\` ENUM('unknown','healthy','unhealthy') NOT NULL DEFAULT 'unknown',
      \`health_detail\` VARCHAR(500) DEFAULT NULL,
      \`last_health_check_at\` DATETIME DEFAULT NULL,
      \`last_migrated_at\` DATETIME DEFAULT NULL,
      \`last_backup_at\` DATETIME DEFAULT NULL,
      \`last_backup_ref\` VARCHAR(128) DEFAULT NULL,
      \`error_message\` VARCHAR(1000) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_tenant_db\` (\`tenant_id\`),
      CONSTRAINT \`fk_tenant_db_tenant\` FOREIGN KEY (\`tenant_id\`)
        REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`${AUDIT}\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`action\` VARCHAR(48) NOT NULL,
      \`detail\` JSON DEFAULT NULL,
      \`idempotency_key\` VARCHAR(128) DEFAULT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`actor_email\` VARCHAR(190) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_tdb_audit_tenant\` (\`tenant_id\`, \`created_at\`),
      UNIQUE KEY \`uniq_tdb_idem\` (\`tenant_id\`, \`action\`, \`idempotency_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureTenantDbSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((err) => { ensured = null; throw err })
  return ensured
}

// ---------------------------------------------------------------------------
// Types + mapping
// ---------------------------------------------------------------------------

export type TenantRegionSettings = {
  dataRegion: string | null
  dbRegion: string | null
  storageRegion: string | null
  backupRegion: string | null
}

export type TenantDbRecord = {
  tenantId: number
  deploymentModel: DeploymentModel
  schema: string | null
  connectionRef: string | null
  region: string | null
  status: ProvisionStatus
  schemaVersion: number
  healthStatus: HealthStatus
  healthDetail: string | null
  lastHealthCheckAt: string | null
  lastMigratedAt: string | null
  lastBackupAt: string | null
  lastBackupRef: string | null
  errorMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

function mapRegistry(row: any): TenantDbRecord {
  return {
    tenantId: Number(row.tenant_id),
    deploymentModel: toDeploymentModel(row.deployment_model) ?? "shared_database",
    schema: row.db_schema ?? null,
    connectionRef: row.connection_ref ?? null,
    region: row.region ?? null,
    status: toProvisionStatus(row.status),
    schemaVersion: Number(row.schema_version ?? 0),
    healthStatus: toHealthStatus(row.health_status),
    healthDetail: row.health_detail ?? null,
    lastHealthCheckAt: row.last_health_check_at ?? null,
    lastMigratedAt: row.last_migrated_at ?? null,
    lastBackupAt: row.last_backup_at ?? null,
    lastBackupRef: row.last_backup_ref ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Region settings (on the tenants row)
// ---------------------------------------------------------------------------

export async function getRegionSettings(tenantId: number): Promise<TenantRegionSettings | null> {
  await ensureTenantDbSchema()
  const rows = await query<any[]>(
    "SELECT `data_region`, `db_region`, `storage_region`, `backup_region` FROM `tenants` WHERE `id` = ? LIMIT 1",
    [tenantId],
  )
  if (!rows[0]) return null
  return {
    dataRegion: rows[0].data_region ?? null,
    dbRegion: rows[0].db_region ?? null,
    storageRegion: rows[0].storage_region ?? null,
    backupRegion: rows[0].backup_region ?? null,
  }
}

/** Persist region residency settings. Values are validated by the caller. */
export async function saveRegionSettings(tenantId: number, settings: TenantRegionSettings): Promise<void> {
  await ensureTenantDbSchema()
  await query(
    "UPDATE `tenants` SET `data_region` = ?, `db_region` = ?, `storage_region` = ?, `backup_region` = ? WHERE `id` = ?",
    [
      toDataRegion(settings.dataRegion),
      toDataRegion(settings.dbRegion),
      toDataRegion(settings.storageRegion),
      toDataRegion(settings.backupRegion),
      tenantId,
    ],
  )
}

// ---------------------------------------------------------------------------
// Routing registry
// ---------------------------------------------------------------------------

export async function getTenantDbRecord(tenantId: number): Promise<TenantDbRecord | null> {
  await ensureTenantDbSchema()
  const rows = await query<any[]>(`SELECT * FROM \`${REGISTRY}\` WHERE \`tenant_id\` = ? LIMIT 1`, [tenantId])
  return rows[0] ? mapRegistry(rows[0]) : null
}

/**
 * Ensure a registry row exists for the tenant, seeded from the tenant's own
 * deployment_model. Idempotent.
 */
export async function ensureRegistryRow(
  tenantId: number,
  seed: { deploymentModel: DeploymentModel; schema?: string | null; connectionRef?: string | null; region?: string | null },
): Promise<TenantDbRecord> {
  await ensureTenantDbSchema()
  await query(
    `INSERT INTO \`${REGISTRY}\` (\`tenant_id\`, \`deployment_model\`, \`db_schema\`, \`connection_ref\`, \`region\`)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`tenant_id\` = \`tenant_id\``,
    [tenantId, seed.deploymentModel, seed.schema ?? null, seed.connectionRef ?? null, seed.region ?? null],
  )
  const record = await getTenantDbRecord(tenantId)
  if (!record) throw new Error("Failed to load tenant DB registry row")
  return record
}

export type RoutingUpdate = {
  deploymentModel?: DeploymentModel
  schema?: string | null
  connectionRef?: string | null
  region?: string | null
}

/**
 * Update routing settings. Changing the deployment model, schema, connection
 * ref or region resets the row to `unprovisioned` and clears health, because the
 * previous provisioning no longer describes the new target.
 */
export async function saveRoutingSettings(tenantId: number, update: RoutingUpdate): Promise<TenantDbRecord> {
  await ensureTenantDbSchema()
  await ensureRegistryRow(tenantId, { deploymentModel: update.deploymentModel ?? "shared_database" })

  const sets: string[] = []
  const values: any[] = []
  if (update.deploymentModel !== undefined) {
    sets.push("`deployment_model` = ?")
    values.push(update.deploymentModel)
  }
  if (update.schema !== undefined) {
    sets.push("`db_schema` = ?")
    values.push(update.schema)
  }
  if (update.connectionRef !== undefined) {
    sets.push("`connection_ref` = ?")
    values.push(update.connectionRef)
  }
  if (update.region !== undefined) {
    sets.push("`region` = ?")
    values.push(toDataRegion(update.region))
  }
  if (sets.length > 0) {
    // Any routing change invalidates prior provisioning state.
    sets.push("`status` = 'unprovisioned'", "`health_status` = 'unknown'", "`health_detail` = NULL", "`error_message` = NULL")
    values.push(tenantId)
    await query(`UPDATE \`${REGISTRY}\` SET ${sets.join(", ")} WHERE \`tenant_id\` = ?`, values)
  }
  const record = await getTenantDbRecord(tenantId)
  if (!record) throw new Error("Failed to load updated tenant DB registry row")
  return record
}

export async function setProvisionStatus(
  tenantId: number,
  status: ProvisionStatus,
  errorMessage?: string | null,
): Promise<void> {
  await ensureTenantDbSchema()
  await query(
    `UPDATE \`${REGISTRY}\` SET \`status\` = ?, \`error_message\` = ? WHERE \`tenant_id\` = ?`,
    [status, errorMessage ?? null, tenantId],
  )
}

export async function recordMigration(tenantId: number, schemaVersion: number): Promise<void> {
  await ensureTenantDbSchema()
  await query(
    `UPDATE \`${REGISTRY}\` SET \`schema_version\` = ?, \`last_migrated_at\` = NOW(), \`status\` = 'active', \`error_message\` = NULL WHERE \`tenant_id\` = ?`,
    [schemaVersion, tenantId],
  )
}

export async function recordHealth(
  tenantId: number,
  healthStatus: HealthStatus,
  detail: string | null,
): Promise<void> {
  await ensureTenantDbSchema()
  await query(
    `UPDATE \`${REGISTRY}\` SET \`health_status\` = ?, \`health_detail\` = ?, \`last_health_check_at\` = NOW() WHERE \`tenant_id\` = ?`,
    [healthStatus, detail ? detail.slice(0, 500) : null, tenantId],
  )
}

export async function recordBackup(tenantId: number, backupRef: string): Promise<void> {
  await ensureTenantDbSchema()
  await query(
    `UPDATE \`${REGISTRY}\` SET \`last_backup_at\` = NOW(), \`last_backup_ref\` = ? WHERE \`tenant_id\` = ?`,
    [backupRef.slice(0, 128), tenantId],
  )
}

// ---------------------------------------------------------------------------
// Audit + idempotency
// ---------------------------------------------------------------------------

export type TenantDbAuditEntry = {
  id: number
  tenantId: number
  action: string
  detail: Record<string, unknown> | null
  actorUserId: number | null
  actorEmail: string | null
  createdAt: string
}

/**
 * Append a tenant-db audit row. When an idempotency key is supplied the unique
 * (tenant, action, key) index makes a replayed action a no-op: `insertId` of 0
 * signals the action was already performed under this key.
 */
export async function recordTenantDbAudit(entry: {
  tenantId: number
  action: string
  detail?: Record<string, unknown> | null
  idempotencyKey?: string | null
  actorUserId?: number | null
  actorEmail?: string | null
}): Promise<{ inserted: boolean }> {
  await ensureTenantDbSchema()
  const res = await query<any>(
    `INSERT INTO \`${AUDIT}\` (\`tenant_id\`, \`action\`, \`detail\`, \`idempotency_key\`, \`actor_user_id\`, \`actor_email\`)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`id\` = \`id\``,
    [
      entry.tenantId,
      entry.action,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.idempotencyKey ?? null,
      entry.actorUserId ?? null,
      entry.actorEmail ?? null,
    ],
  )
  return { inserted: Number(res?.affectedRows ?? 0) === 1 }
}

/** Whether an action has already run under this idempotency key. */
export async function isDuplicateAction(
  tenantId: number,
  action: string,
  idempotencyKey: string,
): Promise<boolean> {
  await ensureTenantDbSchema()
  const rows = await query<any[]>(
    `SELECT 1 FROM \`${AUDIT}\` WHERE \`tenant_id\` = ? AND \`action\` = ? AND \`idempotency_key\` = ? LIMIT 1`,
    [tenantId, action, idempotencyKey],
  )
  return rows.length > 0
}

export async function listTenantDbAudit(tenantId: number, limit = 50): Promise<TenantDbAuditEntry[]> {
  await ensureTenantDbSchema()
  const rows = await query<any[]>(
    `SELECT * FROM \`${AUDIT}\` WHERE \`tenant_id\` = ? ORDER BY \`id\` DESC LIMIT ?`,
    [tenantId, limit],
  )
  return rows.map((r) => {
    let detail: Record<string, unknown> | null = null
    if (r.detail) {
      try {
        detail = typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail
      } catch {
        detail = null
      }
    }
    return {
      id: Number(r.id),
      tenantId: Number(r.tenant_id),
      action: String(r.action),
      detail,
      actorUserId: r.actor_user_id != null ? Number(r.actor_user_id) : null,
      actorEmail: r.actor_email ?? null,
      createdAt: r.created_at,
    }
  })
}

export { withTransaction }
