-- Legal Contracts — Template Master, Variable Master, Generated Contracts,
-- audit trail and reminder ledger.
--
-- This mirrors lib/legal-contracts-db.ts (ensureContractTables),
-- lib/legal-contracts-audit.ts (ensureContractEventsSchema) and
-- lib/legal-contracts-scheduler.ts (ensureReminderLedger) so the module works
-- once this migration is applied by hand on Hostinger. Every statement is
-- idempotent (CREATE TABLE IF NOT EXISTS / INSERT IGNORE) and additive only —
-- it never drops or narrows an existing column.

-- ---------------------------------------------------------------------------
-- Contract template master
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_uid VARCHAR(40) NULL,
  name VARCHAR(190) NOT NULL,
  contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
  category VARCHAR(40) NOT NULL DEFAULT 'Other',
  description VARCHAR(600) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  content LONGTEXT NOT NULL,
  required_variables JSON NULL,
  owner_id BIGINT UNSIGNED NULL,
  usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  review_date DATE NULL,
  expiry_date DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contract_template_uid (template_uid),
  KEY idx_contract_template_status (status),
  KEY idx_contract_template_type (contract_type),
  KEY idx_contract_template_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Template version history (never overwrite an approved historical version)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_template_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
  category VARCHAR(40) NOT NULL DEFAULT 'Other',
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  content LONGTEXT NOT NULL,
  change_note VARCHAR(500) NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_contract_tpl_ver (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Variable master (configurable, in addition to the built-in catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_variables (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  var_key VARCHAR(80) NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  data_source VARCHAR(40) NOT NULL DEFAULT 'manual',
  field VARCHAR(120) NULL,
  grp VARCHAR(60) NOT NULL DEFAULT 'General',
  required TINYINT(1) NOT NULL DEFAULT 0,
  description VARCHAR(400) NULL,
  example_value VARCHAR(190) NULL,
  is_builtin TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contract_var_key (var_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Generated contracts (actual documents produced from a template)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_generated_contracts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_uid VARCHAR(40) NOT NULL,
  reference_no VARCHAR(60) NULL,
  title VARCHAR(220) NOT NULL,
  template_id BIGINT UNSIGNED NULL,
  template_version INT UNSIGNED NULL,
  contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
  category VARCHAR(40) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  source_ref VARCHAR(80) NULL,
  party_type VARCHAR(40) NULL,
  party_name VARCHAR(190) NULL,
  party_id VARCHAR(80) NULL,
  content LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Generated',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  effective_date DATE NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  renewal_date DATE NULL,
  document_id INT UNSIGNED NULL,
  variables_snapshot JSON NULL,
  supersedes_id BIGINT UNSIGNED NULL,
  superseded_by BIGINT UNSIGNED NULL,
  dedupe_key VARCHAR(190) NULL,
  generated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_generated_contract_uid (contract_uid),
  UNIQUE KEY uq_generated_contract_reference (reference_no),
  UNIQUE KEY uq_generated_contract_dedupe (dedupe_key),
  KEY idx_generated_contract_status (status),
  KEY idx_generated_contract_source (source, source_ref),
  KEY idx_generated_contract_template (template_id, template_version),
  KEY idx_generated_contract_expiry (end_date),
  KEY idx_generated_contract_renewal (renewal_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Audit trail — one row per meaningful action on a template or contract
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type VARCHAR(20) NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  entity_ref VARCHAR(60) DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(300) NOT NULL,
  detail JSON DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_legal_event_entity (entity_type, entity_id, created_at),
  KEY idx_legal_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Reminder ledger — makes the cron scheduler idempotent. Each reminder that
-- has already fired stores its dedupe key here so a re-run never double-sends.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_reminders (
  dedupe_key VARCHAR(190) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dedupe_key),
  KEY idx_legal_reminder_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Sidebar features (RBAC-gated, like the rest of the Legal module)
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Contract Templates', 'legal.view_contract_templates', 'Create and manage contract templates', 3
  FROM modules WHERE slug = 'legal';

-- ---------------------------------------------------------------------------
-- Seed a handful of built-in variables so the Variable Master is not empty.
-- The application also ships a code-level catalog (legal-contracts-shared.ts);
-- these rows simply make the configurable master usable out of the box.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO legal_contract_variables (var_key, display_name, data_source, grp, required, description, example_value, is_builtin) VALUES
  ('company_name', 'Company name', 'company', 'Company', 1, 'Registered company name', 'Muenot Technologies Pvt Ltd', 1),
  ('company_gstin', 'Company GSTIN', 'company', 'Company', 0, 'Company GST identification number', '29ABCDE1234F1Z5', 1),
  ('authorized_signatory', 'Authorized signatory', 'company', 'Company', 0, 'Person signing for the company', 'Sandeep Kumar', 1),
  ('employee_name', 'Employee name', 'employee', 'Employee', 1, 'Full name of the employee', 'Sandeep Kumar', 1),
  ('designation', 'Designation', 'employee', 'Employee', 0, 'Employee designation', 'Software Engineer', 1),
  ('joining_date', 'Joining date', 'employee', 'Employee', 0, 'Date of joining', '01 April 2026', 1),
  ('client_name', 'Client contact name', 'client', 'Client', 0, 'Primary client contact', 'Acme Corp', 1),
  ('client_gstin', 'Client GSTIN', 'client', 'Client', 0, 'Client GST identification number', '27AACCA1234A1Z2', 1),
  ('vendor_name', 'Vendor name', 'vendor', 'Vendor', 0, 'Vendor legal / trade name', 'Globex Supplies', 1),
  ('contract_start_date', 'Start date', 'contract', 'Contract', 0, 'Contract start date', '01 April 2026', 1),
  ('contract_end_date', 'End date', 'contract', 'Contract', 0, 'Contract end date', '31 March 2027', 1);
