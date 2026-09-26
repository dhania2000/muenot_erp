-- Spec37 (#201) — Purchase three-way matching (follow-up).
--
-- Mirrors the on-demand DDL in lib/finance-three-way-match-server.ts so managed
-- deploys match the runtime schema exactly. Adds:
--   • the tenant-scoped bill ledger fields on finance_match_results used for
--     sibling-bill totals, duplicate detection, currency and the approval-inbox
--     binding (purchase_bills carries no tenant column, so these are read from
--     the scoped match ledger — never the unscoped bill table);
--   • the finance_match_events audit trail (every compute / override);
--   • the finance_match_idempotency ledger (replay-safe checker decisions).
--
-- Idempotent: every step is guarded, so it is safe to re-run. MySQL 8 supports
-- ADD COLUMN IF NOT EXISTS.

ALTER TABLE finance_match_results
  ADD COLUMN IF NOT EXISTS bill_number         VARCHAR(80)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS vendor_id           VARCHAR(60)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS currency            VARCHAR(10)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS billed_quantity     DECIMAL(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billed_taxable      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approval_request_id INT          DEFAULT NULL;

CREATE TABLE IF NOT EXISTS finance_match_events (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id            INT NOT NULL,
  bill_id              VARCHAR(30) NOT NULL,
  event_type           VARCHAR(30) NOT NULL,
  summary              VARCHAR(500) NOT NULL,
  detail               MEDIUMTEXT DEFAULT NULL,
  actor_id             INT DEFAULT NULL,
  actor_name           VARCHAR(190) DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_match_events_bill (tenant_id, bill_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS finance_match_idempotency (
  tenant_id            INT NOT NULL,
  idem_key             VARCHAR(100) NOT NULL,
  bill_id              VARCHAR(30) NOT NULL,
  decision             VARCHAR(10) NOT NULL,
  response             MEDIUMTEXT NOT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, idem_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
