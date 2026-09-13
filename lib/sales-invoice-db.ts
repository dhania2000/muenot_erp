import { query } from "@/lib/db"

/**
 * Runtime, idempotent schema upgrade for the Sales Invoice module.
 *
 * This follows the same self-creating pattern as lib/clients-db.ts so the
 * upgraded invoice architecture works on existing databases without depending
 * on a migration runner. It is safe to call on every request — the guards make
 * every statement a no-op once applied.
 *
 * What it adds on top of 2026-09-06-add-sales-invoices.sql:
 *   - sales_invoice_items: one invoice → many structured line items.
 *   - canonical party / source links (customer_party_id, contract_id,
 *     quotation_id, source_type, original_invoice_id).
 *   - place-of-supply + seller GST snapshot columns for correct GST derivation.
 *   - posting-lifecycle columns (issued_at / posted_at / cancelled_at,
 *     journal_entry_id) and idempotency_key for safe retries.
 */

let ensured = false

/** ADD COLUMN only when it is not already present (MySQL has no ADD COLUMN IF NOT EXISTS). */
async function addColumnIfMissing(table: string, column: string, definition: string) {
  const rows = (await query(
    `SELECT COUNT(*) AS c
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )) as any[]
  if (Number(rows?.[0]?.c ?? 0) === 0) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export async function ensureSalesInvoiceSchema() {
  if (ensured) return

  // Structured line items. Keyed to the numeric sales_invoices.id so it survives
  // invoice_id string changes and joins cheaply.
  await query(
    `CREATE TABLE IF NOT EXISTS sales_invoice_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      invoice_pk BIGINT UNSIGNED NOT NULL,
      line_no INT NOT NULL DEFAULT 1,
      item_id VARCHAR(40) DEFAULT NULL,
      description TEXT,
      hsn_sac VARCHAR(20) DEFAULT NULL,
      quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
      unit VARCHAR(20) DEFAULT NULL,
      rate DECIMAL(14,2) NOT NULL DEFAULT 0,
      discount_type VARCHAR(10) NOT NULL DEFAULT 'amount',
      discount_value DECIMAL(14,2) NOT NULL DEFAULT 0,
      discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      taxable_value DECIMAL(14,2) NOT NULL DEFAULT 0,
      tax_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
      cgst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
      cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      sgst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
      sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      igst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
      igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      cess_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      line_total DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_sii_invoice (invoice_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Additive header columns. Each is nullable / has a default so existing rows
  // and the existing PDF / list code keep working unchanged.
  const cols: Array<[string, string]> = [
    ["customer_party_id", "VARCHAR(40) DEFAULT NULL"],
    ["contract_id", "VARCHAR(40) DEFAULT NULL"],
    ["quotation_id", "VARCHAR(40) DEFAULT NULL"],
    ["milestone_id", "VARCHAR(40) DEFAULT NULL"],
    ["source_type", "VARCHAR(30) NOT NULL DEFAULT 'Manual'"],
    ["original_invoice_id", "VARCHAR(40) DEFAULT NULL"],
    ["place_of_supply", "VARCHAR(120) DEFAULT NULL"],
    ["place_of_supply_code", "VARCHAR(6) DEFAULT NULL"],
    ["seller_gstin", "VARCHAR(20) DEFAULT NULL"],
    ["seller_state_code", "VARCHAR(6) DEFAULT NULL"],
    ["supply_type", "VARCHAR(20) DEFAULT NULL"],
    ["idempotency_key", "VARCHAR(80) DEFAULT NULL"],
    ["journal_entry_id", "VARCHAR(40) DEFAULT NULL"],
    ["issued_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["posted_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["cancelled_at", "TIMESTAMP NULL DEFAULT NULL"],
    // Email delivery + payment-reminder bookkeeping (Phase 3 wiring).
    ["invoice_last_sent_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["invoice_last_sent_to", "VARCHAR(190) DEFAULT NULL"],
    ["reminder_count", "INT UNSIGNED NOT NULL DEFAULT 0"],
    ["last_reminder_at", "TIMESTAMP NULL DEFAULT NULL"],
  ]
  for (const [name, def] of cols) {
    await addColumnIfMissing("sales_invoices", name, def)
  }

  // Idempotency key is unique when present so a retried create cannot duplicate
  // a financial record. NULLs are allowed to repeat (legacy + manual rows).
  const idx = (await query(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'sales_invoices'
        AND index_name = 'uq_si_idempotency'`,
  )) as any[]
  if (Number(idx?.[0]?.c ?? 0) === 0) {
    await query(`ALTER TABLE sales_invoices ADD UNIQUE KEY uq_si_idempotency (idempotency_key)`)
  }

  ensured = true
}
