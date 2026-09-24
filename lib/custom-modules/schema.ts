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
      created_by INT DEFAULT NULL,
      updated_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_custom_module_rec_module (tenant_id, module_id),
      KEY idx_custom_module_rec_state (tenant_id, module_id, state),
      KEY idx_custom_module_rec_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
