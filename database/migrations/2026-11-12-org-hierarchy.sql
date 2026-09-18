-- SPEC 6 — Organization hierarchy.
-- ---------------------------------------------------------------------------
-- One self-referential tree of typed org units per tenant, plus a user↔unit
-- assignment layer and a change log. Complements (does not replace) the HR
-- hr_departments / hr_designations trees and the finance cost-centre field.
--
-- All three tables are tenant-owned (lib/tenant-tables.ts): the runtime
-- self-heal in lib/org-hierarchy.ts#ensureOrgSchema mirrors this file so
-- existing databases converge without a manual migration step.

CREATE TABLE IF NOT EXISTS org_units (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  unit_code VARCHAR(40) NOT NULL,
  name VARCHAR(180) NOT NULL,
  unit_type ENUM(
    'organization','legal_entity','group','business_unit','division',
    'department','team','branch','location','cost_center','profit_center'
  ) NOT NULL,
  parent_id INT UNSIGNED DEFAULT NULL,
  -- Materialized path of ids ("/1/4/9/") for single-index subtree queries.
  path VARCHAR(600) NOT NULL DEFAULT '',
  depth INT UNSIGNED NOT NULL DEFAULT 0,
  head_user_id INT UNSIGNED DEFAULT NULL,
  external_code VARCHAR(80) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  archived_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_units_tenant_code (tenant_id, unit_code),
  KEY idx_org_units_tenant (tenant_id),
  KEY idx_org_units_parent (parent_id),
  KEY idx_org_units_type (unit_type),
  KEY idx_org_units_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS org_unit_assignments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  org_unit_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  assignment_title VARCHAR(150) DEFAULT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_assignment (tenant_id, org_unit_id, user_id),
  KEY idx_org_assignment_tenant (tenant_id),
  KEY idx_org_assignment_unit (org_unit_id),
  KEY idx_org_assignment_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS org_unit_change_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  org_unit_id INT UNSIGNED DEFAULT NULL,
  action VARCHAR(40) NOT NULL,
  actor_user_id INT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(180) DEFAULT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_org_change_tenant (tenant_id),
  KEY idx_org_change_unit (org_unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cross-module integration: reference an org unit from HR employees and the
-- finance journal for hierarchy-aware HR / Finance / reporting slices.
-- Additive + nullable so existing rows and code paths are unaffected.
ALTER TABLE hr_employees ADD COLUMN org_unit_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_employees ADD KEY idx_hr_employees_org_unit (org_unit_id);
ALTER TABLE journal_entries ADD COLUMN org_unit_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE journal_entries ADD KEY idx_journal_entries_org_unit (org_unit_id);
