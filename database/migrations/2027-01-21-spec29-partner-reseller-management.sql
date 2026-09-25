-- Spec29 — Partner and reseller management (#172)
-- ---------------------------------------------------------------------------
-- Platform-owned tables (no tenant_id ownership), so they are intentionally
-- NOT in the tenant-owned registry; isolation is enforced in
-- lib/partners/store.ts (platform-role guards + session-derived partner scope).
-- • platform_partners: organization, contract terms, revenue share, refund
--   window, signup referral code.
-- • platform_partner_members: users granted partner-dashboard access. Confers
--   no tenant or platform role.
-- • platform_partner_referrals: tenant attribution with ownership and history.
--   The generated active_tenant_id column + unique key enforce ONE active
--   attribution per tenant.
-- • platform_partner_commissions: append-only ledger. entry_key is unique so
--   settlement (commission:<invoice>) and clawback
--   (clawback:<invoice>:<partner>:<refund-state>) are idempotent.
-- Commissions settle against the existing platform_invoices subsystem
-- (paid + refund window elapsed). The runtime store self-heals the same schema
-- for existing installs; this migration is for fresh installs.

CREATE TABLE IF NOT EXISTS `platform_partners` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(160) NOT NULL,
  `kind` VARCHAR(16) NOT NULL DEFAULT 'referral',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `contact_email` VARCHAR(190) DEFAULT NULL,
  `referral_code` VARCHAR(16) DEFAULT NULL,
  `revenue_share_bps` INT UNSIGNED NOT NULL DEFAULT 0,
  `refund_window_days` INT UNSIGNED NOT NULL DEFAULT 30,
  `contract_start` DATE NOT NULL,
  `contract_end` DATE DEFAULT NULL,
  `eligibility_months` INT UNSIGNED DEFAULT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_partner_idem` (`idempotency_key`),
  UNIQUE KEY `uniq_partner_code` (`referral_code`),
  KEY `idx_partner_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_partner_members` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `partner_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `revoked_by` INT UNSIGNED DEFAULT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_partner_member` (`partner_id`, `user_id`),
  KEY `idx_partner_member_user` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_partner_referrals` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `partner_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `ownership` VARCHAR(16) NOT NULL DEFAULT 'platform',
  `source` VARCHAR(16) NOT NULL DEFAULT 'platform',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `active_tenant_id` INT UNSIGNED AS (IF(`status` = 'active', `tenant_id`, NULL)) STORED,
  `attributed_at` DATETIME NOT NULL,
  `ended_at` DATETIME DEFAULT NULL,
  `ended_reason` VARCHAR(300) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `ended_by` INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_referral_active_tenant` (`active_tenant_id`),
  KEY `idx_referral_partner` (`partner_id`, `status`),
  KEY `idx_referral_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_partner_commissions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entry_key` VARCHAR(120) NOT NULL,
  `partner_id` INT UNSIGNED NOT NULL,
  `referral_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `invoice_id` INT UNSIGNED NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
  `share_bps` INT UNSIGNED NOT NULL,
  `settled_at` DATETIME NOT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_commission_entry` (`entry_key`),
  KEY `idx_commission_partner` (`partner_id`, `settled_at`),
  KEY `idx_commission_invoice` (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
