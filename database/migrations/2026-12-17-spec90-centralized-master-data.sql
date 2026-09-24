-- =============================================================
-- SPEC 90 — Centralized Master Data
-- =============================================================
-- Canonical schema for the enterprise master-data architecture. Every table
-- here is otherwise self-healed at runtime by `ensureMasterDataSchema()` in
-- lib/master-data/schema.ts (CREATE TABLE IF NOT EXISTS + seed-if-empty). This
-- migration documents the canonical shape and lets a fresh database be
-- provisioned up front.
--
-- Phase 1 audit (what previously duplicated each master):
--   countries / states / cities / currency / payment_terms
--                          -> free-text VARCHAR columns on `clients` and
--                             finance/HR tables (no master table anywhere).
--   cost_centre            -> free-text `cost_centre` VARCHAR on finance
--                             journal / expenses / fixed-asset tables.
--   unit                   -> free-text `unit` VARCHAR on finance_products.
--   categories             -> disjoint per-module tables (hr_support_categories,
--                             kb_categories, notice_categories, product_categories).
--   approval levels        -> embedded in company_settings config.
--   departments/designations -> hr_departments / hr_designations (kept as the
--                             source of truth; the service DELEGATES to them).
--   tax_codes              -> finance_tax_rates (kept authoritative for invoice
--                             posting; the service DELEGATES to it).
--
-- Backing model:
--   * Global shared catalogue (NO tenant_id, like modules/features):
--     md_currencies, md_countries, md_states, md_cities, md_units,
--     md_payment_terms, md_approval_levels.
--   * Tenant-owned business masters (carry tenant_id, registered in
--     lib/tenant-tables.ts and enforced by the fail-closed guard):
--     md_cost_centers, md_locations, md_categories.
--   * Shared audit trail: md_master_audit.
-- =============================================================

-- ---- Global reference catalogue -----------------------------------------

CREATE TABLE IF NOT EXISTS md_currencies (
  code VARCHAR(3) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  symbol VARCHAR(8) DEFAULT NULL,
  decimals TINYINT NOT NULL DEFAULT 2,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_countries (
  code VARCHAR(2) NOT NULL PRIMARY KEY,
  iso3 VARCHAR(3) DEFAULT NULL,
  name VARCHAR(120) NOT NULL,
  dial_code VARCHAR(8) DEFAULT NULL,
  currency_code VARCHAR(3) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_md_countries_currency (currency_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_states (
  code VARCHAR(12) NOT NULL PRIMARY KEY,
  country_code VARCHAR(2) NOT NULL,
  name VARCHAR(120) NOT NULL,
  gst_state_code VARCHAR(4) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_md_states_country (country_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_cities (
  code VARCHAR(20) NOT NULL PRIMARY KEY,
  state_code VARCHAR(12) DEFAULT NULL,
  country_code VARCHAR(2) NOT NULL,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_md_cities_state (state_code),
  KEY idx_md_cities_country (country_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_units (
  code VARCHAR(20) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  dimension VARCHAR(20) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_payment_terms (
  code VARCHAR(20) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  net_days INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_approval_levels (
  code VARCHAR(20) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  level_no INT NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Tenant-owned business masters --------------------------------------

CREATE TABLE IF NOT EXISTS md_cost_centers (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  parent_code VARCHAR(40) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_md_cc_tenant_code (tenant_id, code),
  KEY idx_md_cc_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_locations (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  city_code VARCHAR(20) DEFAULT NULL,
  state_code VARCHAR(12) DEFAULT NULL,
  country_code VARCHAR(2) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_md_loc_tenant_code (tenant_id, code),
  KEY idx_md_loc_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS md_categories (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  domain VARCHAR(40) NOT NULL DEFAULT 'general',
  code VARCHAR(60) NOT NULL,
  name VARCHAR(160) NOT NULL,
  color VARCHAR(20) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_md_cat_tenant_domain_code (tenant_id, domain, code),
  KEY idx_md_cat_tenant (tenant_id),
  KEY idx_md_cat_domain (tenant_id, domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Shared audit trail --------------------------------------------------

CREATE TABLE IF NOT EXISTS md_master_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT DEFAULT NULL,
  master_kind VARCHAR(40) NOT NULL,
  code VARCHAR(60) NOT NULL,
  action VARCHAR(20) NOT NULL,
  user_id INT DEFAULT NULL,
  old_value JSON DEFAULT NULL,
  new_value JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_mda_kind (master_kind),
  KEY idx_mda_code (master_kind, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed data (currencies, countries, Indian states + GST codes, metros, units,
-- payment terms, approval levels) is applied by seed-if-empty in
-- lib/master-data/schema.ts so it stays in one place and never double-seeds.
