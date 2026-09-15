/**
 * Financial Reports hub — server-only report catalogue.
 *
 * Each report is a named, read-only aggregate over an existing ERP table
 * (finance, HR, sales, operations). Reports are grouped and rendered by a
 * single generic client + one API route, mirroring the config-driven Finance
 * module pattern. Every query is run defensively by the API route, so a report
 * whose source table/column is absent simply returns no rows instead of
 * breaking the whole page.
 *
 * A report column marked `money` is formatted as INR in the UI; a `date`
 * column is left as-is (already a string from the mysql2 dateStrings pool).
 */

import type { ReportDiagnosticsConfig } from "@/lib/finance-report-diagnostics"
import { STATEMENT_COLUMNS, type StatementType } from "@/lib/statement-export"

export type ReportColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
  /** When false, this money column is formatted but not auto-totalled (the
   *  report supplies its own subtotal/total rows, e.g. financial statements). */
  total?: boolean
}

// Advanced-filter dimensions a report can expose. Each maps to a SQL column in
// the report's own FROM context, declared centrally (never per report) so the
// same dimension always behaves identically across the whole catalogue.
export type ReportFilterDim =
  | "account"
  | "accountGroup"
  | "party"
  | "customer"
  | "vendor"
  | "department"
  | "costCentre"
  | "project"
  | "bank"
  | "gstin"
  | "pan"
  | "tdsSection"
  | "status"

export type ReportFilter = {
  dim: ReportFilterDim
  /** SQL column/expression the filter matches against. */
  column: string
  /** "like" (default, case-insensitive contains) or "eq" (exact match). */
  match?: "like" | "eq"
}

// How a report is filtered on time. `range` shows FY / Quarter / Month / date
// range; `asOn` shows a single "as on" date (cumulative up to it); `none` has
// no period control.
export type PeriodMode = "range" | "asOn" | "none"

// Human labels for each filter dimension, shared by the API + UI so the picker
// and the report metadata never drift apart.
export const FILTER_DIM_LABELS: Record<ReportFilterDim, string> = {
  account: "Account",
  accountGroup: "Account Group",
  party: "Party",
  customer: "Customer",
  vendor: "Vendor",
  department: "Department",
  costCentre: "Cost Centre",
  project: "Project",
  bank: "Bank / Cash Account",
  gstin: "GSTIN",
  pan: "PAN",
  tdsSection: "TDS Section",
  status: "Status",
}

export type ReportDef = {
  key: string
  label: string
  group: string
  description: string
  /** SQL executed as-is. `:from` / `:to` placeholders are replaced with a
   *  date range filter when the report has `dateColumn`, else dropped.
   *  Omitted for placeholder reports whose data source does not exist yet. */
  sql?: string
  /** Column used for the date-range filter; when absent the range is ignored. */
  dateColumn?: string
  columns: ReportColumn[]
  /** Advanced dimension filters this report exposes (assigned centrally). */
  filters?: ReportFilter[]
  /** Time-filter style. Defaults to `range` when a `dateColumn` exists. */
  periodMode?: PeriodMode
  /** Reconciliation rules + source-health requirements + empty-state hint
   *  (Phases 21-25). Propagates to `fs-*`/`ab-*` aliases via `from()`. */
  diagnostics?: ReportDiagnosticsConfig
  /** When set, this report is computed by the classification-aware statement
   *  engine (lib/finance-statements.ts) rather than by a raw `sql` string, so
   *  the catalogue reuses the exact same numbers as the Financial Statements
   *  page instead of a second, naive ledger group-by. */
  statement?: StatementType
}

// Helper: a date-range WHERE fragment the API can inline. When a report has no
// dateColumn the API strips the `{{range}}` marker entirely.
const RANGE = "{{range}}"

