-- Spec30 — Affiliate tracking (#173)
-- ---------------------------------------------------------------------------
-- Built ON TOP OF Spec29 partner/reseller management, not beside it: an
-- affiliate IS a `platform_partners` row and portal access is a
-- `platform_partner_members` row. A credited signup becomes a normal
-- `platform_partner_referrals` row with source 'affiliate', so the existing
-- one-active-attribution-per-tenant unique key prevents duplicate credit across
-- links, typed codes and manual attribution. Commissions/clawbacks reuse the
-- Spec29 `platform_partner_commissions` ledger.
--
-- These tables are PLATFORM-OWNED (no tenant_id ownership) and are therefore
-- intentionally NOT in the tenant-owned registry; isolation is enforced in
-- lib/affiliates/store.ts (platform-role guards + a portal pinned to the
-- partner resolved from the caller's active membership, never request input).
-- The runtime store self-heals the same schema for existing installs
-- (ensureAffiliateSchema); this migration is for fresh installs.
--
-- Fraud-resistance notes:
-- • platform_affiliate_clicks stores ONLY sha256 hashes of the click token, IP
--   and UA — never raw values or a partner/link id in the cookie. token_hash is
--   unique, so a forged/edited/replayed cookie attributes nothing.
-- • consumed_at + the referral unique key make a click credit at most one tenant.
-- • platform_affiliate_conversions.uniq_aff_conv_tenant/uniq_aff_conv_click stop
--   duplicate conversion rows per tenant / per click.
-- • platform_affiliate_payout_items.active_commission_id (generated) is unique,
--   so a commission can sit in at most one live payout; voiding releases it.

CREATE TABLE IF NOT EXISTS `platform_affiliate_links` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `partner_id` INT UNSIGNED NOT NULL,
  `code` VARCHAR(16) NOT NULL,
  `label` VARCHAR(80) DEFAULT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_aff_link_code` (`code`),
  UNIQUE KEY `uniq_aff_link_idem` (`idempotency_key`),
  KEY `idx_aff_link_partner` (`partner_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_affiliate_clicks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `link_id` INT UNSIGNED NOT NULL,
  `partner_id` INT UNSIGNED NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `ip_hash` CHAR(64) DEFAULT NULL,
  `ua_hash` CHAR(64) DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `consumed_at` DATETIME DEFAULT NULL,
  `consumed_tenant_id` INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_aff_click_token` (`token_hash`),
  KEY `idx_aff_click_link` (`link_id`, `created_at`),
  KEY `idx_aff_click_partner` (`partner_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_affiliate_conversions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `partner_id` INT UNSIGNED NOT NULL,
  `link_id` INT UNSIGNED DEFAULT NULL,
  `click_id` BIGINT UNSIGNED DEFAULT NULL,
  `rejected_click_id` BIGINT UNSIGNED DEFAULT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `referral_id` INT UNSIGNED DEFAULT NULL,
  `state` VARCHAR(16) NOT NULL DEFAULT 'referred',
  `reject_reason` VARCHAR(40) DEFAULT NULL,
  `referred_at` DATETIME NOT NULL,
  `trial_at` DATETIME DEFAULT NULL,
  `converted_at` DATETIME DEFAULT NULL,
  `paid_at` DATETIME DEFAULT NULL,
  `first_paid_invoice_id` INT UNSIGNED DEFAULT NULL,
  `cancelled_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_aff_conv_tenant` (`tenant_id`),
  UNIQUE KEY `uniq_aff_conv_click` (`click_id`),
  KEY `idx_aff_conv_partner` (`partner_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_affiliate_payouts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `partner_id` INT UNSIGNED NOT NULL,
  `currency` VARCHAR(10) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `reference` VARCHAR(120) DEFAULT NULL,
  `void_reason` VARCHAR(300) DEFAULT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `paid_by` INT UNSIGNED DEFAULT NULL,
  `paid_at` DATETIME DEFAULT NULL,
  `voided_by` INT UNSIGNED DEFAULT NULL,
  `voided_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_aff_payout_idem` (`idempotency_key`),
  KEY `idx_aff_payout_partner` (`partner_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_affiliate_payout_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payout_id` INT UNSIGNED NOT NULL,
  `commission_id` BIGINT UNSIGNED NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `released` TINYINT(1) NOT NULL DEFAULT 0,
  `active_commission_id` BIGINT UNSIGNED AS (IF(`released` = 0, `commission_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_aff_payout_item_active` (`active_commission_id`),
  KEY `idx_aff_payout_item_payout` (`payout_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
