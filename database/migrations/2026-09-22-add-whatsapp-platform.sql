-- =============================================================
-- Migration: WhatsApp multi-agent platform (AiSensy-style)
-- Run in phpMyAdmin (Hostinger) AFTER
-- 2026-09-21-add-whatsapp-shared-inbox.sql.
--
-- Adds the full platform layer on top of the existing shared-inbox tables so
-- ONE WhatsApp Business number (+91 63778 09826) can be worked by MANY ERP
-- agents across MANY departments, with routing, templates, campaigns,
-- audiences, automations, internal notes, media metadata and analytics.
--
-- Nothing here touches coexistence, the WhatsApp Business App, or calls
-- /register. It is purely ERP-side collaboration + marketing metadata.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / IF EXISTS guards (MariaDB
-- 10.x extensions, which Hostinger runs). The runtime self-heal in
-- lib/whatsapp-platform.ts mirrors these tables/columns so a deployment that
-- has not imported this SQL yet still works. This file is the canonical,
-- reviewable definition.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Departments / teams (WhatsApp-specific desks)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_departments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `slug` VARCHAR(120) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `manager_user_id` INT UNSIGNED DEFAULT NULL,
  -- department | round_robin | least_active | least_assigned | manual
  `routing_method` VARCHAR(32) NOT NULL DEFAULT 'round_robin',
  -- JSON: { "0": {"open":"09:00","close":"18:00","enabled":true}, ... } (0=Sun)
  `working_hours` TEXT DEFAULT NULL,
  `auto_assign` TINYINT(1) NOT NULL DEFAULT 1,
  -- newline / comma separated keywords that route an inbound message here
  `keywords` VARCHAR(1000) DEFAULT NULL,
  `color` VARCHAR(16) DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_dept_slug` (`slug`),
  KEY `idx_wa_dept_active` (`is_active`),
  CONSTRAINT `fk_wa_dept_manager` FOREIGN KEY (`manager_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default departments once (only when the table is empty).
INSERT INTO `marketing_whatsapp_departments` (`name`, `slug`, `description`, `routing_method`, `sort_order`)
SELECT * FROM (
  SELECT 'Sales' AS name, 'sales' AS slug, 'New business, quotations and lead follow-up' AS description, 'round_robin' AS routing_method, 1 AS sort_order UNION ALL
  SELECT 'Support', 'support', 'Customer support and issue resolution', 'round_robin', 2 UNION ALL
  SELECT 'Marketing', 'marketing', 'Campaigns, promotions and broadcasts', 'round_robin', 3 UNION ALL
  SELECT 'Accounts', 'accounts', 'Billing, payments and invoices', 'round_robin', 4 UNION ALL
  SELECT 'HR', 'hr', 'Recruitment and people operations', 'round_robin', 5 UNION ALL
  SELECT 'Operations', 'operations', 'Delivery and project operations', 'round_robin', 6 UNION ALL
  SELECT 'Admin', 'admin', 'Administrative and everything else', 'round_robin', 7
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM `marketing_whatsapp_departments`);

