-- ---------------------------------------------------------------------------
-- Per-financial-year opening balances for the Chart of Accounts.
--
-- Adds a dedicated store so an account can carry a distinct opening balance for
-- every financial year, each projected into its own balanced Journal + General
-- Ledger voucher (contra on the Opening Balance Equity head, code 3900). One
-- row per (account_id, financial_year); the posting tracking columns key each
-- year's voucher so it posts, re-posts and reverses independently and
-- idempotently.
--
-- The chart_of_accounts.opening_balance / opening_balance_type /
-- opening_balance_date / financial_year columns are UNCHANGED and remain the
-- account's PRIMARY year — the value shown in the master list, the summary KPI,
-- the exports and the 360° view. lib/finance-opening-balance.ts mirrors that
-- primary entry into this table and back on every sync so the two never drift.
--
-- This table is also created and backfilled at runtime by
-- lib/finance-opening-balance.ts -> ensureOpeningBalanceTable(), so this
-- migration is purely a record of the schema change; both are idempotent and
-- preserve every existing linkage (Journal, General Ledger, Purchase Bills,
-- Sales Invoices, Expenses, Bank & Cash, GST, TDS, Reports).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coa_opening_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id VARCHAR(40) NOT NULL,
  financial_year VARCHAR(12) NOT NULL,
  opening_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  opening_balance_type VARCHAR(10) DEFAULT NULL,
  opening_balance_date DATE DEFAULT NULL,
  ob_voucher_no VARCHAR(40) DEFAULT NULL,
  ob_posted_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  ob_posted_side VARCHAR(10) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coa_ob_year (account_id, financial_year),
  KEY idx_coa_ob_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill the legacy single opening balance held on chart_of_accounts into its
-- financial-year row, carrying the posted-voucher state so it is never
-- re-posted. Rows whose financial_year is blank are backfilled at runtime
-- (where the year can be derived from the opening-balance date).
INSERT INTO coa_opening_balances
    (account_id, financial_year, opening_balance, opening_balance_type,
     opening_balance_date, ob_voucher_no, ob_posted_amount, ob_posted_side)
SELECT c.account_id, c.financial_year, c.opening_balance, c.opening_balance_type,
       c.opening_balance_date, c.ob_voucher_no, c.ob_posted_amount, c.ob_posted_side
  FROM chart_of_accounts c
 WHERE (c.opening_balance <> 0 OR (c.ob_voucher_no IS NOT NULL AND c.ob_voucher_no <> ''))
   AND c.financial_year IS NOT NULL AND c.financial_year <> ''
   AND c.account_code <> '3900'
ON DUPLICATE KEY UPDATE account_id = coa_opening_balances.account_id;
