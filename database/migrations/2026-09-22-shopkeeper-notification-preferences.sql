-- =============================================================
-- Shopkeeper notification preferences
-- =============================================================
-- The mobile Settings screen has notification toggles, but shopkeeper_profiles
-- had nowhere to store them, so every toggle was lost on save. Stored as JSON
-- alongside business_hours rather than as a column per switch, because the set
-- of notification types will grow with the app.
--
-- information_schema guard rather than `ADD COLUMN IF NOT EXISTS`, which is
-- MariaDB-only syntax that MySQL 8 rejects. Idempotent on both engines.
-- =============================================================

SET NAMES utf8mb4;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `shopkeeper_profiles` ADD COLUMN `notification_preferences` JSON NULL AFTER `business_hours`',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'shopkeeper_profiles'
    AND column_name = 'notification_preferences'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