export const FINANCE_REPORTS: ReportDef[] = [
  // -------------------------------------------------------------------------
  // Finance
  // -------------------------------------------------------------------------
  {
    key: "finance-report",
    label: "Finance Report",
    group: "Finance",
    description: "Billing, receipts and outstanding across all finance sub-modules.",
    dateColumn: "record_date",
    sql: `
      SELECT module_key AS module,
             COUNT(*) AS records,
             COALESCE(SUM(amount),0) AS total_amount,
             COALESCE(SUM(debit),0) AS total_debit,
             COALESCE(SUM(credit),0) AS total_credit
      FROM finance_records
      WHERE 1=1 ${RANGE}
      GROUP BY module_key
      ORDER BY total_amount DESC`,
    columns: [
      { key: "module", label: "Module" },
      { key: "records", label: "Records", align: "right" },
      { key: "total_amount", label: "Amount", align: "right", money: true },
      { key: "total_debit", label: "Debit", align: "right", money: true },
      { key: "total_credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "income-vs-expense",
    label: "Income Vs Expense",
    group: "Finance",
    description: "Month-by-month income (sales invoices) against expenses.",
    dateColumn: "d.record_date",
    sql: `
      SELECT DATE_FORMAT(d.record_date, '%Y-%m') AS period,
             COALESCE(SUM(CASE WHEN d.module_key = 'sales-invoices' THEN d.amount ELSE 0 END),0) AS income,
             COALESCE(SUM(CASE WHEN d.module_key IN ('expenses','purchase-bills') THEN d.amount ELSE 0 END),0) AS expense,
             COALESCE(SUM(CASE WHEN d.module_key = 'sales-invoices' THEN d.amount ELSE 0 END),0)
               - COALESCE(SUM(CASE WHEN d.module_key IN ('expenses','purchase-bills') THEN d.amount ELSE 0 END),0) AS net
      FROM finance_records d
      WHERE d.record_date IS NOT NULL ${RANGE}
  GROUP BY period
  ORDER BY period DESC`,
  columns: [
  { key: "period", label: "Month" },
  { key: "income", label: "Income", align: "right", money: true },
  { key: "expense", label: "Expense", align: "right", money: true },
  { key: "net", label: "Net", align: "right", money: true },
  ],
  diagnostics: {
  recon: [{ kind: "plWide" }],
  requires: ["posting", "earnings"],
  emptyHint: "No income or expense records fall in the selected period.",
  },
  },
  {
  key: "expense-report",
    label: "Expense Report",
    group: "Finance",
    description: "Expenses grouped by category with gross, TDS and net payable.",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(expense_category,''),'Uncategorised') AS category,
             COUNT(*) AS records,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(net_payable),0) AS net
      FROM expenses
      WHERE 1=1 ${RANGE}
      GROUP BY category
      ORDER BY gross DESC`,
    columns: [
      { key: "category", label: "Category" },
      { key: "records", label: "Records", align: "right" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "net", label: "Net Payable", align: "right", money: true },
    ],
  },
  {
    key: "sales-report",
    label: "Sales Report",
    group: "Finance",
    description: "Sales invoices by payment status with billed, received and outstanding.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(payment_status,''),'Unpaid') AS payment_status,
             COUNT(*) AS invoices,
             COALESCE(SUM(invoice_total),0) AS billed,
             COALESCE(SUM(amount_received),0) AS received,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM sales_invoices
      WHERE 1=1 ${RANGE}
      GROUP BY payment_status
      ORDER BY billed DESC`,
    columns: [
      { key: "payment_status", label: "Payment Status" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "billed", label: "Billed", align: "right", money: true },
      { key: "received", label: "Received", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "purchase-register",
    label: "Purchase Register",
    group: "Finance",
    description: "Purchase bills by vendor with taxable, GST, TDS, gross and net payable (Phase 100).",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''),'Unnamed vendor') AS vendor,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COUNT(*) AS bills,
             COALESCE(SUM(taxable_amount),0) AS taxable,
             COALESCE(SUM(cgst_amount + sgst_amount + igst_amount + other_tax_cess),0) AS gst,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(gross_bill_amount),0) AS gross,
             COALESCE(SUM(net_payable),0) AS net_payable
      FROM purchase_bills
      WHERE 1=1 ${RANGE}
      GROUP BY vendor, gstin
      ORDER BY gross DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "bills", label: "Bills", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net_payable", label: "Net Payable", align: "right", money: true },
    ],
  },
  {
    key: "accounts-payable-ageing",
    label: "Accounts Payable Ageing",
    group: "Finance",
    description: "Outstanding vendor payables bucketed by age from due date (Phases 103, 108).",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''),'Unnamed vendor') AS vendor,
             COALESCE(SUM(outstanding_amount),0) AS outstanding,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) <= 0 THEN outstanding_amount ELSE 0 END),0) AS not_due,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 1 AND 30 THEN outstanding_amount ELSE 0 END),0) AS d1_30,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END),0) AS d31_60,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END),0) AS d61_90,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) > 90 THEN outstanding_amount ELSE 0 END),0) AS d90_plus
      FROM purchase_bills
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      GROUP BY vendor
      ORDER BY outstanding DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "not_due", label: "Not Due", align: "right", money: true },
      { key: "d1_30", label: "1–30d", align: "right", money: true },
      { key: "d31_60", label: "31–60d", align: "right", money: true },
      { key: "d61_90", label: "61–90d", align: "right", money: true },
      { key: "d90_plus", label: "90d+", align: "right", money: true },
    ],
  },
  {
    key: "bank-book",
    label: "Bank Book",
    group: "Finance",
    description: "Day-by-day money in / out per bank & cash account with running turnover (Phase 101).",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(bank_cash_account_name,''),'Unassigned account') AS account,
             COUNT(*) AS entries,
             COALESCE(SUM(debit),0) AS money_out,
             COALESCE(SUM(credit),0) AS money_in,
             COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) AS net_movement
      FROM bank_transactions
      WHERE 1=1 ${RANGE}
      GROUP BY account
      ORDER BY net_movement DESC`,
    columns: [
      { key: "account", label: "Account" },
      { key: "entries", label: "Entries", align: "right" },
      { key: "money_in", label: "Money In", align: "right", money: true },
      { key: "money_out", label: "Money Out", align: "right", money: true },
      { key: "net_movement", label: "Net Movement", align: "right", money: true },
    ],
  },
  {
    key: "cash-book",
    label: "Cash Book",
    group: "Finance",
    description: "Cash-account receipts and payments only, month by month (Phase 101).",
    dateColumn: "transaction_date",
    sql: `
      SELECT DATE_FORMAT(transaction_date, '%Y-%m') AS period,
             COALESCE(SUM(credit),0) AS receipts,
             COALESCE(SUM(debit),0) AS payments,
             COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) AS net
      FROM bank_transactions
      WHERE transaction_date IS NOT NULL
        AND (COALESCE(account_type,'') = 'Cash' OR bank_cash_account_name LIKE '%Cash%') ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Month" },
      { key: "receipts", label: "Receipts", align: "right", money: true },
      { key: "payments", label: "Payments", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
    ],
  },
  {
    key: "bank-reconciliation",
    label: "Bank Reconciliation",
    group: "Finance",
    description: "Reconciled vs unreconciled bank transactions per account, with pending value (Phase 102).",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(bank_cash_account_name,''),'Unassigned account') AS account,
             COUNT(*) AS total_entries,
             SUM(CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') = 'Reconciled' THEN 1 ELSE 0 END) AS reconciled,
             SUM(CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled' THEN 1 ELSE 0 END) AS unreconciled,
             COALESCE(SUM(CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled'
                               THEN GREATEST(COALESCE(debit,0), COALESCE(credit,0)) ELSE 0 END),0) AS unreconciled_value
      FROM bank_transactions
      WHERE 1=1 ${RANGE}
      GROUP BY account
      ORDER BY unreconciled_value DESC`,
    columns: [
      { key: "account", label: "Account" },
      { key: "total_entries", label: "Entries", align: "right" },
      { key: "reconciled", label: "Reconciled", align: "right" },
      { key: "unreconciled", label: "Unreconciled", align: "right" },
      { key: "unreconciled_value", label: "Pending Value", align: "right", money: true },
    ],
  },
  // -------------------------------------------------------------------------
  // Sales / CRM
  // -------------------------------------------------------------------------
  {
    key: "deal-report",
    label: "Deal Report",
    group: "Sales",
    description: "Lead pipeline broken down by deal status.",
    dateColumn: "lead_date",
    sql: `
      SELECT status AS deal_stage,
             COUNT(*) AS leads,
             SUM(CASE WHEN lead_status = 'Won' THEN 1 ELSE 0 END) AS won,
             SUM(CASE WHEN lead_status = 'Lost' THEN 1 ELSE 0 END) AS lost,
             ROUND(AVG(lead_health_score),1) AS avg_health
      FROM sales_leads
      WHERE 1=1 ${RANGE}
      GROUP BY status
      ORDER BY leads DESC`,
    columns: [
      { key: "deal_stage", label: "Stage" },
      { key: "leads", label: "Leads", align: "right" },
      { key: "won", label: "Won", align: "right" },
      { key: "lost", label: "Lost", align: "right" },
      { key: "avg_health", label: "Avg Health", align: "right" },
    ],
  },
  // -------------------------------------------------------------------------
  // HR
  // -------------------------------------------------------------------------
  {
    key: "attendance-report",
    label: "Attendance Report",
    group: "HR",
    description: "Attendance summary by status with hours and overtime.",
    dateColumn: "work_date",
    sql: `
      SELECT status,
             COUNT(*) AS records,
             COALESCE(SUM(working_hours),0) AS total_hours,
             COALESCE(SUM(overtime_hours),0) AS overtime_hours,
             COALESCE(SUM(late_minutes),0) AS late_minutes
      FROM hr_attendance
      WHERE 1=1 ${RANGE}
      GROUP BY status
      ORDER BY records DESC`,
    columns: [
      { key: "status", label: "Status" },
      { key: "records", label: "Records", align: "right" },
      { key: "total_hours", label: "Working Hrs", align: "right" },
      { key: "overtime_hours", label: "Overtime Hrs", align: "right" },
      { key: "late_minutes", label: "Late (min)", align: "right" },
    ],
  },
  {
    key: "leave-report",
    label: "Leave Report",
    group: "HR",
    description: "Leave requests grouped by status with total days.",
    dateColumn: "from_date",
    sql: `
      SELECT status,
             COUNT(*) AS requests,
             COALESCE(SUM(days),0) AS total_days
      FROM hr_leave_requests
      WHERE 1=1 ${RANGE}
      GROUP BY status
      ORDER BY requests DESC`,
    columns: [
      { key: "status", label: "Status" },
      { key: "requests", label: "Requests", align: "right" },
      { key: "total_days", label: "Total Days", align: "right" },
    ],
  },
  {
    key: "task-report",
    label: "Task Report",
    group: "HR / Operations",
    description: "Operational issues (tasks) by status and priority.",
    dateColumn: "created_at",
    sql: `
      SELECT status,
             COUNT(*) AS tasks,
             SUM(CASE WHEN priority IN ('High','Critical') THEN 1 ELSE 0 END) AS high_priority,
             SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
      FROM operations_issues
      WHERE 1=1 ${RANGE}
      GROUP BY status
      ORDER BY tasks DESC`,
    columns: [
      { key: "status", label: "Status" },
      { key: "tasks", label: "Tasks", align: "right" },
      { key: "high_priority", label: "High / Critical", align: "right" },
      { key: "resolved", label: "Resolved", align: "right" },
    ],
  },
  {
    key: "time-log-report",
    label: "Time Log Report",
    group: "HR / Operations",
    description: "Daily logged working hours from attendance.",
    dateColumn: "work_date",
    sql: `
      SELECT work_date AS log_date,
             COUNT(DISTINCT employee_id) AS employees,
             COALESCE(SUM(working_hours),0) AS logged_hours,
             COALESCE(SUM(overtime_hours),0) AS overtime_hours
      FROM hr_attendance
      WHERE work_date IS NOT NULL ${RANGE}
      GROUP BY work_date
      ORDER BY work_date DESC`,
    columns: [
      { key: "log_date", label: "Date" },
      { key: "employees", label: "Employees", align: "right" },
      { key: "logged_hours", label: "Logged Hrs", align: "right" },
      { key: "overtime_hours", label: "Overtime Hrs", align: "right" },
    ],
  },
  {
    key: "weekly-timesheet",
    label: "Weekly Timesheet",
    group: "HR / Operations",
    description: "Per-employee logged hours grouped by ISO week.",
    dateColumn: "work_date",
    sql: `
      SELECT employee_name,
             CONCAT(YEAR(work_date), '-W', LPAD(WEEK(work_date, 3), 2, '0')) AS week,
             COUNT(*) AS days_logged,
             COALESCE(SUM(working_hours),0) AS total_hours,
             COALESCE(SUM(overtime_hours),0) AS overtime_hours
      FROM hr_attendance
      WHERE work_date IS NOT NULL ${RANGE}
      GROUP BY employee_name, week
      ORDER BY week DESC, employee_name`,
    columns: [
      { key: "employee_name", label: "Employee" },
      { key: "week", label: "Week" },
      { key: "days_logged", label: "Days", align: "right" },
      { key: "total_hours", label: "Total Hrs", align: "right" },
      { key: "overtime_hours", label: "Overtime Hrs", align: "right" },
    ],
  },

  // =========================================================================
  // Expenses (Finance → Expenses reporting suite, Phases 1–12, 19, 20)
  //
  // Every report below is a read-only projection over the authoritative
  // `expenses` engine table (and the shared `finance_gst_input` register for
  // GST). No value is duplicated or hand-maintained: taxable / GST / TDS /
  // gross / net / paid / outstanding all come straight from the columns the
  // server engine computes on write (lib/finance-expenses.ts). Grouped under
  // "Expenses" so they surface as their own category on the Financial Reports
  // page while still being served by the finance-domain reports route.
  // =========================================================================
  {
    key: "expense-register",
    label: "Expense Register",
    group: "Expenses",
    description: "Every expense line with payee, PAN/GSTIN, tax, gross, net, paid and outstanding (Phase 2).",
    dateColumn: "expense_date",
    sql: `
      SELECT expense_id,
             expense_date AS date,
             COALESCE(NULLIF(expense_type,''),'—') AS type,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(vendor_pan,''),'—') AS pan,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(expense_category,''),'—') AS category,
             COALESCE(NULLIF(expense_head,''),'—') AS head,
             COALESCE(NULLIF(project_name,''),'—') AS project,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(gst_amount,0) AS gst,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(net_payable,0) AS net,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(workflow_status,''), approval_status) AS status
      FROM expenses
      WHERE 1=1 ${RANGE}
      ORDER BY expense_date DESC, id DESC`,
    columns: [
      { key: "expense_id", label: "Expense ID" },
      { key: "date", label: "Date" },
      { key: "type", label: "Type" },
      { key: "party", label: "Employee / Vendor" },
      { key: "pan", label: "PAN" },
      { key: "gstin", label: "GSTIN" },
      { key: "category", label: "Category" },
      { key: "head", label: "Head" },
      { key: "project", label: "Project" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "employee-expense",
    label: "Employee Expense",
    group: "Expenses",
    description: "Employee-borne expenses with advance, adjustment and reimbursement payable (Phase 3).",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(employee_name,''), party_name) AS employee,
             COALESCE(NULLIF(employee_id,''),'—') AS employee_id,
             COALESCE(NULLIF(department,''),'—') AS department,
             expense_id AS expense,
             expense_date AS date,
             COALESCE(NULLIF(expense_category,''),'—') AS category,
             COALESCE(NULLIF(project_name,''),'—') AS project,
             COALESCE(gst_amount,0) AS gst,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(advance_amount,0) AS advance,
             COALESCE(advance_adjusted,0) AS adjusted,
             COALESCE(net_payable,0) AS payable,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding
      FROM expenses
      WHERE employee_id IS NOT NULL AND employee_id <> '' ${RANGE}
      ORDER BY expense_date DESC, id DESC`,
    columns: [
      { key: "employee", label: "Employee" },
      { key: "employee_id", label: "Employee ID" },
      { key: "department", label: "Department" },
      { key: "expense", label: "Expense" },
      { key: "date", label: "Date" },
      { key: "category", label: "Category" },
      { key: "project", label: "Project" },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "advance", label: "Advance", align: "right", money: true },
      { key: "adjusted", label: "Adjusted", align: "right", money: true },
      { key: "payable", label: "Payable", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "vendor-expense",
    label: "Vendor Expense",
    group: "Expenses",
    description: "Vendor-borne expenses with GSTIN, PAN, invoice, tax, gross, net, paid and outstanding (Phase 4).",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''), party_name) AS vendor,
             COALESCE(NULLIF(vendor_id,''),'—') AS vendor_id,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(vendor_pan,''),'—') AS pan,
             expense_id AS expense,
             COALESCE(NULLIF(vendor_invoice_number,''), NULLIF(bill_receipt_no,''),'—') AS invoice,
             expense_date AS date,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(gst_amount,0) AS gst,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(net_payable,0) AS net,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding
      FROM expenses
      WHERE vendor_id IS NOT NULL AND vendor_id <> '' ${RANGE}
      ORDER BY expense_date DESC, id DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "vendor_id", label: "Vendor ID" },
      { key: "gstin", label: "GSTIN" },
      { key: "pan", label: "PAN" },
      { key: "expense", label: "Expense" },
      { key: "invoice", label: "Invoice / Receipt" },
      { key: "date", label: "Date" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "reimbursement-register",
    label: "Reimbursement Register",
    group: "Expenses",
    description: "Employee reimbursements with advance, adjustment, additional claim and settlement status.",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(employee_name,''), party_name) AS employee,
             expense_id AS expense,
             expense_date AS date,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(advance_amount,0) AS advance,
             COALESCE(advance_adjusted,0) AS adjusted,
             COALESCE(additional_reimbursement,0) AS additional,
             COALESCE(net_payable,0) AS payable,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(reimbursement_status,''), NULLIF(workflow_status,''), approval_status) AS status
      FROM expenses
      WHERE employee_id IS NOT NULL AND employee_id <> '' ${RANGE}
      ORDER BY expense_date DESC, id DESC`,
    columns: [
      { key: "employee", label: "Employee" },
      { key: "expense", label: "Expense" },
      { key: "date", label: "Date" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "advance", label: "Advance", align: "right", money: true },
      { key: "adjusted", label: "Adjusted", align: "right", money: true },
      { key: "additional", label: "Additional", align: "right", money: true },
      { key: "payable", label: "Payable", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "project-expense",
    label: "Project Expense",
    group: "Expenses",
    description: "Expenses attributed to projects with client, payee, category, tax, gross and outstanding (Phase 7).",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(project_name,''),'Unassigned') AS project,
             COALESCE(NULLIF(client_name,''),'—') AS client,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(expense_category,''),'—') AS category,
             COALESCE(NULLIF(expense_head,''),'—') AS head,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(gst_amount,0) AS gst,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(net_payable,0) AS net,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding
      FROM expenses
      WHERE 1=1 ${RANGE}
      ORDER BY project, expense_date DESC`,
    columns: [
      { key: "project", label: "Project" },
      { key: "client", label: "Client" },
      { key: "party", label: "Employee / Vendor" },
      { key: "category", label: "Category" },
      { key: "head", label: "Expense Head" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "department-expense",
    label: "Department Expense",
    group: "Expenses",
    description: "Spend rolled up by department with tax, gross, net, paid and outstanding.",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(department,''),'Unassigned') AS department,
             COUNT(*) AS records,
             COALESCE(SUM(taxable_amount),0) AS taxable,
             COALESCE(SUM(gst_amount),0) AS gst,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(net_payable),0) AS net,
             COALESCE(SUM(amount_paid),0) AS paid,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM expenses
      WHERE 1=1 ${RANGE}
      GROUP BY department
      ORDER BY gross DESC`,
    columns: [
      { key: "department", label: "Department" },
      { key: "records", label: "Records", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "cost-centre-expense",
    label: "Cost Centre Expense",
    group: "Expenses",
    description: "Spend rolled up by cost centre with tax, gross, net, paid and outstanding.",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(cost_centre,''),'Unassigned') AS cost_centre,
             COUNT(*) AS records,
             COALESCE(SUM(taxable_amount),0) AS taxable,
             COALESCE(SUM(gst_amount),0) AS gst,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(net_payable),0) AS net,
             COALESCE(SUM(amount_paid),0) AS paid,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM expenses
      WHERE 1=1 ${RANGE}
      GROUP BY cost_centre
      ORDER BY gross DESC`,
    columns: [
      { key: "cost_centre", label: "Cost Centre" },
      { key: "records", label: "Records", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    // Phase 35 — cost-centre rollup over the posted general ledger, so the
    // dimension entered on manual journals (and carried through posting) is
    // reportable alongside the expense-sourced cost-centre report above.
    key: "cost-centre-ledger",
    label: "Cost Centre Ledger",
    group: "Finance",
    description: "Posted general-ledger movement rolled up by cost centre — debit, credit, GST, TDS and net.",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(cost_centre,''),'Unassigned') AS cost_centre,
             COUNT(*) AS entries,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit,
             COALESCE(SUM(gst_amount),0) AS gst,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS net
      FROM general_ledger
      WHERE 1=1 ${RANGE}
      GROUP BY cost_centre
      ORDER BY net DESC`,
    columns: [
      { key: "cost_centre", label: "Cost Centre" },
      { key: "entries", label: "Entries", align: "right" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
    ],
  },
  {
    key: "expense-payment-register",
    label: "Payment Register",
    group: "Expenses",
    description: "Expenses with a payment made — mode, date, reference, gross, TDS, net, paid and balance.",
    dateColumn: "expense_date",
    sql: `
      SELECT expense_id AS expense,
             expense_date AS date,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(payment_mode,''),'—') AS mode,
             payment_date,
             COALESCE(NULLIF(payment_reference,''),'—') AS reference,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(net_payable,0) AS net,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM expenses
      WHERE COALESCE(amount_paid,0) > 0 ${RANGE}
      ORDER BY payment_date DESC, id DESC`,
    columns: [
      { key: "expense", label: "Expense" },
      { key: "date", label: "Date" },
      { key: "party", label: "Employee / Vendor" },
      { key: "mode", label: "Mode" },
      { key: "payment_date", label: "Paid On" },
      { key: "reference", label: "Reference" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Balance", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "outstanding-expense",
    label: "Outstanding Expense",
    group: "Expenses",
    description: "All expenses with a balance still payable, aged from the expense date.",
    dateColumn: "expense_date",
    sql: `
      SELECT expense_id AS expense,
             expense_date AS date,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             DATEDIFF(CURDATE(), expense_date) AS age_days,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM expenses
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      ORDER BY outstanding_amount DESC`,
    columns: [
      { key: "expense", label: "Expense" },
      { key: "date", label: "Date" },
      { key: "party", label: "Employee / Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "age_days", label: "Age (days)", align: "right" },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "overdue-expense",
    label: "Overdue Expense",
    group: "Expenses",
    description: "Outstanding expenses aged beyond their payment terms (default 30 days when no term is set).",
    dateColumn: "expense_date",
    sql: `
      SELECT expense_id AS expense,
             expense_date AS date,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(payment_terms,''),'—') AS terms,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             DATEDIFF(CURDATE(), expense_date) AS age_days
      FROM expenses
      WHERE COALESCE(outstanding_amount,0) > 0
        AND DATEDIFF(CURDATE(), expense_date) > COALESCE(NULLIF(CAST(payment_terms AS UNSIGNED),0),30)
        ${RANGE}
      ORDER BY age_days DESC`,
    columns: [
      { key: "expense", label: "Expense" },
      { key: "date", label: "Date" },
      { key: "party", label: "Employee / Vendor" },
      { key: "terms", label: "Terms (days)" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "age_days", label: "Age (days)", align: "right" },
    ],
  },
  {
    key: "expense-category-analytics",
    label: "Category Analytics",
    group: "Expenses",
    description: "Spend by category and expense head with record count and gross / net split (Phase 10).",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(expense_category,''),'Uncategorised') AS category,
             COALESCE(NULLIF(expense_head,''),'—') AS head,
             COUNT(*) AS records,
             COALESCE(SUM(taxable_amount),0) AS taxable,
             COALESCE(SUM(gst_amount),0) AS gst,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(net_payable),0) AS net
      FROM expenses
      WHERE 1=1 ${RANGE}
      GROUP BY category, head
      ORDER BY gross DESC`,
    columns: [
      { key: "category", label: "Category" },
      { key: "head", label: "Expense Head" },
      { key: "records", label: "Records", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
    ],
  },
  {
    key: "expense-top-spend",
    label: "Top Expenses",
    group: "Expenses",
    description: "Highest single expenses by gross amount with payee, category and project (Phase 11).",
    dateColumn: "expense_date",
    sql: `
      SELECT expense_id AS expense,
             expense_date AS date,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(expense_category,''),'—') AS category,
             COALESCE(NULLIF(project_name,''),'—') AS project,
             COALESCE(gross_amount,0) AS gross,
             COALESCE(net_payable,0) AS net,
             COALESCE(outstanding_amount,0) AS outstanding
      FROM expenses
      WHERE 1=1 ${RANGE}
      ORDER BY gross_amount DESC
      LIMIT 50`,
    columns: [
      { key: "expense", label: "Expense" },
      { key: "date", label: "Date" },
      { key: "party", label: "Employee / Vendor" },
      { key: "category", label: "Category" },
      { key: "project", label: "Project" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "expense-monthly-trend",
    label: "Expense Trend",
    group: "Expenses",
    description: "Month-by-month expense gross, tax and net across the selected period (Phase 9).",
    dateColumn: "expense_date",
    sql: `
      SELECT DATE_FORMAT(expense_date, '%Y-%m') AS period,
             COUNT(*) AS records,
             COALESCE(SUM(taxable_amount),0) AS taxable,
             COALESCE(SUM(gst_amount),0) AS gst,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(net_payable),0) AS net
      FROM expenses
      WHERE expense_date IS NOT NULL ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Month" },
      { key: "records", label: "Records", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst", label: "GST", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
    ],
  },
  {
    key: "expense-gst-input",
    label: "Expense GST Input",
    group: "Expenses",
    description: "ITC register rows sourced from expenses — taxable, rate, CGST/SGST/IGST/Cess, net ITC and 2B reconciliation (Phase 5).",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(source_transaction_id,''), source_bill_id) AS expense_id,
             COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(vendor_pan,''),'—') AS pan,
             COALESCE(NULLIF(bill_number,''),'—') AS invoice,
             bill_date AS date,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(gst_rate,0) AS gst_rate,
             COALESCE(cgst_amount,0) AS cgst,
             COALESCE(sgst_amount,0) AS sgst,
             COALESCE(igst_amount,0) AS igst,
             COALESCE(cess_amount,0) AS cess,
             COALESCE(itc_eligible_amount,0) AS itc,
             COALESCE(itc_reversal_amount,0) AS itc_reversal,
             COALESCE(itc_net,0) AS net_itc,
             COALESCE(NULLIF(gstr2b_reference,''),'—') AS twob_status,
             COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS reconciliation
      FROM finance_gst_input
      WHERE source = 'Expense' ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "expense_id", label: "Expense ID" },
      { key: "vendor", label: "Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "pan", label: "PAN" },
      { key: "invoice", label: "Invoice" },
      { key: "date", label: "Date" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst_rate", label: "GST Rate", align: "right" },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "cess", label: "Cess", align: "right", money: true },
      { key: "itc", label: "ITC", align: "right", money: true },
      { key: "itc_reversal", label: "ITC Reversal", align: "right", money: true },
      { key: "net_itc", label: "Net ITC", align: "right", money: true },
      { key: "twob_status", label: "2B Status" },
      { key: "reconciliation", label: "Reconciliation" },
    ],
  },
  {
    key: "expense-tds",
    label: "Expense TDS",
    group: "Expenses",
    description: "TDS deducted on expenses — section, nature, gross, rate, TDS, paid and balance (Phase 6).",
    dateColumn: "expense_date",
    sql: `
      SELECT expense_id,
             COALESCE(NULLIF(party_name,''),'—') AS payee,
             COALESCE(NULLIF(vendor_pan,''),'—') AS pan,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(tds_section,''),'—') AS section,
             COALESCE(NULLIF(tds_nature_of_payment,''),'—') AS nature,
             COALESCE(tds_base,0) AS gross,
             COALESCE(tds_rate,0) AS tds_rate,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS balance
      FROM expenses
      WHERE COALESCE(tds_applicable,0) = 1 AND COALESCE(tds_amount,0) > 0 ${RANGE}
      ORDER BY expense_date DESC, id DESC`,
    columns: [
      { key: "expense_id", label: "Expense ID" },
      { key: "payee", label: "Vendor / Employee" },
      { key: "pan", label: "PAN" },
      { key: "gstin", label: "GSTIN" },
      { key: "section", label: "Section" },
      { key: "nature", label: "Nature" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds_rate", label: "TDS Rate", align: "right" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
  },
  {
    key: "expense-raw-gst",
    label: "Raw GST Data",
    group: "Expenses",
    description: "Flat GST export for the CA / return filing — FY, period, quarter and the full ITC breakdown (Phase 19).",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(financial_year,''),'—') AS fy,
             COALESCE(NULLIF(period,''),'—') AS month,
             COALESCE(NULLIF(quarter,''),'—') AS quarter,
             COALESCE(NULLIF(source_transaction_id,''), source_bill_id) AS expense_id,
             COALESCE(NULLIF(source,''),'—') AS source,
             COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(vendor_pan,''),'—') AS pan,
             COALESCE(NULLIF(bill_number,''),'—') AS invoice,
             bill_date AS date,
             COALESCE(NULLIF(hsn_sac,''),'—') AS hsn_sac,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(gst_rate,0) AS gst_rate,
             COALESCE(cgst_amount,0) AS cgst,
             COALESCE(sgst_amount,0) AS sgst,
             COALESCE(igst_amount,0) AS igst,
             COALESCE(cess_amount,0) AS cess,
             COALESCE(itc_eligible_amount,0) AS itc,
             COALESCE(itc_reversal_amount,0) AS itc_reversal,
             COALESCE(itc_net,0) AS net_itc,
             COALESCE(NULLIF(gstr2b_reference,''),'—') AS twob_status,
             COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS reconciliation
      FROM finance_gst_input
      WHERE source = 'Expense' ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "fy", label: "FY" },
      { key: "month", label: "Month" },
      { key: "quarter", label: "Quarter" },
      { key: "expense_id", label: "Expense ID" },
      { key: "source", label: "Source" },
      { key: "vendor", label: "Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "pan", label: "PAN" },
      { key: "invoice", label: "Invoice" },
      { key: "date", label: "Date" },
      { key: "hsn_sac", label: "HSN/SAC" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gst_rate", label: "GST Rate", align: "right" },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "cess", label: "Cess", align: "right", money: true },
      { key: "itc", label: "ITC", align: "right", money: true },
      { key: "itc_reversal", label: "ITC Reversal", align: "right", money: true },
      { key: "net_itc", label: "Net ITC", align: "right", money: true },
      { key: "twob_status", label: "2B Status" },
      { key: "reconciliation", label: "Reconciliation" },
    ],
  },
  {
    key: "expense-raw-tds",
    label: "Raw TDS Data",
    group: "Expenses",
    description: "Flat TDS export for the CA / return filing — FY, quarter, section, nature, rate, TDS, paid and balance (Phase 20).",
    dateColumn: "expense_date",
    sql: `
      SELECT COALESCE(NULLIF(financial_year,''),'—') AS fy,
             COALESCE(NULLIF(accounting_period,''),'—') AS month,
             COALESCE(NULLIF(party_name,''),'—') AS payee,
             expense_id,
             COALESCE(NULLIF(expense_type,''),'—') AS source,
             COALESCE(NULLIF(vendor_pan,''),'—') AS pan,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(tds_section,''),'—') AS section,
             COALESCE(NULLIF(tds_nature_of_payment,''),'—') AS nature,
             COALESCE(tds_base,0) AS gross,
             COALESCE(tds_rate,0) AS tds_rate,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS balance
      FROM expenses
      WHERE COALESCE(tds_applicable,0) = 1 AND COALESCE(tds_amount,0) > 0 ${RANGE}
      ORDER BY expense_date DESC, id DESC`,
    columns: [
      { key: "fy", label: "FY" },
      { key: "month", label: "Month" },
      { key: "payee", label: "Vendor / Employee" },
      { key: "expense_id", label: "Expense ID" },
      { key: "source", label: "Source" },
      { key: "pan", label: "PAN" },
      { key: "gstin", label: "GSTIN" },
      { key: "section", label: "Section" },
      { key: "nature", label: "Nature" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds_rate", label: "TDS Rate", align: "right" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
  },

  // ==========================================================================
  // Phase 1 — data-backed definitions for the Financial Reports catalogue.
  //
  // Each report below is a read-only projection over an EXISTING ERP table:
  //   general_ledger / journal_entries / chart_of_accounts (posted accounting),
  //   sales_invoices + payments (receivables), purchase_bills (payables),
  //   bank_transactions + finance_accounts (bank & cash), gst_filings +
  //   finance_gst_input (GST), tds_filings (TDS), finance_records (P&L).
  // They are grouped under "Finance" so they never leak into the cross-module
  // Reports facility (GENERAL_REPORTS excludes finance-domain groups). The
  // Financial Reports catalogue reaches them via from(); nothing here duplicates
  // an engine — every value comes straight from the source module's columns.
  // ==========================================================================

  // --- Core financial statements (posted general ledger + COA classification) -
  {
    key: "rx-trial-balance",
    label: "Trial Balance",
    group: "Finance",
    description: "Debit and credit balance per ledger account from the posted general ledger.",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(account_name,''),'Unclassified') AS account,
             COALESCE(NULLIF(account_group,''),'—') AS account_group,
             COALESCE(NULLIF(account_type,''),'—') AS account_type,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit,
             COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance
      FROM general_ledger
      WHERE 1=1 ${RANGE}
      GROUP BY account, account_group, account_type
      ORDER BY account_group, account`,
    columns: [
      { key: "account", label: "Account" },
      { key: "account_group", label: "Group" },
      { key: "account_type", label: "Type" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
    diagnostics: {
      recon: [{ kind: "debitCredit" }],
      requires: ["posting", "coaMapping"],
      emptyHint:
        "No posted ledger entries fall in the selected period. Post approved journal entries to populate the Trial Balance.",
    },
  },
  {
    key: "rx-balance-sheet",
    label: "Balance Sheet",
    group: "Finance",
    description: "Asset, liability and equity balances classified from the posted ledger.",
    dateColumn: "transaction_date",
    sql: `
      SELECT CASE
               WHEN account_type LIKE '%Asset%' THEN 'Assets'
               WHEN account_type LIKE '%Liab%' THEN 'Liabilities'
               WHEN account_type LIKE '%Equity%' OR account_type LIKE '%Capital%' THEN 'Equity'
               ELSE 'Other'
             END AS section,
             COALESCE(NULLIF(account_group,''),'—') AS account_group,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit,
             COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance
      FROM general_ledger
      WHERE (account_type LIKE '%Asset%' OR account_type LIKE '%Liab%'
             OR account_type LIKE '%Equity%' OR account_type LIKE '%Capital%') ${RANGE}
      GROUP BY section, account_group, account
      ORDER BY section, account_group, account`,
    columns: [
      { key: "section", label: "Section" },
      { key: "account_group", label: "Group" },
      { key: "account", label: "Account" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
    diagnostics: {
      recon: [{ kind: "balanceSheet" }],
      requires: ["posting", "coaMapping", "earnings"],
      emptyHint:
        "No posted balances classify into Assets, Liabilities or Equity for this period. Check Chart of Accounts classification and post entries.",
    },
  },
  {
    key: "rx-cash-flow",
    label: "Cash Flow Statement",
    group: "Finance",
    description: "Month-by-month cash inflow, outflow and net movement across bank & cash accounts.",
    dateColumn: "transaction_date",
    sql: `
      SELECT DATE_FORMAT(transaction_date, '%Y-%m') AS period,
             COALESCE(SUM(credit),0) AS inflow,
             COALESCE(SUM(debit),0) AS outflow,
             COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) AS net_cash
      FROM bank_transactions
      WHERE transaction_date IS NOT NULL ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Month" },
      { key: "inflow", label: "Inflow", align: "right", money: true },
      { key: "outflow", label: "Outflow", align: "right", money: true },
      { key: "net_cash", label: "Net Cash", align: "right", money: true },
    ],
    diagnostics: {
      recon: [{ kind: "cashFlow" }],
      requires: ["bank"],
      emptyHint: "No bank or cash movement recorded in the selected period.",
    },
  },
  {
    key: "rx-quarterly-pl",
    label: "Quarterly Profit & Loss",
    group: "Finance",
    description: "Income against expenses, summarised by financial quarter.",
    dateColumn: "record_date",
    sql: `
      SELECT CONCAT(YEAR(record_date), '-Q', QUARTER(record_date)) AS period,
             COALESCE(SUM(CASE WHEN module_key = 'sales-invoices' THEN amount ELSE 0 END),0) AS income,
             COALESCE(SUM(CASE WHEN module_key IN ('expenses','purchase-bills') THEN amount ELSE 0 END),0) AS expense,
             COALESCE(SUM(CASE WHEN module_key = 'sales-invoices' THEN amount ELSE 0 END),0)
               - COALESCE(SUM(CASE WHEN module_key IN ('expenses','purchase-bills') THEN amount ELSE 0 END),0) AS net
      FROM finance_records
      WHERE record_date IS NOT NULL ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Quarter" },
      { key: "income", label: "Income", align: "right", money: true },
      { key: "expense", label: "Expense", align: "right", money: true },
      { key: "net", label: "Net", align: "right", money: true },
    ],
    diagnostics: {
      recon: [{ kind: "plWide" }],
      requires: ["posting", "earnings"],
      emptyHint: "No income or expense records fall in the selected period.",
    },
  },

  // --- Accounting books (journal_entries / general_ledger / chart_of_accounts) -
  {
    key: "rx-journal-register",
    label: "Journal Register",
    group: "Finance",
    description: "Every journal entry line with voucher type, account, debit and credit.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(voucher_type,''),'—') AS voucher_type,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(approval_status,''),'Pending') AS approval,
             COALESCE(NULLIF(posting_status,''),'Unposted') AS posting
      FROM journal_entries
      WHERE 1=1 ${RANGE}
      ORDER BY journal_date DESC, id DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "voucher_type", label: "Voucher" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "approval", label: "Approval" },
      { key: "posting", label: "Posting" },
    ],
  },
  {
    key: "rx-voucher-register",
    label: "Voucher Register",
    group: "Finance",
    description: "Journal activity grouped by voucher type with debit and credit totals.",
    dateColumn: "journal_date",
    sql: `
      SELECT COALESCE(NULLIF(voucher_type,''),'Unspecified') AS voucher_type,
             COUNT(*) AS entries,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit
      FROM journal_entries
      WHERE 1=1 ${RANGE}
      GROUP BY voucher_type
      ORDER BY entries DESC`,
    columns: [
      { key: "voucher_type", label: "Voucher Type" },
      { key: "entries", label: "Entries", align: "right" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-account-ledger",
    label: "Account Ledger",
    group: "Finance",
    description: "Posted ledger movement per account with debit, credit and net balance.",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(account_name,''),'Unclassified') AS account,
             COALESCE(NULLIF(account_group,''),'—') AS account_group,
             COUNT(*) AS entries,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit,
             COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance
      FROM general_ledger
      WHERE 1=1 ${RANGE}
      GROUP BY account, account_group
      ORDER BY account_group, account`,
    columns: [
      { key: "account", label: "Account" },
      { key: "account_group", label: "Group" },
      { key: "entries", label: "Entries", align: "right" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
  },
  {
    key: "rx-group-ledger",
    label: "Group Ledger",
    group: "Finance",
    description: "Posted ledger movement rolled up by account group.",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(account_group,''),'Ungrouped') AS account_group,
             COUNT(*) AS entries,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit,
             COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance
      FROM general_ledger
      WHERE 1=1 ${RANGE}
      GROUP BY account_group
      ORDER BY balance DESC`,
    columns: [
      { key: "account_group", label: "Group" },
      { key: "entries", label: "Entries", align: "right" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
  },
  {
    key: "rx-receipt-register",
    label: "Receipt Register",
    group: "Finance",
    description: "Cash and bank receipts recorded against invoices.",
    dateColumn: "payment_date",
    sql: `
      SELECT payment_id,
             payment_date,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(invoice_ref,''),'—') AS invoice,
             COALESCE(NULLIF(payment_mode,''),'—') AS mode,
             COALESCE(NULLIF(reference_no,''),'—') AS reference,
             COALESCE(amount,0) AS amount
      FROM payments
      WHERE COALESCE(NULLIF(status,''),'Active') = 'Active' ${RANGE}
      ORDER BY payment_date DESC, id DESC`,
    columns: [
      { key: "payment_id", label: "Receipt" },
      { key: "payment_date", label: "Date" },
      { key: "party", label: "Party" },
      { key: "invoice", label: "Against Invoice" },
      { key: "mode", label: "Mode" },
      { key: "reference", label: "Reference" },
      { key: "amount", label: "Amount", align: "right", money: true },
    ],
  },
  {
    key: "rx-contra-register",
    label: "Contra Register",
    group: "Finance",
    description: "Bank/cash contra entries (transfers between own accounts).",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(reference_no,''),'—') AS reference
      FROM bank_transactions
      WHERE voucher_type LIKE '%Contra%' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Counterparty" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "reference", label: "Reference" },
    ],
  },
  {
    key: "rx-adjustment-register",
    label: "Adjustment Register",
    group: "Finance",
    description: "Journal entries flagged as adjustments.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(narration,''),'—') AS narration,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM journal_entries
      WHERE (voucher_type LIKE '%Adjust%' OR reference_type LIKE '%Adjust%') ${RANGE}
      ORDER BY journal_date DESC, id DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "narration", label: "Narration" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-opening-balance",
    label: "Opening Balance Report",
    group: "Finance",
    description: "Opening balances per ledger account from the chart of accounts.",
    sql: `
      SELECT COALESCE(NULLIF(account_code,''),'—') AS code,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(account_group,''),'—') AS account_group,
             COALESCE(NULLIF(account_type,''),'—') AS account_type,
             COALESCE(opening_balance,0) AS opening_balance,
             COALESCE(NULLIF(opening_balance_type,''),'—') AS balance_type
      FROM chart_of_accounts
      ORDER BY account_group, code`,
    columns: [
      { key: "code", label: "Code" },
      { key: "account", label: "Account" },
      { key: "account_group", label: "Group" },
      { key: "account_type", label: "Type" },
      { key: "opening_balance", label: "Opening Balance", align: "right", money: true },
      { key: "balance_type", label: "Dr/Cr" },
    ],
  },
  {
    key: "rx-closing-balance",
    label: "Closing Balance Report",
    group: "Finance",
    description: "Closing balance per ledger account from the posted general ledger.",
    dateColumn: "transaction_date",
    sql: `
      SELECT COALESCE(NULLIF(account_name,''),'Unclassified') AS account,
             COALESCE(NULLIF(account_group,''),'—') AS account_group,
             COALESCE(SUM(debit),0) AS debit,
             COALESCE(SUM(credit),0) AS credit,
             COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS closing_balance
      FROM general_ledger
      WHERE 1=1 ${RANGE}
      GROUP BY account, account_group
      ORDER BY account_group, account`,
    columns: [
      { key: "account", label: "Account" },
      { key: "account_group", label: "Group" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "closing_balance", label: "Closing Balance", align: "right", money: true },
    ],
  },
  {
    key: "rx-suspense-account",
    label: "Suspense Account Report",
    group: "Finance",
    description: "Ledger lines posted to suspense accounts awaiting classification.",
    dateColumn: "transaction_date",
    sql: `
      SELECT ledger_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM general_ledger
      WHERE account_name LIKE '%Suspense%' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "ledger_id", label: "Ledger" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-reversal-register",
    label: "Reversal Register",
    group: "Finance",
    description: "Journal entries recorded as reversals.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(voucher_type,''),'—') AS voucher_type,
             COALESCE(NULLIF(narration,''),'—') AS narration,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM journal_entries
      WHERE (voucher_type LIKE '%Revers%' OR reference_type LIKE '%Revers%'
             OR narration LIKE '%revers%') ${RANGE}
      ORDER BY journal_date DESC, id DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "voucher_type", label: "Voucher" },
      { key: "narration", label: "Narration" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-cancelled-voucher",
    label: "Cancelled Voucher Report",
    group: "Finance",
    description: "Journal vouchers marked cancelled.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(voucher_type,''),'—') AS voucher_type,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(approval_status,''),'—') AS approval
      FROM journal_entries
      WHERE approval_status = 'Cancelled' OR posting_status = 'Cancelled' ${RANGE}
      ORDER BY journal_date DESC, id DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "voucher_type", label: "Voucher" },
      { key: "account", label: "Account" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "approval", label: "Status" },
    ],
  },

  // --- Receivables (sales_invoices) ------------------------------------------
  {
    key: "rx-customer-outstanding",
    label: "Customer Outstanding",
    group: "Finance",
    description: "Billed, received and outstanding grouped by customer (dues only).",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(client_name,''),'Unnamed customer') AS customer,
             COUNT(*) AS invoices,
             COALESCE(SUM(invoice_total),0) AS billed,
             COALESCE(SUM(amount_received),0) AS received,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM sales_invoices
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      GROUP BY customer
      ORDER BY outstanding DESC`,
    columns: [
      { key: "customer", label: "Customer" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "billed", label: "Billed", align: "right", money: true },
      { key: "received", label: "Received", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "rx-customer-sales",
    label: "Customer-wise Sales",
    group: "Finance",
    description: "Billed, received and outstanding grouped by customer.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(client_name,''),'Unnamed customer') AS customer,
             COUNT(*) AS invoices,
             COALESCE(SUM(invoice_total),0) AS billed,
             COALESCE(SUM(amount_received),0) AS received,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM sales_invoices
      WHERE 1=1 ${RANGE}
      GROUP BY customer
      ORDER BY billed DESC`,
    columns: [
      { key: "customer", label: "Customer" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "billed", label: "Billed", align: "right", money: true },
      { key: "received", label: "Received", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "rx-receivable-ageing",
    label: "Receivable Ageing",
    group: "Finance",
    description: "Outstanding receivables bucketed by age from the due date.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(client_name,''),'Unnamed customer') AS customer,
             COALESCE(SUM(outstanding_amount),0) AS outstanding,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) <= 0 THEN outstanding_amount ELSE 0 END),0) AS not_due,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 1 AND 30 THEN outstanding_amount ELSE 0 END),0) AS d1_30,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END),0) AS d31_60,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END),0) AS d61_90,
             COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) > 90 THEN outstanding_amount ELSE 0 END),0) AS d90_plus
      FROM sales_invoices
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      GROUP BY customer
      ORDER BY outstanding DESC`,
    columns: [
      { key: "customer", label: "Customer" },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "not_due", label: "Not Due", align: "right", money: true },
      { key: "d1_30", label: "1–30d", align: "right", money: true },
      { key: "d31_60", label: "31–60d", align: "right", money: true },
      { key: "d61_90", label: "61–90d", align: "right", money: true },
      { key: "d90_plus", label: "90d+", align: "right", money: true },
    ],
  },
  {
    key: "rx-invoice-receivable",
    label: "Invoice-wise Receivable",
    group: "Finance",
    description: "Each unpaid sales invoice with billed, received and outstanding.",
    dateColumn: "invoice_date",
    sql: `
      SELECT invoice_id,
             invoice_date,
             COALESCE(NULLIF(client_name,''),'—') AS customer,
             due_date,
             COALESCE(invoice_total,0) AS billed,
             COALESCE(amount_received,0) AS received,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM sales_invoices
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      ORDER BY outstanding_amount DESC`,
    columns: [
      { key: "invoice_id", label: "Invoice" },
      { key: "invoice_date", label: "Date" },
      { key: "customer", label: "Customer" },
      { key: "due_date", label: "Due" },
      { key: "billed", label: "Billed", align: "right", money: true },
      { key: "received", label: "Received", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-overdue-receivable",
    label: "Overdue Receivables",
    group: "Finance",
    description: "Unpaid invoices past their due date, aged in days.",
    dateColumn: "invoice_date",
    sql: `
      SELECT invoice_id,
             invoice_date,
             COALESCE(NULLIF(client_name,''),'—') AS customer,
             due_date,
             COALESCE(outstanding_amount,0) AS outstanding,
             DATEDIFF(CURDATE(), due_date) AS age_days,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM sales_invoices
      WHERE COALESCE(outstanding_amount,0) > 0 AND due_date IS NOT NULL
        AND due_date < CURDATE() ${RANGE}
      ORDER BY age_days DESC`,
    columns: [
      { key: "invoice_id", label: "Invoice" },
      { key: "invoice_date", label: "Date" },
      { key: "customer", label: "Customer" },
      { key: "due_date", label: "Due" },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "age_days", label: "Age (days)", align: "right" },
      { key: "status", label: "Status" },
    ],
  },

  // --- Payables (purchase_bills) ---------------------------------------------
  {
    key: "rx-vendor-outstanding",
    label: "Vendor Outstanding",
    group: "Finance",
    description: "Gross, paid and outstanding grouped by vendor (dues only).",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''),'Unnamed vendor') AS vendor,
             COUNT(*) AS bills,
             COALESCE(SUM(gross_bill_amount),0) AS gross,
             COALESCE(SUM(amount_paid),0) AS paid,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM purchase_bills
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      GROUP BY vendor
      ORDER BY outstanding DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "bills", label: "Bills", align: "right" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "rx-bill-payable",
    label: "Bill-wise Payable",
    group: "Finance",
    description: "Each unpaid purchase bill with gross, paid and outstanding.",
    dateColumn: "bill_date",
    sql: `
      SELECT po_number,
             bill_date,
             COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             due_date,
             COALESCE(gross_bill_amount,0) AS gross,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM purchase_bills
      WHERE COALESCE(outstanding_amount,0) > 0 ${RANGE}
      ORDER BY outstanding_amount DESC`,
    columns: [
      { key: "po_number", label: "Bill / PO" },
      { key: "bill_date", label: "Date" },
      { key: "vendor", label: "Vendor" },
      { key: "due_date", label: "Due" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-overdue-payable",
    label: "Overdue Payables",
    group: "Finance",
    description: "Unpaid bills past their due date, aged in days.",
    dateColumn: "bill_date",
    sql: `
      SELECT po_number,
             bill_date,
             COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             due_date,
             COALESCE(outstanding_amount,0) AS outstanding,
             DATEDIFF(CURDATE(), due_date) AS age_days,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM purchase_bills
      WHERE COALESCE(outstanding_amount,0) > 0 AND due_date IS NOT NULL
        AND due_date < CURDATE() ${RANGE}
      ORDER BY age_days DESC`,
    columns: [
      { key: "po_number", label: "Bill / PO" },
      { key: "bill_date", label: "Date" },
      { key: "vendor", label: "Vendor" },
      { key: "due_date", label: "Due" },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "age_days", label: "Age (days)", align: "right" },
      { key: "status", label: "Status" },
    ],
  },

  // --- GST (gst_filings outward + finance_gst_input ITC) ---------------------
  {
    key: "rx-gstr1-summary",
    label: "GSTR-1 Summary",
    group: "Finance",
    description: "Outward supplies summarised by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COUNT(*) AS invoices,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(igst),0) AS igst,
             COALESCE(SUM(cgst),0) AS cgst,
             COALESCE(SUM(sgst),0) AS sgst,
             COALESCE(SUM(cess_amount),0) AS cess,
             COALESCE(SUM(total_tax),0) AS total_tax,
             COALESCE(SUM(total_invoice_value),0) AS invoice_value
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "cess", label: "Cess", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
      { key: "invoice_value", label: "Invoice Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gstr1-detailed",
    label: "GSTR-1 Detailed Register",
    group: "Finance",
    description: "Outward supply invoices with recipient, place of supply and tax split.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(invoice_number,''),'—') AS invoice,
             invoice_date,
             COALESCE(NULLIF(recipient_name,''),'—') AS recipient,
             COALESCE(NULLIF(recipient_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(place_of_supply,''),'—') AS place_of_supply,
             COALESCE(tax_rate,0) AS rate,
             COALESCE(taxable_value,0) AS taxable,
             COALESCE(igst,0) AS igst,
             COALESCE(cgst,0) AS cgst,
             COALESCE(sgst,0) AS sgst,
             COALESCE(cess_amount,0) AS cess,
             COALESCE(total_invoice_value,0) AS invoice_value
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      ORDER BY invoice_date DESC, id DESC`,
    columns: [
      { key: "invoice", label: "Invoice" },
      { key: "invoice_date", label: "Date" },
      { key: "recipient", label: "Recipient" },
      { key: "gstin", label: "GSTIN" },
      { key: "place_of_supply", label: "Place of Supply" },
      { key: "rate", label: "Rate", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "cess", label: "Cess", align: "right", money: true },
      { key: "invoice_value", label: "Invoice Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-b2b",
    label: "B2B Sales Report",
    group: "Finance",
    description: "Registered (B2B) outward supplies grouped by recipient GSTIN.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(recipient_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(recipient_name,''),'—') AS recipient,
             COUNT(*) AS invoices,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(total_tax),0) AS total_tax,
             COALESCE(SUM(total_invoice_value),0) AS invoice_value
      FROM gst_filings
      WHERE recipient_gstin IS NOT NULL AND recipient_gstin <> '' ${RANGE}
      GROUP BY gstin, recipient
      ORDER BY invoice_value DESC`,
    columns: [
      { key: "gstin", label: "GSTIN" },
      { key: "recipient", label: "Recipient" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
      { key: "invoice_value", label: "Invoice Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-b2c",
    label: "B2C Sales Report",
    group: "Finance",
    description: "Unregistered (B2C) outward supplies grouped by place of supply.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(place_of_supply,''),'—') AS place_of_supply,
             COUNT(*) AS invoices,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(total_tax),0) AS total_tax,
             COALESCE(SUM(total_invoice_value),0) AS invoice_value
      FROM gst_filings
      WHERE recipient_gstin IS NULL OR recipient_gstin = '' ${RANGE}
      GROUP BY place_of_supply
      ORDER BY invoice_value DESC`,
    columns: [
      { key: "place_of_supply", label: "Place of Supply" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
      { key: "invoice_value", label: "Invoice Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-credit-note",
    label: "Credit Note Register",
    group: "Finance",
    description: "GST credit notes with recipient and tax reversed.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(invoice_number,''),'—') AS document,
             invoice_date,
             COALESCE(NULLIF(recipient_name,''),'—') AS recipient,
             COALESCE(taxable_value,0) AS taxable,
             COALESCE(total_tax,0) AS total_tax,
             COALESCE(total_invoice_value,0) AS value
      FROM gst_filings
      WHERE invoice_type LIKE '%Credit%' ${RANGE}
      ORDER BY invoice_date DESC, id DESC`,
    columns: [
      { key: "document", label: "Credit Note" },
      { key: "invoice_date", label: "Date" },
      { key: "recipient", label: "Recipient" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
      { key: "value", label: "Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-debit-note",
    label: "Debit Note Register",
    group: "Finance",
    description: "GST debit notes with recipient and additional tax.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(invoice_number,''),'—') AS document,
             invoice_date,
             COALESCE(NULLIF(recipient_name,''),'—') AS recipient,
             COALESCE(taxable_value,0) AS taxable,
             COALESCE(total_tax,0) AS total_tax,
             COALESCE(total_invoice_value,0) AS value
      FROM gst_filings
      WHERE invoice_type LIKE '%Debit%' ${RANGE}
      ORDER BY invoice_date DESC, id DESC`,
    columns: [
      { key: "document", label: "Debit Note" },
      { key: "invoice_date", label: "Date" },
      { key: "recipient", label: "Recipient" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
      { key: "value", label: "Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-output",
    label: "GST Output Report",
    group: "Finance",
    description: "Output GST on sales by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(cgst),0) AS cgst,
             COALESCE(SUM(sgst),0) AS sgst,
             COALESCE(SUM(igst),0) AS igst,
             COALESCE(SUM(cess_amount),0) AS cess,
             COALESCE(SUM(total_tax),0) AS total_tax
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "cess", label: "Cess", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-eligible-itc",
    label: "Eligible ITC Report",
    group: "Finance",
    description: "Input GST eligible for credit, per source bill.",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(bill_number,''),'—') AS bill,
             bill_date,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(itc_cgst,0) AS itc_cgst,
             COALESCE(itc_sgst,0) AS itc_sgst,
             COALESCE(itc_igst,0) AS itc_igst,
             COALESCE(itc_cess,0) AS itc_cess,
             COALESCE(itc_net,0) AS net_itc
      FROM finance_gst_input
      WHERE COALESCE(itc_eligible,0) = 1 ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "bill", label: "Bill" },
      { key: "bill_date", label: "Date" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "itc_cgst", label: "ITC CGST", align: "right", money: true },
      { key: "itc_sgst", label: "ITC SGST", align: "right", money: true },
      { key: "itc_igst", label: "ITC IGST", align: "right", money: true },
      { key: "itc_cess", label: "ITC Cess", align: "right", money: true },
      { key: "net_itc", label: "Net ITC", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-ineligible-itc",
    label: "Ineligible ITC Report",
    group: "Finance",
    description: "Input GST blocked or ineligible for credit, per source bill.",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(NULLIF(vendor_gstin,''),'—') AS gstin,
             COALESCE(NULLIF(bill_number,''),'—') AS bill,
             bill_date,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(total_gst,0) AS total_gst,
             COALESCE(itc_ineligible_amount,0) AS ineligible
      FROM finance_gst_input
      WHERE COALESCE(itc_ineligible_amount,0) > 0 ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "gstin", label: "GSTIN" },
      { key: "bill", label: "Bill" },
      { key: "bill_date", label: "Date" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_gst", label: "Total GST", align: "right", money: true },
      { key: "ineligible", label: "Ineligible ITC", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-itc-reversal",
    label: "ITC Reversal Report",
    group: "Finance",
    description: "Input tax credit reversed, per source bill.",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(NULLIF(bill_number,''),'—') AS bill,
             bill_date,
             COALESCE(itc_gross,0) AS itc_gross,
             COALESCE(itc_reversal_amount,0) AS reversal,
             COALESCE(itc_net,0) AS net_itc
      FROM finance_gst_input
      WHERE COALESCE(itc_reversal_amount,0) > 0 ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "bill", label: "Bill" },
      { key: "bill_date", label: "Date" },
      { key: "itc_gross", label: "ITC Gross", align: "right", money: true },
      { key: "reversal", label: "Reversal", align: "right", money: true },
      { key: "net_itc", label: "Net ITC", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-recon",
    label: "GST Reconciliation",
    group: "Finance",
    description: "Input GST reconciliation status against GSTR-2B.",
    dateColumn: "bill_date",
    sql: `
      SELECT COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS status,
             COUNT(*) AS records,
             COALESCE(SUM(taxable_amount),0) AS taxable,
             COALESCE(SUM(total_gst),0) AS total_gst,
             COALESCE(SUM(itc_net),0) AS net_itc
      FROM finance_gst_input
      WHERE 1=1 ${RANGE}
      GROUP BY status
      ORDER BY records DESC`,
    columns: [
      { key: "status", label: "Reconciliation" },
      { key: "records", label: "Records", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_gst", label: "Total GST", align: "right", money: true },
      { key: "net_itc", label: "Net ITC", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-rate-wise",
    label: "GST Rate-wise Report",
    group: "Finance",
    description: "Outward supplies grouped by GST rate.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(tax_rate,0) AS rate,
             COUNT(*) AS invoices,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(total_tax),0) AS total_tax
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY rate
      ORDER BY rate`,
    columns: [
      { key: "rate", label: "Rate %", align: "right" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-gstin-wise",
    label: "GSTIN-wise Report",
    group: "Finance",
    description: "Outward supplies grouped by recipient GSTIN.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(recipient_gstin,''),'Unregistered') AS gstin,
             COUNT(*) AS invoices,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(total_tax),0) AS total_tax,
             COALESCE(SUM(total_invoice_value),0) AS invoice_value
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY gstin
      ORDER BY invoice_value DESC`,
    columns: [
      { key: "gstin", label: "GSTIN" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
      { key: "invoice_value", label: "Invoice Value", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-place-supply",
    label: "Place of Supply Report",
    group: "Finance",
    description: "Outward supplies grouped by place of supply.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(place_of_supply,''),'—') AS place_of_supply,
             COUNT(*) AS invoices,
             COALESCE(SUM(taxable_value),0) AS taxable,
             COALESCE(SUM(igst),0) AS igst,
             COALESCE(SUM(cgst),0) AS cgst,
             COALESCE(SUM(sgst),0) AS sgst,
             COALESCE(SUM(total_tax),0) AS total_tax
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY place_of_supply
      ORDER BY total_tax DESC`,
    columns: [
      { key: "place_of_supply", label: "Place of Supply" },
      { key: "invoices", label: "Invoices", align: "right" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "total_tax", label: "Total Tax", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-cgst",
    label: "CGST Report",
    group: "Finance",
    description: "Output CGST against input CGST (ITC) by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(SUM(cgst),0) AS output_cgst,
             COALESCE(SUM(itc_cgst),0) AS itc_cgst,
             COALESCE(SUM(cgst),0) - COALESCE(SUM(itc_cgst),0) AS net_cgst
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "output_cgst", label: "Output CGST", align: "right", money: true },
      { key: "itc_cgst", label: "ITC CGST", align: "right", money: true },
      { key: "net_cgst", label: "Net CGST", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-sgst",
    label: "SGST Report",
    group: "Finance",
    description: "Output SGST against input SGST (ITC) by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(SUM(sgst),0) AS output_sgst,
             COALESCE(SUM(itc_sgst),0) AS itc_sgst,
             COALESCE(SUM(sgst),0) - COALESCE(SUM(itc_sgst),0) AS net_sgst
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "output_sgst", label: "Output SGST", align: "right", money: true },
      { key: "itc_sgst", label: "ITC SGST", align: "right", money: true },
      { key: "net_sgst", label: "Net SGST", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-igst",
    label: "IGST Report",
    group: "Finance",
    description: "Output IGST against input IGST (ITC) by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(SUM(igst),0) AS output_igst,
             COALESCE(SUM(itc_igst),0) AS itc_igst,
             COALESCE(SUM(igst),0) - COALESCE(SUM(itc_igst),0) AS net_igst
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "output_igst", label: "Output IGST", align: "right", money: true },
      { key: "itc_igst", label: "ITC IGST", align: "right", money: true },
      { key: "net_igst", label: "Net IGST", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-cess",
    label: "Cess Report",
    group: "Finance",
    description: "Output cess against input cess (ITC) by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(SUM(cess_amount),0) AS output_cess,
             COALESCE(SUM(itc_cess),0) AS itc_cess,
             COALESCE(SUM(cess_amount),0) - COALESCE(SUM(itc_cess),0) AS net_cess
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "output_cess", label: "Output Cess", align: "right", money: true },
      { key: "itc_cess", label: "ITC Cess", align: "right", money: true },
      { key: "net_cess", label: "Net Cess", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-liability",
    label: "GST Liability Report",
    group: "Finance",
    description: "Net GST liability after ITC, interest and late fee by return period.",
    dateColumn: "invoice_date",
    sql: `
      SELECT COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(SUM(total_tax),0) AS output_tax,
             COALESCE(SUM(net_itc),0) AS net_itc,
             COALESCE(SUM(interest),0) AS interest,
             COALESCE(SUM(late_fee),0) AS late_fee,
             COALESCE(SUM(total_liability),0) AS liability
      FROM gst_filings
      WHERE 1=1 ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Period" },
      { key: "output_tax", label: "Output Tax", align: "right", money: true },
      { key: "net_itc", label: "Net ITC", align: "right", money: true },
      { key: "interest", label: "Interest", align: "right", money: true },
      { key: "late_fee", label: "Late Fee", align: "right", money: true },
      { key: "liability", label: "Net Liability", align: "right", money: true },
    ],
  },
  {
    key: "rx-gst-payment-challan",
    label: "GST Payment / Challan Report",
    group: "Finance",
    description: "GST payments made against challans.",
    dateColumn: "payment_date",
    sql: `
      SELECT gst_filing_id,
             COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(NULLIF(challan_cin,''),'—') AS challan,
             payment_date,
             COALESCE(total_liability,0) AS liability,
             COALESCE(NULLIF(payment_status,''),'Pending') AS status
      FROM gst_filings
      WHERE challan_cin IS NOT NULL AND challan_cin <> '' ${RANGE}
      ORDER BY payment_date DESC, id DESC`,
    columns: [
      { key: "gst_filing_id", label: "Filing" },
      { key: "period", label: "Period" },
      { key: "challan", label: "Challan CIN" },
      { key: "payment_date", label: "Paid On" },
      { key: "liability", label: "Liability", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-gst-exception",
    label: "GST Exception Report",
    group: "Finance",
    description: "GST filings flagged with validation errors.",
    dateColumn: "invoice_date",
    sql: `
      SELECT gst_filing_id,
             COALESCE(NULLIF(return_period,''),'—') AS period,
             COALESCE(NULLIF(gstin,''),'—') AS gstin,
             COALESCE(NULLIF(validation_status,''),'—') AS validation,
             COALESCE(validation_error_count,0) AS errors,
             COALESCE(NULLIF(validation_message,''),'—') AS message
      FROM gst_filings
      WHERE COALESCE(validation_error_count,0) > 0
         OR COALESCE(NULLIF(validation_status,''),'') = 'Error' ${RANGE}
      ORDER BY errors DESC, id DESC`,
    columns: [
      { key: "gst_filing_id", label: "Filing" },
      { key: "period", label: "Period" },
      { key: "gstin", label: "GSTIN" },
      { key: "validation", label: "Validation" },
      { key: "errors", label: "Errors", align: "right" },
      { key: "message", label: "Message" },
    ],
  },

  // --- TDS / TCS (tds_filings) -----------------------------------------------
  {
    key: "rx-tds-deductee",
    label: "Deductee-wise TDS Report",
    group: "Finance",
    description: "TDS grouped by deductee with gross, deducted, paid and balance.",
    dateColumn: "challan_date",
    sql: `
      SELECT COALESCE(NULLIF(deductee_name,''),'—') AS deductee,
             COALESCE(NULLIF(pan,''),'—') AS pan,
             COUNT(*) AS records,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(tds_paid),0) AS paid,
             COALESCE(SUM(balance_payable_refund),0) AS balance
      FROM tds_filings
      WHERE 1=1 ${RANGE}
      GROUP BY deductee, pan
      ORDER BY tds DESC`,
    columns: [
      { key: "deductee", label: "Deductee" },
      { key: "pan", label: "PAN" },
      { key: "records", label: "Records", align: "right" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-pan",
    label: "PAN-wise TDS Report",
    group: "Finance",
    description: "TDS grouped by deductee PAN.",
    dateColumn: "challan_date",
    sql: `
      SELECT COALESCE(NULLIF(pan,''),'—') AS pan,
             COUNT(DISTINCT deductee_name) AS deductees,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(tds_paid),0) AS paid
      FROM tds_filings
      WHERE 1=1 ${RANGE}
      GROUP BY pan
      ORDER BY tds DESC`,
    columns: [
      { key: "pan", label: "PAN" },
      { key: "deductees", label: "Deductees", align: "right" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-employee",
    label: "Employee TDS Report",
    group: "Finance",
    description: "TDS on salaries (section 192).",
    dateColumn: "challan_date",
    sql: `
      SELECT COALESCE(NULLIF(deductee_name,''),'—') AS employee,
             COALESCE(NULLIF(pan,''),'—') AS pan,
             COALESCE(NULLIF(section,''),'—') AS section,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(tds_paid),0) AS paid
      FROM tds_filings
      WHERE section = '192' OR payment_type LIKE '%Salary%' ${RANGE}
      GROUP BY employee, pan, section
      ORDER BY tds DESC`,
    columns: [
      { key: "employee", label: "Employee" },
      { key: "pan", label: "PAN" },
      { key: "section", label: "Section" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-challan",
    label: "TDS Challan Register",
    group: "Finance",
    description: "TDS challans with section, amount, interest and late fee.",
    dateColumn: "challan_date",
    sql: `
      SELECT COALESCE(NULLIF(challan_no,''),'—') AS challan,
             challan_date,
             COALESCE(NULLIF(section,''),'—') AS section,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(interest,0) AS interest,
             COALESCE(late_fee,0) AS late_fee,
             COALESCE(tds_paid,0) AS paid
      FROM tds_filings
      WHERE challan_no IS NOT NULL AND challan_no <> '' ${RANGE}
      ORDER BY challan_date DESC, id DESC`,
    columns: [
      { key: "challan", label: "Challan" },
      { key: "challan_date", label: "Date" },
      { key: "section", label: "Section" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "interest", label: "Interest", align: "right", money: true },
      { key: "late_fee", label: "Late Fee", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-payment",
    label: "TDS Payment Report",
    group: "Finance",
    description: "TDS deducted, paid and balance by quarter.",
    dateColumn: "challan_date",
    sql: `
      SELECT COALESCE(NULLIF(quarter,''),'—') AS quarter,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(tds_paid),0) AS paid,
             COALESCE(SUM(balance_payable_refund),0) AS balance
      FROM tds_filings
      WHERE 1=1 ${RANGE}
      GROUP BY quarter
      ORDER BY quarter DESC`,
    columns: [
      { key: "quarter", label: "Quarter" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-outstanding",
    label: "TDS Outstanding Report",
    group: "Finance",
    description: "TDS filings with a balance still payable.",
    dateColumn: "filing_due_date",
    sql: `
      SELECT tds_filing_id,
             COALESCE(NULLIF(deductee_name,''),'—') AS deductee,
             COALESCE(NULLIF(section,''),'—') AS section,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(tds_paid,0) AS paid,
             COALESCE(balance_payable_refund,0) AS balance,
             COALESCE(NULLIF(return_status,''),'Pending') AS status
      FROM tds_filings
      WHERE COALESCE(balance_payable_refund,0) > 0 ${RANGE}
      ORDER BY balance DESC`,
    columns: [
      { key: "tds_filing_id", label: "Filing" },
      { key: "deductee", label: "Deductee" },
      { key: "section", label: "Section" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "balance", label: "Balance", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-tds-return-summary",
    label: "TDS Return Summary",
    group: "Finance",
    description: "TDS summarised by quarter and return type.",
    dateColumn: "filing_due_date",
    sql: `
      SELECT COALESCE(NULLIF(quarter,''),'—') AS quarter,
             COALESCE(NULLIF(return_type,''),'—') AS return_type,
             COUNT(*) AS records,
             COALESCE(SUM(gross_amount),0) AS gross,
             COALESCE(SUM(tds_amount),0) AS tds,
             COALESCE(SUM(tds_paid),0) AS paid,
             COALESCE(SUM(total_liability),0) AS liability
      FROM tds_filings
      WHERE 1=1 ${RANGE}
      GROUP BY quarter, return_type
      ORDER BY quarter DESC`,
    columns: [
      { key: "quarter", label: "Quarter" },
      { key: "return_type", label: "Return" },
      { key: "records", label: "Records", align: "right" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "liability", label: "Liability", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-interest",
    label: "TDS Interest Report",
    group: "Finance",
    description: "TDS filings carrying interest for late deduction / payment.",
    dateColumn: "challan_date",
    sql: `
      SELECT tds_filing_id,
             COALESCE(NULLIF(quarter,''),'—') AS quarter,
             COALESCE(NULLIF(section,''),'—') AS section,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(interest,0) AS interest,
             COALESCE(total_liability,0) AS liability
      FROM tds_filings
      WHERE COALESCE(interest,0) > 0 ${RANGE}
      ORDER BY interest DESC`,
    columns: [
      { key: "tds_filing_id", label: "Filing" },
      { key: "quarter", label: "Quarter" },
      { key: "section", label: "Section" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "interest", label: "Interest", align: "right", money: true },
      { key: "liability", label: "Liability", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-late-fee",
    label: "TDS Late Fee Report",
    group: "Finance",
    description: "TDS filings carrying a late filing fee (section 234E).",
    dateColumn: "challan_date",
    sql: `
      SELECT tds_filing_id,
             COALESCE(NULLIF(quarter,''),'—') AS quarter,
             COALESCE(NULLIF(return_type,''),'—') AS return_type,
             COALESCE(tds_amount,0) AS tds,
             COALESCE(late_fee,0) AS late_fee,
             COALESCE(total_liability,0) AS liability
      FROM tds_filings
      WHERE COALESCE(late_fee,0) > 0 ${RANGE}
      ORDER BY late_fee DESC`,
    columns: [
      { key: "tds_filing_id", label: "Filing" },
      { key: "quarter", label: "Quarter" },
      { key: "return_type", label: "Return" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "late_fee", label: "Late Fee", align: "right", money: true },
      { key: "liability", label: "Liability", align: "right", money: true },
    ],
  },
  {
    key: "rx-tds-correction",
    label: "TDS Correction Report",
    group: "Finance",
    description: "TDS filings flagged for correction.",
    dateColumn: "filing_due_date",
    sql: `
      SELECT tds_filing_id,
             COALESCE(NULLIF(quarter,''),'—') AS quarter,
             COALESCE(NULLIF(deductee_name,''),'—') AS deductee,
             COALESCE(NULLIF(section,''),'—') AS section,
             COALESCE(tds_amount,0) AS tds,
             correction_date,
             COALESCE(NULLIF(return_status,''),'—') AS status
      FROM tds_filings
      WHERE COALESCE(correction_required,0) = 1 ${RANGE}
      ORDER BY correction_date DESC, id DESC`,
    columns: [
      { key: "tds_filing_id", label: "Filing" },
      { key: "quarter", label: "Quarter" },
      { key: "deductee", label: "Deductee" },
      { key: "section", label: "Section" },
      { key: "tds", label: "TDS", align: "right", money: true },
      { key: "correction_date", label: "Correction Date" },
      { key: "status", label: "Status" },
    ],
  },

  // --- Bank & Cash (bank_transactions + finance_accounts) --------------------
  {
    key: "rx-bank-unreconciled",
    label: "Unreconciled Bank Transactions",
    group: "Finance",
    description: "Bank transactions not yet reconciled.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(reconciliation_status,''),'Pending') AS status
      FROM bank_transactions
      WHERE COALESCE(NULLIF(reconciliation_status,''),'Pending') <> 'Reconciled' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-bank-difference",
    label: "Bank Difference Report",
    group: "Finance",
    description: "Book balance vs bank statement balance per account.",
    sql: `
      SELECT COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(bank_name,''),'—') AS bank,
             COALESCE(current_book_balance,0) AS book_balance,
             COALESCE(bank_statement_balance,0) AS statement_balance,
             COALESCE(difference,0) AS difference,
             COALESCE(NULLIF(reconciliation_status,''),'Pending') AS status
      FROM finance_accounts
      ORDER BY ABS(COALESCE(difference,0)) DESC`,
    columns: [
      { key: "account", label: "Account" },
      { key: "bank", label: "Bank" },
      { key: "book_balance", label: "Book Balance", align: "right", money: true },
      { key: "statement_balance", label: "Statement", align: "right", money: true },
      { key: "difference", label: "Difference", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-bank-charges",
    label: "Bank Charges Report",
    group: "Finance",
    description: "Bank transactions posted to bank charges.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(account_head,''),'—') AS head,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM bank_transactions
      WHERE account_head LIKE '%Charge%' OR narration LIKE '%charge%' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "head", label: "Head" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-bank-interest",
    label: "Bank Interest Report",
    group: "Finance",
    description: "Bank transactions posted to interest.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(account_head,''),'—') AS head,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM bank_transactions
      WHERE account_head LIKE '%Interest%' OR narration LIKE '%interest%' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "head", label: "Head" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-bank-transfer",
    label: "Bank Transfer Register",
    group: "Finance",
    description: "Inter-account transfers (contra) between bank & cash accounts.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS counterparty,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(reference_no,''),'—') AS reference
      FROM bank_transactions
      WHERE voucher_type LIKE '%Contra%' OR voucher_type LIKE '%Transfer%'
         OR transaction_type LIKE '%Transfer%' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "counterparty", label: "Counterparty" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "reference", label: "Reference" },
    ],
  },
  {
    key: "rx-cheque-register",
    label: "Cheque Register",
    group: "Finance",
    description: "Bank transactions settled by cheque.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(cheque_utr_reference,''),'—') AS cheque,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(reconciliation_status,''),'Pending') AS status
      FROM bank_transactions
      WHERE payment_mode LIKE '%Cheque%'
         OR (cheque_utr_reference IS NOT NULL AND cheque_utr_reference <> '') ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "cheque", label: "Cheque / Ref" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-outstanding-cheques",
    label: "Outstanding Cheques Report",
    group: "Finance",
    description: "Cheque transactions not yet reconciled / cleared.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(cheque_utr_reference,''),'—') AS cheque,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM bank_transactions
      WHERE payment_mode LIKE '%Cheque%'
        AND COALESCE(NULLIF(reconciliation_status,''),'Pending') <> 'Reconciled' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "cheque", label: "Cheque / Ref" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-utr-register",
    label: "UTR / Payment Reference Register",
    group: "Finance",
    description: "Bank transactions with a UTR / payment reference.",
    dateColumn: "transaction_date",
    sql: `
      SELECT transaction_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(NULLIF(payment_mode,''),'—') AS mode,
             COALESCE(NULLIF(cheque_utr_reference,''),'—') AS reference,
             COALESCE(amount,0) AS amount
      FROM bank_transactions
      WHERE cheque_utr_reference IS NOT NULL AND cheque_utr_reference <> '' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "transaction_id", label: "Txn" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "mode", label: "Mode" },
      { key: "reference", label: "UTR / Reference" },
      { key: "amount", label: "Amount", align: "right", money: true },
    ],
  },
  {
    key: "rx-account-balances",
    label: "Bank Balance Schedule",
    group: "Finance",
    description: "Opening and current book balance per bank & cash account.",
    sql: `
      SELECT COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(account_type,''),'—') AS account_type,
             COALESCE(NULLIF(bank_name,''),'—') AS bank,
             COALESCE(opening_balance,0) AS opening_balance,
             COALESCE(current_book_balance,0) AS book_balance,
             COALESCE(NULLIF(active_status,''),'Active') AS status
      FROM finance_accounts
      ORDER BY account`,
    columns: [
      { key: "account", label: "Account" },
      { key: "account_type", label: "Type" },
      { key: "bank", label: "Bank" },
      { key: "opening_balance", label: "Opening", align: "right", money: true },
      { key: "book_balance", label: "Book Balance", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-cash-balances",
    label: "Cash Balance Schedule",
    group: "Finance",
    description: "Opening and current book balance per cash account.",
    sql: `
      SELECT COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(opening_balance,0) AS opening_balance,
             COALESCE(current_book_balance,0) AS book_balance,
             COALESCE(NULLIF(active_status,''),'Active') AS status
      FROM finance_accounts
      WHERE account_type LIKE '%Cash%'
      ORDER BY account`,
    columns: [
      { key: "account", label: "Account" },
      { key: "opening_balance", label: "Opening", align: "right", money: true },
      { key: "book_balance", label: "Book Balance", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },

  // --- Sales & Purchase (sales_invoices / purchase_bills) --------------------
  {
    key: "rx-sales-invoice-register",
    label: "Sales Invoice Register",
    group: "Finance",
    description: "Every sales invoice with tax split, received and outstanding.",
    dateColumn: "invoice_date",
    sql: `
      SELECT invoice_id,
             invoice_date,
             COALESCE(NULLIF(client_name,''),'—') AS customer,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(cgst_amount,0) AS cgst,
             COALESCE(sgst_amount,0) AS sgst,
             COALESCE(igst_amount,0) AS igst,
             COALESCE(invoice_total,0) AS total,
             COALESCE(amount_received,0) AS received,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM sales_invoices
      WHERE 1=1 ${RANGE}
      ORDER BY invoice_date DESC, id DESC`,
    columns: [
      { key: "invoice_id", label: "Invoice" },
      { key: "invoice_date", label: "Date" },
      { key: "customer", label: "Customer" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "total", label: "Total", align: "right", money: true },
      { key: "received", label: "Received", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-sales-return",
    label: "Sales Return Register",
    group: "Finance",
    description: "Sales credit notes / returns.",
    dateColumn: "invoice_date",
    sql: `
      SELECT invoice_id,
             invoice_date,
             COALESCE(NULLIF(client_name,''),'—') AS customer,
             COALESCE(NULLIF(invoice_type,''),'—') AS type,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(invoice_total,0) AS total
      FROM sales_invoices
      WHERE invoice_type LIKE '%Credit%' OR invoice_type LIKE '%Return%' ${RANGE}
      ORDER BY invoice_date DESC, id DESC`,
    columns: [
      { key: "invoice_id", label: "Document" },
      { key: "invoice_date", label: "Date" },
      { key: "customer", label: "Customer" },
      { key: "type", label: "Type" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "total", label: "Total", align: "right", money: true },
    ],
  },
  {
    key: "rx-sales-vs-collection",
    label: "Sales vs Collection Report",
    group: "Finance",
    description: "Billed against received and outstanding, month by month.",
    dateColumn: "invoice_date",
    sql: `
      SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS period,
             COALESCE(SUM(invoice_total),0) AS billed,
             COALESCE(SUM(amount_received),0) AS received,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM sales_invoices
      WHERE invoice_date IS NOT NULL ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Month" },
      { key: "billed", label: "Billed", align: "right", money: true },
      { key: "received", label: "Received", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },
  {
    key: "rx-purchase-bill-register",
    label: "Purchase Bill Register",
    group: "Finance",
    description: "Every purchase bill with tax split, paid and outstanding.",
    dateColumn: "bill_date",
    sql: `
      SELECT po_number,
             bill_date,
             COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(cgst_amount,0) AS cgst,
             COALESCE(sgst_amount,0) AS sgst,
             COALESCE(igst_amount,0) AS igst,
             COALESCE(gross_bill_amount,0) AS gross,
             COALESCE(amount_paid,0) AS paid,
             COALESCE(outstanding_amount,0) AS outstanding,
             COALESCE(NULLIF(payment_status,''),'Unpaid') AS status
      FROM purchase_bills
      WHERE 1=1 ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "po_number", label: "Bill / PO" },
      { key: "bill_date", label: "Date" },
      { key: "vendor", label: "Vendor" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "cgst", label: "CGST", align: "right", money: true },
      { key: "sgst", label: "SGST", align: "right", money: true },
      { key: "igst", label: "IGST", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
  {
    key: "rx-purchase-return",
    label: "Purchase Return Register",
    group: "Finance",
    description: "Purchase debit notes / returns.",
    dateColumn: "bill_date",
    sql: `
      SELECT po_number,
             bill_date,
             COALESCE(NULLIF(vendor_name,''),'—') AS vendor,
             COALESCE(NULLIF(bill_type,''),'—') AS type,
             COALESCE(taxable_amount,0) AS taxable,
             COALESCE(gross_bill_amount,0) AS gross
      FROM purchase_bills
      WHERE bill_type LIKE '%Debit%' OR bill_type LIKE '%Return%' ${RANGE}
      ORDER BY bill_date DESC, id DESC`,
    columns: [
      { key: "po_number", label: "Document" },
      { key: "bill_date", label: "Date" },
      { key: "vendor", label: "Vendor" },
      { key: "type", label: "Type" },
      { key: "taxable", label: "Taxable", align: "right", money: true },
      { key: "gross", label: "Gross", align: "right", money: true },
    ],
  },
  {
    key: "rx-purchase-vs-payment",
    label: "Purchase vs Payment Report",
    group: "Finance",
    description: "Billed against paid and outstanding, month by month.",
    dateColumn: "bill_date",
    sql: `
      SELECT DATE_FORMAT(bill_date, '%Y-%m') AS period,
             COALESCE(SUM(gross_bill_amount),0) AS gross,
             COALESCE(SUM(amount_paid),0) AS paid,
             COALESCE(SUM(outstanding_amount),0) AS outstanding
      FROM purchase_bills
      WHERE bill_date IS NOT NULL ${RANGE}
      GROUP BY period
      ORDER BY period DESC`,
    columns: [
      { key: "period", label: "Month" },
      { key: "gross", label: "Gross", align: "right", money: true },
      { key: "paid", label: "Paid", align: "right", money: true },
      { key: "outstanding", label: "Outstanding", align: "right", money: true },
    ],
  },

  // --- CA / Audit (journal_entries + general_ledger) -------------------------
  {
    key: "rx-manual-journal",
    label: "Manual Journal Report",
    group: "Finance",
    description: "Journal entries created manually rather than by a source module.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(voucher_type,''),'—') AS voucher_type,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(narration,''),'—') AS narration,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM journal_entries
      WHERE COALESCE(NULLIF(source_module,''),'Manual') = 'Manual'
         OR source_module LIKE '%Manual%' ${RANGE}
      ORDER BY journal_date DESC, id DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "voucher_type", label: "Voucher" },
      { key: "account", label: "Account" },
      { key: "narration", label: "Narration" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-unapproved",
    label: "Unapproved Transaction Report",
    group: "Finance",
    description: "Journal entries pending approval.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(voucher_type,''),'—') AS voucher_type,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(approval_status,''),'Pending') AS approval
      FROM journal_entries
      WHERE COALESCE(NULLIF(approval_status,''),'Pending') <> 'Approved' ${RANGE}
      ORDER BY journal_date DESC, id DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "voucher_type", label: "Voucher" },
      { key: "account", label: "Account" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "approval", label: "Approval" },
    ],
  },
  {
    key: "rx-high-value",
    label: "High Value Transaction Report",
    group: "Finance",
    description: "Journal entries of ₹1,00,000 or more.",
    dateColumn: "journal_date",
    sql: `
      SELECT journal_entry_id,
             journal_date,
             COALESCE(NULLIF(voucher_type,''),'—') AS voucher_type,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit
      FROM journal_entries
      WHERE GREATEST(COALESCE(debit,0), COALESCE(credit,0)) >= 100000 ${RANGE}
      ORDER BY GREATEST(COALESCE(debit,0), COALESCE(credit,0)) DESC`,
    columns: [
      { key: "journal_entry_id", label: "Journal" },
      { key: "journal_date", label: "Date" },
      { key: "voucher_type", label: "Voucher" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
    ],
  },
  {
    key: "rx-unreconciled-gl",
    label: "Unreconciled Transaction Report",
    group: "Finance",
    description: "Posted ledger lines not yet reconciled.",
    dateColumn: "transaction_date",
    sql: `
      SELECT ledger_id,
             transaction_date,
             COALESCE(NULLIF(account_name,''),'—') AS account,
             COALESCE(NULLIF(party_name,''),'—') AS party,
             COALESCE(debit,0) AS debit,
             COALESCE(credit,0) AS credit,
             COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS status
      FROM general_ledger
      WHERE COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled' ${RANGE}
      ORDER BY transaction_date DESC, id DESC`,
    columns: [
      { key: "ledger_id", label: "Ledger" },
      { key: "transaction_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "debit", label: "Debit", align: "right", money: true },
      { key: "credit", label: "Credit", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
  },
]

// ---------------------------------------------------------------------------
// Central filter + period assignment
// ---------------------------------------------------------------------------
// Rather than repeating filter wiring on every report, advanced dimensions are
// assigned by source table: every report that reads a given table gets the
// same, verified set of dimension filters. Catalogue entries built with `from`
// inherit these automatically. Only reports whose SQL carries the `{{range}}`
// injection marker can receive filters (that is where the WHERE fragment is
// spliced in); reports without it are left period/filter-free.

const f = (dim: ReportFilterDim, column: string, match?: "like" | "eq"): ReportFilter => ({
  dim,
  column,
  ...(match ? { match } : {}),
})

const TABLE_FILTERS: Record<string, ReportFilter[]> = {
  sales_invoices: [f("customer", "client_name"), f("status", "payment_status")],
  purchase_bills: [f("vendor", "vendor_name"), f("gstin", "vendor_gstin"), f("status", "payment_status")],
  general_ledger: [f("account", "account_name"), f("accountGroup", "account_group")],
  chart_of_accounts: [f("account", "account_name"), f("accountGroup", "account_group")],
  journal_entries: [f("account", "account_name"), f("party", "party_name"), f("status", "posting_status")],
  bank_transactions: [f("bank", "bank_cash_account_name"), f("party", "party_name"), f("status", "reconciliation_status")],
  expenses: [
    f("party", "party_name"),
    f("vendor", "vendor_name"),
    f("department", "department"),
    f("project", "project_name"),
    f("gstin", "vendor_gstin"),
    f("pan", "vendor_pan"),
    f("status", "workflow_status"),
  ],
  payments: [f("party", "party_name"), f("status", "status")],
}

// Reports read cumulatively "as on" a date rather than over a period.
const AS_ON_REPORTS = new Set(["rx-trial-balance", "rx-balance-sheet", "rx-closing-balance"])

for (const r of FINANCE_REPORTS) {
  const table = r.sql?.match(/FROM\s+(\w+)/i)?.[1] ?? null
  if (r.sql?.includes("{{range}}") && table && TABLE_FILTERS[table]) {
    r.filters = TABLE_FILTERS[table]
  }
  r.periodMode = AS_ON_REPORTS.has(r.key) ? "asOn" : r.dateColumn ? "range" : "none"
}

export const FINANCE_REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(
  FINANCE_REPORTS.map((r) => [r.key, r]),
)

// The reports hub is split into two facilities: finance-domain reports stay
// under the Finance module's "Financial Reports" page, while every cross-
// department report (Sales / HR / Operations) lives under the standalone
// "Reports" facility. Membership is derived from the report's `group`.
const FINANCE_DOMAIN_GROUPS = new Set(["Finance", "Expenses"])
export const GENERAL_REPORTS = FINANCE_REPORTS.filter((r) => !FINANCE_DOMAIN_GROUPS.has(r.group))
export const GENERAL_REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(
  GENERAL_REPORTS.map((r) => [r.key, r]),
)

// ---------------------------------------------------------------------------
// Financial Reports page catalogue
// ---------------------------------------------------------------------------
// The Financial Reports page is organised into 16 accounting categories,
// browsed via a category picker + report picker. A report either reuses an
// existing data-backed aggregate (`from`, cloning a definition above) or is a
// declared placeholder (`stub`). A placeholder has no SQL and renders a
// "no data source yet" note until its underlying data exists in the ERP.

type ReportMeta = {
  key: string
  label: string
  group: string
  description: string
  /** Optional per-entry overrides of the inherited period/filter behaviour. */
  periodMode?: PeriodMode
  filters?: ReportFilter[]
}

function from(sourceKey: string, meta: ReportMeta): ReportDef {
  const src = FINANCE_REPORT_MAP[sourceKey]
  if (!src) throw new Error(`Unknown source report: ${sourceKey}`)
  return { ...src, ...meta }
}

function stub(meta: ReportMeta): ReportDef {
  return { periodMode: "none", ...meta, columns: [] }
}

const PENDING = "Data source not available yet — this report will populate once its data exists."

export const FINANCIAL_REPORT_GROUPS = [
  "Core Financial Statements",
  "Accounting Books",
  "Receivables",
  "Payables",
  "GST",
  "TDS / TCS",
  "Bank & Cash",
  "Sales & Purchase",
  "Expenses",
  "Fixed Assets",
  "Loans & Advances",
  "CA / Audit",
  "CA Schedules",
  "Tax / Income Tax",
  "Management / MIS",
  "Year-End",
] as const

export const FINANCE_ONLY_REPORTS: ReportDef[] = [
  // 1. Core Financial Statements ------------------------------------------
  {
    key: "fs-trial-balance",
    label: "Trial Balance",
    group: "Core Financial Statements",
    description: "Cumulative debit/credit per account, classified from the Chart of Accounts and posted General Ledger.",
    statement: "trial-balance",
    periodMode: "asOn",
    columns: STATEMENT_COLUMNS["trial-balance"],
  },
  {
    key: "fs-profit-loss",
    label: "Profit & Loss",
    group: "Core Financial Statements",
    description: "Income and expense movement over the period, grouped by reporting head with net profit / loss.",
    statement: "profit-loss",
    periodMode: "range",
    columns: STATEMENT_COLUMNS["profit-loss"],
  },
  {
    key: "fs-balance-sheet",
    label: "Balance Sheet",
    group: "Core Financial Statements",
    description: "Assets, liabilities and equity as on a date, classified from the Chart of Accounts.",
    statement: "balance-sheet",
    periodMode: "asOn",
    columns: STATEMENT_COLUMNS["balance-sheet"],
  },
  {
    key: "fs-cash-flow",
    label: "Cash Flow Statement",
    group: "Core Financial Statements",
    description: "Cash movement over the period grouped by operating, investing and financing activity.",
    statement: "cash-flow",
    periodMode: "range",
    columns: STATEMENT_COLUMNS["cash-flow"],
  },
  stub({ key: "fs-comparative-pl", label: "Comparative Profit & Loss", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-comparative-bs", label: "Comparative Balance Sheet", group: "Core Financial Statements", description: PENDING }),
  from("income-vs-expense", { key: "fs-monthly-pl", label: "Monthly Profit & Loss", group: "Core Financial Statements", description: "Monthly income, expense and net position." }),
  from("rx-quarterly-pl", { key: "fs-quarterly-pl", label: "Quarterly Profit & Loss", group: "Core Financial Statements", description: "Income against expenses, summarised by financial quarter." }),
  stub({ key: "fs-working-capital", label: "Working Capital Statement", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-changes-equity", label: "Statement of Changes in Equity", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-ratio-analysis", label: "Financial Ratio Analysis", group: "Core Financial Statements", description: PENDING }),

  // 2. Accounting Books ---------------------------------------------------
  from("finance-report", { key: "ab-day-book", label: "Day Book", group: "Accounting Books", description: "All finance activity summarised by module." }),
  from("rx-journal-register", { key: "ab-journal-register", label: "Journal Register", group: "Accounting Books", description: "Every journal entry line with voucher, account, debit and credit." }),
  from("rx-voucher-register", { key: "ab-voucher-register", label: "Voucher Register", group: "Accounting Books", description: "Journal activity grouped by voucher type." }),
  from("rx-account-ledger", { key: "ab-account-ledger", label: "Account Ledger", group: "Accounting Books", description: "Posted ledger movement per account with net balance." }),
  from("rx-group-ledger", { key: "ab-group-ledger", label: "Group Ledger", group: "Accounting Books", description: "Posted ledger movement rolled up by account group." }),
  from("cash-book", { key: "ab-cash-book", label: "Cash Book", group: "Accounting Books", description: "Cash receipts and payments by month." }),
  from("bank-book", { key: "ab-bank-book", label: "Bank Book", group: "Accounting Books", description: "Money in and out per bank account." }),
  stub({ key: "ab-petty-cash-book", label: "Petty Cash Book", group: "Accounting Books", description: PENDING }),
  from("rx-receipt-register", { key: "ab-receipt-register", label: "Receipt Register", group: "Accounting Books", description: "Cash and bank receipts recorded against invoices." }),
  from("expense-payment-register", { key: "ab-payment-register", label: "Payment Register", group: "Accounting Books", description: "Payments made against expenses." }),
  from("rx-contra-register", { key: "ab-contra-register", label: "Contra Register", group: "Accounting Books", description: "Bank/cash contra entries between own accounts." }),
  from("rx-adjustment-register", { key: "ab-adjustment-register", label: "Adjustment Register", group: "Accounting Books", description: "Journal entries flagged as adjustments." }),
  from("rx-opening-balance", { key: "ab-opening-balance", label: "Opening Balance Report", group: "Accounting Books", description: "Opening balances per ledger account." }),
  from("rx-closing-balance", { key: "ab-closing-balance", label: "Closing Balance Report", group: "Accounting Books", description: "Closing balance per ledger account from the posted ledger." }),
  from("rx-suspense-account", { key: "ab-suspense-account", label: "Suspense Account Report", group: "Accounting Books", description: "Ledger lines posted to suspense accounts." }),
  from("rx-reversal-register", { key: "ab-reversal-register", label: "Reversal Register", group: "Accounting Books", description: "Journal entries recorded as reversals." }),
  from("rx-cancelled-voucher", { key: "ab-cancelled-voucher", label: "Cancelled Voucher Report", group: "Accounting Books", description: "Journal vouchers marked cancelled." }),

  // 3. Receivables --------------------------------------------------------
  from("sales-report", { key: "ar-accounts-receivable", label: "Accounts Receivable", group: "Receivables", description: "Billed, received and outstanding by payment status." }),
  from("rx-customer-outstanding", { key: "ar-customer-outstanding", label: "Customer Outstanding", group: "Receivables", description: "Billed, received and outstanding grouped by customer (dues only)." }),
  from("rx-receivable-ageing", { key: "ar-receivable-ageing", label: "Receivable Ageing", group: "Receivables", description: "Outstanding receivables bucketed by age from the due date." }),
  from("rx-invoice-receivable", { key: "ar-invoice-wise", label: "Invoice-wise Receivable", group: "Receivables", description: "Each unpaid sales invoice with received and outstanding." }),
  from("rx-customer-sales", { key: "ar-customer-wise", label: "Customer-wise Receivable", group: "Receivables", description: "Billed, received and outstanding grouped by customer." }),
  stub({ key: "ar-customer-ledger", label: "Customer Ledger", group: "Receivables", description: PENDING }),
  stub({ key: "ar-customer-statement", label: "Customer Statement", group: "Receivables", description: PENDING }),
  from("rx-overdue-receivable", { key: "ar-overdue", label: "Overdue Receivables", group: "Receivables", description: "Unpaid invoices past their due date, aged in days." }),
  stub({ key: "ar-customer-advance", label: "Customer Advance Report", group: "Receivables", description: PENDING }),
  stub({ key: "ar-reconciliation", label: "Receivable Reconciliation", group: "Receivables", description: PENDING }),

  // 4. Payables -----------------------------------------------------------
  from("purchase-register", { key: "ap-accounts-payable", label: "Accounts Payable", group: "Payables", description: "Vendor bills with taxable, GST, TDS and net payable." }),
  from("rx-vendor-outstanding", { key: "ap-vendor-outstanding", label: "Vendor Outstanding", group: "Payables", description: "Gross, paid and outstanding grouped by vendor (dues only)." }),
  from("accounts-payable-ageing", { key: "ap-payable-ageing", label: "Payable Ageing", group: "Payables", description: "Outstanding payables bucketed by age." }),
  from("rx-bill-payable", { key: "ap-bill-wise", label: "Bill-wise Payable", group: "Payables", description: "Each unpaid purchase bill with paid and outstanding." }),
  from("purchase-register", { key: "ap-vendor-wise", label: "Vendor-wise Payable", group: "Payables", description: "Payable totals grouped by vendor." }),
  stub({ key: "ap-vendor-ledger", label: "Vendor Ledger", group: "Payables", description: PENDING }),
  stub({ key: "ap-vendor-statement", label: "Vendor Statement", group: "Payables", description: PENDING }),
  from("rx-overdue-payable", { key: "ap-overdue", label: "Overdue Payables", group: "Payables", description: "Unpaid bills past their due date, aged in days." }),
  stub({ key: "ap-vendor-advance", label: "Vendor Advance Report", group: "Payables", description: PENDING }),
  stub({ key: "ap-reconciliation", label: "Payable Reconciliation", group: "Payables", description: PENDING }),

  // 5. GST ----------------------------------------------------------------
  from("rx-gstr1-summary", { key: "gst-gstr1-summary", label: "GSTR-1 Summary", group: "GST", description: "Outward supply summary by GST rate and supply type for the GSTR-1 return period." }),
  from("rx-gstr1-detailed", { key: "gst-gstr1-detailed", label: "GSTR-1 Detailed Register", group: "GST", description: "Invoice-level outward supply register with taxable value and tax split." }),
  from("rx-gst-b2b", { key: "gst-b2b-sales", label: "B2B Sales Report", group: "GST", description: "Registered (B2B) outward supplies with counterparty GSTIN and tax break-up." }),
  from("rx-gst-b2c", { key: "gst-b2c-sales", label: "B2C Sales Report", group: "GST", description: "Unregistered (B2C) outward supplies with taxable value and tax." }),
  from("rx-gst-credit-note", { key: "gst-credit-note", label: "Credit Note Register", group: "GST", description: "Credit notes issued against outward supplies with tax adjustment." }),
  from("rx-gst-debit-note", { key: "gst-debit-note", label: "Debit Note Register", group: "GST", description: "Debit notes raised against supplies with tax adjustment." }),
  from("rx-gst-output", { key: "gst-output", label: "GST Output Report", group: "GST", description: "Output GST payable on outward supplies split by CGST / SGST / IGST / cess." }),
  from("expense-gst-input", { key: "gst-input-itc", label: "GST Input / ITC Report", group: "GST", description: "Input GST and ITC captured on expenses." }),
  from("rx-gst-eligible-itc", { key: "gst-eligible-itc", label: "Eligible ITC Report", group: "GST", description: "Input tax credit eligible to be claimed on inward supplies for the period." }),
  from("rx-gst-ineligible-itc", { key: "gst-ineligible-itc", label: "Ineligible ITC Report", group: "GST", description: "Blocked / ineligible input tax credit that cannot be claimed." }),
  from("rx-gst-itc-reversal", { key: "gst-itc-reversal", label: "ITC Reversal Report", group: "GST", description: "Input tax credit reversed during the period with reason and tax split." }),
  from("rx-gst-recon", { key: "gst-gstr2b-recon", label: "GSTR-2B Reconciliation", group: "GST", description: "Books vs GSTR-2B input credit reconciliation highlighting mismatches." }),
  stub({ key: "gst-rcm", label: "RCM Report", group: "GST", description: PENDING }),
  from("rx-gst-rate-wise", { key: "gst-rate-wise", label: "GST Rate-wise Report", group: "GST", description: "Taxable value and tax grouped by GST rate slab." }),
  from("expense-raw-gst", { key: "gst-hsn-sac", label: "HSN / SAC Summary", group: "GST", description: "GST line items with HSN/SAC detail." }),
  from("rx-gst-gstin-wise", { key: "gst-gstin-wise", label: "GSTIN-wise Report", group: "GST", description: "Supplies grouped by counterparty GSTIN with taxable value and tax." }),
  from("rx-gst-place-supply", { key: "gst-place-supply", label: "Place of Supply Report", group: "GST", description: "Supplies grouped by place of supply (state) for inter/intra-state analysis." }),
  from("rx-gst-cgst", { key: "gst-cgst", label: "CGST Report", group: "GST", description: "Central GST component across outward and inward supplies for the period." }),
  from("rx-gst-sgst", { key: "gst-sgst", label: "SGST Report", group: "GST", description: "State GST component across outward and inward supplies for the period." }),
  from("rx-gst-igst", { key: "gst-igst", label: "IGST Report", group: "GST", description: "Integrated GST component across inter-state supplies for the period." }),
  from("rx-gst-cess", { key: "gst-cess", label: "Cess Report", group: "GST", description: "GST compensation cess charged and collected during the period." }),
  from("rx-gst-liability", { key: "gst-liability", label: "GST Liability Report", group: "GST", description: "Net GST payable — output tax less eligible input credit — for the period." }),
  from("rx-gst-payment-challan", { key: "gst-payment-challan", label: "GST Payment / Challan Report", group: "GST", description: "GST payments and challans recorded against the liability for the period." }),
  stub({ key: "gst-reconciliation", label: "GST Reconciliation Report", group: "GST", description: PENDING }),
  from("rx-gst-exception", { key: "gst-exception", label: "GST Exception Report", group: "GST", description: "Supplies with missing GSTIN, rate or place-of-supply data needing correction." }),
  stub({ key: "gst-amendment", label: "GST Amendment Report", group: "GST", description: PENDING }),

  // 6. TDS / TCS ----------------------------------------------------------
  from("expense-tds", { key: "tds-deduction-register", label: "TDS Deduction Register", group: "TDS / TCS", description: "TDS deducted on expenses by section." }),
  from("expense-raw-tds", { key: "tds-section-wise", label: "Section-wise TDS Report", group: "TDS / TCS", description: "TDS line items grouped by section." }),
  from("rx-tds-deductee", { key: "tds-deductee-wise", label: "Deductee-wise TDS Report", group: "TDS / TCS", description: "TDS deducted grouped by deductee with section, rate and tax amount." }),
  from("rx-tds-pan", { key: "tds-pan-wise", label: "PAN-wise TDS Report", group: "TDS / TCS", description: "TDS deducted grouped by deductee PAN for return filing." }),
  stub({ key: "tds-vendor", label: "Vendor TDS Report", group: "TDS / TCS", description: PENDING }),
  from("rx-tds-employee", { key: "tds-employee", label: "Employee TDS Report", group: "TDS / TCS", description: "TDS on salary deducted per employee under section 192." }),
  stub({ key: "tds-freelancer", label: "Freelancer TDS Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-customer-receivable", label: "Customer TDS Receivable", group: "TDS / TCS", description: PENDING }),
  from("rx-tds-challan", { key: "tds-challan-register", label: "TDS Challan Register", group: "TDS / TCS", description: "TDS challans deposited with the government with BSR code and date." }),
  from("rx-tds-payment", { key: "tds-payment", label: "TDS Payment Report", group: "TDS / TCS", description: "TDS payments made during the period against deducted liability." }),
  from("rx-tds-outstanding", { key: "tds-outstanding", label: "TDS Outstanding Report", group: "TDS / TCS", description: "TDS deducted but not yet deposited to the government." }),
  stub({ key: "tds-reconciliation", label: "TDS Reconciliation Report", group: "TDS / TCS", description: PENDING }),
  from("rx-tds-return-summary", { key: "tds-return-summary", label: "TDS Return Summary", group: "TDS / TCS", description: "Section-wise TDS summary for quarterly return (24Q / 26Q) filing." }),
  from("rx-tds-interest", { key: "tds-interest", label: "TDS Interest Report", group: "TDS / TCS", description: "Interest payable on late deduction or late deposit of TDS." }),
  from("rx-tds-late-fee", { key: "tds-late-fee", label: "TDS Late Fee Report", group: "TDS / TCS", description: "Late filing fee under section 234E on delayed TDS returns." }),
  stub({ key: "tds-form16", label: "Form 16 Register", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-form16a", label: "Form 16A Register", group: "TDS / TCS", description: PENDING }),
  from("rx-tds-correction", { key: "tds-correction", label: "TDS Correction Report", group: "TDS / TCS", description: "Corrections and revisions made to previously deducted or filed TDS." }),
  stub({ key: "tds-exception", label: "TDS Exception Report", group: "TDS / TCS", description: PENDING }),

  // 7. Bank & Cash --------------------------------------------------------
  from("bank-book", { key: "bc-bank-balance", label: "Bank-wise Balance Report", group: "Bank & Cash", description: "Movement and net balance per bank account." }),
  from("cash-book", { key: "bc-cash-position", label: "Cash Position Report", group: "Bank & Cash", description: "Cash receipts, payments and net position." }),
  from("bank-reconciliation", { key: "bc-bank-recon", label: "Bank Reconciliation Statement", group: "Bank & Cash", description: "Reconciled vs unreconciled bank entries." }),
  from("rx-bank-unreconciled", { key: "bc-unreconciled", label: "Unreconciled Bank Transactions", group: "Bank & Cash", description: "Bank statement lines not yet matched to a book entry." }),
  from("rx-bank-difference", { key: "bc-bank-difference", label: "Bank Difference Report", group: "Bank & Cash", description: "Difference between book balance and bank statement balance per account." }),
  from("rx-bank-charges", { key: "bc-bank-charges", label: "Bank Charges Report", group: "Bank & Cash", description: "Bank charges and fees debited during the period." }),
  from("rx-bank-interest", { key: "bc-bank-interest", label: "Bank Interest Report", group: "Bank & Cash", description: "Interest credited or debited by the bank during the period." }),
  from("rx-bank-transfer", { key: "bc-bank-transfer", label: "Bank Transfer Register", group: "Bank & Cash", description: "Inter-account and contra bank transfers recorded in the period." }),
  from("rx-cheque-register", { key: "bc-cheque-register", label: "Cheque Register", group: "Bank & Cash", description: "Cheques issued and received with number, date and clearing status." }),
  from("rx-outstanding-cheques", { key: "bc-outstanding-cheques", label: "Outstanding Cheques Report", group: "Bank & Cash", description: "Issued cheques not yet cleared by the bank." }),
  from("rx-utr-register", { key: "bc-utr-register", label: "UTR / Payment Reference Register", group: "Bank & Cash", description: "Electronic payments with UTR / reference number and value date." }),

  // 8. Sales & Purchase ---------------------------------------------------
  from("sales-report", { key: "sp-sales-register", label: "Sales Register", group: "Sales & Purchase", description: "Sales invoices by payment status." }),
  from("rx-sales-invoice-register", { key: "sp-sales-invoice-register", label: "Sales Invoice Register", group: "Sales & Purchase", description: "All sales invoices raised in the period with value, tax and status." }),
  from("rx-customer-sales", { key: "sp-customer-wise-sales", label: "Customer-wise Sales", group: "Sales & Purchase", description: "Sales value grouped by customer for the period." }),
  from("rx-sales-return", { key: "sp-sales-return", label: "Sales Return Register", group: "Sales & Purchase", description: "Sales returns / credit notes with value and tax reversal." }),
  from("rx-sales-vs-collection", { key: "sp-sales-vs-collection", label: "Sales vs Collection Report", group: "Sales & Purchase", description: "Invoiced sales against amounts collected to gauge realisation." }),
  from("purchase-register", { key: "sp-purchase-register", label: "Purchase Register", group: "Sales & Purchase", description: "Purchase bills by vendor." }),
  from("rx-purchase-bill-register", { key: "sp-purchase-bill-register", label: "Purchase Bill Register", group: "Sales & Purchase", description: "All purchase bills recorded in the period with value, tax and status." }),
  from("rx-vendor-outstanding", { key: "sp-vendor-wise-purchase", label: "Vendor-wise Purchase", group: "Sales & Purchase", description: "Purchase value and outstanding grouped by vendor for the period." }),
  from("rx-purchase-return", { key: "sp-purchase-return", label: "Purchase Return Register", group: "Sales & Purchase", description: "Purchase returns / debit notes with value and tax reversal." }),
  from("rx-purchase-vs-payment", { key: "sp-purchase-vs-payment", label: "Purchase vs Payment Report", group: "Sales & Purchase", description: "Billed purchases against amounts paid to gauge settlement." }),

  // 9. Expenses -----------------------------------------------------------
  from("expense-register", { key: "ex-register", label: "Expense Register", group: "Expenses", description: "Every expense with tax, payment and status." }),
  from("expense-category-analytics", { key: "ex-category-wise", label: "Category-wise Expense", group: "Expenses", description: "Expenses grouped by category and head." }),
  from("department-expense", { key: "ex-department-wise", label: "Department-wise Expense", group: "Expenses", description: "Expense totals by department." }),
  from("cost-centre-expense", { key: "ex-cost-centre-wise", label: "Cost Centre-wise Expense", group: "Expenses", description: "Expense totals by cost centre." }),
  from("project-expense", { key: "ex-project-wise", label: "Project-wise Expense", group: "Expenses", description: "Expense totals by project and client." }),
  from("employee-expense", { key: "ex-employee", label: "Employee Expense", group: "Expenses", description: "Employee-incurred expenses and advances." }),
  from("vendor-expense", { key: "ex-vendor", label: "Vendor Expense", group: "Expenses", description: "Vendor expenses with GSTIN and PAN." }),
  from("reimbursement-register", { key: "ex-reimbursement", label: "Reimbursement Report", group: "Expenses", description: "Reimbursable expenses and settlements." }),
  from("expense-gst-input", { key: "ex-gst", label: "Expense GST Report", group: "Expenses", description: "GST/ITC on expenses." }),
  from("expense-tds", { key: "ex-tds", label: "Expense TDS Report", group: "Expenses", description: "TDS on expenses by section." }),
  stub({ key: "ex-budget-vs-actual", label: "Expense Budget vs Actual", group: "Expenses", description: PENDING }),
  stub({ key: "ex-variance", label: "Expense Variance Report", group: "Expenses", description: PENDING }),
  from("expense-category-analytics", { key: "ex-category-analytics", label: "Category Analytics", group: "Expenses", description: "Analytics across expense categories and heads." }),
  from("expense-top-spend", { key: "ex-top-spend", label: "Top Expenses", group: "Expenses", description: "Highest-value expenses in the period." }),
  from("expense-monthly-trend", { key: "ex-trend", label: "Expense Trend", group: "Expenses", description: "Month-on-month expense movement." }),
  from("outstanding-expense", { key: "ex-outstanding", label: "Outstanding Expense", group: "Expenses", description: "Unpaid expenses with ageing." }),
  from("overdue-expense", { key: "ex-overdue", label: "Overdue Expense", group: "Expenses", description: "Expenses past their payment terms." }),
  from("expense-payment-register", { key: "ex-payments", label: "Expense Payment Register", group: "Expenses", description: "Payments recorded against expenses." }),
  from("expense-raw-gst", { key: "ex-raw-gst", label: "Raw GST Data", group: "Expenses", description: "Unaggregated GST rows for export." }),
  from("expense-raw-tds", { key: "ex-raw-tds", label: "Raw TDS Data", group: "Expenses", description: "Unaggregated TDS rows for export." }),

  // 10. Fixed Assets ------------------------------------------------------
  stub({ key: "fa-register", label: "Fixed Asset Register", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-addition", label: "Asset Addition Report", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-disposal", label: "Asset Disposal Report", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-transfer", label: "Asset Transfer Report", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-depreciation", label: "Depreciation Register", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-accumulated-depreciation", label: "Accumulated Depreciation Report", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-asset-ledger", label: "Asset-wise Ledger", group: "Fixed Assets", description: PENDING }),
  stub({ key: "fa-reconciliation", label: "Fixed Asset Reconciliation", group: "Fixed Assets", description: PENDING }),

  // 11. Loans & Advances --------------------------------------------------
  stub({ key: "la-loan-register", label: "Loan Register", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-loan-outstanding", label: "Loan Outstanding Report", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-principal-interest", label: "Principal & Interest Report", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-repayment-schedule", label: "Loan Repayment Schedule", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-employee-advance", label: "Employee Advance Report", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-customer-advance", label: "Customer Advance Report", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-vendor-advance", label: "Vendor Advance Report", group: "Loans & Advances", description: PENDING }),
  stub({ key: "la-advances-reconciliation", label: "Advances Reconciliation", group: "Loans & Advances", description: PENDING }),

  // 12. CA / Audit --------------------------------------------------------
  stub({ key: "ca-audit-trail", label: "Audit Trail Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-altered-entries", label: "Altered Entries Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-deleted-entries", label: "Deleted Entries Report", group: "CA / Audit", description: PENDING }),
  from("rx-cancelled-voucher", { key: "ca-cancelled-entries", label: "Cancelled Entries Report", group: "CA / Audit", description: "Vouchers cancelled after posting, with user and timestamp for audit." }),
  from("rx-reversal-register", { key: "ca-reversed-entries", label: "Reversed Entries Report", group: "CA / Audit", description: "Journal reversals with the original entry reference and reason." }),
  stub({ key: "ca-backdated-entries", label: "Backdated Entries Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-duplicate-voucher", label: "Duplicate Voucher Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-duplicate-invoice", label: "Duplicate Invoice Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-duplicate-payment", label: "Duplicate Payment Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-voucher-gap", label: "Voucher Number Gap Report", group: "CA / Audit", description: PENDING }),
  from("rx-manual-journal", { key: "ca-manual-journal", label: "Manual Journal Report", group: "CA / Audit", description: "Manually posted journal vouchers not generated by a subsystem." }),
  from("rx-adjustment-register", { key: "ca-manual-adjustment", label: "Manual Adjustment Report", group: "CA / Audit", description: "Manual adjustment entries with narration and posting user." }),
  from("rx-unapproved", { key: "ca-unapproved-transaction", label: "Unapproved Transaction Report", group: "CA / Audit", description: "Transactions still pending approval in the workflow." }),
  from("rx-high-value", { key: "ca-high-value", label: "High Value Transaction Report", group: "CA / Audit", description: "Transactions above the high-value threshold flagged for review." }),
  stub({ key: "ca-negative-cash", label: "Negative Cash Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-negative-bank", label: "Negative Bank Balance Report", group: "CA / Audit", description: PENDING }),
  from("rx-unreconciled-gl", { key: "ca-unreconciled-transaction", label: "Unreconciled Transaction Report", group: "CA / Audit", description: "Ledger entries not yet reconciled against their control account." }),
  stub({ key: "ca-tax-override", label: "Tax Override Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-manual-override", label: "Manual Override Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-missing-document", label: "Missing Supporting Document Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-exception", label: "Exception Report", group: "CA / Audit", description: PENDING }),

  // 13. CA Schedules ------------------------------------------------------
  stub({ key: "sch-debtors", label: "Debtors Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-creditors", label: "Creditors Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-fixed-assets", label: "Fixed Assets Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-loans", label: "Loans Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-advances", label: "Advances Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-investments", label: "Investments Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-capital-account", label: "Capital Account Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-reserves-surplus", label: "Reserves & Surplus Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-revenue", label: "Revenue Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-expense", label: "Expense Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-gst", label: "GST Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-tds", label: "TDS Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-bank-balance", label: "Bank Balance Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-cash-balance", label: "Cash Balance Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-provision", label: "Provision Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-accrual", label: "Accrual Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-prepaid", label: "Prepaid Expense Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-outstanding-liability", label: "Outstanding Liability Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-related-party", label: "Related Party Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-contingent-liability", label: "Contingent Liability Schedule", group: "CA Schedules", description: PENDING }),
  stub({ key: "sch-commitments", label: "Commitments Schedule", group: "CA Schedules", description: PENDING }),

  // 14. Tax / Income Tax --------------------------------------------------
  stub({ key: "tax-book-vs-tax-profit", label: "Book Profit vs Tax Profit", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-taxable-income", label: "Taxable Income Computation", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-depreciation-compare", label: "Tax Depreciation vs Book Depreciation", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-disallowance", label: "Disallowance Report", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-allowable-expense", label: "Allowable Expense Report", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-tds-credit", label: "TDS Credit Report", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-advance-tax", label: "Advance Tax Report", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-provision", label: "Tax Provision Report", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-liability-forecast", label: "Tax Liability Forecast", group: "Tax / Income Tax", description: PENDING }),
  stub({ key: "tax-interest-penalty", label: "Tax Interest / Penalty Exposure", group: "Tax / Income Tax", description: PENDING }),

  // 15. Management / MIS --------------------------------------------------
  from("income-vs-expense", { key: "mis-revenue-analysis", label: "Revenue Analysis", group: "Management / MIS", description: "Revenue and net trend by month." }),
  stub({ key: "mis-gross-margin", label: "Gross Margin Analysis", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-cost-analysis", label: "Cost Analysis", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-ebitda", label: "EBITDA Report", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-ebitda-margin", label: "EBITDA Margin Report", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-profitability", label: "Profitability Analysis", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-project-profitability", label: "Project Profitability", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-department-profitability", label: "Department Profitability", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-cost-centre-profitability", label: "Cost Centre Profitability", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-budget-vs-actual", label: "Budget vs Actual", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-variance-analysis", label: "Variance Analysis", group: "Management / MIS", description: PENDING }),
  stub({ key: "mis-cash-flow-forecast", label: "Cash Flow Forecast", group: "Management / MIS", description: PENDING }),

  // 16. Year-End ----------------------------------------------------------
  {
    key: "ye-trial-balance",
    label: "Year-End Trial Balance",
    group: "Year-End",
    description: "Closing debit/credit per account as on the year-end date, from the classification engine.",
    statement: "trial-balance",
    periodMode: "asOn",
    columns: STATEMENT_COLUMNS["trial-balance"],
  },
  stub({ key: "ye-adjustment-register", label: "Year-End Adjustment Register", group: "Year-End", description: PENDING }),
  stub({ key: "ye-provision", label: "Provision Report", group: "Year-End", description: PENDING }),
  stub({ key: "ye-accrual", label: "Accrual Report", group: "Year-End", description: PENDING }),
  stub({ key: "ye-prepaid", label: "Prepaid Expense Report", group: "Year-End", description: PENDING }),
  from("outstanding-expense", { key: "ye-outstanding-expense", label: "Outstanding Expense Report", group: "Year-End", description: "Unpaid expenses carried at year-end." }),
  stub({ key: "ye-bad-debt-provision", label: "Bad Debt Provision Report", group: "Year-End", description: PENDING }),
  stub({ key: "ye-tax-provision", label: "Tax Provision Report", group: "Year-End", description: PENDING }),
  stub({ key: "ye-reconciliation", label: "Year-End Reconciliation", group: "Year-End", description: PENDING }),
  stub({ key: "ye-opening-carry-forward", label: "Opening Balance Carry Forward Report", group: "Year-End", description: PENDING }),
  stub({ key: "ye-closing", label: "Year-End Closing Report", group: "Year-End", description: PENDING }),
  stub({ key: "ye-audit-checklist", label: "Year-End Audit Checklist", group: "Year-End", description: PENDING }),
]

export const FINANCE_ONLY_REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(
  FINANCE_ONLY_REPORTS.map((r) => [r.key, r]),
)
