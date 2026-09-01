-- Adds bank-reconciliation tracking to finance_records so the Finance Dashboard
-- can show a Reconciled / Unreconciled / Exception breakdown for bank transactions.
ALTER TABLE finance_records
  ADD COLUMN reconciliation_status ENUM('Reconciled','Unreconciled','Exception') DEFAULT NULL AFTER status;

-- Helpful index for the dashboard's "recent bank transactions" + reconciliation queries.
ALTER TABLE finance_records
  ADD INDEX idx_finance_reconciliation (module_key, reconciliation_status);
