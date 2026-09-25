-- Spec21 (requirement #35) — WebAuthn security keys / passkeys.
-- ---------------------------------------------------------------------------
-- Phishing-resistant MFA storage. Mirrors the self-healing DDL in
-- lib/webauthn-store.ts (ensureWebAuthnSchema) so operators who apply schema
-- out of band converge to the exact same shape the application creates at
-- runtime. Safe to run repeatedly (IF NOT EXISTS).
--
-- Guarantees these tables back:
--   * webauthn_credentials  — one row per enrolled authenticator, scoped by
--     (tenant_id, user_id). Every lookup filters on both, which is the
--     cross-tenant defense. credential_id is globally UNIQUE so one physical
--     authenticator can never be silently rebound to a second account.
--   * webauthn_challenges   — single-use challenges bound to
--     (tenant_id, user_id, purpose, origin, rp_id) with a short expiry.
--     Consumption deletes the row atomically, so a cloned/replayed challenge
--     can only ever be spent once.
--   * webauthn_auth_failures — per-user failure ledger driving the sliding
--     authentication lockout that stops a cloned-key / replay probe.

CREATE TABLE IF NOT EXISTS `webauthn_credentials` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `credential_id` VARCHAR(255) NOT NULL,
  `public_key` TEXT NOT NULL,
  `sign_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `transports` VARCHAR(255) DEFAULT NULL,
  `label` VARCHAR(120) DEFAULT NULL,
  `backed_up` TINYINT(1) NOT NULL DEFAULT 0,
  `aaguid` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_webauthn_credential_id` (`credential_id`),
  KEY `idx_webauthn_user` (`tenant_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `webauthn_challenges` (
  `id` VARCHAR(64) NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `purpose` ENUM('register','authenticate') NOT NULL,
  `challenge` VARCHAR(255) NOT NULL,
  `origin` VARCHAR(255) NOT NULL,
  `rp_id` VARCHAR(255) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webauthn_challenge_user` (`tenant_id`, `user_id`, `purpose`),
  KEY `idx_webauthn_challenge_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `webauthn_auth_failures` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `reason` VARCHAR(64) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_webauthn_failures` (`tenant_id`, `user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
