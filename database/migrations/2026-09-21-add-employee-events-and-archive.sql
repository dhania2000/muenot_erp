-- Employee lifecycle: unified audit + timeline events, import history, and
-- soft-archive support for hr_employees.
--
-- Safe to run multiple times. MariaDB syntax (ADD COLUMN IF NOT EXISTS) is used
-- to match the existing migrations in this project.

-- ---------------------------------------------------------------------------
-- Unified event log (drives both the Audit trail and the activity Timeline).
-- Intentionally has NO foreign key on employee_id: audit rows must OUTLIVE the
-- employee record so a hard delete still leaves a permanent trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `hr_employee_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT UNSIGNED NOT NULL,
  `employee_ref` VARCHAR(50) DEFAULT NULL,
  `employee_name` VARCHAR(150) DEFAULT NULL,
  `event_type` VARCHAR(60) NOT NULL,
  `summary` VARCHAR(255) NOT NULL,
  `changes` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hr_event_employee` (`employee_id`, `created_at`),
  KEY `idx_hr_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Import history — one row per bulk import run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `hr_employee_imports` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_name` VARCHAR(255) DEFAULT NULL,
  `total_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  `imported` INT UNSIGNED NOT NULL DEFAULT 0,
  `failed` INT UNSIGNED NOT NULL DEFAULT 0,
  `skipped` INT UNSIGNED NOT NULL DEFAULT 0,
  `errors` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hr_import_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Soft-archive support on the employee master.
-- ---------------------------------------------------------------------------
ALTER TABLE `hr_employees`
  ADD COLUMN IF NOT EXISTS `archived_at` DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `archived_by` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `status_changed_at` DATETIME DEFAULT NULL;

-- New feature slugs (resolve onto the existing hr.employees permission module).
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Employee Audit Trail', 'hr.view_employee_audit', 'View employee change history and timeline', 14
FROM modules WHERE slug = 'hr';
