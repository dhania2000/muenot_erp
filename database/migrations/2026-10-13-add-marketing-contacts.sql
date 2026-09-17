-- Marketing > Contacts
-- Mirrors ensureContactSchema() in lib/marketing/contacts-db.ts
-- Contacts, tags, activity timeline, and segments.

CREATE TABLE IF NOT EXISTS marketing_contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_code VARCHAR(40) NOT NULL,
  first_name VARCHAR(120) NULL,
  last_name VARCHAR(120) NULL,
  full_name VARCHAR(190) NOT NULL,
  email VARCHAR(190) NULL,
  email_normalized VARCHAR(190) NULL,
  phone VARCHAR(40) NULL,
  phone_normalized VARCHAR(40) NULL,
  company_name VARCHAR(190) NULL,
  job_title VARCHAR(150) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'Manual',
  lifecycle_stage VARCHAR(30) NOT NULL DEFAULT 'Subscriber',
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  owner_id INT UNSIGNED NULL,
  client_id BIGINT UNSIGNED NULL,
  lead_id BIGINT UNSIGNED NULL,
  email_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Subscribed',
  whatsapp_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending',
  sms_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending',
  consent TINYINT(1) NOT NULL DEFAULT 0,
  consent_source VARCHAR(120) NULL,
  consent_at DATETIME NULL,
  deliverability ENUM('Unknown','Deliverable','Risky','Bounced','Complained') NOT NULL DEFAULT 'Unknown',
  bounce_count INT UNSIGNED NOT NULL DEFAULT 0,
  lead_score INT NOT NULL DEFAULT 0,
  address VARCHAR(255) NULL,
  city VARCHAR(120) NULL,
  state VARCHAR(120) NULL,
  country VARCHAR(120) NULL,
  postal_code VARCHAR(30) NULL,
  language VARCHAR(40) NULL,
  timezone VARCHAR(60) NULL,
  last_activity_at DATETIME NULL,
  last_campaign_at DATETIME NULL,
  notes TEXT NULL,
  archived_at DATETIME NULL,
  archived_by INT UNSIGNED NULL,
  merged_into_id BIGINT UNSIGNED NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_code (contact_code),
  KEY idx_mc_name (full_name),
  KEY idx_mc_email (email_normalized),
  KEY idx_mc_phone (phone_normalized),
  KEY idx_mc_status (status),
  KEY idx_mc_stage (lifecycle_stage),
  KEY idx_mc_owner (owner_id),
  KEY idx_mc_client (client_id),
  KEY idx_mc_lead (lead_id),
  KEY idx_mc_archived (archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_contact_tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  tag VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_tag (contact_id, tag),
  KEY idx_mct_tag (tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_contact_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  contact_code VARCHAR(40) NULL,
  type VARCHAR(40) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  meta JSON NULL,
  actor_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_mca_contact (contact_id),
  KEY idx_mca_type (type),
  KEY idx_mca_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_segments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  segment_code VARCHAR(40) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(255) NULL,
  type ENUM('Static','Dynamic') NOT NULL DEFAULT 'Static',
  rules JSON NULL,
  color VARCHAR(20) NULL,
  created_by INT UNSIGNED NULL,
  archived_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_segment_code (segment_code),
  KEY idx_seg_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_segment_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  segment_id BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  added_by INT UNSIGNED NULL,
  added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_segment_member (segment_id, contact_id),
  KEY idx_sm_contact (contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Contacts','marketing.contacts.view','View marketing contacts and segments',70 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Contacts','marketing.contacts.manage','Add, edit, import and merge marketing contacts',71 FROM modules WHERE slug='marketing';
