-- =============================================================
-- Migration: WhatsApp Cloud API messaging (inbox + conversations)
-- Run this in phpMyAdmin (Hostinger) after the base schema and the
-- marketing social migration.
-- Safe to run once. Uses IF NOT EXISTS throughout, so it is idempotent.
--
-- These tables are SEPARATE from the internal employee messaging tables
-- (`conversations`, `messages`, `conversation_participants`) which power the
-- ERP's internal chat and MUST remain untouched. WhatsApp uses its own
-- namespace so the two systems never collide.
--
-- Covers:
--   1. marketing_whatsapp_contacts       -> one row per external WhatsApp user
--   2. marketing_whatsapp_conversations  -> one thread per contact + number
--   3. marketing_whatsapp_messages       -> every inbound/outbound message
--   4. marketing_whatsapp_webhook_events -> lightweight webhook audit log
--
-- The existing `marketing_whatsapp_integration` table (created at runtime by
-- lib/whatsapp.ts ensureWhatsAppTable) is intentionally NOT redefined here so
-- existing deployments keep their stored, encrypted credentials.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_contacts
-- An external person we exchange WhatsApp messages with. `phone_number` is the
-- E.164 digits without a leading +. `lead_id` optionally links to an existing
-- CRM lead so the conversation can show the linked contact — never duplicated.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_contacts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone_number` VARCHAR(32) NOT NULL,
  `profile_name` VARCHAR(191) DEFAULT NULL,
  `wa_contact_id` VARCHAR(64) DEFAULT NULL,
  `lead_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_contact_phone` (`phone_number`),
  KEY `idx_wa_contact_lead` (`lead_id`),
  CONSTRAINT `fk_wa_contact_lead` FOREIGN KEY (`lead_id`) REFERENCES `sales_leads` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_conversations
-- One conversation thread per (contact, business phone number). `status` marks
-- open/closed. `last_customer_message_at` drives the 24-hour customer service
-- window used to decide whether free text is allowed.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_conversations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `contact_id` INT UNSIGNED NOT NULL,
  `phone_number_id` VARCHAR(191) NOT NULL,
  `waba_id` VARCHAR(191) DEFAULT NULL,
  `status` ENUM('open','closed') NOT NULL DEFAULT 'open',
  `last_message_at` DATETIME DEFAULT NULL,
  `last_customer_message_at` DATETIME DEFAULT NULL,
  `unread_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_message_preview` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_convo_contact_number` (`contact_id`, `phone_number_id`),
  KEY `idx_wa_convo_last_message` (`last_message_at`),
  KEY `idx_wa_convo_status` (`status`),
  CONSTRAINT `fk_wa_convo_contact` FOREIGN KEY (`contact_id`) REFERENCES `marketing_whatsapp_contacts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_messages
-- Every message in both directions. `wamid` is Meta's message id and is UNIQUE
-- so retried webhooks never create duplicates. `status` follows the Cloud API
-- lifecycle. Media is referenced by Meta media id + metadata only — never the
-- blob itself (see requirement 16).
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_messages` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `direction` ENUM('inbound','outbound') NOT NULL,
  `message_type` VARCHAR(32) NOT NULL DEFAULT 'text',
  `message_body` TEXT DEFAULT NULL,
  `media_id` VARCHAR(191) DEFAULT NULL,
  `media_mime_type` VARCHAR(128) DEFAULT NULL,
  `media_filename` VARCHAR(255) DEFAULT NULL,
  `media_url` VARCHAR(500) DEFAULT NULL,
  `sender_phone` VARCHAR(32) DEFAULT NULL,
  `recipient_phone` VARCHAR(32) DEFAULT NULL,
  `status` ENUM('received','queued','sent','delivered','read','failed') NOT NULL DEFAULT 'queued',
  `status_rank` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `meta_timestamp` DATETIME DEFAULT NULL,
  `error_code` VARCHAR(32) DEFAULT NULL,
  `error_message` VARCHAR(500) DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `read_at` DATETIME DEFAULT NULL,
  `sent_by_user_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_message_wamid` (`wamid`),
  KEY `idx_wa_message_conversation` (`conversation_id`),
  KEY `idx_wa_message_direction` (`direction`),
  KEY `idx_wa_message_status` (`status`),
  KEY `idx_wa_message_created` (`created_at`),
  CONSTRAINT `fk_wa_message_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_message_user` FOREIGN KEY (`sent_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_webhook_events
-- Lightweight audit log for debugging Meta webhook retries. Stores metadata
-- ONLY — never tokens, secrets, verify tokens or PINs. `dedup_key` makes event
-- processing idempotent for status updates that share a wamid.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_webhook_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_type` VARCHAR(48) NOT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `phone_number_id` VARCHAR(191) DEFAULT NULL,
  `dedup_key` VARCHAR(255) DEFAULT NULL,
  `processing_status` ENUM('received','processed','skipped','error') NOT NULL DEFAULT 'received',
  `error` VARCHAR(500) DEFAULT NULL,
  `received_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_event_dedup` (`dedup_key`),
  KEY `idx_wa_event_wamid` (`wamid`),
  KEY `idx_wa_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
