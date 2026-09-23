-- Preserve historical connections while making an explicitly released phone
-- available for a different tenant. No existing connection is released here.
ALTER TABLE `marketing_whatsapp_integration`
  ADD COLUMN IF NOT EXISTS `released_at` DATETIME DEFAULT NULL;

-- The tenant-scoped key must exist before dropping the old global key.
ALTER TABLE `marketing_whatsapp_integration`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_integration_tenant_phone` (`tenant_id`, `phone_number_id`);
ALTER TABLE `marketing_whatsapp_integration` DROP INDEX IF EXISTS `uniq_phone_number`;

CREATE TABLE IF NOT EXISTS `marketing_whatsapp_ownership_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `integration_id` INT UNSIGNED NOT NULL,
  `previous_tenant_id` INT UNSIGNED NULL,
  `phone_number_id` VARCHAR(191) NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `actor_user_id` INT UNSIGNED NULL,
  `reason` VARCHAR(500) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_ownership_integration` (`integration_id`),
  KEY `idx_wa_ownership_phone` (`phone_number_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
