-- SPEC 61 / 56-58 — Server-side session store + SSO (OIDC/SAML) identity providers.
--
-- Documents the schema that lib/session-store.ts and lib/sso-store.ts also
-- self-heal at runtime (same pattern as lib/secrets/store.ts and
-- lib/tenant-ensure.ts), so a fresh database converges without running this
-- file manually and an existing one can apply it directly.

CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(64) NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT NULL,
  `user_agent` VARCHAR(500) DEFAULT NULL,
  `login_method` VARCHAR(20) NOT NULL DEFAULT 'password',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_active_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NOT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  `revoked_reason` VARCHAR(60) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_user_sessions_session_id` (`session_id`),
  KEY `idx_user_sessions_user` (`user_id`),
  KEY `idx_user_sessions_tenant` (`tenant_id`),
  CONSTRAINT `fk_user_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_providers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `type` ENUM('oidc','saml') NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `status` ENUM('draft','enabled','disabled') NOT NULL DEFAULT 'draft',
  `domains` VARCHAR(255) DEFAULT NULL,
  `auto_provision` TINYINT(1) NOT NULL DEFAULT 1,
  `default_role` ENUM('admin','employee') NOT NULL DEFAULT 'employee',
  `issuer_url` VARCHAR(255) DEFAULT NULL,
  `discovery_url` VARCHAR(255) DEFAULT NULL,
  `authorization_endpoint` VARCHAR(255) DEFAULT NULL,
  `token_endpoint` VARCHAR(255) DEFAULT NULL,
  `userinfo_endpoint` VARCHAR(255) DEFAULT NULL,
  `jwks_uri` VARCHAR(255) DEFAULT NULL,
  `client_id` VARCHAR(255) DEFAULT NULL,
  `client_secret_encrypted` TEXT DEFAULT NULL,
  `scopes` VARCHAR(255) DEFAULT 'openid email profile',
  `entity_id` VARCHAR(255) DEFAULT NULL,
  `sso_url` VARCHAR(255) DEFAULT NULL,
  `certificate` TEXT DEFAULT NULL,
  `email_attribute` VARCHAR(120) DEFAULT NULL,
  `first_name_attribute` VARCHAR(120) DEFAULT NULL,
  `last_name_attribute` VARCHAR(120) DEFAULT NULL,
  `employee_id_attribute` VARCHAR(120) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_login_at` DATETIME DEFAULT NULL,
  `last_test_at` DATETIME DEFAULT NULL,
  `last_test_ok` TINYINT(1) DEFAULT NULL,
  `last_test_message` VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sso_providers_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_login_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `email` VARCHAR(190) DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL,
  `message` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sso_login_events_provider` (`provider_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_identities` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT, `provider_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL, `user_id` INT UNSIGNED NOT NULL, `subject` VARCHAR(255) NOT NULL,
  `email_at_link` VARCHAR(190) DEFAULT NULL, `deprovisioned_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uniq_sso_identity_subject` (`provider_id`,`subject`),
  UNIQUE KEY `uniq_sso_identity_user` (`provider_id`,`user_id`), KEY `idx_sso_identity_tenant` (`tenant_id`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
