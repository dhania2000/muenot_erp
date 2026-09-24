-- =============================================================
-- SPEC 108 — Contact Management
-- =============================================================
-- Centralized contacts consumed by CRM, vendor and customer modules. A contact
-- can be a Person or a Company, carry a role/department, multiple email/phone
-- channels, social channels, multiple addresses, and be linked to any number of
-- customers/vendors with a typed relationship.
--
-- Backing model (tenant-owned; register in lib/tenant-tables.ts):
--   contacts               : the person/company master.
--   contact_channels       : emails, phones, social handles (1..n per contact).
--   contact_addresses      : multiple addresses per contact.
--   contact_relationships  : links a contact to a customer/vendor/other entity.
-- =============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  contact_type VARCHAR(10) NOT NULL DEFAULT 'person', -- person | company
  first_name VARCHAR(120) DEFAULT NULL,
  last_name VARCHAR(120) DEFAULT NULL,
  company_name VARCHAR(200) DEFAULT NULL,             -- when contact_type = company / employer
  display_name VARCHAR(255) NOT NULL,
  role VARCHAR(120) DEFAULT NULL,                     -- job title / role
  department VARCHAR(120) DEFAULT NULL,
  primary_email VARCHAR(255) DEFAULT NULL,            -- denormalized primary for search
  primary_phone VARCHAR(40) DEFAULT NULL,
  owner_id INT DEFAULT NULL,                          -- user who owns the contact
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_contacts_tenant (tenant_id),
  KEY idx_contacts_display (tenant_id, display_name),
  KEY idx_contacts_email (tenant_id, primary_email),
  KEY idx_contacts_type (tenant_id, contact_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_channels (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  channel_type VARCHAR(20) NOT NULL,           -- email | phone | mobile | whatsapp | linkedin | twitter | website | other
  label VARCHAR(40) DEFAULT NULL,              -- work | personal | billing ...
  value VARCHAR(255) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_contact_ch_tenant (tenant_id),
  KEY idx_contact_ch_contact (contact_id),
  KEY idx_contact_ch_type (tenant_id, channel_type, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_addresses (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  label VARCHAR(40) DEFAULT NULL,              -- billing | shipping | office | home
  line1 VARCHAR(255) DEFAULT NULL,
  line2 VARCHAR(255) DEFAULT NULL,
  city VARCHAR(120) DEFAULT NULL,
  state VARCHAR(120) DEFAULT NULL,
  country_code VARCHAR(2) DEFAULT NULL,
  postal_code VARCHAR(20) DEFAULT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_contact_addr_tenant (tenant_id),
  KEY idx_contact_addr_contact (contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_relationships (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  related_entity VARCHAR(40) NOT NULL,         -- customer | vendor | lead | company | employee
  related_record_id VARCHAR(64) NOT NULL,
  relationship VARCHAR(60) DEFAULT NULL,       -- primary_contact | billing | decision_maker ...
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_rel (tenant_id, contact_id, related_entity, related_record_id),
  KEY idx_contact_rel_tenant (tenant_id),
  KEY idx_contact_rel_contact (contact_id),
  KEY idx_contact_rel_entity (tenant_id, related_entity, related_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
