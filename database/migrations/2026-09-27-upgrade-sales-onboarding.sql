-- =============================================================
-- Client Onboarding (Implementation / Activation) upgrade
-- (additive, non-destructive)
-- -------------------------------------------------------------
-- Turns the simple `sales_onboarding` table into a relational
-- client-implementation lifecycle:
--   * Free-text company / contract / owner become real foreign keys
--     (company_id, contract_id, quotation_id, lead_id, contact_id,
--      owner_id, kickoff_meeting_id) into the canonical Sales masters.
--   * Adds planning + lifecycle fields (priority, health, progress_pct,
--     target/actual completion, go-live, hold/block/cancel, handover).
--   * Adds optimistic-concurrency (row_version) and soft-archive
--     (archived_at) so records are never hard-deleted by default.
--   * Adds lightweight owned sub-entities (checklist, tasks, milestones,
--     documents, risks/blockers, team) plus append-only activity + history
--     and reusable onboarding templates.
--   * Links `sales_meetings.onboarding_id` so a kickoff traces both ways.
--   * Onboarding codes continue the legacy `OB-###` sequence race-safely
--     through `record_id_sequences` (prefix OB) — never MAX()+1.
--
-- This file documents the target schema for fresh installs. The SAME
-- objects are created/altered idempotently at runtime by
-- ensureOnboardingSchema() in lib/sales/onboarding-service.ts, so existing
-- databases self-heal without running this migration by hand.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so
-- each column / key change goes through helper procedures that first
-- check information_schema and skip anything that already exists
-- (mirrors addColumnIfMissing / addKeyIfMissing in the service).
-- =============================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS `__ob_add_column` $$
CREATE PROCEDURE `__ob_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__ob_add_key` $$
CREATE PROCEDURE `__ob_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- -------------------------------------------------------------
-- 1. New columns on sales_onboarding
-- -------------------------------------------------------------

-- Relational linkage
CALL __ob_add_column('sales_onboarding', 'company_id',          '`company_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contact_id',          '`contact_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contract_id',         '`contract_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'quotation_id',        '`quotation_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'lead_id',             '`lead_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'owner_id',            '`owner_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'kickoff_meeting_id',  '`kickoff_meeting_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'template_id',         '`template_id` INT UNSIGNED DEFAULT NULL');

