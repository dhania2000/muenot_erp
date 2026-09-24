-- =============================================================
-- SPEC 110 — Task Management
-- =============================================================
-- Centralized task engine shared by every module. Supports task, assignee(s),
-- team, priority, due date, dependencies, checklist, comments, attachments,
-- recurrence, status and approval.
--
-- Backing model (tenant-owned; register in lib/tenant-tables.ts):
--   tasks                 : the task record.
--   task_assignees        : many assignees / watchers per task.
--   task_dependencies     : task-to-task blocking edges.
--   task_checklist_items  : sub-items within a task.
--   task_comments         : threaded comments.
--   task_attachments      : files linked to a task.
-- =============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT NULL,
  team_id BIGINT DEFAULT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT 'medium', -- low | medium | high | urgent
  status VARCHAR(20) NOT NULL DEFAULT 'todo',     -- todo | in_progress | blocked | in_review | done | cancelled
  due_date DATE DEFAULT NULL,
  due_at TIMESTAMP NULL DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  progress TINYINT NOT NULL DEFAULT 0,            -- 0..100
  -- Optional link to the entity the task is about.
  related_entity VARCHAR(60) DEFAULT NULL,        -- deal | customer | invoice | ticket ...
  related_id VARCHAR(64) DEFAULT NULL,
  -- Recurrence (RRULE-style config); NULL = one-off.
  recurrence JSON DEFAULT NULL,
  recurrence_parent_id BIGINT DEFAULT NULL,       -- points to the template task
  -- Approval workflow.
  requires_approval TINYINT(1) NOT NULL DEFAULT 0,
  approval_status VARCHAR(20) DEFAULT NULL,        -- pending | approved | rejected
  approved_by INT DEFAULT NULL,
  approved_at TIMESTAMP NULL DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tasks_tenant (tenant_id),
  KEY idx_tasks_status (tenant_id, status),
  KEY idx_tasks_due (tenant_id, due_date),
  KEY idx_tasks_team (tenant_id, team_id),
  KEY idx_tasks_related (tenant_id, related_entity, related_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_assignees (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  task_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'assignee', -- assignee | watcher | approver
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_assignee (task_id, user_id, role),
  KEY idx_task_assignee_tenant (tenant_id),
  KEY idx_task_assignee_task (task_id),
  KEY idx_task_assignee_user (tenant_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_dependencies (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  task_id BIGINT NOT NULL,                       -- the dependent task
  depends_on_task_id BIGINT NOT NULL,            -- must finish first
  dependency_type VARCHAR(20) NOT NULL DEFAULT 'finish_to_start',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_dep (task_id, depends_on_task_id),
  KEY idx_task_dep_tenant (tenant_id),
  KEY idx_task_dep_task (task_id),
  KEY idx_task_dep_on (depends_on_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_checklist_items (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  task_id BIGINT NOT NULL,
  content VARCHAR(500) NOT NULL,
  is_done TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  done_by INT DEFAULT NULL,
  done_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task_chk_tenant (tenant_id),
  KEY idx_task_chk_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_comments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  task_id BIGINT NOT NULL,
  parent_comment_id BIGINT DEFAULT NULL,
  body TEXT NOT NULL,
  author_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_task_cmt_tenant (tenant_id),
  KEY idx_task_cmt_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_attachments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  task_id BIGINT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url VARCHAR(1024) NOT NULL,
  file_size BIGINT DEFAULT NULL,
  content_type VARCHAR(120) DEFAULT NULL,
  uploaded_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task_att_tenant (tenant_id),
  KEY idx_task_att_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
