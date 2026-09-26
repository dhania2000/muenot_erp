-- Spec47 — Security review & separate audit streams (#38-40, #209-212, #245-249).
-- ---------------------------------------------------------------------------
-- Spec47 adds NO new audit trail. It projects the three EXISTING append-only
-- trails (`audit_log_entries`, `security_audit_events`, `platform_admin_audit`)
-- into five separated streams and lets privileged operators produce masked,
-- retention/legal-hold-aware exports. This migration only adds the export
-- LEDGER — an append-only record of every export produced (who, why, what
-- scope, how many rows, and the tamper-evident digest of the payload).
--
-- The store (lib/audit-streams-store.ts) self-heals this same schema at runtime
-- (matching the audit-log/security-event pattern), so this file exists for
-- fresh installs and to document the shape; no manual step is required.

CREATE TABLE IF NOT EXISTS `security_audit_exports` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 0 = a platform-side export; otherwise the tenant that produced it.
  `tenant_scope` INT UNSIGNED NOT NULL DEFAULT 0,
  `stream` VARCHAR(16) NOT NULL,
  `masked` TINYINT(1) NOT NULL DEFAULT 1,
  `reason` VARCHAR(500) NOT NULL,
  `from_ts` DATETIME(3) DEFAULT NULL,
  `to_ts` DATETIME(3) DEFAULT NULL,
  `row_limit` INT UNSIGNED NOT NULL DEFAULT 1000,
  `filter_tenant_id` INT UNSIGNED DEFAULT NULL,
  `record_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `excluded_by_retention` INT UNSIGNED NOT NULL DEFAULT 0,
  `held_count` INT UNSIGNED NOT NULL DEFAULT 0,
  -- Hash chain over the exported records; any post-export edit/reorder changes it.
  `digest` CHAR(64) NOT NULL,
  -- Fingerprint of the export REQUEST, used to detect idempotency-key reuse with
  -- a different request body.
  `fingerprint` CHAR(64) NOT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_email` VARCHAR(190) DEFAULT NULL,
  `viewer_kind` VARCHAR(32) NOT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_export_idem` (`tenant_scope`, `idempotency_key`),
  KEY `idx_export_scope_stream` (`tenant_scope`, `stream`),
  KEY `idx_export_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The export ledger is itself evidence: append-only. Reject every UPDATE, and
-- every DELETE (the ledger is never purged by tenant-facing paths). Best-effort:
-- a host that forbids trigger creation still has application-level immutability
-- (the store exposes no update/delete function and assertMutableTable() blocks
-- generic mutators).
DROP TRIGGER IF EXISTS `security_audit_exports_no_update`;
CREATE TRIGGER `security_audit_exports_no_update` BEFORE UPDATE ON `security_audit_exports`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_audit_exports is append-only';

DROP TRIGGER IF EXISTS `security_audit_exports_no_delete`;
CREATE TRIGGER `security_audit_exports_no_delete` BEFORE DELETE ON `security_audit_exports`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_audit_exports is append-only';
