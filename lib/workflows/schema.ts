import "server-only"
import { query } from "@/lib/db"
import { ensureNotificationsSchema } from "@/lib/notifications"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"
let ready: Promise<void> | undefined
export const workflowDDL = [
  `CREATE TABLE IF NOT EXISTS erp_workflows (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, definition JSON NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1, created_by INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS erp_workflow_runs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, workflow_id BIGINT UNSIGNED NOT NULL, snapshot JSON NOT NULL, record_id BIGINT UNSIGNED NOT NULL, request_key VARCHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL, requested_by INT UNSIGNED NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'queued', cursor INT NOT NULL DEFAULT 0, available_at DATETIME NOT NULL, error_code VARCHAR(80) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY request_idx(tenant_id,workflow_id,request_key), KEY due_idx(status,available_at), KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS erp_workflow_events (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, run_id BIGINT UNSIGNED NOT NULL, step INT NOT NULL, event_type VARCHAR(40) NOT NULL, actor_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY run_idx(tenant_id,run_id,id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS erp_workflow_notices (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, run_id BIGINT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, message VARCHAR(1000) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY inbox_idx(tenant_id,user_id,id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS erp_workflow_tasks (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, title VARCHAR(255) NOT NULL, description TEXT NOT NULL, priority VARCHAR(16) NOT NULL DEFAULT 'Medium', status VARCHAR(24) NOT NULL DEFAULT 'Open', assigned_to INT UNSIGNED NOT NULL, source_run_id BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB`,
  // Immutable history of every save. Powers the "workflow history" / versioning requirement without mutating runs' own immutable snapshots.
  `CREATE TABLE IF NOT EXISTS erp_workflow_versions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, workflow_id BIGINT UNSIGNED NOT NULL, version INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, description VARCHAR(500) NOT NULL DEFAULT '', definition JSON NOT NULL, changed_by INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY wf_idx(tenant_id,workflow_id,version)) ENGINE=InnoDB`,
  // Engine-owned record of asset-assignment actions. The engine deliberately does
  // not write to legacy asset tables (unverified tenant isolation); this keeps the
  // "assets" action tenant-scoped, auditable and safe.
  `CREATE TABLE IF NOT EXISTS erp_workflow_asset_actions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, run_id BIGINT UNSIGNED NOT NULL, asset_tag VARCHAR(64) NOT NULL, assigned_to INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id), KEY run_idx(tenant_id,run_id)) ENGINE=InnoDB`,
]
async function ensureColumn(table: string, column: string, ddl: string): Promise<boolean> {
  const rows = await query<any[]>("SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=? LIMIT 1", [table, column])
  if (!rows.length) { await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`); return true }
  return false
}
export function ensureWorkflowSchema() {
  return ready ??= (async () => {
    for (const ddl of workflowDDL) await query(ddl)
    // Added after the initial release; kept as idempotent ALTERs so existing installs upgrade in place.
    await ensureColumn("erp_workflows", "description", "description VARCHAR(500) NOT NULL DEFAULT ''")
    await ensureColumn("erp_workflows", "version", "version INT UNSIGNED NOT NULL DEFAULT 1")
    await ensureColumn("erp_workflow_runs", "branch", "branch VARCHAR(8) NOT NULL DEFAULT 'then'")
    // Spec13 draft/publish lifecycle. New workflows start as 'draft' and must be
    // explicitly published before they can run.
    const addedStatus = await ensureColumn("erp_workflows", "status", "status VARCHAR(16) NOT NULL DEFAULT 'draft'")
    await ensureColumn("erp_workflows", "published_version", "published_version INT UNSIGNED NULL")
    await ensureColumn("erp_workflows", "published_at", "published_at DATETIME NULL")
    // Backfill once: pre-existing enabled workflows are treated as already published
    // so they keep running after the lifecycle is introduced.
    if (addedStatus) await query("UPDATE erp_workflows SET status='published', published_version=version, published_at=CURRENT_TIMESTAMP WHERE enabled=1")
    await ensureNotificationsSchema()
    await ensureNotificationEngineSchema()
  })().catch(e => { ready = undefined; throw e })
}
