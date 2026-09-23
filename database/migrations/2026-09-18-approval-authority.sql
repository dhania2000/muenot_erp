-- =============================================================================
-- Approval Authority
-- -----------------------------------------------------------------------------
-- A configurable, tenant-scoped approval-rule engine. Rules match a request by
-- module, legal entity, department, requester role, and amount range, and carry
-- an ordered set of levels. Levels run sequentially; the approvers within a
-- level combine as all / any / quorum (parallel). Delegation reroutes an
-- approver's authority; escalation adds an approver when a step goes stale.
--
-- The application self-heals these tables at runtime (lib/approval-authority.ts
-- #ensureApprovalSchema), so this migration is the canonical, idempotent record
-- of the schema. Safe to run more than once — every statement uses IF NOT
-- EXISTS and no existing table is touched.
-- =============================================================================

-- Rule header: what a rule matches on + how the winner is chosen.
CREATE TABLE IF NOT EXISTS approval_rules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  module_key VARCHAR(80) NOT NULL DEFAULT '*',
  active TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 0,
  entity_id INT UNSIGNED DEFAULT NULL,
  department VARCHAR(150) DEFAULT NULL,
  applies_role VARCHAR(150) DEFAULT NULL,
  min_amount DECIMAL(18,2) DEFAULT NULL,
  max_amount DECIMAL(18,2) DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ar_tenant_module (tenant_id, module_key),
  KEY idx_ar_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ordered approval levels belonging to a rule (sequential by level_no).
CREATE TABLE IF NOT EXISTS approval_rule_levels (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id INT UNSIGNED NOT NULL,
  level_no INT NOT NULL,
  name VARCHAR(160) DEFAULT NULL,
  mode ENUM('all','any','quorum') NOT NULL DEFAULT 'all',
  quorum INT DEFAULT NULL,
  escalate_after_hours INT DEFAULT NULL,
  escalate_to_kind ENUM('user','role','department','dynamic') DEFAULT NULL,
  escalate_to_value VARCHAR(190) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_rule_level (rule_id, level_no),
  KEY idx_arl_rule (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Approver targets on a level (user / role / department / dynamic).
CREATE TABLE IF NOT EXISTS approval_rule_level_approvers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  level_id INT UNSIGNED NOT NULL,
  kind ENUM('user','role','department','dynamic') NOT NULL,
  value VARCHAR(190) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_arla_level (level_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A live approval request raised by a business module against a record.
CREATE TABLE IF NOT EXISTS approval_requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  module_key VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) DEFAULT NULL,
  entity_pk INT UNSIGNED DEFAULT NULL,
  entity_ref VARCHAR(190) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  amount DECIMAL(18,2) DEFAULT NULL,
  department VARCHAR(150) DEFAULT NULL,
  requester_role VARCHAR(150) DEFAULT NULL,
  legal_entity_id INT UNSIGNED DEFAULT NULL,
  rule_id INT UNSIGNED DEFAULT NULL,
  status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  current_level INT DEFAULT NULL,
  requested_by INT UNSIGNED DEFAULT NULL,
  requested_by_name VARCHAR(190) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_areq_tenant_status (tenant_id, status),
  KEY idx_areq_entity (tenant_id, entity_type, entity_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-approver step state for a request. One row per resolved approver slot.
CREATE TABLE IF NOT EXISTS approval_request_steps (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  level_no INT NOT NULL,
  level_name VARCHAR(160) DEFAULT NULL,
  mode ENUM('all','any','quorum') NOT NULL DEFAULT 'all',
  quorum INT DEFAULT NULL,
  target_kind ENUM('user','role','department','dynamic') NOT NULL,
  target_value VARCHAR(190) NOT NULL,
  approver_user_id INT UNSIGNED DEFAULT NULL,
  decision ENUM('pending','approved','rejected','skipped','delegated') NOT NULL DEFAULT 'pending',
  acted_by INT UNSIGNED DEFAULT NULL,
  acted_at TIMESTAMP NULL DEFAULT NULL,
  comment VARCHAR(500) DEFAULT NULL,
  activated_at TIMESTAMP NULL DEFAULT NULL,
  is_escalation TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_ars_request (request_id),
  KEY idx_ars_approver (approver_user_id, decision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit of every action taken on a request.
CREATE TABLE IF NOT EXISTS approval_step_actions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  step_id INT UNSIGNED DEFAULT NULL,
  action ENUM('raise','approve','reject','delegate','escalate','auto_approve','cancel') NOT NULL,
  actor_id INT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(190) DEFAULT NULL,
  from_user_id INT UNSIGNED DEFAULT NULL,
  to_user_id INT UNSIGNED DEFAULT NULL,
  comment VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_asa_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Standing delegation of approval authority from one user to another.
CREATE TABLE IF NOT EXISTS approval_delegations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  from_user_id INT UNSIGNED NOT NULL,
  to_user_id INT UNSIGNED NOT NULL,
  reason VARCHAR(300) DEFAULT NULL,
  starts_at TIMESTAMP NULL DEFAULT NULL,
  ends_at TIMESTAMP NULL DEFAULT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adel_tenant (tenant_id),
  KEY idx_adel_from (tenant_id, from_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
