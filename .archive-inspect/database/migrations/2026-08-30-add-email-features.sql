-- =============================================================
-- Migration: Sales Email Templates + Email Sending + Open Tracking
-- Run this in phpMyAdmin (Hostinger) after the base schema.
-- Safe to run once. Uses IF NOT EXISTS where possible.
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: sales_email_templates
-- Reusable email templates that can be selected when emailing a lead.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_email_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `category` VARCHAR(80) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_email_templates_created_by` (`created_by`),
  CONSTRAINT `fk_email_templates_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_emails
-- One row per email sent to a lead. `tracking_token` is embedded in an
-- invisible tracking pixel so we can detect opens without the recipient
-- knowing. `open_count` / `first_opened_at` / `last_opened_at` are updated
-- when the pixel is loaded.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_emails` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED DEFAULT NULL,
  `template_id` INT UNSIGNED DEFAULT NULL,
  `to_email` VARCHAR(190) NOT NULL,
  `to_name` VARCHAR(190) DEFAULT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `tracking_token` VARCHAR(64) NOT NULL,
  `status` ENUM('Sent','Failed','Opened') NOT NULL DEFAULT 'Sent',
  `error_message` VARCHAR(500) DEFAULT NULL,
  `open_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `first_opened_at` DATETIME DEFAULT NULL,
  `last_opened_at` DATETIME DEFAULT NULL,
  `sent_by` INT UNSIGNED DEFAULT NULL,
  `sent_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_email_token` (`tracking_token`),
  KEY `idx_emails_lead` (`lead_id`),
  KEY `idx_emails_status` (`status`),
  CONSTRAINT `fk_emails_lead` FOREIGN KEY (`lead_id`) REFERENCES `sales_leads` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_emails_template` FOREIGN KEY (`template_id`) REFERENCES `sales_email_templates` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_emails_sent_by` FOREIGN KEY (`sent_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_email_events
-- Detailed log of every open event (each pixel hit) for auditing.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_email_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email_id` INT UNSIGNED NOT NULL,
  `event_type` VARCHAR(30) NOT NULL DEFAULT 'open',
  `user_agent` VARCHAR(400) DEFAULT NULL,
  `ip_address` VARCHAR(60) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_events_email` (`email_id`),
  CONSTRAINT `fk_events_email` FOREIGN KEY (`email_id`) REFERENCES `sales_emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- New Sales features (permissions). module_id = 2 is Sales.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'View Email Templates', 'sales.view_email_templates', 'View sales email templates', 13
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.view_email_templates');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'Manage Email Templates', 'sales.manage_email_templates', 'Create, edit, and delete email templates', 14
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.manage_email_templates');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'Send Emails', 'sales.send_emails', 'Send tracked emails to leads', 15
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.send_emails');

-- Seed a few starter templates (optional).
INSERT INTO `sales_email_templates` (`name`, `subject`, `body`, `category`)
SELECT * FROM (
  SELECT
    'Introduction' AS name,
    'Great to connect, {{contact_person}}' AS subject,
    '<p>Hi {{contact_person}},</p><p>Thanks for your interest in {{company_name}} working with Muenot. I''d love to show you how we can help.</p><p>Are you free for a quick call this week?</p><p>Best regards,<br/>The Muenot Team</p>' AS body,
    'Outreach' AS category
) AS t
WHERE NOT EXISTS (SELECT 1 FROM `sales_email_templates` WHERE `name` = 'Introduction');

INSERT INTO `sales_email_templates` (`name`, `subject`, `body`, `category`)
SELECT * FROM (
  SELECT
    'Follow-up' AS name,
    'Following up, {{contact_person}}' AS subject,
    '<p>Hi {{contact_person}},</p><p>Just circling back on my previous note. Do you have any questions I can help with?</p><p>Best regards,<br/>The Muenot Team</p>' AS body,
    'Follow-up' AS category
) AS t
WHERE NOT EXISTS (SELECT 1 FROM `sales_email_templates` WHERE `name` = 'Follow-up');
