-- =============================================================
-- Migration: WhatsApp Business multi-tenant data isolation
-- Run in phpMyAdmin (Hostinger) AFTER
--   2026-09-20-add-whatsapp-messaging.sql
--   2026-09-21-add-whatsapp-shared-inbox.sql
--   2026-09-22-add-whatsapp-platform.sql
--   2026-11-07-tenant-data-isolation.sql
--
-- PURPOSE
--   The WhatsApp platform was built single-tenant: one global integration row,
--   and contacts/conversations/messages/campaigns/etc. that any tenant could
--   read. This migration scopes EVERY WhatsApp table to a tenant so each
--   customer organization only ever sees its own WhatsApp data, and adds an
--   `integration_id` so a tenant can connect more than one WhatsApp Business
--   number without the rows colliding.
--
-- WHAT IT DOES (all additive + idempotent)
--   1. Adds `tenant_id` to every WhatsApp table (mirrors lib/tenant-tables.ts;
--      the generic self-heal in lib/tenant-ensure.ts also adds this at runtime).
--   2. Adds `integration_id` to the data tables that hang off a connected
--      number (contacts, conversations, messages, webhook_events, campaigns,
--      templates, media).
--   3. Backfills tenant_id only when an existing ERP ownership relationship
--      proves the owner; ambiguous legacy rows remain NULL for administrator
--      mapping instead of being assigned to an arbitrary tenant.
--   4. Replaces globally-unique keys with tenant-scoped composite unique keys
--      so two tenants can legitimately hold the same phone number / wamid /
--      template name without a collision.
--
-- IDEMPOTENT: uses IF NOT EXISTS / IF EXISTS (MariaDB 10.x, which Hostinger
-- runs). Safe to run more than once. lib/whatsapp.ts, lib/whatsapp-store.ts and
-- lib/whatsapp-platform.ts mirror this at runtime so a deployment that has not
-- imported this SQL yet still isolates correctly.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Resolve only ownership that is proven by existing ERP relationships. Legacy
-- rows without a provable owner intentionally remain NULL and are unavailable
-- to tenant APIs until an administrator maps them; never guess the first tenant.
-- -------------------------------------------------------------
SET @default_tenant := NULL;

-- =============================================================
-- 1. marketing_whatsapp_integration
-- =============================================================
ALTER TABLE `marketing_whatsapp_integration`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_integration` i
JOIN `users` u ON u.`id` = i.`connected_by_user_id` AND u.`tenant_id` IS NOT NULL
SET i.`tenant_id` = u.`tenant_id`
WHERE i.`tenant_id` IS NULL;
UPDATE `marketing_whatsapp_integration` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_integration`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_integration_tenant` (`tenant_id`);
-- A number is unique WITHIN a tenant, not globally.
ALTER TABLE `marketing_whatsapp_integration` DROP INDEX IF EXISTS `uniq_phone_number`;
ALTER TABLE `marketing_whatsapp_integration`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_integration_tenant_phone` (`tenant_id`, `phone_number_id`);

-- =============================================================
-- 2. marketing_whatsapp_contacts
-- =============================================================
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_contacts` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_contacts` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_contacts_tenant` (`tenant_id`);
-- Phone is unique per (tenant, number), so two tenants can talk to the same
-- customer independently.
ALTER TABLE `marketing_whatsapp_contacts` DROP INDEX IF EXISTS `uniq_wa_contact_phone`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_contact_tenant_phone` (`tenant_id`, `phone_number`);

-- =============================================================
-- 3. marketing_whatsapp_conversations
-- =============================================================
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_conversations` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_conversations` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_conversations_tenant` (`tenant_id`);
-- A foreign key on `contact_id` is backed by the old unique index, so MariaDB
-- refuses to drop it (#1553). Add a standalone index on `contact_id` FIRST so
-- the FK has another index to lean on, THEN the old unique key is free to drop.
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_conversations_contact` (`contact_id`);
ALTER TABLE `marketing_whatsapp_conversations` DROP INDEX IF EXISTS `uniq_wa_convo_contact_number`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_convo_tenant_contact_number` (`tenant_id`, `contact_id`, `phone_number_id`);

-- =============================================================
-- 4. marketing_whatsapp_messages
-- =============================================================
ALTER TABLE `marketing_whatsapp_messages`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_messages`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_messages` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_messages` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_messages`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_messages_tenant` (`tenant_id`);
-- wamid stays idempotent, but scoped to the tenant so two tenants can never
-- clash and one tenant can never update another's message by wamid.
ALTER TABLE `marketing_whatsapp_messages` DROP INDEX IF EXISTS `uniq_wa_message_wamid`;
ALTER TABLE `marketing_whatsapp_messages`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_message_tenant_wamid` (`tenant_id`, `wamid`);

-- =============================================================
-- 5. marketing_whatsapp_webhook_events
-- =============================================================
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_webhook_events` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_webhook_events` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_webhook_events_tenant` (`tenant_id`);
ALTER TABLE `marketing_whatsapp_webhook_events` DROP INDEX IF EXISTS `uniq_wa_event_dedup`;
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_event_tenant_dedup` (`tenant_id`, `dedup_key`);

-- =============================================================
-- 6. marketing_whatsapp_assignments
-- =============================================================
ALTER TABLE `marketing_whatsapp_assignments`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_assignments` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_assignments`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_assignments_tenant` (`tenant_id`);

