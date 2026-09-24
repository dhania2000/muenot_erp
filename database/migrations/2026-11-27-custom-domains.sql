-- SPEC 157 — Custom Domain.
--
-- Per-tenant custom domains (e.g. erp.customer.com) with ownership verification
-- and activation state. lib/custom-domain-store.ts self-heals this schema at
-- runtime (same pattern as lib/sso-store.ts), so a fresh database converges
-- without running this file manually and an existing one can apply it directly.
--
-- Isolation: `hostname` is globally UNIQUE (a domain belongs to exactly one
-- tenant); every admin operation additionally filters by `tenant_id`. The
-- (hostname, status) index backs the pre-auth host -> tenant resolution used to
-- brand the login screen on a customer's own domain.

CREATE TABLE IF NOT EXISTS `tenant_domains` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `hostname` VARCHAR(253) NOT NULL,
  `status` ENUM('pending','verified','active','disabled','failed') NOT NULL DEFAULT 'pending',
  `verification_token` VARCHAR(64) NOT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `activated_at` DATETIME DEFAULT NULL,
  `last_checked_at` DATETIME DEFAULT NULL,
  `last_error` VARCHAR(255) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_domains_hostname` (`hostname`),
  KEY `idx_tenant_domains_tenant` (`tenant_id`),
  KEY `idx_tenant_domains_active` (`hostname`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
