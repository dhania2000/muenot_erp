-- SPEC 7 — Multi-entity support.
-- ---------------------------------------------------------------------------
-- Lets a SINGLE tenant operate multiple legal / business entities, each with
-- its own tax identity (GST/VAT), bank accounts, accounting book and address,
-- while still rolling everything up into consolidated reporting.
--
-- This file is the canonical migration; lib/legal-entities.ts ships an
-- idempotent self-heal (ensureEntitySchema) that mirrors it exactly so a fresh
-- tenant is provisioned on first use even before this runs. Everything here is
-- additive and safe to re-run (IF NOT EXISTS / additive ALTERs).

CREATE TABLE IF NOT EXISTS legal_entities (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  entity_code VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  legal_name VARCHAR(190) DEFAULT NULL,
  entity_type VARCHAR(40) NOT NULL DEFAULT 'private_limited',
  registration_no VARCHAR(80) DEFAULT NULL,
  tax_name VARCHAR(40) DEFAULT NULL,
  tax_number VARCHAR(60) DEFAULT NULL,
  secondary_tax_name VARCHAR(40) DEFAULT NULL,
  secondary_tax_number VARCHAR(60) DEFAULT NULL,
  base_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  book_name VARCHAR(120) DEFAULT NULL,
  email VARCHAR(190) DEFAULT NULL,
  phone VARCHAR(40) DEFAULT NULL,
  address_line VARCHAR(255) DEFAULT NULL,
  city VARCHAR(120) DEFAULT NULL,
  state VARCHAR(120) DEFAULT NULL,
  postal_code VARCHAR(30) DEFAULT NULL,
  country VARCHAR(120) DEFAULT NULL,
  org_unit_id INT UNSIGNED DEFAULT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_entities_tenant_code (tenant_id, entity_code),
  KEY idx_legal_entities_tenant (tenant_id),
  KEY idx_legal_entities_org_unit (org_unit_id),
  KEY idx_legal_entities_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS legal_entity_bank_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  entity_id INT UNSIGNED NOT NULL,
  account_name VARCHAR(190) NOT NULL,
  bank_name VARCHAR(190) DEFAULT NULL,
  account_no VARCHAR(60) DEFAULT NULL,
  ifsc_swift VARCHAR(40) DEFAULT NULL,
  branch VARCHAR(190) DEFAULT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  account_type VARCHAR(40) DEFAULT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_entity_bank_tenant (tenant_id),
  KEY idx_entity_bank_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS intercompany_transactions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  txn_code VARCHAR(40) NOT NULL,
  from_entity_id INT UNSIGNED NOT NULL,
  to_entity_id INT UNSIGNED NOT NULL,
  txn_date DATE DEFAULT NULL,
  amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  category VARCHAR(80) DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  reference_no VARCHAR(120) DEFAULT NULL,
  status ENUM('draft','posted','settled','cancelled') NOT NULL DEFAULT 'draft',
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_intercompany_tenant_code (tenant_id, txn_code),
  KEY idx_intercompany_tenant (tenant_id),
  KEY idx_intercompany_from (from_entity_id),
  KEY idx_intercompany_to (to_entity_id),
  KEY idx_intercompany_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Thread entity context onto finance ledgers + documents. Additive + nullable
-- so every existing posted row keeps working (entity_id NULL => "Unassigned").
-- These mirror ENTITY_LINKED_TABLES in lib/legal-entities.ts. Guarded ALTERs
-- (MySQL lacks ADD COLUMN IF NOT EXISTS on older versions; the app self-heal
-- checks information_schema before altering).
ALTER TABLE journal_entries  ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_journal_entries_entity (entity_id);
ALTER TABLE general_ledger   ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_general_ledger_entity (entity_id);
ALTER TABLE finance_accounts ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_finance_accounts_entity (entity_id);
ALTER TABLE finance_records  ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_finance_records_entity (entity_id);
ALTER TABLE sales_invoices   ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_sales_invoices_entity (entity_id);
ALTER TABLE purchase_bills   ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_purchase_bills_entity (entity_id);
ALTER TABLE expenses         ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_expenses_entity (entity_id);
