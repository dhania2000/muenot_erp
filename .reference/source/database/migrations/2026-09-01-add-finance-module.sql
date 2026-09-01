CREATE TABLE IF NOT EXISTS finance_records (
  record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_key VARCHAR(40) NOT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  record_date DATE DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  record_type VARCHAR(80) DEFAULT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(40) NOT NULL DEFAULT 'Draft',
  description TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (record_id), KEY idx_finance_module (module_key), KEY idx_finance_date (record_date), KEY idx_finance_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'Finance', 'finance', 'Billing, expenses, banking, and finance masters.', 'wallet', 2 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'finance');
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Finance', 'finance.view_dashboard', 'View finance module', 1 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Manage Finance', 'finance.manage_records', 'Create and edit finance records', 2 FROM modules WHERE slug = 'finance';
