import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing schema for the Freelance Invoices sub-module. The config-driven
 * CRUD factory writes exactly the columns declared in the ModuleConfig, so the
 * new `freelancer_email` field (and the invoice-send tracking columns) must
 * exist before any INSERT/UPDATE runs. MySQL has no "ADD COLUMN IF NOT EXISTS",
 * so we check information_schema first. Runs once per process.
 */
let ensured = false

async function ensureColumn(table: string, column: string, definition: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function hasIndex(table: string, index: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )
  return rows.length > 0
}

export async function ensureFreelanceInvoiceColumns() {
  if (ensured) return
  await ensureColumn("freelance_invoices", "freelancer_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn("freelance_invoices", "invoice_last_sent_at", "DATETIME DEFAULT NULL")
  await ensureColumn("freelance_invoices", "invoice_last_sent_to", "VARCHAR(190) DEFAULT NULL")
  ensured = true
}

let fteEnsured = false

/**
 * Self-healing schema for the FTE Invoices sub-module. Mirrors the freelance
 * helper: the config now carries an `employee_email` recipient field plus the
 * invoice-send tracking columns, none of which exist in the base migration.
 */
export async function ensureFteInvoiceColumns() {
  if (fteEnsured) return
  await ensureColumn("fte_invoices", "employee_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn("fte_invoices", "invoice_last_sent_at", "DATETIME DEFAULT NULL")
  await ensureColumn("fte_invoices", "invoice_last_sent_to", "VARCHAR(190) DEFAULT NULL")
  fteEnsured = true
}

let cvEnsured = false

/**
 * Self-healing schema for the Customer / Vendor master. GSTIN verification
 * snapshots the taxpayer's registration details from the GST network onto the
 * party record, plus an authoritative verification status the server sets (it
 * never trusts a client-supplied status). None of these exist in the base
 * migration, so add them before any INSERT/UPDATE touches the table.
 */
export async function ensureCustomerVendorGstColumns() {
  if (cvEnsured) return
  // Vendor master fields introduced with the Vendors upgrade.
  await ensureColumn("customers_vendors", "trade_name", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("customers_vendors", "vendor_category", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn("customers_vendors", "registered_address", "TEXT DEFAULT NULL")
  await ensureColumn("customers_vendors", "upi_id", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn("customers_vendors", "tds_applicable", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn("customers_vendors", "kyc_status", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_trade_name", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_status", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_taxpayer_type", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn("customers_vendors", "business_constitution", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_registration_date", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_cancellation_date", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_block_status", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_verification_status", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_verified_at", "DATETIME DEFAULT NULL")
  await ensureColumn("customers_vendors", "gst_verification_source", "VARCHAR(60) DEFAULT NULL")
  cvEnsured = true
}

let pbEnsured = false

/**
 * Self-healing schema for the Purchase Bill master upgrade (Phases 1–5).
 *
 * Adds the immutable server-generated Bill ID, the frozen vendor snapshot
 * (GSTIN / PAN / TAN / state / addresses / terms), the place-of-supply + GST
 * split fields, the accounting heads and the document attachment columns. The
 * legacy schema keyed bills on `po_number` (UNIQUE) and used it as the display
 * id; we promote `bill_id` to the business key, backfill existing rows with a
 * stable legacy id, and relax the old PO uniqueness so PO Number becomes an
 * optional reference again.
 */
export async function ensurePurchaseBillColumns() {
  if (pbEnsured) return
  const t = "purchase_bills"

  // Phase 1 — immutable, server-generated Bill ID.
  await ensureColumn(t, "bill_id", "VARCHAR(30) DEFAULT NULL")

  // Phase 4 — bill information.
  await ensureColumn(t, "bill_number", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "grn_number", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn(t, "accounting_period", "VARCHAR(20) DEFAULT NULL")

  // Phase 2/3 — frozen vendor snapshot.
  await ensureColumn(t, "vendor_legal_name", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn(t, "vendor_gstin", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "vendor_pan", "VARCHAR(15) DEFAULT NULL")
  await ensureColumn(t, "vendor_tan", "VARCHAR(15) DEFAULT NULL")
  await ensureColumn(t, "vendor_state", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "vendor_state_code", "VARCHAR(6) DEFAULT NULL")
  await ensureColumn(t, "gst_registration_type", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "gst_status", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "currency", "VARCHAR(10) DEFAULT NULL")
  await ensureColumn(t, "payment_terms", "VARCHAR(40) DEFAULT NULL")

  // Phase 4 — billing + place of supply.
  await ensureColumn(t, "billing_address", "TEXT DEFAULT NULL")
  await ensureColumn(t, "supply_location", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "place_of_supply", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "place_of_supply_code", "VARCHAR(6) DEFAULT NULL")
  await ensureColumn(t, "supply_type", "VARCHAR(20) DEFAULT NULL")

  // Phase 5 — GST rate + TDS base.
  await ensureColumn(t, "gst_rate", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_base", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 4 — accounting heads.
  await ensureColumn(t, "expense_account", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "payable_account", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "cost_centre", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "department", "VARCHAR(120) DEFAULT NULL")

  // Phase 4 — document attachments.
  await ensureColumn(t, "bill_attachment_url", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "po_document_url", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "grn_document_url", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "supporting_docs_url", "TEXT DEFAULT NULL")

  // Backfill a stable, immutable id for any pre-existing rows so the business
  // key is never blank. Legacy rows are tagged PB-LEGACY-###### by row id.
  await query(
    `UPDATE ${t} SET bill_id = CONCAT('PB-LEGACY-', LPAD(id, 6, '0'))
       WHERE bill_id IS NULL OR bill_id = ''`,
  )

  // Drop the old PO Number uniqueness — PO Number is now an optional reference.
  if (await hasIndex(t, "uq_purchase_po")) {
    await query(`ALTER TABLE ${t} DROP INDEX uq_purchase_po`)
  }
  // Enforce Bill ID uniqueness (the new business key).
  if (!(await hasIndex(t, "uq_pb_bill_id"))) {
    await query(`ALTER TABLE ${t} ADD UNIQUE KEY uq_pb_bill_id (bill_id)`)
  }
  if (!(await hasIndex(t, "idx_pb_bill_number"))) {
    await query(`ALTER TABLE ${t} ADD KEY idx_pb_bill_number (bill_number)`)
  }

  pbEnsured = true
}

let gstInputEnsured = false

/**
 * Self-healing schema for the GST Input (ITC) subsystem — Phases 6–20.
 *
 * Creates the purchase-bill line items table, the GST Input register, the
 * GSTR-2B staging table, and adds effective-dating to the tax master. MySQL 8
 * supports `CREATE TABLE IF NOT EXISTS`, so the tables are idempotent without
 * information_schema gymnastics; the tax-rate columns still need the guarded
 * ADD COLUMN because the base table pre-exists. Runs once per process.
 */
export async function ensureGstInputSchema() {
  if (gstInputEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS purchase_bill_items (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    bill_id           VARCHAR(30) NOT NULL,
    line_no           INT NOT NULL DEFAULT 1,
    description       VARCHAR(500) DEFAULT NULL,
    hsn_sac           VARCHAR(20) DEFAULT NULL,
    quantity          DECIMAL(14,3) NOT NULL DEFAULT 0,
    unit              VARCHAR(20) DEFAULT NULL,
    rate              DECIMAL(14,4) NOT NULL DEFAULT 0,
    discount_type     VARCHAR(10) NOT NULL DEFAULT 'amount',
    discount_value    DECIMAL(14,2) NOT NULL DEFAULT 0,
    discount_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
    taxable_value     DECIMAL(14,2) NOT NULL DEFAULT 0,
    gst_rate          DECIMAL(6,2) NOT NULL DEFAULT 0,
    cgst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
    cgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    sgst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
    sgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    igst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
    igst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    cess_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    line_total        DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_eligibility   VARCHAR(20) NOT NULL DEFAULT 'Eligible',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_pbi_bill (bill_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS finance_gst_input (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    gst_input_id          VARCHAR(30) NOT NULL,
    source                VARCHAR(40) NOT NULL DEFAULT 'Purchase Bill',
    source_bill_id        VARCHAR(30) NOT NULL,
    source_bill_ref       VARCHAR(60) DEFAULT NULL,
    bill_number           VARCHAR(120) DEFAULT NULL,
    bill_date             DATE DEFAULT NULL,
    period                VARCHAR(7) DEFAULT NULL,
    quarter               VARCHAR(7) DEFAULT NULL,
    financial_year        VARCHAR(12) DEFAULT NULL,
    vendor_id             VARCHAR(40) DEFAULT NULL,
    vendor_name           VARCHAR(255) DEFAULT NULL,
    vendor_gstin          VARCHAR(20) DEFAULT NULL,
    vendor_state          VARCHAR(120) DEFAULT NULL,
    vendor_state_code     VARCHAR(6) DEFAULT NULL,
    place_of_supply       VARCHAR(120) DEFAULT NULL,
    supply_type           VARCHAR(20) DEFAULT NULL,
    taxable_amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    gst_rate              DECIMAL(6,2) NOT NULL DEFAULT 0,
    cgst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
    sgst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
    igst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
    cess_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
    total_gst             DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_eligible          TINYINT(1) NOT NULL DEFAULT 1,
    itc_section           VARCHAR(40) DEFAULT 'Input Services',
    itc_gross             DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_eligible_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_ineligible_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_reversal_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_net               DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_cgst              DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_sgst              DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_igst              DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_cess              DECIMAL(14,2) NOT NULL DEFAULT 0,
    itc_claimed           TINYINT(1) NOT NULL DEFAULT 0,
    claimed_period        VARCHAR(7) DEFAULT NULL,
    reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'Unreconciled',
    gstr2b_reference      VARCHAR(120) DEFAULT NULL,
    gstr2b_taxable        DECIMAL(14,2) DEFAULT NULL,
    gstr2b_tax            DECIMAL(14,2) DEFAULT NULL,
    match_variance        DECIMAL(14,2) DEFAULT NULL,
    status                VARCHAR(20) NOT NULL DEFAULT 'Available',
    narration             VARCHAR(500) DEFAULT NULL,
    created_by            INT DEFAULT NULL,
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_gin_source (source, source_bill_id),
    UNIQUE KEY uq_gin_id (gst_input_id),
    KEY idx_gin_period (period),
    KEY idx_gin_quarter (quarter),
    KEY idx_gin_vendor_gstin (vendor_gstin),
    KEY idx_gin_recon (reconciliation_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS finance_gstr2b (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    period            VARCHAR(7) NOT NULL,
    supplier_gstin    VARCHAR(20) DEFAULT NULL,
    supplier_name     VARCHAR(255) DEFAULT NULL,
    bill_number       VARCHAR(120) DEFAULT NULL,
    bill_date         DATE DEFAULT NULL,
    taxable_amount    DECIMAL(14,2) NOT NULL DEFAULT 0,
    cgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    sgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    igst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    cess_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
    total_tax         DECIMAL(14,2) NOT NULL DEFAULT 0,
    source            VARCHAR(30) NOT NULL DEFAULT 'Draft',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_g2b_period (period),
    KEY idx_g2b_gstin (supplier_gstin)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Phase 10 — effective-dating on the (pre-existing) tax master, when present.
  const taxTable = await query<any[]>(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'finance_tax_rates' LIMIT 1`,
  )
  if (taxTable.length > 0) {
    await ensureColumn("finance_tax_rates", "effective_from", "DATE DEFAULT NULL")
    await ensureColumn("finance_tax_rates", "effective_to", "DATE DEFAULT NULL")
    await ensureColumn("finance_tax_rates", "status", "VARCHAR(20) NOT NULL DEFAULT 'Active'")
  }

  gstInputEnsured = true
}
