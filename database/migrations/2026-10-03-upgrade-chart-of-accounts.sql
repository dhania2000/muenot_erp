-- ---------------------------------------------------------------------------
-- Chart of Accounts master upgrade.
--
-- Adds the account-hierarchy / posting-configuration columns the upgraded
-- master needs and flags the posting-engine control accounts as system
-- accounts so they cannot be renamed, recoded, deactivated or deleted from the
-- UI. The columns are also self-healed at runtime by
-- lib/finance-ensure.ts → ensureChartOfAccountsColumns() so this migration is
-- purely a record of the schema change; both are idempotent.
--
-- IMPORTANT: this preserves every existing linkage. Journal, General Ledger,
-- Purchase Bills, Sales Invoices, Expenses, Bank & Cash, GST, TDS and Reports
-- all resolve accounts by `account_id` / `account_code`, none of which change.
-- ---------------------------------------------------------------------------

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_date DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS financial_year VARCHAR(12) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_system TINYINT(1) NOT NULL DEFAULT 0;

-- Parent-account lookup index for the hierarchy view + dependency checks.
CREATE INDEX IF NOT EXISTS idx_coa_parent ON chart_of_accounts (parent_account_id);

-- Flag the posting-engine control accounts. Matched by the stable
-- account_code, so a company's own re-seeded account with the same code is
-- protected too. Codes mirror lib/finance-accounts.ts (ROLE_DEFAULT_CODE) and
-- the 2026-09-13 / 2026-10-02 seed migrations.
UPDATE chart_of_accounts
   SET is_system = 1
 WHERE account_code IN (
   '1200', -- Accounts Receivable
   '1450', -- TDS Receivable
   '4000', -- Sales Revenue
   '2110', '2120', '2130', '2140', -- Output CGST / SGST / IGST / Cess (GST Payable)
   '1000', -- Bank
   '1010', -- Cash
   '5000', -- Purchases / Expenses
   '1410', '1420', '1430', '1440', -- Input CGST / SGST / IGST / Cess (GST Input)
   '2000', -- Accounts Payable
   '2150', -- TDS Payable
   '5100', -- General Expenses
   '2200', -- Employee Reimbursements Payable
   '1460'  -- Employee Advances
 );
