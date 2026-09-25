-- Spec32 (#176-179) follow-up · idempotent release-note authoring and
-- tenant-keyed read state.
--  * product_updates.idempotency_key: a retried POST with the same
--    Idempotency-Key returns the original draft instead of a duplicate.
--  * product_update_reads is re-keyed (tenant_id, update_id, user_id) so read
--    state can never be shared across tenants.
--
-- Idempotent: ensureProductUpdatesSchema() self-heals the same changes, so
-- running this file twice (or after the app booted) is safe.

SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'product_updates' AND column_name = 'idempotency_key');
SET @sql := IF(@col = 0,
  'ALTER TABLE `product_updates` ADD COLUMN `idempotency_key` VARCHAR(80) DEFAULT NULL, ADD UNIQUE KEY `uq_pu_idempotency` (`idempotency_key`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @pk := (SELECT column_name FROM information_schema.key_column_usage
  WHERE table_schema = DATABASE() AND table_name = 'product_update_reads' AND constraint_name = 'PRIMARY'
  ORDER BY ordinal_position LIMIT 1);
SET @sql := IF(@pk IS NOT NULL AND @pk <> 'tenant_id',
  'ALTER TABLE `product_update_reads` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `update_id`, `user_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
