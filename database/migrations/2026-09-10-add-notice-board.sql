-- Notice Board (matches Worksuite /account/notices)
-- Company announcements addressed to employees or clients, optionally scoped to a department.
CREATE TABLE IF NOT EXISTS notices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  heading VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  to_type ENUM('employees','clients') NOT NULL DEFAULT 'employees',
  department VARCHAR(150) NULL,
  created_by INT NULL,
  created_by_name VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_notices_to_type (to_type),
  INDEX idx_notices_created (created_at)
);

-- Feature: manage (create/edit/delete) notices. The base "notice-board.view" feature
-- is already seeded by the workspace-modules migration for read access.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage notices', 'notice-board.manage', 'Create, edit and delete company notices', 93
FROM modules WHERE slug = 'notice-board';
