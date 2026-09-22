-- =============================================================
-- Shopkeeper customer fields on the existing WhatsApp contact record
-- =============================================================
-- The Shopkeeper app's "Customer" IS the tenant's WhatsApp contact
-- (marketing_whatsapp_contacts), which is already tenant-scoped and already
-- carries notes/tags. Two fields are missing for the mobile Customer screens:
--
--   email       — the app collects it; there was nowhere to put it.
--   archived_at — shopkeeper_orders references contacts, so a hard DELETE would
--                 blank the customer off historical orders. The mobile DELETE
--                 therefore archives instead, and this column records that.
--
-- Written with an information_schema guard rather than
-- `ADD COLUMN IF NOT EXISTS`, which is MariaDB-only syntax that MySQL 8
-- rejects. This form is idempotent on both engines.
-- =============================================================

SET NAMES utf8mb4;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `marketing_whatsapp_contacts` ADD COLUMN `email` VARCHAR(190) NULL AFTER `profile_name`',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'marketing_whatsapp_contacts'
    AND column_name = 'email'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `marketing_whatsapp_contacts` ADD COLUMN `archived_at` DATETIME NULL DEFAULT NULL',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'marketing_whatsapp_contacts'
    AND column_name = 'archived_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `idx_whatsapp_contacts_tenant_archived` ON `marketing_whatsapp_contacts` (`tenant_id`, `archived_at`)',
    'DO 0'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'marketing_whatsapp_contacts'
    AND index_name = 'idx_whatsapp_contacts_tenant_archived'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
