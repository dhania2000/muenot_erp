-- =============================================================
-- Legal E-Sign Module — MySQL Schema
-- Import this file in phpMyAdmin (Hostinger) after schema.sql.
-- These tables are also auto-created at runtime by ensureEsignTables()
-- in lib/legal-esign.ts; this file lets you provision them up front.
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: legal_esign_files
-- Secure blob store for signature images AND generated PDFs.
-- Rows are served only through auth-gated / token-scoped routes.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_files`;
CREATE TABLE `legal_esign_files` (
  `id` VARCHAR(40) NOT NULL,
  `kind` VARCHAR(20) NOT NULL DEFAULT 'signature',
  `filename` VARCHAR(255) DEFAULT NULL,
  `content_type` VARCHAR(150) DEFAULT NULL,
  `size` INT UNSIGNED DEFAULT NULL,
  `data` LONGBLOB NOT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_esign_files_kind` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_signatories
-- Reusable internal (company) signatories and their saved signature.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_signatories`;
CREATE TABLE `legal_esign_signatories` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `signatory_uid` VARCHAR(40) NOT NULL,
  `employee_id` INT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(190) NOT NULL,
  `designation` VARCHAR(190) DEFAULT NULL,
  `department` VARCHAR(190) DEFAULT NULL,
  `email` VARCHAR(190) DEFAULT NULL,
  `signature_file_id` VARCHAR(40) DEFAULT NULL,
  `signature_status` VARCHAR(20) NOT NULL DEFAULT 'None',
  `status` VARCHAR(20) NOT NULL DEFAULT 'Active',
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `default_scope` VARCHAR(40) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_signatory_uid` (`signatory_uid`),
  KEY `idx_signatory_employee` (`employee_id`),
  KEY `idx_signatory_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_signatory_versions
-- Audit history of saved-signature changes per signatory.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_signatory_versions`;
CREATE TABLE `legal_esign_signatory_versions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `signatory_id` INT UNSIGNED NOT NULL,
  `signature_file_id` VARCHAR(40) DEFAULT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sig_version_signatory` (`signatory_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_requests
-- One signing request (envelope) per document.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_requests`;
CREATE TABLE `legal_esign_requests` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_uid` VARCHAR(40) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `document_source` VARCHAR(40) NOT NULL DEFAULT 'contract',
  `contract_id` INT UNSIGNED DEFAULT NULL,
  `template_id` INT UNSIGNED DEFAULT NULL,
  `template_version` INT UNSIGNED DEFAULT NULL,
  `source_module` VARCHAR(40) DEFAULT NULL,
  `source_record_id` VARCHAR(64) DEFAULT NULL,
  `signing_type` VARCHAR(12) NOT NULL DEFAULT 'sequential',
  `status` VARCHAR(24) NOT NULL DEFAULT 'Draft',
  `due_date` DATE DEFAULT NULL,
  `message` TEXT DEFAULT NULL,
  `auto_email_signed` TINYINT(1) NOT NULL DEFAULT 0,
  `require_confirm` TINYINT(1) NOT NULL DEFAULT 1,
  `base_file_id` VARCHAR(40) DEFAULT NULL,
  `signed_file_id` VARCHAR(40) DEFAULT NULL,
  `cancel_reason` VARCHAR(500) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `sent_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_request_uid` (`request_uid`),
  KEY `idx_request_status` (`status`),
  KEY `idx_request_contract` (`contract_id`),
  KEY `idx_request_source` (`document_source`, `source_record_id`),
  KEY `idx_request_due` (`due_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_signers
-- Individual signers on a request, with hashed single-use tokens.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_signers`;
CREATE TABLE `legal_esign_signers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` INT UNSIGNED NOT NULL,
  `signer_uid` VARCHAR(40) NOT NULL,
  `signer_type` VARCHAR(30) NOT NULL,
  `ref_id` VARCHAR(64) DEFAULT NULL,
  `signatory_id` INT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(190) NOT NULL,
  `email` VARCHAR(190) NOT NULL,
  `mobile` VARCHAR(40) DEFAULT NULL,
  `role` VARCHAR(80) DEFAULT NULL,
  `signing_order` INT NOT NULL DEFAULT 1,
  `status` VARCHAR(20) NOT NULL DEFAULT 'Pending',
  `token_hash` VARCHAR(64) DEFAULT NULL,
  `token_expires_at` DATETIME DEFAULT NULL,
  `token_used` TINYINT(1) NOT NULL DEFAULT 0,
  `signature_method` VARCHAR(20) DEFAULT NULL,
  `signature_file_id` VARCHAR(40) DEFAULT NULL,
  `viewed_at` DATETIME DEFAULT NULL,
  `signed_at` DATETIME DEFAULT NULL,
  `rejected_at` DATETIME DEFAULT NULL,
  `reject_reason` VARCHAR(500) DEFAULT NULL,
  `sign_ip` VARCHAR(60) DEFAULT NULL,
  `sign_user_agent` VARCHAR(400) DEFAULT NULL,
  `confirmed` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_signer_uid` (`signer_uid`),
  KEY `idx_signer_request` (`request_id`),
  KEY `idx_signer_token` (`token_hash`),
  KEY `idx_signer_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_fields
-- Placed signature/date/text fields per signer on the document.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_fields`;
CREATE TABLE `legal_esign_fields` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` INT UNSIGNED NOT NULL,
  `signer_id` INT UNSIGNED NOT NULL,
  `field_type` VARCHAR(20) NOT NULL,
  `page` INT NOT NULL DEFAULT 1,
  `pos_x` FLOAT NOT NULL DEFAULT 0,
  `pos_y` FLOAT NOT NULL DEFAULT 0,
  `width` FLOAT NOT NULL DEFAULT 0.22,
  `height` FLOAT NOT NULL DEFAULT 0.06,
  `value` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_field_request` (`request_id`),
  KEY `idx_field_signer` (`signer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_events
-- Immutable audit trail for every request/signer action.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_events`;
CREATE TABLE `legal_esign_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` INT UNSIGNED NOT NULL,
  `signer_id` INT UNSIGNED DEFAULT NULL,
  `event_type` VARCHAR(60) NOT NULL,
  `summary` VARCHAR(300) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `ip` VARCHAR(60) DEFAULT NULL,
  `user_agent` VARCHAR(400) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_event_request` (`request_id`, `created_at`),
  KEY `idx_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: legal_esign_reminders
-- Cron reminder ledger — one row per (signer, reminder key) keeps
-- repeated cron runs idempotent.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `legal_esign_reminders`;
CREATE TABLE `legal_esign_reminders` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` INT UNSIGNED NOT NULL,
  `signer_id` INT UNSIGNED NOT NULL,
  `reminder_key` VARCHAR(40) NOT NULL,
  `sent_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_reminder` (`signer_id`, `reminder_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
