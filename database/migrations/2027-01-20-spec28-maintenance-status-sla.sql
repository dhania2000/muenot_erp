-- Spec28 — Maintenance mode, public status and support SLA (#125-127)
-- ---------------------------------------------------------------------------
-- • platform_maintenance_windows: platform / tenant / module maintenance
--   switches as scheduled windows. Platform rows have tenant_id NULL, so this
--   table is intentionally NOT in the tenant-owned registry; isolation is
--   enforced in lib/maintenance/store.ts.
-- • platform_support_sla_policies: global SLA targets per support_level
--   (from plan entitlements) × ticket priority.
-- • platform_support_tickets / _events: tenant-owned customer→platform tickets
--   with SLA deadlines snapshotted at creation and breach flags.
-- Public status is derived from existing tables (system_health_checks and
-- platform_dr_incidents/_events); customer-facing incident updates are stored
-- as DR events with kind = 'public_update'. The runtime stores self-heal the
-- same schema for existing installs; this migration is for fresh installs.

CREATE TABLE IF NOT EXISTS `platform_maintenance_windows` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scope` VARCHAR(16) NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `module_key` VARCHAR(48) DEFAULT NULL,
  `title` VARCHAR(200) NOT NULL,
  `message` VARCHAR(1000) NOT NULL DEFAULT '',
  `starts_at` DATETIME NOT NULL,
  `ends_at` DATETIME DEFAULT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'scheduled',
  `idempotency_scope` VARCHAR(40) NOT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `ended_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_maint_idem` (`idempotency_scope`, `idempotency_key`),
  KEY `idx_maint_active` (`status`, `starts_at`),
  KEY `idx_maint_tenant` (`tenant_id`, `status`),
  CONSTRAINT `fk_maint_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_support_sla_policies` (
  `support_level` VARCHAR(16) NOT NULL,
  `priority` VARCHAR(16) NOT NULL,
  `response_minutes` INT UNSIGNED NOT NULL,
  `resolution_minutes` INT UNSIGNED NOT NULL,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`support_level`, `priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `platform_support_sla_policies` (`support_level`, `priority`, `response_minutes`, `resolution_minutes`) VALUES
  ('community','low',4320,21600),('community','normal',2880,14400),('community','high',1440,7200),('community','urgent',720,4320),
  ('email','low',1440,7200),('email','normal',480,4320),('email','high',240,1440),('email','urgent',120,720),
  ('priority','low',480,2880),('priority','normal',240,1440),('priority','high',60,480),('priority','urgent',30,240),
  ('dedicated','low',240,1440),('dedicated','normal',60,480),('dedicated','high',30,240),('dedicated','urgent',15,120);

CREATE TABLE IF NOT EXISTS `platform_support_tickets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `reference` VARCHAR(40) NOT NULL,
  `subject` VARCHAR(200) NOT NULL,
  `description` TEXT,
  `priority` VARCHAR(16) NOT NULL DEFAULT 'normal',
  `status` VARCHAR(24) NOT NULL DEFAULT 'open',
  `plan_code` VARCHAR(64) DEFAULT NULL,
  `support_level` VARCHAR(16) NOT NULL,
  `response_due_at` DATETIME NOT NULL,
  `resolution_due_at` DATETIME NOT NULL,
  `first_response_at` DATETIME DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  `response_breached` TINYINT(1) NOT NULL DEFAULT 0,
  `resolution_breached` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_pst_ref` (`reference`),
  UNIQUE KEY `uniq_pst_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_pst_tenant` (`tenant_id`, `status`),
  KEY `idx_pst_due` (`status`, `response_due_at`, `resolution_due_at`),
  CONSTRAINT `fk_pst_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_support_ticket_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `ticket_id` BIGINT UNSIGNED NOT NULL,
  `kind` VARCHAR(24) NOT NULL,
  `visibility` VARCHAR(12) NOT NULL DEFAULT 'customer',
  `message` VARCHAR(5000) NOT NULL DEFAULT '',
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pste_ticket` (`tenant_id`, `ticket_id`, `created_at`),
  CONSTRAINT `fk_pste_ticket` FOREIGN KEY (`ticket_id`)
    REFERENCES `platform_support_tickets` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_pste_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
