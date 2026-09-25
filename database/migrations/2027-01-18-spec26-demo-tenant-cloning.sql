-- Spec26 — Demo tenant & cloning (#121, #122)
-- ---------------------------------------------------------------------------
-- Registry of demo tenants: exactly one canonical `template` (marked, seeded
-- with synthetic data) plus any number of `clone`s provisioned from it. Each
-- clone is an isolated tenant with its own fresh ids and admin credentials and
-- a TTL after which it is expired and purged.
--
-- The store (lib/demo-tenant-store.ts) also self-heals this schema at runtime
-- (CREATE TABLE IF NOT EXISTS), so this migration is the durable/portable
-- record of the schema and is safe to run repeatedly.
--
-- NOTE: this table only tracks which tenants are demos and their lifecycle.
-- The synthetic business data lives in the normal tenant-owned tables (e.g.
-- `clients`) scoped by tenant_id. Secrets, integrations, billing/payment and
-- session tables are NEVER cloned — see DEMO_CLONE_DENYLIST in the model.

CREATE TABLE IF NOT EXISTS `demo_tenants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `kind` ENUM('template','clone') NOT NULL,
  `source_template_tenant_id` INT UNSIGNED NULL,
  `status` ENUM('active','expired','cleaned') NOT NULL DEFAULT 'active',
  `label` VARCHAR(190) NULL,
  `admin_user_id` INT UNSIGNED NULL,
  `admin_email` VARCHAR(190) NULL,
  -- Clones only: when the demo tenant expires and becomes eligible for cleanup.
  `expires_at` DATETIME NULL,
  `created_by` INT UNSIGNED NULL,
  -- Scopes an idempotent clone retry so a replayed request never provisions a second tenant.
  `idempotency_key` VARCHAR(100) NULL,
  `seeded_at` DATETIME NULL,
  `last_reset_at` DATETIME NULL,
  `cleaned_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_demo_tenant` (`tenant_id`),
  UNIQUE KEY `uq_demo_idem` (`idempotency_key`),
  KEY `idx_demo_kind_status` (`kind`, `status`),
  KEY `idx_demo_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
