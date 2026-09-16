-- =====================================================================
-- Finance > Loans & Advances sub-module — full schema
-- ---------------------------------------------------------------------
-- Mirrors the self-healing schema the app builds at runtime:
--   * base `loans_advances` table      -> lib/finance-ensure.ensureRegisterModuleTables
--   * Phase-4 extra columns            -> lib/finance-ensure.ensureLoansAdvancesColumns
--   * loans_advances_schedule          -> per-installment amortisation schedule
--
-- Idempotent: safe to run on a fresh DB or an existing one (uses
-- CREATE TABLE IF NOT EXISTS). All accounting still flows Journal -> GL
-- through the shared posting engine (lib/finance-register-posting); these
-- tables only hold the loan master and its repayment schedule.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Loan / advance master (base + Phase-4 columns merged into one definition)
--    `direction` distinguishes a loan/advance GIVEN (asset/receivable) from
--    one TAKEN (liability/payable); the posting engine keys off it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans_advances (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  loan_id                VARCHAR(30)  NOT NULL,
  party_name             VARCHAR(255) DEFAULT NULL,
  party_type             VARCHAR(40)  DEFAULT NULL,
  direction              VARCHAR(40)  DEFAULT NULL,
  principal              DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_rate          DECIMAL(6,2)  NOT NULL DEFAULT 0,
  disbursement_date      DATE         DEFAULT NULL,
  financial_year         VARCHAR(12)  DEFAULT NULL,
  funding_source         VARCHAR(40)  DEFAULT NULL,
  repayment_terms        VARCHAR(255) DEFAULT NULL,
  outstanding_amount     DECIMAL(16,2) NOT NULL DEFAULT 0,
  status                 VARCHAR(30)  NOT NULL DEFAULT 'Active',
  notes                  TEXT         DEFAULT NULL,

  -- Posting columns (shared voucher engine)
  posting_status         VARCHAR(20)  NOT NULL DEFAULT 'Unposted',
  voucher_no             VARCHAR(30)  DEFAULT NULL,
  reversal_voucher_no    VARCHAR(30)  DEFAULT NULL,
  posted_amount          DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot        LONGTEXT     DEFAULT NULL,
  posted_at              DATETIME     DEFAULT NULL,

  -- Phase-4 additional columns (ensureLoansAdvancesColumns)
  loan_type              VARCHAR(40)  DEFAULT NULL,
  party_id               VARCHAR(40)  DEFAULT NULL,
  interest_method        VARCHAR(30)  DEFAULT NULL,
  start_date             DATE         DEFAULT NULL,
  end_date               DATE         DEFAULT NULL,
  tenure_months          INT          NOT NULL DEFAULT 0,
  installment_frequency  VARCHAR(20)  DEFAULT NULL,
  emi_amount             DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_total         DECIMAL(16,2) NOT NULL DEFAULT 0,
  total_payable          DECIMAL(16,2) NOT NULL DEFAULT 0,
  outstanding_principal  DECIMAL(16,2) NOT NULL DEFAULT 0,
  outstanding_interest   DECIMAL(16,2) NOT NULL DEFAULT 0,
  purpose                VARCHAR(255) DEFAULT NULL,
  bank_account_id        VARCHAR(40)  DEFAULT NULL,
  bank_account_name      VARCHAR(190) DEFAULT NULL,
  document_url           TEXT         DEFAULT NULL,

  created_by             INT          DEFAULT NULL,
  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_la_id (loan_id),
  KEY idx_la_fy (financial_year),
  KEY idx_la_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2. Per-installment amortisation schedule
--    One row per loan + installment. Regenerated wholesale whenever the
--    loan's principal / rate / tenure / method / start date change, and
--    dropped on loan delete (see lib/finance-crud AFTER_DELETE hook).
--    No direct accounting impact — a repayment plan / tracking log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans_advances_schedule (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  loan_id              VARCHAR(30)  NOT NULL,
  installment_no       INT          NOT NULL DEFAULT 0,
  due_date             DATE         DEFAULT NULL,
  opening_balance      DECIMAL(16,2) NOT NULL DEFAULT 0,
  emi                  DECIMAL(16,2) NOT NULL DEFAULT 0,
  principal_component  DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_component   DECIMAL(16,2) NOT NULL DEFAULT 0,
  closing_balance      DECIMAL(16,2) NOT NULL DEFAULT 0,
  status               VARCHAR(20)  NOT NULL DEFAULT 'Due',
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_las_loan (loan_id),
  KEY idx_las_due (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
