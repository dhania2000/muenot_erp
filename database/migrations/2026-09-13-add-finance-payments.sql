-- ---------------------------------------------------------------------------
-- Phase 2 — Payments as source of truth + cancel reversal
--
-- Run-once, idempotent. Adds the `payments` table (append-only cash receipts
-- applied against a source document, currently sales invoices), the columns a
-- sales invoice needs to track a cancel reversal, and the PAY id sequence.
--
-- A payment records money actually received. Recording it posts the cash side
-- of the entry (Dr Bank/Cash, Cr Accounts Receivable) so the ledger — not a
-- free-text field on the invoice — becomes the source of truth for cash.
-- Reversing a payment (bounced cheque, mistaken entry) unwinds that voucher;
-- cancelling a posted invoice reverses its original sales voucher.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_id VARCHAR(40) NOT NULL,
  -- source document this receipt is applied against
  entity_type VARCHAR(40) NOT NULL DEFAULT 'sales_invoice',
  invoice_pk BIGINT UNSIGNED DEFAULT NULL,
  invoice_ref VARCHAR(40) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(255) DEFAULT NULL,
  payment_date DATE NOT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- how the money arrived; deposit_role selects the ledger account (bank|cash)
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'Bank',
  deposit_role VARCHAR(10) NOT NULL DEFAULT 'bank',
  reference_no VARCHAR(120) DEFAULT NULL,
  narration VARCHAR(255) DEFAULT NULL,
  -- cash-side posting created when the payment is recorded
  voucher_no VARCHAR(40) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',        -- Active | Reversed
  reversal_voucher_no VARCHAR(40) DEFAULT NULL,
  reversal_reason VARCHAR(255) DEFAULT NULL,
  reversed_at TIMESTAMP NULL DEFAULT NULL,
  reversed_by BIGINT UNSIGNED DEFAULT NULL,
  idempotency_key VARCHAR(80) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pay_payment_id (payment_id),
  UNIQUE KEY uq_pay_idempotency (idempotency_key),
  KEY idx_pay_invoice (invoice_pk),
  KEY idx_pay_status (status),
  KEY idx_pay_party (party_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reversal tracking for a cancelled posted invoice. cancelled_at already exists
-- (added by the sales-invoice runtime schema); only the voucher/reason are new.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'sales_invoices' AND column_name = 'reversal_voucher_no');
SET @sql := IF(@col = 0,
  'ALTER TABLE sales_invoices ADD COLUMN reversal_voucher_no VARCHAR(40) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'sales_invoices' AND column_name = 'cancel_reason');
SET @sql := IF(@col = 0,
  'ALTER TABLE sales_invoices ADD COLUMN cancel_reason VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- PAY id sequence (nextRecordId("PAY")). Seed only if not already present.
INSERT INTO record_id_sequences (prefix, next_number)
SELECT 'PAY', 0
WHERE NOT EXISTS (SELECT 1 FROM record_id_sequences WHERE prefix = 'PAY');