-- -------------------------------------------------------------
-- Department membership: which ERP users staff each department
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_department_agents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `department_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `role` ENUM('agent','manager') NOT NULL DEFAULT 'agent',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_dept_agent` (`department_id`, `user_id`),
  KEY `idx_wa_dept_agent_user` (`user_id`),
  CONSTRAINT `fk_wa_deptagent_dept` FOREIGN KEY (`department_id`) REFERENCES `marketing_whatsapp_departments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_deptagent_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Per-user WhatsApp agent settings + granular capabilities
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_agent_settings` (
  `user_id` INT UNSIGNED NOT NULL,
  `is_agent` TINYINT(1) NOT NULL DEFAULT 0,
  `is_available` TINYINT(1) NOT NULL DEFAULT 1,
  `can_view_all` TINYINT(1) NOT NULL DEFAULT 0,
  `can_view_department` TINYINT(1) NOT NULL DEFAULT 1,
  `can_send` TINYINT(1) NOT NULL DEFAULT 1,
  `can_assign` TINYINT(1) NOT NULL DEFAULT 0,
  `can_reassign` TINYINT(1) NOT NULL DEFAULT 0,
  `can_close` TINYINT(1) NOT NULL DEFAULT 1,
  `can_send_templates` TINYINT(1) NOT NULL DEFAULT 1,
  `can_create_campaigns` TINYINT(1) NOT NULL DEFAULT 0,
  `can_view_analytics` TINYINT(1) NOT NULL DEFAULT 0,
  `can_manage_contacts` TINYINT(1) NOT NULL DEFAULT 0,
  `can_manage_automation` TINYINT(1) NOT NULL DEFAULT 0,
  `last_assigned_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  KEY `idx_wa_agent_is_agent` (`is_agent`),
  CONSTRAINT `fk_wa_agent_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Conversation platform columns: department, bot/human, SLA, source
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `department_id` INT UNSIGNED DEFAULT NULL AFTER `assigned_team`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `bot_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `priority`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `sla_due_at` DATETIME DEFAULT NULL AFTER `bot_enabled`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `first_response_at` DATETIME DEFAULT NULL AFTER `sla_due_at`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `closed_at` DATETIME DEFAULT NULL AFTER `first_response_at`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `closed_by` INT UNSIGNED DEFAULT NULL AFTER `closed_at`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `source` VARCHAR(64) DEFAULT NULL AFTER `closed_by`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_department` (`department_id`);
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_sla` (`sla_due_at`);

-- -------------------------------------------------------------
-- Contact platform columns: geo + segmentation attributes
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `city` VARCHAR(120) DEFAULT NULL AFTER `tags`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `state` VARCHAR(120) DEFAULT NULL AFTER `city`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `country` VARCHAR(120) DEFAULT NULL AFTER `state`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `opted_in` TINYINT(1) NOT NULL DEFAULT 1 AFTER `country`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `custom_attributes` TEXT DEFAULT NULL AFTER `opted_in`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `last_interaction_at` DATETIME DEFAULT NULL AFTER `custom_attributes`;

-- -------------------------------------------------------------
-- Message note-to-self: whether an outbound msg came from a campaign
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_messages`
  ADD COLUMN IF NOT EXISTS `campaign_id` INT UNSIGNED DEFAULT NULL AFTER `sent_by_user_id`;
ALTER TABLE `marketing_whatsapp_messages`
  ADD KEY IF NOT EXISTS `idx_wa_message_campaign` (`campaign_id`);

-- -------------------------------------------------------------
-- Internal notes (never sent to the customer)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_internal_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `note` TEXT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_note_convo` (`conversation_id`),
  CONSTRAINT `fk_wa_note_convo` FOREIGN KEY (`conversation_id`) REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_note_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Department transfer audit trail (separate from agent assignments)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_transfers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `from_department_id` INT UNSIGNED DEFAULT NULL,
  `to_department_id` INT UNSIGNED DEFAULT NULL,
  `from_agent_id` INT UNSIGNED DEFAULT NULL,
  `to_agent_id` INT UNSIGNED DEFAULT NULL,
  `transferred_by` INT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_transfer_convo` (`conversation_id`),
  CONSTRAINT `fk_wa_transfer_convo` FOREIGN KEY (`conversation_id`) REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Media metadata (never stores the token or the blob itself)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_media` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message_id` INT UNSIGNED DEFAULT NULL,
  `conversation_id` INT UNSIGNED DEFAULT NULL,
  `media_id` VARCHAR(191) NOT NULL,
  `mime_type` VARCHAR(128) DEFAULT NULL,
  `filename` VARCHAR(255) DEFAULT NULL,
  `file_size` INT UNSIGNED DEFAULT NULL,
  `sha256` VARCHAR(128) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_media_id` (`media_id`),
  KEY `idx_wa_media_message` (`message_id`),
  KEY `idx_wa_media_convo` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Template cache (synced from Meta; only approved ones are sendable)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `language` VARCHAR(16) NOT NULL,
  `category` VARCHAR(48) DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  `header_type` VARCHAR(32) DEFAULT NULL,
  `header_text` VARCHAR(1000) DEFAULT NULL,
  `body_text` TEXT DEFAULT NULL,
  `footer_text` VARCHAR(1000) DEFAULT NULL,
  `buttons_json` TEXT DEFAULT NULL,
  `variable_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `meta_id` VARCHAR(64) DEFAULT NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_template` (`name`, `language`),
  KEY `idx_wa_template_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Audiences (saved segmentation filters)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_audiences` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  -- JSON: { "match": "AND"|"OR", "conditions": [ { field, op, value }, ... ] }
  `filter_json` TEXT DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_wa_audience_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Campaigns (broadcasts / promotions)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_campaigns` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `type` VARCHAR(48) NOT NULL DEFAULT 'promotional',
  `department_id` INT UNSIGNED DEFAULT NULL,
  `audience_id` INT UNSIGNED DEFAULT NULL,
  -- snapshot of resolved audience filter at launch time
  `audience_filter_json` TEXT DEFAULT NULL,
  `template_name` VARCHAR(191) DEFAULT NULL,
  `template_language` VARCHAR(16) DEFAULT NULL,
  -- JSON array of variable mappings, e.g. ["{{name}}","10%","https://..."]
  `variables_json` TEXT DEFAULT NULL,
  `media_link` VARCHAR(1000) DEFAULT NULL,
  `header_media_id` VARCHAR(191) DEFAULT NULL,
  `scheduled_at` DATETIME DEFAULT NULL,
  `timezone` VARCHAR(64) DEFAULT 'Asia/Kolkata',
  `status` ENUM('draft','scheduled','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
  `total_recipients` INT UNSIGNED NOT NULL DEFAULT 0,
  `sent_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `delivered_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `read_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `failed_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `replied_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `launched_by` INT UNSIGNED DEFAULT NULL,
  `launched_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `last_error` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_campaign_status` (`status`),
  KEY `idx_wa_campaign_scheduled` (`scheduled_at`),
  CONSTRAINT `fk_wa_campaign_dept` FOREIGN KEY (`department_id`) REFERENCES `marketing_whatsapp_departments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_campaign_audience` FOREIGN KEY (`audience_id`) REFERENCES `marketing_whatsapp_audiences` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_campaign_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Campaign recipients (per-contact delivery tracking)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_campaign_recipients` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` INT UNSIGNED NOT NULL,
  `contact_id` INT UNSIGNED DEFAULT NULL,
  `phone_number` VARCHAR(32) NOT NULL,
  `variables_json` TEXT DEFAULT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `status` ENUM('pending','sent','delivered','read','failed','replied') NOT NULL DEFAULT 'pending',
  `error_message` VARCHAR(500) DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `read_at` DATETIME DEFAULT NULL,
  `replied_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_camp_recipient` (`campaign_id`, `phone_number`),
  KEY `idx_wa_camp_recipient_campaign` (`campaign_id`),
  KEY `idx_wa_camp_recipient_wamid` (`wamid`),
  KEY `idx_wa_camp_recipient_status` (`status`),
  CONSTRAINT `fk_wa_camp_recipient_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `marketing_whatsapp_campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Campaign events (append-only analytics stream)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_campaign_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` INT UNSIGNED NOT NULL,
  `recipient_id` BIGINT UNSIGNED DEFAULT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `detail` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_camp_event_campaign` (`campaign_id`),
  KEY `idx_wa_camp_event_type` (`event_type`),
  CONSTRAINT `fk_wa_camp_event_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `marketing_whatsapp_campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Automations (rule-based; chatbot-ready)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_automations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  -- keyword | new_conversation | no_reply | customer_requests_human | welcome
  `trigger_type` VARCHAR(48) NOT NULL,
  `trigger_config_json` TEXT DEFAULT NULL,
  -- send_template | send_text | assign_department | assign_agent | notify | create_task
  `action_type` VARCHAR(48) NOT NULL,
  `action_config_json` TEXT DEFAULT NULL,
  `department_id` INT UNSIGNED DEFAULT NULL,
  `priority` INT NOT NULL DEFAULT 0,
  `run_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_run_at` DATETIME DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_automation_active` (`is_active`),
  KEY `idx_wa_automation_trigger` (`trigger_type`),
  CONSTRAINT `fk_wa_automation_dept` FOREIGN KEY (`department_id`) REFERENCES `marketing_whatsapp_departments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Notifications: link WhatsApp events into the ERP notifications table
-- when it exists (created elsewhere). No-op here beyond a helpful index.
-- -------------------------------------------------------------
