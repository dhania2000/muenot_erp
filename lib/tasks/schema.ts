import "server-only"
import { query } from "@/lib/db"
import { ensureNotificationsSchema } from "@/lib/notifications"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"

/**
 * SPEC 110 — Centralized Task Engine schema (self-healing).
 * ---------------------------------------------------------------------------
 * A single, tenant-owned task backbone that any module can create work
 * against. Unlike the module-local `operations_tasks` pipeline, this engine
 * models every dimension the spec calls for as a first-class citizen:
 * assignee, team, priority, due date, dependencies, checklist, comments,
 * attachments, recurrence, status and approval.
 *
 * Every table carries `tenant_id` and is registered in lib/tenant-tables.ts so
 * the fail-closed data-layer guard and the tenant-scope helpers protect it.
 */

let ready: Promise<void> | undefined

export const taskDDL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    task_type VARCHAR(40) NOT NULL DEFAULT 'Task',
    status VARCHAR(32) NOT NULL DEFAULT 'To Do',
    priority VARCHAR(16) NOT NULL DEFAULT 'Medium',
    assignee_id INT UNSIGNED NULL,
    assignee_name VARCHAR(150) NULL,
    team_id INT UNSIGNED NULL,
    team_name VARCHAR(150) NULL,
    reporter_id INT UNSIGNED NULL,
    reporter_name VARCHAR(150) NULL,
    start_date DATE NULL,
    due_date DATE NULL,
    completed_at DATETIME NULL,
    progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
    recurrence VARCHAR(16) NOT NULL DEFAULT 'none',
    recurrence_interval INT UNSIGNED NOT NULL DEFAULT 1,
    recurrence_until DATE NULL,
    recurrence_parent_id BIGINT UNSIGNED NULL,
    approval_required TINYINT(1) NOT NULL DEFAULT 0,
    approval_status VARCHAR(16) NOT NULL DEFAULT 'none',
    approver_id INT UNSIGNED NULL,
    approver_name VARCHAR(150) NULL,
    approval_note VARCHAR(500) NULL,
    approval_at DATETIME NULL,
    source_module VARCHAR(60) NULL,
    source_entity VARCHAR(60) NULL,
    source_entity_id VARCHAR(64) NULL,
    created_by INT UNSIGNED NULL,
    created_by_name VARCHAR(150) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_tasks_tenant (tenant_id, id),
    KEY idx_tasks_status (tenant_id, status),
    KEY idx_tasks_assignee (tenant_id, assignee_id),
    KEY idx_tasks_due (tenant_id, due_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_dependencies (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    depends_on_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_task_dep (tenant_id, task_id, depends_on_id),
    KEY idx_dep_task (tenant_id, task_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_checklist_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    item_text VARCHAR(500) NOT NULL,
    is_done TINYINT(1) NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    completed_by_name VARCHAR(150) NULL,
    completed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_check_task (tenant_id, task_id, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_comments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    author_id INT UNSIGNED NULL,
    author_name VARCHAR(150) NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_comment_task (tenant_id, task_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_attachments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_url VARCHAR(1024) NOT NULL,
    file_size BIGINT UNSIGNED NULL,
    content_type VARCHAR(150) NULL,
    uploaded_by_id INT UNSIGNED NULL,
    uploaded_by_name VARCHAR(150) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_attach_task (tenant_id, task_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_activity (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    actor_id INT UNSIGNED NULL,
    actor_name VARCHAR(150) NULL,
    action VARCHAR(60) NOT NULL,
    detail VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_activity_task (tenant_id, task_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]

export function ensureTaskSchema() {
  return (ready ??= (async () => {
    for (const ddl of taskDDL) await query(ddl)
    await ensureNotificationsSchema()
    await ensureNotificationEngineSchema()
  })().catch((e) => {
    ready = undefined
    throw e
  }))
}
