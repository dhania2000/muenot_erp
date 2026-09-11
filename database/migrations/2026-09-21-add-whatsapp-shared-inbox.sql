-- =============================================================
-- Migration: WhatsApp Shared Inbox (multi-agent) layer
-- Run this in phpMyAdmin (Hostinger) AFTER
-- 2026-09-20-add-whatsapp-messaging.sql.
--
-- Adds the collaboration layer on top of the existing WhatsApp messaging
-- tables so multiple ERP agents can work the SAME WhatsApp Business number
-- (+91 63778 09826) from one Shared Inbox:
--   * conversation assignment (individual agent + team)
--   * conversation priority
--   * a "pending" conversation status (open / pending / closed)
--   * contact notes + tags
--   * an assignment audit trail
--
-- Nothing here touches the coexistence connection or the WhatsApp Business
-- App on the same number. It is purely ERP-side collaboration metadata.
--
-- The runtime helper ensureWhatsAppMessagingTables() in lib/whatsapp-store.ts
-- self-heals these same columns/tables, so a deployment that has not run this
-- SQL yet still works. This file is the canonical, reviewable definition.
--
-- IDEMPOTENT: every statement below uses IF NOT EXISTS / IF EXISTS guards and
-- is split into its own ALTER, so this file can be re-imported safely even if
-- the runtime self-heal (or a previous partial import) already added some of
-- these columns, keys, or constraints. This avoids the phpMyAdmin
-- "#1060 - Duplicate column name" abort on re-run. Requires MariaDB 10.x
-- (which Hostinger uses); the IF NOT EXISTS clauses are MariaDB extensions.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Conversations: assignment + priority + pending status
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `assigned_agent_id` INT UNSIGNED DEFAULT NULL AFTER `waba_id`;

ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `assigned_team` VARCHAR(64) DEFAULT NULL AFTER `assigned_agent_id`;

ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `priority` ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal' AFTER `assigned_team`;

ALTER TABLE `marketing_whatsapp_conversations`
  MODIFY COLUMN `status` ENUM('open','pending','closed') NOT NULL DEFAULT 'open';

ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_agent` (`assigned_agent_id`);

ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_team` (`assigned_team`);

ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_priority` (`priority`);

-- Re-create the FK defensively: drop it if a previous run/self-heal added it,
-- then add it back so the definition stays canonical.
ALTER TABLE `marketing_whatsapp_conversations`
  DROP FOREIGN KEY IF EXISTS `fk_wa_convo_agent`;

ALTER TABLE `marketing_whatsapp_conversations`
  ADD CONSTRAINT `fk_wa_convo_agent` FOREIGN KEY (`assigned_agent_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL;

-- -------------------------------------------------------------
-- Contacts: agent-facing notes + tags
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `notes` TEXT DEFAULT NULL AFTER `lead_id`;

ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `tags` VARCHAR(500) DEFAULT NULL AFTER `notes`;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_assignments
-- Audit trail of every assign / reassign / unassign action so admins can see
-- who routed a conversation and when. Never stores secrets.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_assignments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `action` ENUM('assign','reassign','unassign') NOT NULL,
  `assigned_agent_id` INT UNSIGNED DEFAULT NULL,
  `assigned_team` VARCHAR(64) DEFAULT NULL,
  `assigned_by` INT UNSIGNED DEFAULT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_assign_convo` (`conversation_id`),
  KEY `idx_wa_assign_agent` (`assigned_agent_id`),
  CONSTRAINT `fk_wa_assign_convo` FOREIGN KEY (`conversation_id`)
    REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_assign_agent` FOREIGN KEY (`assigned_agent_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_assign_by` FOREIGN KEY (`assigned_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
