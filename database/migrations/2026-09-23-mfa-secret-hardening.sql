-- Widen the existing TOTP column for the authenticated sec:v1: envelope.
-- Legacy plaintext rows are encrypted by ensureUserLifecycleSchema when
-- SETTINGS_ENCRYPTION_KEY is configured; no secret is written to SQL logs here.
SET @mfa_secret_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'mfa_secret'
);
SET @mfa_secret_sql = IF(@mfa_secret_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `mfa_secret` VARCHAR(255) DEFAULT NULL',
  'ALTER TABLE `users` MODIFY COLUMN `mfa_secret` VARCHAR(255) DEFAULT NULL');
PREPARE mfa_secret_stmt FROM @mfa_secret_sql;
EXECUTE mfa_secret_stmt;
DEALLOCATE PREPARE mfa_secret_stmt;

SET @mfa_step_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'mfa_last_used_step'
);
SET @mfa_step_sql = IF(@mfa_step_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `mfa_last_used_step` BIGINT UNSIGNED DEFAULT NULL',
  'SELECT 1');
PREPARE mfa_step_stmt FROM @mfa_step_sql;
EXECUTE mfa_step_stmt;
DEALLOCATE PREPARE mfa_step_stmt;
