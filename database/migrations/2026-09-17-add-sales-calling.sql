-- =============================================================
-- Migration: Sales In-Browser Calling (Telnyx Voice / WebRTC)
-- Run this in phpMyAdmin (Hostinger) after the base schema.
-- Safe to run once. Uses IF NOT EXISTS where possible.
--
-- NOTE: If you previously ran the Twilio version of this migration,
-- rename the old column instead of recreating the table:
--   ALTER TABLE `sales_calls` CHANGE `twilio_call_sid` `telnyx_call_id` VARCHAR(64) DEFAULT NULL;
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: sales_calls
-- One row per call placed to a lead from the browser dialer.
-- `telnyx_call_id` links the row to the Telnyx call so status
-- and duration can be reconciled. `disposition` + `notes` capture
-- the outcome the employee records after hanging up.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_calls` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED DEFAULT NULL,
  `to_number` VARCHAR(40) NOT NULL,
  `to_name` VARCHAR(190) DEFAULT NULL,
  `from_number` VARCHAR(40) DEFAULT NULL,
  `telnyx_call_id` VARCHAR(64) DEFAULT NULL,
  `direction` ENUM('Outbound','Inbound') NOT NULL DEFAULT 'Outbound',
  `status` ENUM('Initiated','Ringing','In Progress','Completed','Failed','Busy','No Answer','Canceled') NOT NULL DEFAULT 'Initiated',
  `duration_seconds` INT UNSIGNED NOT NULL DEFAULT 0,
  `disposition` VARCHAR(80) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `called_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_calls_lead` (`lead_id`),
  KEY `idx_calls_status` (`status`),
  KEY `idx_calls_sid` (`telnyx_call_id`),
  CONSTRAINT `fk_calls_lead` FOREIGN KEY (`lead_id`) REFERENCES `sales_leads` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_calls_called_by` FOREIGN KEY (`called_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- New Sales feature (permission). module_id = 2 is Sales.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'Make Calls', 'sales.make_calls', 'Call leads directly from the browser', 16
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.make_calls');
