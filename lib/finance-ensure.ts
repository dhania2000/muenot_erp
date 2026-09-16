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
  await ensureInvoiceWorkflowColumns("freelance_invoices")
  ensured = true
}

/**
 * Shared self-healing schema for the two-stage invoice approval workflow
 * (Phase — employee then reporting-manager sign-off). The assigned employee
 * approves/rejects first, then their reporting manager; `workflow_manager_id`
 * is snapshotted from HR so per-user visibility never depends on a live join.
 * Applied to both Freelance and FTE invoices.
 */
export async function ensureInvoiceWorkflowColumns(table: string) {
  await ensureColumn(table, "workflow_status", "VARCHAR(40) NOT NULL DEFAULT 'Pending Employee Approval'")
  await ensureColumn(table, "workflow_manager_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(table, "workflow_manager_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(table, "workflow_rejected_by", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(table, "workflow_rejection_reason", "TEXT DEFAULT NULL")
  await ensureColumn(table, "employee_approved_at", "DATETIME DEFAULT NULL")
  await ensureColumn(table, "manager_approved_at", "DATETIME DEFAULT NULL")
}

let fteEnsured = false

/**
 * Self-healing schema for the FTE Invoices sub-module. Mirrors the freelance
 * helper: the config now carries an `employee_email` recipient field plus the
 * invoice-send tracking columns, none of which exist in the base migration.
 */
export async function ensureFteInvoiceColumns() {
  if (fteEnsured) return
  const t = "fte_invoices"
  await ensureColumn(t, "employee_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "invoice_last_sent_at", "DATETIME DEFAULT NULL")
  await ensureColumn(t, "invoice_last_sent_to", "VARCHAR(190) DEFAULT NULL")
  await ensureInvoiceWorkflowColumns(t)

  // Phase 2/3 — frozen Client snapshot (sourced from the Clients master).
  await ensureColumn(t, "client_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "client_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "client_legal_name", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn(t, "client_gstin", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "client_pan", "VARCHAR(15) DEFAULT NULL")
  await ensureColumn(t, "billing_address", "TEXT DEFAULT NULL")
  await ensureColumn(t, "client_state", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "client_state_code", "VARCHAR(6) DEFAULT NULL")
  await ensureColumn(t, "client_pin", "VARCHAR(12) DEFAULT NULL")
  await ensureColumn(t, "currency", "VARCHAR(10) DEFAULT NULL")
  await ensureColumn(t, "payment_terms", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn(t, "billing_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "contact_person", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "client_status", "VARCHAR(40) DEFAULT NULL")

  // Phase 4 — frozen Project snapshot (sourced from Projects/Operations master).
  await ensureColumn(t, "project_status", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn(t, "project_client_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "project_client_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "cost_centre", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "billing_terms", "VARCHAR(120) DEFAULT NULL")

  // Phase 5 — Employee billing profile (sourced from HR → Employees).
  await ensureColumn(t, "billing_role", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "billing_rate", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "employee_status", "VARCHAR(40) DEFAULT NULL")

  // Phase 8 — internal reference vs client PO (kept separate).
  await ensureColumn(t, "internal_reference", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn(t, "po_number", "VARCHAR(120) DEFAULT NULL")

  // Phase 9 — centralized financial period.
  await ensureColumn(t, "quarter", "VARCHAR(6) DEFAULT NULL")
  await ensureColumn(t, "accounting_period", "VARCHAR(20) DEFAULT NULL")

  // Phase 10/11 — billing period + billable-days model.
  await ensureColumn(t, "billing_period_start", "DATE DEFAULT NULL")
  await ensureColumn(t, "billing_period_end", "DATE DEFAULT NULL")
  await ensureColumn(t, "billable_days", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "non_billable_days", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "billable_hours", "DECIMAL(8,2) NOT NULL DEFAULT 0")

  // Phase 14/15 — rate snapshot (frozen when the invoice is finalized).
  await ensureColumn(t, "rate_source", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn(t, "rate_snapshot", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "billing_basis_snapshot", "VARCHAR(40) DEFAULT NULL")

  // Phase 16 — client billing calculation (kept separate from payroll).
  await ensureColumn(t, "base_billing", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "billing_overtime", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "billing_bonus", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "other_charges", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "billing_adjustment", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "gross_client_billing", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 16 — GST / TDS on the client invoice + receivable tracking.
  await ensureColumn(t, "gst_rate", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "gst_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_rate", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "net_receivable", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "amount_paid", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "outstanding", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 17 — employee cost ledger (separate from client billing).
  await ensureColumn(t, "salary_cost", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "employer_pf", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "employer_esi", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "other_employer_cost", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "employee_cost_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 18 — profitability.
  await ensureColumn(t, "other_allocated_cost", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "gross_margin", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "margin_percent", "DECIMAL(8,2) NOT NULL DEFAULT 0")

  // Phase 10 — billing period type + payment/GST/TDS status facets.
  await ensureColumn(t, "billing_period_type", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn(t, "payment_status", "VARCHAR(30) NOT NULL DEFAULT 'Unpaid'")
  await ensureColumn(t, "gst_status", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn(t, "tds_status", "VARCHAR(30) DEFAULT NULL")

  // Phase 23 — client contract linkage.
  await ensureColumn(t, "contract_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "contract_reference", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "contract_start", "DATE DEFAULT NULL")
  await ensureColumn(t, "contract_end", "DATE DEFAULT NULL")
  await ensureColumn(t, "contract_value", "DECIMAL(16,2) NOT NULL DEFAULT 0")

  // Phase 8/28 — search + performance indexes.
  const idx = async (name: string, cols: string) => {
    if (!(await hasIndex(t, name))) await query(`ALTER TABLE ${t} ADD KEY ${name} (${cols})`)
  }
  await idx("idx_fte_client", "client_id")
  await idx("idx_fte_project", "project_id")
  await idx("idx_fte_emp_id", "employee_id")
  await idx("idx_fte_payment_status", "payment_status")

  fteEnsured = true
}

let coaEnsured = false

/**
 * System-account codes the posting engine resolves by `account_code`
 * (lib/finance-accounts.ts → ROLE_DEFAULT_CODE and the seed migrations). These
 * back Journal / Ledger postings for Sales, Purchase, GST, TDS, Bank, Cash and
 * the payable/receivable control heads, so they are flagged `is_system = 1` and
 * protected from destructive edits/deletes in the CRUD factory.
 */
export const SYSTEM_ACCOUNT_CODES = [
  "1200", // Accounts Receivable
  "1450", // TDS Receivable
  "4000", // Sales Revenue
  "2110", "2120", "2130", "2140", // Output CGST / SGST / IGST / Cess (GST Payable)
  "2160", // GST Payable (Net) — GST payment settlement control head
  "1000", // Bank
  "1010", // Cash
  "5000", // Purchases / Expenses
  "1410", "1420", "1430", "1440", // Input CGST / SGST / IGST / Cess (GST Input)
  "2000", // Accounts Payable
  "2150", // TDS Payable
  "5100", // General Expenses
  "2200", // Employee Reimbursements Payable
  "1460", // Employee Advances
  "3900", // Opening Balance Equity (contra head for opening-balance postings)
] as const

/**
 * Self-healing schema for the Chart of Accounts master upgrade.
 *
 * Adds the account hierarchy / posting-configuration columns the upgraded
 * master needs (opening-balance date, financial year, and the `is_system`
 * protection flag) without disturbing the columns every downstream link
 * (Journal, General Ledger, Purchase Bills, Sales Invoices, Expenses, Bank &
 * Cash, GST, TDS, Reports) already resolves by `account_id` / `account_code`.
 * Then flags the posting-engine control accounts so they cannot be renamed,
 * recoded, deactivated or deleted from the UI.
 */
export async function ensureChartOfAccountsColumns() {
  if (coaEnsured) return
  const t = "chart_of_accounts"
  await ensureColumn(t, "opening_balance_date", "DATE DEFAULT NULL")
  await ensureColumn(t, "financial_year", "VARCHAR(12) DEFAULT NULL")
  await ensureColumn(t, "is_system", "TINYINT(1) NOT NULL DEFAULT 0")

  // Opening-balance posting state (Phase — requirements 14/15). An opening
  // balance is projected into a real, balanced Journal + General Ledger voucher
  // (see lib/finance-opening-balance.ts); these columns key that posting so it
  // is idempotent (never double-posts) and can be reversed/re-posted cleanly
  // when the amount or side changes — never a fake number on this table alone.
  await ensureColumn(t, "ob_voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "ob_posted_amount", "DECIMAL(18,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "ob_posted_side", "VARCHAR(10) DEFAULT NULL")

  // Reporting classification OVERRIDES (requirement 71). Each account's Balance
  // Sheet / Profit & Loss / Cash Flow group is auto-derived from its type, code
  // and name (see lib/finance-classification.ts); these columns only hold an
  // explicit override when a user pins a different group. NULL/blank means "use
  // the auto-derived value", so the statements engine never depends on them
  // being populated and no second classification system is introduced.
  await ensureColumn(t, "bs_group", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "pnl_group", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "cashflow_group", "VARCHAR(20) DEFAULT NULL")

  // Widen the status column so the Archived lifecycle state (requirement 12) is
  // storable even if the column was originally a narrower ENUM. Best-effort: a
  // column that is already wide enough makes this a harmless no-op.
  try {
    await query(`ALTER TABLE ${t} MODIFY COLUMN active_status VARCHAR(20) DEFAULT 'Active'`)
  } catch (error) {
    console.log("[v0] chart_of_accounts.active_status widen skipped:", (error as Error).message)
  }

  // Indexes that keep list/search/filter/hierarchy queries fast on a large
  // Chart of Accounts (requirements 112/113): Account ID, Code, Name, Type,
  // Parent ID and Status. The base migration seeds most of these; the two that
  // large installs commonly lack (parent hierarchy walk + account_group filter)
  // are self-healed here so an already-provisioned table is upgraded in place.
  if (!(await hasIndex(t, "idx_coa_parent"))) {
    await query(`ALTER TABLE ${t} ADD KEY idx_coa_parent (parent_account_id)`)
  }
  if (!(await hasIndex(t, "idx_coa_group"))) {
    await query(`ALTER TABLE ${t} ADD KEY idx_coa_group (account_group)`)
  }

  // Flag the posting-engine control accounts (idempotent). Matched by the stable
  // account_code so a company's own re-seeded account with the same code is
  // protected too.
  const placeholders = SYSTEM_ACCOUNT_CODES.map(() => "?").join(",")
  await query(
    `UPDATE ${t} SET is_system = 1 WHERE account_code IN (${placeholders})`,
    [...SYSTEM_ACCOUNT_CODES],
  )
  coaEnsured = true
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

  // Centralized TDS rule master resolution — frozen rule snapshot (parity with
  // Expenses). The rate/section/thresholds are resolved server-side from the
  // effective-dated finance_tds_rules master and frozen onto the bill so a later
  // rate change never rewrites a posted document (Phase 9/10 of the TDS module).
  await ensureColumn(t, "tds_entity_type", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn(t, "tds_nature_of_payment", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "tds_threshold_single", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_threshold_annual", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_no_pan_rate_applied", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_rule_version", "VARCHAR(30) DEFAULT NULL")

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

  // Phase 33–37 — Journal / General Ledger posting linkage. `voucher_no` ties
  // the bill to its balanced posting, `posted_gross` makes the sync idempotent,
  // and `posting_status` surfaces the posted/unposted state in the register.
  await ensureColumn(t, "voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "reversal_voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "posting_status", "VARCHAR(20) NOT NULL DEFAULT 'Unposted'")
  await ensureColumn(t, "posted_at", "DATETIME DEFAULT NULL")
  await ensureColumn(t, "posted_gross", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  // Frozen copy of the money fields as posted, so a later reversal always
  // unwinds the exact original amounts even if the bill was edited since.
  await ensureColumn(t, "posted_snapshot", "LONGTEXT DEFAULT NULL")

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

let expenseEnsured = false

/**
 * Self-healing schema for the Expenses upgrade (Phases 1–34).
 *
 * The base `expenses` table already carries the core fields (id, date, type,
 * party, project, category/head, single-line tax, TDS, approval, reimbursement,
 * GST-credit). This adds the frozen Employee snapshot (from HR), the frozen
 * Vendor snapshot (from Finance Vendors), the Project/Client/Cost-Centre
 * linkage, the accounting period + references, the COA expense-head mapping,
 * the GST rate/cess/supply-type split, the payment-status/outstanding tracking,
 * the employee advance + reimbursement adjustment fields, the document URLs and
 * the duplicate hash — none of which exist in the original migration. It also
 * adds the indexes required by Phase 34. Runs once per process.
 */
export async function ensureExpenseColumns() {
  if (expenseEnsured) return
  const t = "expenses"

  // Phase 13 — expense details / references.
  await ensureColumn(t, "accounting_period", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "reference_number", "VARCHAR(80) DEFAULT NULL")
  await ensureColumn(t, "vendor_invoice_number", "VARCHAR(80) DEFAULT NULL")
  await ensureColumn(t, "hsn_sac", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "quantity", "DECIMAL(14,3) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rate", "DECIMAL(14,4) NOT NULL DEFAULT 0")
  await ensureColumn(t, "discount", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 4 — frozen Employee snapshot (sourced from HR → Employees).
  await ensureColumn(t, "employee_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "employee_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "department", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "designation", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "employment_type", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn(t, "employee_email", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "employee_mobile", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "employee_manager", "VARCHAR(160) DEFAULT NULL")

  // Phase 5 — frozen Vendor snapshot (sourced from Finance → Vendors).
  await ensureColumn(t, "vendor_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "vendor_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "vendor_legal_name", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn(t, "vendor_gstin", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "gst_status", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "gst_registration_type", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "vendor_pan", "VARCHAR(15) DEFAULT NULL")
  await ensureColumn(t, "vendor_state", "VARCHAR(120) DEFAULT NULL")
  await ensureColumn(t, "vendor_state_code", "VARCHAR(6) DEFAULT NULL")
  await ensureColumn(t, "vendor_pin", "VARCHAR(12) DEFAULT NULL")
  await ensureColumn(t, "vendor_address", "TEXT DEFAULT NULL")
  await ensureColumn(t, "payment_terms", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "currency", "VARCHAR(10) DEFAULT NULL")

  // Phase 6/7/8 — project / client / cost-centre linkage.
  await ensureColumn(t, "client_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "project_status", "VARCHAR(60) DEFAULT NULL")

  // Phase 9 — expense head → Chart of Accounts mapping.
  await ensureColumn(t, "expense_head_account_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "expense_head_account_name", "VARCHAR(190) DEFAULT NULL")

  // Phase 10 — bank/cash account snapshot.
  await ensureColumn(t, "bank_cash_account_name", "VARCHAR(160) DEFAULT NULL")

  // Phase 15 — GST rate + cess + supply-type driven split.
  await ensureColumn(t, "gst_applicable", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn(t, "gst_rate", "DECIMAL(6,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "gst_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "cess_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "supply_type", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "itc_status", "VARCHAR(30) DEFAULT NULL")

  // Phase 17 — payment status tracking (derived, never hand-maintained).
  await ensureColumn(t, "payment_status", "VARCHAR(30) NOT NULL DEFAULT 'Unpaid'")
  await ensureColumn(t, "payment_mode", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "amount_paid", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "outstanding_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 19/20 — employee advance + adjustment.
  await ensureColumn(t, "advance_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "advance_adjusted", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "remaining_advance", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "additional_reimbursement", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "other_adjustment", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 18 — reimbursement workflow submission timestamp.
  await ensureColumn(t, "submitted_at", "DATETIME DEFAULT NULL")

  // Phase 22 — document attachments (existing ERP blob storage).
  await ensureColumn(t, "receipt_url", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "vendor_invoice_url", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "supporting_docs_url", "TEXT DEFAULT NULL")

  // Phase 24 — duplicate detection fingerprint.
  await ensureColumn(t, "duplicate_hash", "VARCHAR(64) DEFAULT NULL")

  // --- Part 2 tax automation -------------------------------------------------
  // Phase 5 — Reverse Charge Mechanism (self-assessed GST).
  await ensureColumn(t, "rcm_applicable", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rcm_taxable_value", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rcm_cgst", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rcm_sgst", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rcm_igst", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rcm_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "rcm_itc", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 6 — ITC ledger (separately tracked from the GST charged).
  await ensureColumn(t, "gst_credit_eligible", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_cgst", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_sgst", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_igst", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_cess", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_total", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_reversal", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "itc_net", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 19–25 — TDS base + rule snapshot (frozen from the TDS Rule Master).
  await ensureColumn(t, "tds_base", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_entity_type", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn(t, "tds_nature_of_payment", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "tds_threshold_single", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_threshold_annual", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_no_pan_rate_applied", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn(t, "tds_rule_version", "VARCHAR(30) DEFAULT NULL")

  // Phase 39 — GST rule versioning (which config produced the rate).
  await ensureColumn(t, "gst_rule_version", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "gst_rate_source", "VARCHAR(60) DEFAULT NULL")

  // Journal / General Ledger posting linkage (accrual-on-post). `voucher_no`
  // ties the expense to its balanced posting, `posted_gross` makes the sync
  // idempotent, and `posted_snapshot` freezes the amounts as posted so a later
  // reversal always unwinds the exact original figures even if the row changed.
  await ensureColumn(t, "voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "reversal_voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "posting_status", "VARCHAR(20) NOT NULL DEFAULT 'Unposted'")
  await ensureColumn(t, "posted_at", "DATETIME DEFAULT NULL")
  await ensureColumn(t, "posted_gross", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "posted_snapshot", "LONGTEXT DEFAULT NULL")

  // Full lifecycle state machine (Draft → Submitted → Pending Approval →
  // Approved → Posted → Paid, plus Rejected / Cancelled). `approval_status`
  // stays as the coarse Pending/Approved/Rejected mirror the list UI badges,
  // while `workflow_status` carries the authoritative fine-grained state.
  await ensureColumn(t, "workflow_status", "VARCHAR(30) NOT NULL DEFAULT 'Draft'")
  await ensureColumn(t, "approved_by_id", "INT DEFAULT NULL")
  await ensureColumn(t, "approved_at", "DATETIME DEFAULT NULL")
  await ensureColumn(t, "rejected_reason", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "cancelled_reason", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn(t, "refunded_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")

  // Phase 34 — indexes for search + aggregation performance.
  const idx = async (name: string, cols: string) => {
    if (!(await hasIndex(t, name))) await query(`ALTER TABLE ${t} ADD KEY ${name} (${cols})`)
  }
  await idx("idx_exp_employee", "employee_id")
  await idx("idx_exp_vendor", "vendor_id")
  await idx("idx_exp_project", "project_id")
  await idx("idx_exp_type", "expense_type")
  await idx("idx_exp_payment_status", "payment_status")
  await idx("idx_exp_approval", "approval_status")
  await idx("idx_exp_gstin", "vendor_gstin")
  await idx("idx_exp_pan", "vendor_pan")
  await idx("idx_exp_dup", "duplicate_hash")

  expenseEnsured = true
}

let bankTxnEnsured = false

/**
 * Self-healing schema for the Bank Transactions upgrade (Foundation phase).
 *
 * The base `bank_transactions` table already carries the movement fields (date,
 * account, type, party, debit/credit, GST/TDS, reconciliation). This adds the
 * centralized financial period (quarter + accounting period), the smart-party
 * type, the source-document linkage, the bank-to-bank transfer linkage and the
 * Journal / General Ledger posting columns — so a posted transaction becomes
 * the auditable bridge into the existing accounting engine. Runs once/process.
 */
export async function ensureBankTransactionColumns() {
  if (bankTxnEnsured) return
  const t = "bank_transactions"

  // Centralized financial period (month already exists in the base migration).
  await ensureColumn(t, "quarter", "VARCHAR(6) DEFAULT NULL")
  await ensureColumn(t, "accounting_period", "VARCHAR(20) DEFAULT NULL")

  // Smart party selection — which master the party was resolved from so the
  // form can source the right picker (Customer→Clients, Vendor→Vendors,
  // Employee→HR) and genuine bank-only rows can be tagged Other/Unknown.
  await ensureColumn(t, "party_type", "VARCHAR(20) DEFAULT NULL")

  // Source-document linkage (Phase 11/12) — when a transaction settles an
  // existing finance document these trace it back to its origin.
  await ensureColumn(t, "source_module", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "source_transaction_id", "VARCHAR(60) DEFAULT NULL")

  // Bank-to-bank transfer linkage (Phase 20/98–100). Both legs of one transfer
  // share a `transfer_id`; the counter account is the other side of the move.
  await ensureColumn(t, "transfer_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "counter_account_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "counter_account_name", "VARCHAR(190) DEFAULT NULL")

  // Journal / General Ledger posting linkage. `voucher_no` ties the transaction
  // to its balanced posting, `posted_amount` makes the sync idempotent, and
  // `posted_snapshot` freezes the amounts as posted so a later reversal always
  // unwinds the exact original figures even if the row was edited since.
  await ensureColumn(t, "voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "reversal_voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "posting_status", "VARCHAR(20) NOT NULL DEFAULT 'Unposted'")
  await ensureColumn(t, "posted_at", "DATETIME DEFAULT NULL")
  await ensureColumn(t, "posted_amount", "DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "posted_snapshot", "LONGTEXT DEFAULT NULL")

  // Search + aggregation performance (Phase 85).
  const idx = async (name: string, cols: string) => {
    if (!(await hasIndex(t, name))) await query(`ALTER TABLE ${t} ADD KEY ${name} (${cols})`)
  }
  await idx("idx_btx_value_date", "value_date")
  await idx("idx_btx_reference", "reference_no")
  await idx("idx_btx_utr", "cheque_utr_reference")
  await idx("idx_btx_party", "party_id")
  await idx("idx_btx_account_head", "account_head_id")
  await idx("idx_btx_bank_account", "bank_cash_account_id")
  await idx("idx_btx_source", "source_transaction_id")
  await idx("idx_btx_transfer", "transfer_id")

  bankTxnEnsured = true
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

  // Phase 8–10 — the register is a single centralized table shared by Purchase
  // Bills AND Expenses. Expenses add an employee side (reimbursements), a frozen
  // vendor PAN, an HSN/SAC + RCM flag and the source-transaction display id.
  // The base CREATE above only runs on a fresh DB, so add these for existing
  // installs where the table already exists.
  await ensureColumn("finance_gst_input", "source_transaction_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("finance_gst_input", "employee_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("finance_gst_input", "employee_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn("finance_gst_input", "vendor_pan", "VARCHAR(15) DEFAULT NULL")
  await ensureColumn("finance_gst_input", "hsn_sac", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("finance_gst_input", "rcm_applicable", "TINYINT(1) NOT NULL DEFAULT 0")

  gstInputEnsured = true
}

/**
 * Self-healing schema for the six balance-sheet register modules — Fixed Assets,
 * Loans & Advances, Investments, Provisions & Accruals, Capital & Equity and the
 * Related Parties master. The five transactional tables carry the standard
 * posting columns (voucher_no / posting_status / posted_amount / posted_snapshot)
 * written only by the register posting engine; Related Parties is a plain
 * disclosure master. MySQL 8 supports `CREATE TABLE IF NOT EXISTS`, so every
 * table is idempotent. Runs once per process.
 */
let registerTablesEnsured = false

/** Standard posting columns shared by every transactional register table. */
const POSTING_COLS = `
  posting_status      VARCHAR(20) NOT NULL DEFAULT 'Unposted',
  voucher_no          VARCHAR(30) DEFAULT NULL,
  reversal_voucher_no VARCHAR(30) DEFAULT NULL,
  posted_amount       DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot     LONGTEXT DEFAULT NULL,
  posted_at           DATETIME DEFAULT NULL,`

export async function ensureRegisterModuleTables() {
  if (registerTablesEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS fixed_assets (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    asset_id                VARCHAR(30) NOT NULL,
    asset_name              VARCHAR(255) DEFAULT NULL,
    asset_category          VARCHAR(80) DEFAULT NULL,
    acquisition_date        DATE DEFAULT NULL,
    financial_year          VARCHAR(12) DEFAULT NULL,
    cost                    DECIMAL(16,2) NOT NULL DEFAULT 0,
    funding_source          VARCHAR(40) DEFAULT NULL,
    depreciation_method     VARCHAR(40) DEFAULT NULL,
    useful_life_years       DECIMAL(6,2) NOT NULL DEFAULT 0,
    salvage_value           DECIMAL(16,2) NOT NULL DEFAULT 0,
    accumulated_depreciation DECIMAL(16,2) NOT NULL DEFAULT 0,
    net_book_value          DECIMAL(16,2) NOT NULL DEFAULT 0,
    location                VARCHAR(190) DEFAULT NULL,
    custodian               VARCHAR(190) DEFAULT NULL,
    status                  VARCHAR(30) NOT NULL DEFAULT 'In Use',
    notes                   TEXT DEFAULT NULL,${POSTING_COLS}
    created_by              INT DEFAULT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fa_id (asset_id),
    KEY idx_fa_fy (financial_year),
    KEY idx_fa_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS loans_advances (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    loan_id             VARCHAR(30) NOT NULL,
    party_name          VARCHAR(255) DEFAULT NULL,
    party_type          VARCHAR(40) DEFAULT NULL,
    direction           VARCHAR(40) DEFAULT NULL,
    principal           DECIMAL(16,2) NOT NULL DEFAULT 0,
    interest_rate       DECIMAL(6,2) NOT NULL DEFAULT 0,
    disbursement_date   DATE DEFAULT NULL,
    financial_year      VARCHAR(12) DEFAULT NULL,
    funding_source      VARCHAR(40) DEFAULT NULL,
    repayment_terms     VARCHAR(255) DEFAULT NULL,
    outstanding_amount  DECIMAL(16,2) NOT NULL DEFAULT 0,
    status              VARCHAR(30) NOT NULL DEFAULT 'Active',
    notes               TEXT DEFAULT NULL,${POSTING_COLS}
    created_by          INT DEFAULT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_la_id (loan_id),
    KEY idx_la_fy (financial_year),
    KEY idx_la_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS investments (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    investment_id       VARCHAR(30) NOT NULL,
    investment_name     VARCHAR(255) DEFAULT NULL,
    investment_type     VARCHAR(60) DEFAULT NULL,
    acquisition_date    DATE DEFAULT NULL,
    financial_year      VARCHAR(12) DEFAULT NULL,
    amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
    funding_source      VARCHAR(40) DEFAULT NULL,
    units               DECIMAL(16,4) NOT NULL DEFAULT 0,
    expected_return_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
    maturity_date       DATE DEFAULT NULL,
    current_value       DECIMAL(16,2) NOT NULL DEFAULT 0,
    status              VARCHAR(30) NOT NULL DEFAULT 'Active',
    notes               TEXT DEFAULT NULL,${POSTING_COLS}
    created_by          INT DEFAULT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_inv_id (investment_id),
    KEY idx_inv_fy (financial_year),
    KEY idx_inv_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS provisions_accruals (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    provision_id        VARCHAR(30) NOT NULL,
    provision_name      VARCHAR(255) DEFAULT NULL,
    provision_type      VARCHAR(60) DEFAULT NULL,
    provision_date      DATE DEFAULT NULL,
    financial_year      VARCHAR(12) DEFAULT NULL,
    amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
    related_party       VARCHAR(255) DEFAULT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'Open',
    notes               TEXT DEFAULT NULL,${POSTING_COLS}
    created_by          INT DEFAULT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_prv_id (provision_id),
    KEY idx_prv_fy (financial_year),
    KEY idx_prv_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS capital_equity (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    entry_id            VARCHAR(30) NOT NULL,
    entry_type          VARCHAR(60) DEFAULT NULL,
    contributor_name    VARCHAR(255) DEFAULT NULL,
    entry_date          DATE DEFAULT NULL,
    financial_year      VARCHAR(12) DEFAULT NULL,
    amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
    mode                VARCHAR(40) DEFAULT NULL,
    transfer_source     VARCHAR(60) DEFAULT NULL,
    direction           VARCHAR(20) DEFAULT NULL,
    instrument          VARCHAR(120) DEFAULT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'Active',
    notes               TEXT DEFAULT NULL,${POSTING_COLS}
    created_by          INT DEFAULT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cap_id (entry_id),
    KEY idx_cap_fy (financial_year),
    KEY idx_cap_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS related_parties (
    id                     INT AUTO_INCREMENT PRIMARY KEY,
    party_id               VARCHAR(30) NOT NULL,
    party_name             VARCHAR(255) DEFAULT NULL,
    relationship           VARCHAR(80) DEFAULT NULL,
    pan                    VARCHAR(15) DEFAULT NULL,
    gstin                  VARCHAR(20) DEFAULT NULL,
    nature_of_relationship VARCHAR(255) DEFAULT NULL,
    opening_balance        DECIMAL(16,2) NOT NULL DEFAULT 0,
    contact_person         VARCHAR(190) DEFAULT NULL,
    email                  VARCHAR(190) DEFAULT NULL,
    phone                  VARCHAR(40) DEFAULT NULL,
    address                TEXT DEFAULT NULL,
    status                 VARCHAR(30) NOT NULL DEFAULT 'Active',
    notes                  TEXT DEFAULT NULL,
    created_by             INT DEFAULT NULL,
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rp_id (party_id),
    KEY idx_rp_relationship (relationship),
    KEY idx_rp_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Phase 7 — Capital & Equity gained the internal-transfer columns after the
  // base table shipped. Add them idempotently so an existing database picks up
  // the counter equity head + Increase/Decrease direction the posting engine reads.
  await ensureColumn("capital_equity", "transfer_source", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn("capital_equity", "direction", "VARCHAR(20) DEFAULT NULL")

  // Phase 8 — Related Parties link to an existing master (customer / vendor /
  // employee) instead of duplicating it, and carry an effective window. These
  // columns are added idempotently so an existing `related_parties` table picks
  // up the source link + effective dates the picker and transaction matcher use.
  await ensureColumn("related_parties", "source_type", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("related_parties", "source_id", "VARCHAR(60) DEFAULT NULL")
  await ensureColumn("related_parties", "effective_from", "DATE DEFAULT NULL")
  await ensureColumn("related_parties", "effective_to", "DATE DEFAULT NULL")

  registerTablesEnsured = true
}

/**
 * Self-healing schema for the Phase 4 Loans & Advances build. The base
 * `loans_advances` table predates the richer loan model (type, EMI, tenure,
 * installment frequency, split outstanding, purpose, bank account, documents),
 * so the new columns are added idempotently, and the dedicated amortisation
 * schedule table is created. Runs once per process, after the register tables.
 */
let loansAdvancesEnsured = false

export async function ensureLoansAdvancesColumns() {
  if (loansAdvancesEnsured) return
  await ensureRegisterModuleTables()

  const t = "loans_advances"
  await ensureColumn(t, "loan_type", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "party_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "interest_method", "VARCHAR(30) DEFAULT NULL")
  await ensureColumn(t, "start_date", "DATE DEFAULT NULL")
  await ensureColumn(t, "end_date", "DATE DEFAULT NULL")
  await ensureColumn(t, "tenure_months", "INT NOT NULL DEFAULT 0")
  await ensureColumn(t, "installment_frequency", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "emi_amount", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "interest_total", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "total_payable", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "outstanding_principal", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "outstanding_interest", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn(t, "purpose", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn(t, "bank_account_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "bank_account_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "document_url", "TEXT DEFAULT NULL")

  await query(`CREATE TABLE IF NOT EXISTS loans_advances_schedule (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    loan_id             VARCHAR(30) NOT NULL,
    installment_no      INT NOT NULL DEFAULT 0,
    due_date            DATE DEFAULT NULL,
    opening_balance     DECIMAL(16,2) NOT NULL DEFAULT 0,
    emi                 DECIMAL(16,2) NOT NULL DEFAULT 0,
    principal_component DECIMAL(16,2) NOT NULL DEFAULT 0,
    interest_component  DECIMAL(16,2) NOT NULL DEFAULT 0,
    closing_balance     DECIMAL(16,2) NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL DEFAULT 'Due',
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_las_loan (loan_id),
    KEY idx_las_due (due_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  loansAdvancesEnsured = true
}

/**
 * Self-healing schema for the Phase 6 Provisions & Accruals build. The base
 * `provisions_accruals` table predates the richer model (a general Type of
 * Provision / Accrual / Prepaid Expense, the P&L / balance-sheet account, the
 * start / end date, the periodicity + recurring flag, the funding source and a
 * document link), so the new columns are added idempotently, and the dedicated
 * periodic-posting schedule table is created. Runs once per process, after the
 * register tables.
 */
let provisionsAccrualsEnsured = false

export async function ensureProvisionsAccrualsColumns() {
  if (provisionsAccrualsEnsured) return
  await ensureRegisterModuleTables()

  const t = "provisions_accruals"
  await ensureColumn(t, "account_id", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "account_name", "VARCHAR(190) DEFAULT NULL")
  await ensureColumn(t, "accrual_nature", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "funding_source", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn(t, "start_date", "DATE DEFAULT NULL")
  await ensureColumn(t, "end_date", "DATE DEFAULT NULL")
  await ensureColumn(t, "period", "VARCHAR(20) DEFAULT NULL")
  await ensureColumn(t, "recurring", "VARCHAR(10) DEFAULT NULL")
  await ensureColumn(t, "document_url", "TEXT DEFAULT NULL")

  await query(`CREATE TABLE IF NOT EXISTS provisions_accruals_schedule (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    provision_id        VARCHAR(30) NOT NULL,
    installment_no      INT NOT NULL DEFAULT 0,
    period_date         DATE DEFAULT NULL,
    amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
    voucher_no          VARCHAR(40) DEFAULT NULL,
    posting_status      VARCHAR(20) NOT NULL DEFAULT 'Pending',
    posted_at           DATETIME DEFAULT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pas (provision_id, installment_no),
    KEY idx_pas_prov (provision_id),
    KEY idx_pas_date (period_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  provisionsAccrualsEnsured = true
}
