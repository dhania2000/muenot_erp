-- =============================================================
-- Migration: Recruitment In-Browser Calling (Telnyx Voice / WebRTC)
-- Run this in phpMyAdmin (Hostinger) after the base schema and the
-- Worksuite recruit module migration.
-- Safe to run once. Uses IF NOT EXISTS where possible.
-- Uses the same Telnyx credentials as Sales — no extra config is required.
--
-- NOTE: If you previously ran the Twilio version of this migration,
-- rename the old column instead of recreating the table:
--   ALTER TABLE `recruit_calls` CHANGE `twilio_call_sid` `telnyx_call_id` VARCHAR(64) DEFAULT NULL;
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: recruit_calls
-- One row per call placed to an applicant from the browser dialer.
-- `application_id` links the call to a recruit_applications row when
-- available (calls from the Candidate Database aggregate view leave it
-- NULL). `disposition` + `notes` capture the outcome the recruiter
-- records after hanging up.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `recruit_calls` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `application_id` INT UNSIGNED DEFAULT NULL,
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
  KEY `idx_recruit_calls_app` (`application_id`),
  KEY `idx_recruit_calls_status` (`status`),
  KEY `idx_recruit_calls_sid` (`telnyx_call_id`),
  CONSTRAINT `fk_recruit_calls_app` FOREIGN KEY (`application_id`) REFERENCES `recruit_applications` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_recruit_calls_called_by` FOREIGN KEY (`called_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- New Recruitment feature (permission), attached to the recruitment module.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Make Calls', 'recruitment.make_calls', 'Call applicants directly from the browser', 9
FROM `modules` WHERE `slug` = 'recruitment'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'recruitment.make_calls');
