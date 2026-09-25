-- Spec6 — SaaS tax, revenue & accounting (#81-83, #240-241)
-- ---------------------------------------------------------------------------
-- Materializes the schema that the SaaS billing services self-heal at runtime
-- so fresh installs get it directly; existing installs converge on first use.
-- Safe to run more than once.
--
--   * billing_invoices GST columns  -> lib/billing/billing-engine.ts
--   * platform_journal(+lines)       -> lib/billing/platform-ledger.ts
--   * deferred_revenue_*             -> lib/billing/revenue-recognition.ts
--
-- The platform seller ledger (platform_journal) is DELIBERATELY separate from
-- the customer's own ERP finance ledger (general_ledger): billing a customer
-- for their subscription is the PLATFORM's revenue/receivable and must never
-- post into that customer's books. Both are scoped by tenant_id.

-- ── GST / place-of-supply on the SaaS invoice (#81-83) ──────────────────────
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `credit_note_of`       INT UNSIGNED DEFAULT NULL;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `seller_gstin`         VARCHAR(20)  DEFAULT NULL;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `place_of_supply`      VARCHAR(120) DEFAULT NULL;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `place_of_supply_code` VARCHAR(4)   DEFAULT NULL;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `supply_type`          VARCHAR(16)  DEFAULT NULL;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `igst_total`           DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `cgst_total`           DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE `billing_invoices` ADD COLUMN IF NOT EXISTS `sgst_total`           DECIMAL(14,2) NOT NULL DEFAULT 0;

-- ── Platform seller ledger (double-entry, separate from customer books) ─────
CREATE TABLE IF NOT EXISTS `platform_journal` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `tenant_id`    INT NOT NULL,
  `entry_no`     VARCHAR(32) NOT NULL,
  `source_type`  VARCHAR(24) NOT NULL,
  `source_id`    VARCHAR(64) NOT NULL,
  `event_type`   VARCHAR(32) NOT NULL,
  `entry_date`   DATE NOT NULL,
  `memo`         VARCHAR(255) NULL,
  `total_debit`  DECIMAL(14,2) NOT NULL DEFAULT 0,
  `total_credit` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_by`   VARCHAR(64) NULL,
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Idempotency: one journal per (tenant, source, event) — retries never double-post.
  UNIQUE KEY `uq_platform_journal_src` (`tenant_id`, `source_type`, `source_id`, `event_type`),
  KEY `idx_platform_journal_tenant` (`tenant_id`, `entry_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_journal_lines` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `tenant_id`    INT NOT NULL,
  `journal_id`   INT NOT NULL,
  `account_code` VARCHAR(16) NOT NULL,
  `account_name` VARCHAR(64) NOT NULL,
  `debit`        DECIMAL(14,2) NOT NULL DEFAULT 0,
  `credit`       DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_platform_journal_lines_journal` (`journal_id`),
  KEY `idx_platform_journal_lines_acct` (`tenant_id`, `account_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Deferred revenue & straight-line recognition (#240-241) ─────────────────
CREATE TABLE IF NOT EXISTS `deferred_revenue_schedules` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `tenant_id`       INT NOT NULL,
  `invoice_id`      INT NOT NULL,
  `subscription_id` INT NULL,
  `currency`        VARCHAR(8) NOT NULL DEFAULT 'INR',
  `total_amount`    DECIMAL(14,2) NOT NULL DEFAULT 0,
  `months`          INT NOT NULL DEFAULT 1,
  `start_date`      DATE NOT NULL,
  `status`          VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_at`      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_defrev_invoice` (`tenant_id`, `invoice_id`),
  KEY `idx_defrev_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `deferred_revenue_entries` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `tenant_id`     INT NOT NULL,
  `schedule_id`   INT NOT NULL,
  `period_month`  CHAR(7) NOT NULL,
  `period_start`  DATE NOT NULL,
  `period_end`    DATE NOT NULL,
  `amount`        DECIMAL(14,2) NOT NULL DEFAULT 0,
  `recognized`    TINYINT NOT NULL DEFAULT 0,
  `recognized_at` DATE NULL,
  `journal_id`    INT NULL,
  `created_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_defrev_entries_sched` (`schedule_id`),
  KEY `idx_defrev_entries_due` (`tenant_id`, `recognized`, `period_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit + idempotency for every deferred-revenue reduction by a credit note/void.
CREATE TABLE IF NOT EXISTS `deferred_revenue_reversals` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `tenant_id`        INT NOT NULL,
  `invoice_id`       INT NOT NULL,
  `source_type`      VARCHAR(24) NOT NULL,
  `source_id`        VARCHAR(64) NOT NULL,
  `requested_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `from_deferred`    DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_defrev_reversal_src` (`tenant_id`, `source_type`, `source_id`),
  KEY `idx_defrev_reversal_invoice` (`tenant_id`, `invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
