-- Spec43 (#196-199, #207-208) — Risk & compliance dashboards.
-- The dashboard AGGREGATES existing subsystems (approvals, maker-checker,
-- security audit, background jobs, payments, GST/TDS/reconciliation, HR
-- documents/attendance/training and contract obligations). It creates NO new
-- source-of-truth data; the only table it owns is a snapshot cache used for
-- staleness detection and idempotent refreshes.
--
-- Mirrors lib/risk-compliance/schema.ts (self-healing on first request).

CREATE TABLE IF NOT EXISTS `risk_compliance_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  -- Canonical key for the aggregation scope, e.g. "group" | "company:12" |
  -- "branch:4" | "department:Finance". Lets one tenant cache several scopes.
  `scope_key` VARCHAR(190) NOT NULL DEFAULT 'group',
  -- Full computed dashboard payload (metrics + per-source rollups).
  `payload` JSON NOT NULL,
  -- Wall-clock time the payload was computed; drives staleness.
  `computed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `computed_by` INT UNSIGNED DEFAULT NULL,
  -- Idempotency for POST /refresh: a repeated key returns the same row.
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rc_snapshot_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_rc_snapshot_scope` (`tenant_id`, `scope_key`, `computed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
