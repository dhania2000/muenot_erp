import "server-only"
/**
 * SPEC 96 — Custom Module Framework schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Same migration-runner-free pattern as the rest of the codebase: every
 * statement is CREATE TABLE IF NOT EXISTS, safe to run on every request and
 * against a live production database.
 *
 * Two tenant-owned tables (registered in lib/tenant-tables.ts):
 *   - custom_modules         : one row per module DEFINITION — its name, slug,
 *                              status, and the fields / list view / permissions
 *                              / workflow / reports as JSON. UNIQUE (tenant,
 *                              slug).
 *   - custom_module_records  : one row per record captured against a module —
 *                              the validated values, the workflow state and the
 *                              attachments as JSON. Indexed by (tenant, module)
 *                              and by (tenant, module, state) for list filters.
 *
 * A single generic record table backs EVERY custom module (metadata-driven
 * storage): the module id discriminates rows, so a tenant can add unlimited
 * modules without a schema migration. This is what keeps custom modules
 * "lightweight" and makes tenant isolation a single predicate.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureCustomModuleSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS custom_modules (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      slug VARCHAR(60) NOT NULL,
      name VARCHAR(80) NOT NULL,
      plural_name VARCHAR(100) NOT NULL DEFAULT '',
      description VARCHAR(1000) NOT NULL DEFAULT '',
      icon VARCHAR(40) NOT NULL DEFAULT 'Blocks',
      nav_group VARCHAR(60) NOT NULL DEFAULT 'Custom',
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      allow_attachments TINYINT NOT NULL DEFAULT 0,
      fields_json JSON NOT NULL,
      list_view_json JSON NOT NULL,
      permissions_json JSON NOT NULL,
      workflow_json JSON NOT NULL,
      reports_json JSON NOT NULL,
      version INT NOT NULL DEFAULT 1,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_custom_module_slug (tenant_id, slug),
      KEY idx_custom_module_tenant (tenant_id),
      KEY idx_custom_module_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS custom_module_records (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      module_id BIGINT NOT NULL,
      module_version INT NOT NULL DEFAULT 1,
      state VARCHAR(60) DEFAULT NULL,
      values_json JSON NOT NULL,
      attachments_json JSON NOT NULL,
      merged_into BIGINT DEFAULT NULL,
      merged_at DATETIME DEFAULT NULL,
      created_by INT DEFAULT NULL,
      updated_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_custom_module_rec_module (tenant_id, module_id),
      KEY idx_custom_module_rec_state (tenant_id, module_id, state),
      KEY idx_custom_module_rec_merged (tenant_id, module_id, merged_into),
      KEY idx_custom_module_rec_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // SPEC 104 — record merge history. One row per executed merge, holding the
  // full pre-merge snapshot so an authorized operator can roll the merge back.
  await query(`
    CREATE TABLE IF NOT EXISTS custom_module_merges (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      module_id BIGINT NOT NULL,
      module_version INT NOT NULL DEFAULT 1,
      primary_id BIGINT NOT NULL,
      secondary_ids_json JSON NOT NULL,
      field_sources_json JSON NOT NULL,
      snapshot_json JSON NOT NULL,
      reference_changes INT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'merged',
      created_by INT DEFAULT NULL,
      rolled_back_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rolled_back_at DATETIME DEFAULT NULL,
      KEY idx_custom_module_merge_module (tenant_id, module_id),
      KEY idx_custom_module_merge_status (tenant_id, module_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Self-heal the tombstone columns on databases whose records table predates
  // SPEC 104 (CREATE TABLE IF NOT EXISTS never adds columns to an existing row).
  await ensureColumn("custom_module_records", "merged_into", "BIGINT DEFAULT NULL")
  await ensureColumn("custom_module_records", "merged_at", "DATETIME DEFAULT NULL")
}

/** Add a column only when it is missing — idempotent, safe on every request. */
async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const rows = (await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )) as unknown[]
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}
