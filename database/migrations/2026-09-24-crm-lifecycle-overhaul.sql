-- =============================================================
-- Sales CRM lifecycle overhaul (additive, non-destructive)
-- -------------------------------------------------------------
-- Principles:
--   * One row per lead in `sales_leads`. Won / Lost / Follow Up are
--     lifecycle STATES on that row plus outcome metadata columns.
--     There are NO copy/duplicate tables for won or lost leads.
--   * Every business rule funnels through the central service in
--     lib/sales/lead-lifecycle.ts. Nothing writes lifecycle state
--     directly.
--   * History is append-only and immutable (stage / owner history,
--     activity timeline, audit log). Rows are never physically moved
--     or deleted to represent a state change.
--
-- This file documents the target schema for fresh installs. The same
-- objects are also created/altered idempotently at runtime by
-- ensureLeadLifecycleSchema() so existing databases self-heal without
-- a manual migration step.
--
-- This script is SAFE TO RE-RUN. Column / index additions go through
-- helper procedures that check information_schema first, so a database
-- that already has some of these objects will skip them instead of
-- failing with "#1060 Duplicate column name".
-- =============================================================

-- --- Idempotent DDL helpers -----------------------------------------
DROP PROCEDURE IF EXISTS `__cl_add_column`;
DROP PROCEDURE IF EXISTS `__cl_add_key`;

DELIMITER $$

