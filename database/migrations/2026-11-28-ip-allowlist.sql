-- IP allowlisting for sign-in.
--
-- Documents the schema that lib/ip-allowlist-store.ts also self-heals at
-- runtime (same pattern as lib/session-store.ts and lib/secrets/store.ts),
-- so a fresh database converges without running this file manually and an
-- existing one can apply it directly.

CREATE TABLE IF NOT EXISTS `ip_allowlist_entries` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `label` VARCHAR(120) NOT NULL,
  `cidr` VARCHAR(64) NOT NULL,
  `mode` ENUM('allow','block') NOT NULL DEFAULT 'allow',
  `scope` ENUM('all','admin') NOT NULL DEFAULT 'all',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_matched_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ip_allowlist_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
