-- Knowledge Base (matches Worksuite /account/knowledgebase)
-- Help articles grouped by category and addressed to employees or clients.
CREATE TABLE IF NOT EXISTS kb_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_category_name (name)
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  heading VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category_id INT NULL,
  to_type ENUM('employees','clients') NOT NULL DEFAULT 'employees',
  created_by INT NULL,
  created_by_name VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_kb_articles_to_type (to_type),
  INDEX idx_kb_articles_category (category_id),
  CONSTRAINT fk_kb_article_category FOREIGN KEY (category_id) REFERENCES kb_categories (id) ON DELETE SET NULL
);

-- Feature: manage (create/edit/delete) articles and categories. The base
-- "knowledge-base.view" feature is already seeded by the workspace-modules migration.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage knowledge base', 'knowledge-base.manage', 'Create, edit and delete articles and categories', 93
FROM modules WHERE slug = 'knowledge-base';