CREATE PROCEDURE `__cl_add_column`(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END $$

CREATE PROCEDURE `__cl_add_key`(
  IN p_table VARCHAR(64),
  IN p_key VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_key
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD KEY `', p_key, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- --- sales_leads: new nullable lifecycle + qualification columns ----
CALL `__cl_add_column`('sales_leads', 'company_id', "INT UNSIGNED DEFAULT NULL AFTER `company_name`");
CALL `__cl_add_column`('sales_leads', 'priority', "ENUM('Low','Medium','High','Urgent') DEFAULT NULL AFTER `lead_status`");
CALL `__cl_add_column`('sales_leads', 'estimated_value', "DECIMAL(14,2) DEFAULT NULL AFTER `priority`");
CALL `__cl_add_column`('sales_leads', 'currency', "VARCHAR(8) DEFAULT NULL AFTER `estimated_value`");
CALL `__cl_add_column`('sales_leads', 'probability', "TINYINT UNSIGNED DEFAULT NULL AFTER `currency`");
CALL `__cl_add_column`('sales_leads', 'expected_close_date', "DATE DEFAULT NULL AFTER `probability`");
CALL `__cl_add_column`('sales_leads', 'campaign', "VARCHAR(150) DEFAULT NULL AFTER `expected_close_date`");
CALL `__cl_add_column`('sales_leads', 'tags', "VARCHAR(500) DEFAULT NULL AFTER `campaign`");
CALL `__cl_add_column`('sales_leads', 'next_follow_up_at', "DATETIME DEFAULT NULL AFTER `follow_up_date`");
CALL `__cl_add_column`('sales_leads', 'won_at', "DATETIME DEFAULT NULL AFTER `tags`");
CALL `__cl_add_column`('sales_leads', 'won_value', "DECIMAL(14,2) DEFAULT NULL AFTER `won_at`");
CALL `__cl_add_column`('sales_leads', 'won_by', "INT UNSIGNED DEFAULT NULL AFTER `won_value`");
CALL `__cl_add_column`('sales_leads', 'won_notes', "TEXT DEFAULT NULL AFTER `won_by`");
CALL `__cl_add_column`('sales_leads', 'lost_at', "DATETIME DEFAULT NULL AFTER `won_notes`");
CALL `__cl_add_column`('sales_leads', 'lost_reason', "VARCHAR(120) DEFAULT NULL AFTER `lost_at`");
CALL `__cl_add_column`('sales_leads', 'lost_notes', "TEXT DEFAULT NULL AFTER `lost_reason`");
CALL `__cl_add_column`('sales_leads', 'lost_by', "INT UNSIGNED DEFAULT NULL AFTER `lost_notes`");
CALL `__cl_add_column`('sales_leads', 'reopened_at', "DATETIME DEFAULT NULL AFTER `lost_by`");
CALL `__cl_add_column`('sales_leads', 'archived_at', "DATETIME DEFAULT NULL AFTER `reopened_at`");
CALL `__cl_add_column`('sales_leads', 'row_version', "INT UNSIGNED NOT NULL DEFAULT 1 AFTER `archived_at`");

CALL `__cl_add_key`('sales_leads', 'idx_leads_company_id', '(`company_id`)');
CALL `__cl_add_key`('sales_leads', 'idx_leads_next_follow_up', '(`next_follow_up_at`)');
CALL `__cl_add_key`('sales_leads', 'idx_leads_archived', '(`archived_at`)');

-- --- Immutable stage / lifecycle history ----------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_stage_history` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED NOT NULL,
  `from_status` VARCHAR(40) DEFAULT NULL,
  `to_status` VARCHAR(40) DEFAULT NULL,
  `from_lead_status` VARCHAR(20) DEFAULT NULL,
  `to_lead_status` VARCHAR(20) DEFAULT NULL,
  `note` VARCHAR(500) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stage_hist_lead` (`lead_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Immutable owner assignment history -----------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_owner_history` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED NOT NULL,
  `from_owner` INT UNSIGNED DEFAULT NULL,
  `to_owner` INT UNSIGNED DEFAULT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_owner_hist_lead` (`lead_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Unified activity timeline --------------------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_activities` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED NOT NULL,
  `activity_type` VARCHAR(40) NOT NULL DEFAULT 'note',
  `title` VARCHAR(255) DEFAULT NULL,
  `body` TEXT DEFAULT NULL,
  `ref_type` VARCHAR(40) DEFAULT NULL,
  `ref_id` VARCHAR(64) DEFAULT NULL,
  `occurred_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_activity_lead` (`lead_id`, `occurred_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- First-class follow-up entity -----------------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_followups` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `followup_code` VARCHAR(30) DEFAULT NULL,
  `lead_id` INT UNSIGNED NOT NULL,
  `due_at` DATETIME NOT NULL,
  `channel` VARCHAR(40) DEFAULT NULL,
  `purpose` VARCHAR(255) DEFAULT NULL,
  `status` ENUM('Open','Done','Cancelled') NOT NULL DEFAULT 'Open',
  `outcome` TEXT DEFAULT NULL,
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `completed_by` INT UNSIGNED DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_followup_code` (`followup_code`),
  KEY `idx_followup_lead` (`lead_id`),
  KEY `idx_followup_status_due` (`status`, `due_at`),
  KEY `idx_followup_assignee` (`assigned_to`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Central audit log (all sales entities) -------------------------
CREATE TABLE IF NOT EXISTS `sales_audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entity_type` VARCHAR(40) NOT NULL,
  `entity_id` VARCHAR(64) NOT NULL,
  `action` VARCHAR(60) NOT NULL,
  `summary` VARCHAR(500) DEFAULT NULL,
  `meta` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_entity` (`entity_type`, `entity_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- In-app notifications -------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `type` VARCHAR(40) NOT NULL DEFAULT 'info',
  `title` VARCHAR(255) NOT NULL,
  `body` VARCHAR(500) DEFAULT NULL,
  `link` VARCHAR(255) DEFAULT NULL,
  `entity_type` VARCHAR(40) DEFAULT NULL,
  `entity_id` VARCHAR(64) DEFAULT NULL,
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`, `is_read`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Idempotency guard for lifecycle events -------------------------
CREATE TABLE IF NOT EXISTS `sales_event_dedup` (
  `event_key` VARCHAR(191) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`event_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Feature flags for the new lead views ---------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'View Follow-ups', 'sales.view_followups', 'View and manage the follow-up queue', 17
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.view_followups');

-- --- Clean up helper procedures -------------------------------------
DROP PROCEDURE IF EXISTS `__cl_add_column`;
DROP PROCEDURE IF EXISTS `__cl_add_key`;
