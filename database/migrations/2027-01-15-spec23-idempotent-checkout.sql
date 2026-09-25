-- Spec23 · Idempotent invoice checkout (#147-149)
-- One PENDING gateway payment per (tenant, invoice, provider, outstanding
-- amount). NULL keys (manual payments, settled/failed attempts) never collide
-- because MySQL unique indexes allow multiple NULLs.
--
-- Idempotent: ensureBillingSchema() self-heals the same column + index, so
-- running this file twice (or after the app booted) is safe.

SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'billing_payments' AND column_name = 'checkout_key');
SET @sql := IF(@col = 0,
  'ALTER TABLE `billing_payments` ADD COLUMN `checkout_key` VARCHAR(120) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'billing_payments' AND index_name = 'uq_billing_payments_checkout');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `billing_payments` ADD UNIQUE KEY `uq_billing_payments_checkout` (`tenant_id`, `checkout_key`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