-- Denormalized display fields (kept in sync from the resolved relations)
CALL __ob_add_column('sales_onboarding', 'contact_person',      '`contact_person` VARCHAR(150) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contract_code',       '`contract_code` VARCHAR(40) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'currency',            '`currency` VARCHAR(8) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contract_value',      '`contract_value` DECIMAL(14,2) DEFAULT NULL');

-- Planning + lifecycle
CALL __ob_add_column('sales_onboarding', 'priority',                "`priority` ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium'");
CALL __ob_add_column('sales_onboarding', 'health',                  "`health` ENUM('Healthy','At Risk','Blocked') NOT NULL DEFAULT 'Healthy'");
CALL __ob_add_column('sales_onboarding', 'progress_pct',            '`progress_pct` TINYINT UNSIGNED NOT NULL DEFAULT 0');
CALL __ob_add_column('sales_onboarding', 'target_completion_date',  '`target_completion_date` DATE DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'completed_at',            '`completed_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'completed_by',            '`completed_by` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'go_live_date',            '`go_live_date` DATE DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'go_live_notes',           '`go_live_notes` TEXT DEFAULT NULL');

-- Hold / block / cancel
CALL __ob_add_column('sales_onboarding', 'hold_reason',            '`hold_reason` VARCHAR(255) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'hold_since',             '`hold_since` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'expected_resume_date',   '`expected_resume_date` DATE DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'blocked_reason',         '`blocked_reason` VARCHAR(255) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'blocked_since',          '`blocked_since` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'cancel_reason',          '`cancel_reason` VARCHAR(255) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'cancelled_at',           '`cancelled_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'cancelled_by',           '`cancelled_by` INT UNSIGNED DEFAULT NULL');

-- Handover
CALL __ob_add_column('sales_onboarding', 'handover_to_id',         '`handover_to_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'handover_at',            '`handover_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'handover_notes',         '`handover_notes` TEXT DEFAULT NULL');

-- Notes / scope
CALL __ob_add_column('sales_onboarding', 'requirements_summary',   '`requirements_summary` TEXT DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'scope_notes',            '`scope_notes` TEXT DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'internal_notes',         '`internal_notes` TEXT DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'customer_notes',         '`customer_notes` TEXT DEFAULT NULL');

-- Concurrency + soft archive + authorship
CALL __ob_add_column('sales_onboarding', 'row_version',            '`row_version` INT UNSIGNED NOT NULL DEFAULT 1');
CALL __ob_add_column('sales_onboarding', 'archived_at',            '`archived_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'created_by',             '`created_by` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'updated_by',             '`updated_by` INT UNSIGNED DEFAULT NULL');

-- Widen the legacy stage/status ENUMs to free-form vocabularies (keeps old values).
ALTER TABLE `sales_onboarding` MODIFY `current_stage` VARCHAR(40) NOT NULL DEFAULT 'Planning';
ALTER TABLE `sales_onboarding` MODIFY `status` VARCHAR(20) NOT NULL DEFAULT 'Not Started';

-- Indexes for the common list filters.
CALL __ob_add_key('sales_onboarding', 'idx_ob_company',  'KEY `idx_ob_company` (`company_id`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_contract', 'KEY `idx_ob_contract` (`contract_id`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_status',   'KEY `idx_ob_status` (`status`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_owner',    'KEY `idx_ob_owner` (`owner_id`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_archived', 'KEY `idx_ob_archived` (`archived_at`)');

-- Kickoff meetings link back to onboarding.
CALL __ob_add_column('sales_meetings', 'onboarding_id', '`onboarding_id` INT UNSIGNED DEFAULT NULL');

-- -------------------------------------------------------------
-- 2. Owned sub-entities, timeline, history, templates
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `sales_onboarding_checklist` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `stage` VARCHAR(40) DEFAULT NULL,
  `is_required` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('Pending','In Progress','Done','N/A') NOT NULL DEFAULT 'Pending',
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_checklist_ob` (`onboarding_id`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_tasks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('Open','In Progress','Done','Cancelled') NOT NULL DEFAULT 'Open',
  `priority` ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_tasks_ob` (`onboarding_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_milestones` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('Pending','In Progress','Done','Missed') NOT NULL DEFAULT 'Pending',
  `due_date` DATE DEFAULT NULL,
  `completed_date` DATE DEFAULT NULL,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_milestones_ob` (`onboarding_id`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_documents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `doc_status` ENUM('Requested','Received','Verified','Rejected','N/A') NOT NULL DEFAULT 'Requested',
  `is_required` TINYINT(1) NOT NULL DEFAULT 0,
  `file_url` VARCHAR(500) DEFAULT NULL,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `verified_by` INT UNSIGNED DEFAULT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_docs_ob` (`onboarding_id`, `doc_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_risks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `kind` ENUM('Risk','Blocker') NOT NULL DEFAULT 'Risk',
  `severity` ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium',
  `status` ENUM('Open','Mitigating','Resolved') NOT NULL DEFAULT 'Open',
  `mitigation` TEXT DEFAULT NULL,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `opened_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` DATETIME DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_risks_ob` (`onboarding_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_team` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `role` VARCHAR(80) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ob_team` (`onboarding_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_activities` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `activity_type` VARCHAR(40) NOT NULL DEFAULT 'note',
  `title` VARCHAR(255) DEFAULT NULL,
  `body` TEXT DEFAULT NULL,
  `ref_type` VARCHAR(40) DEFAULT NULL,
  `ref_id` VARCHAR(64) DEFAULT NULL,
  `occurred_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_activity` (`onboarding_id`, `occurred_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_history` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `field` VARCHAR(40) NOT NULL,
  `from_value` VARCHAR(255) DEFAULT NULL,
  `to_value` VARCHAR(255) DEFAULT NULL,
  `note` VARCHAR(500) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_history` (`onboarding_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `checklist` JSON DEFAULT NULL,
  `milestones` JSON DEFAULT NULL,
  `documents` JSON DEFAULT NULL,
  `tasks` JSON DEFAULT NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ob_template_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- 3. Race-safe numbering (prefix OB) seeded from the legacy MAX
-- -------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number)
SELECT 'OB', COALESCE(MAX(CAST(REGEXP_REPLACE(onboarding_code, '^[^0-9]*', '') AS UNSIGNED)), 0)
FROM sales_onboarding
WHERE onboarding_code REGEXP '^OB-?[0-9]+$'
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

-- -------------------------------------------------------------
-- 4. Default onboarding template (only when none exist)
-- -------------------------------------------------------------
INSERT INTO `sales_onboarding_templates` (name, description, checklist, milestones, documents, tasks)
SELECT
  'Standard Implementation',
  'Default onboarding playbook for new client implementations.',
  JSON_ARRAY(
    JSON_OBJECT('title','Signed contract received','stage','Planning','is_required',1),
    JSON_OBJECT('title','Kickoff meeting scheduled','stage','Kickoff','is_required',1),
    JSON_OBJECT('title','Requirements gathered','stage','Setup','is_required',1),
    JSON_OBJECT('title','Environment provisioned','stage','Configuration','is_required',1),
    JSON_OBJECT('title','Data migration complete','stage','Integration','is_required',0),
    JSON_OBJECT('title','User training delivered','stage','Training','is_required',1),
    JSON_OBJECT('title','UAT sign-off','stage','UAT','is_required',1),
    JSON_OBJECT('title','Go-live checklist confirmed','stage','Go-Live','is_required',1)
  ),
  JSON_ARRAY(
    JSON_OBJECT('name','Kickoff complete'),
    JSON_OBJECT('name','Configuration complete'),
    JSON_OBJECT('name','Go-live')
  ),
  JSON_ARRAY(
    JSON_OBJECT('name','Signed contract','is_required',1),
    JSON_OBJECT('name','Requirements document','is_required',1),
    JSON_OBJECT('name','UAT sign-off','is_required',1)
  ),
  JSON_ARRAY()
WHERE NOT EXISTS (SELECT 1 FROM `sales_onboarding_templates`);

-- -------------------------------------------------------------
-- 5. Clean up helper procedures
-- -------------------------------------------------------------
DROP PROCEDURE IF EXISTS `__ob_add_column`;
DROP PROCEDURE IF EXISTS `__ob_add_key`;
