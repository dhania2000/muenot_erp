-- Marketing > Marketing Planner
-- Content calendar board: each item moves across Backlog -> Planned -> In Progress -> Published.
-- The Planner UI (components/marketing/marketing-planner-client.tsx) is currently
-- client-only; this table gives it durable persistence.

CREATE TABLE IF NOT EXISTS marketing_planner_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_code VARCHAR(40) NOT NULL,
  title VARCHAR(190) NOT NULL,
  description VARCHAR(1000) NULL,
  channel VARCHAR(60) NOT NULL DEFAULT 'Email',
  status ENUM('Backlog','Planned','In Progress','Published') NOT NULL DEFAULT 'Backlog',
  sort_order INT NOT NULL DEFAULT 0,
  due_date DATE NULL,
  publish_at DATETIME NULL,
  published_at DATETIME NULL,
  campaign VARCHAR(190) NULL,
  owner_id INT UNSIGNED NULL,
  assignee_id INT UNSIGNED NULL,
  color VARCHAR(20) NULL,
  tags JSON NULL,
  meta JSON NULL,
  archived_at DATETIME NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_code (item_code),
  KEY idx_mp_status (status, sort_order),
  KEY idx_mp_channel (channel),
  KEY idx_mp_due (due_date),
  KEY idx_mp_owner (owner_id),
  KEY idx_mp_archived (archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Marketing Planner','marketing.planner.view','View the marketing content calendar',90 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Marketing Planner','marketing.planner.manage','Create, edit and schedule planner items',91 FROM modules WHERE slug='marketing';