-- =============================================================
-- 7. marketing_whatsapp_departments
-- =============================================================
ALTER TABLE `marketing_whatsapp_departments`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_departments` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_departments`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_departments_tenant` (`tenant_id`);
-- Slug is unique per tenant, so each tenant gets its own "sales"/"support" desk.
ALTER TABLE `marketing_whatsapp_departments` DROP INDEX IF EXISTS `uniq_wa_dept_slug`;
ALTER TABLE `marketing_whatsapp_departments`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_dept_tenant_slug` (`tenant_id`, `slug`);

-- =============================================================
-- 8. marketing_whatsapp_department_agents
-- =============================================================
ALTER TABLE `marketing_whatsapp_department_agents`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_department_agents` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_department_agents`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_department_agents_tenant` (`tenant_id`);

-- =============================================================
-- 9. marketing_whatsapp_agent_settings
-- =============================================================
ALTER TABLE `marketing_whatsapp_agent_settings`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `user_id`;
UPDATE `marketing_whatsapp_agent_settings` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_agent_settings`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_agent_settings_tenant` (`tenant_id`);

-- =============================================================
-- 10. marketing_whatsapp_internal_notes
-- =============================================================
ALTER TABLE `marketing_whatsapp_internal_notes`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_internal_notes` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_internal_notes`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_internal_notes_tenant` (`tenant_id`);

-- =============================================================
-- 11. marketing_whatsapp_transfers
-- =============================================================
ALTER TABLE `marketing_whatsapp_transfers`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_transfers` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_transfers`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_transfers_tenant` (`tenant_id`);

-- =============================================================
-- 12. marketing_whatsapp_media
-- =============================================================
ALTER TABLE `marketing_whatsapp_media`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_media`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_media` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_media` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_media`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_media_tenant` (`tenant_id`);
ALTER TABLE `marketing_whatsapp_media` DROP INDEX IF EXISTS `uniq_wa_media_id`;
ALTER TABLE `marketing_whatsapp_media`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_media_tenant_id` (`tenant_id`, `media_id`);

-- =============================================================
-- 13. marketing_whatsapp_templates
-- =============================================================
ALTER TABLE `marketing_whatsapp_templates`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_templates`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_templates` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_templates` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_templates`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_templates_tenant` (`tenant_id`);
ALTER TABLE `marketing_whatsapp_templates` DROP INDEX IF EXISTS `uniq_wa_template`;
ALTER TABLE `marketing_whatsapp_templates` DROP INDEX IF EXISTS `uniq_wa_template_tenant`;
ALTER TABLE `marketing_whatsapp_templates`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_template_tenant_integration` (`tenant_id`, `integration_id`, `name`, `language`);

-- =============================================================
-- 14. marketing_whatsapp_template_versions
-- =============================================================
ALTER TABLE `marketing_whatsapp_template_versions`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_template_versions`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
ALTER TABLE `marketing_whatsapp_template_versions`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_template_versions_tenant` (`tenant_id`);

-- =============================================================
-- 15. marketing_whatsapp_audiences
-- =============================================================
ALTER TABLE `marketing_whatsapp_audiences`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_audiences` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_audiences`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_audiences_tenant` (`tenant_id`);

-- =============================================================
-- 16. marketing_whatsapp_campaigns
-- =============================================================
ALTER TABLE `marketing_whatsapp_campaigns`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_campaigns`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_campaigns` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_campaigns` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_campaigns`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_campaigns_tenant` (`tenant_id`);

-- =============================================================
-- 17. marketing_whatsapp_campaign_recipients
-- =============================================================
ALTER TABLE `marketing_whatsapp_campaign_recipients`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_campaign_recipients`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_campaign_recipients` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_campaign_recipients`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_campaign_recipients_tenant` (`tenant_id`);

-- =============================================================
-- 18. marketing_whatsapp_campaign_events
-- =============================================================
ALTER TABLE `marketing_whatsapp_campaign_events`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_campaign_events`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_campaign_events` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_campaign_events`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_campaign_events_tenant` (`tenant_id`);

-- =============================================================
-- 19. marketing_whatsapp_automations
-- =============================================================
ALTER TABLE `marketing_whatsapp_automations`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_automations`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_automations` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_automations`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_automations_tenant` (`tenant_id`);

-- Diagnostics are tenant-owned as well; an unmapped legacy row stays NULL and
-- is never returned by a normal tenant query. The table may be runtime-created
-- on older deployments, so create the compatible shape before altering it.
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_diagnostics` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `integration_id` INT UNSIGNED DEFAULT NULL,
  `direction` VARCHAR(16) NOT NULL,
  `outcome` VARCHAR(16) NOT NULL,
  `context` VARCHAR(64) NOT NULL,
  `phone_number` VARCHAR(32) DEFAULT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `template_name` VARCHAR(191) DEFAULT NULL,
  `campaign_id` INT UNSIGNED DEFAULT NULL,
  `error_code` INT DEFAULT NULL,
  `retryable` TINYINT(1) DEFAULT NULL,
  `message` VARCHAR(1000) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `marketing_whatsapp_diagnostics`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_diagnostics`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
ALTER TABLE `marketing_whatsapp_diagnostics`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_diagnostics_tenant` (`tenant_id`);
