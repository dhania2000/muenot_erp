import "server-only"
import { query } from "@/lib/db"
import { ensureNotificationsSchema } from "@/lib/notifications"
let ready:Promise<void>|undefined
export const notificationDDL=[
  `CREATE TABLE IF NOT EXISTS notification_templates (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, title VARCHAR(255) NOT NULL, body TEXT NOT NULL, created_by INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notification_preferences (tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL, enabled BOOLEAN NOT NULL, destination VARCHAR(512) NULL, min_priority INT NOT NULL DEFAULT 0, frequency VARCHAR(20) NOT NULL DEFAULT 'immediate', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY(tenant_id,user_id,channel)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notification_module_prefs (tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, module_key VARCHAR(80) NOT NULL, enabled BOOLEAN NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY(tenant_id,user_id,module_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL, request_key VARCHAR(191) NOT NULL, request_hash CHAR(64) NOT NULL, title VARCHAR(255) NOT NULL, body TEXT NOT NULL, link VARCHAR(255) NULL, source_context JSON NULL, priority INT NOT NULL DEFAULT 5, mandatory TINYINT(1) NOT NULL DEFAULT 0, available_at DATETIME NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'queued', attempts INT NOT NULL DEFAULT 0, lease CHAR(36) NULL, started_at DATETIME NULL, result_id VARCHAR(191) NULL, error_code VARCHAR(80) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY identity_idx(tenant_id,channel,request_key), KEY due_idx(status,available_at,priority), KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS notification_delivery_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, delivery_id BIGINT UNSIGNED NOT NULL, attempt INT NOT NULL, status VARCHAR(20) NOT NULL, actor_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY delivery_idx(tenant_id,delivery_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]
// MySQL has no "ADD COLUMN IF NOT EXISTS", so probe information_schema first.
// Lets existing installs upgrade the preference/delivery tables in place.
async function ensureColumn(table:string,column:string,ddl:string) {
  const rows=await query<any[]>("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",[table,column])
  if(!rows.length)await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`)
}
export function ensureNotificationEngineSchema(){return ready??=(async()=>{
  await ensureNotificationsSchema()
  for(const ddl of notificationDDL)await query(ddl)
  await ensureColumn("notification_preferences","min_priority","min_priority INT NOT NULL DEFAULT 0")
  await ensureColumn("notification_preferences","frequency","frequency VARCHAR(20) NOT NULL DEFAULT 'immediate'")
  await ensureColumn("notification_deliveries","mandatory","mandatory TINYINT(1) NOT NULL DEFAULT 0")
})().catch(e=>{ready=undefined;throw e})}
