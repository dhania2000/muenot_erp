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

export type ReportColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
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
]

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

type ReportMeta = { key: string; label: string; group: string; description: string }

function from(sourceKey: string, meta: ReportMeta): ReportDef {
  const src = FINANCE_REPORT_MAP[sourceKey]
  if (!src) throw new Error(`Unknown source report: ${sourceKey}`)
  return { ...src, ...meta }
}

function stub(meta: ReportMeta): ReportDef {
  return { ...meta, columns: [] }
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
  stub({ key: "fs-trial-balance", label: "Trial Balance", group: "Core Financial Statements", description: PENDING }),
  from("income-vs-expense", { key: "fs-profit-loss", label: "Profit & Loss", group: "Core Financial Statements", description: "Income against expenses, month by month." }),
  stub({ key: "fs-balance-sheet", label: "Balance Sheet", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-cash-flow", label: "Cash Flow Statement", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-comparative-pl", label: "Comparative Profit & Loss", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-comparative-bs", label: "Comparative Balance Sheet", group: "Core Financial Statements", description: PENDING }),
  from("income-vs-expense", { key: "fs-monthly-pl", label: "Monthly Profit & Loss", group: "Core Financial Statements", description: "Monthly income, expense and net position." }),
  stub({ key: "fs-quarterly-pl", label: "Quarterly Profit & Loss", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-working-capital", label: "Working Capital Statement", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-changes-equity", label: "Statement of Changes in Equity", group: "Core Financial Statements", description: PENDING }),
  stub({ key: "fs-ratio-analysis", label: "Financial Ratio Analysis", group: "Core Financial Statements", description: PENDING }),

  // 2. Accounting Books ---------------------------------------------------
  from("finance-report", { key: "ab-day-book", label: "Day Book", group: "Accounting Books", description: "All finance activity summarised by module." }),
  stub({ key: "ab-journal-register", label: "Journal Register", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-voucher-register", label: "Voucher Register", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-account-ledger", label: "Account Ledger", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-group-ledger", label: "Group Ledger", group: "Accounting Books", description: PENDING }),
  from("cash-book", { key: "ab-cash-book", label: "Cash Book", group: "Accounting Books", description: "Cash receipts and payments by month." }),
  from("bank-book", { key: "ab-bank-book", label: "Bank Book", group: "Accounting Books", description: "Money in and out per bank account." }),
  stub({ key: "ab-petty-cash-book", label: "Petty Cash Book", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-receipt-register", label: "Receipt Register", group: "Accounting Books", description: PENDING }),
  from("expense-payment-register", { key: "ab-payment-register", label: "Payment Register", group: "Accounting Books", description: "Payments made against expenses." }),
  stub({ key: "ab-contra-register", label: "Contra Register", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-adjustment-register", label: "Adjustment Register", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-opening-balance", label: "Opening Balance Report", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-closing-balance", label: "Closing Balance Report", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-suspense-account", label: "Suspense Account Report", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-reversal-register", label: "Reversal Register", group: "Accounting Books", description: PENDING }),
  stub({ key: "ab-cancelled-voucher", label: "Cancelled Voucher Report", group: "Accounting Books", description: PENDING }),

  // 3. Receivables --------------------------------------------------------
  from("sales-report", { key: "ar-accounts-receivable", label: "Accounts Receivable", group: "Receivables", description: "Billed, received and outstanding by payment status." }),
  stub({ key: "ar-customer-outstanding", label: "Customer Outstanding", group: "Receivables", description: PENDING }),
  stub({ key: "ar-receivable-ageing", label: "Receivable Ageing", group: "Receivables", description: PENDING }),
  stub({ key: "ar-invoice-wise", label: "Invoice-wise Receivable", group: "Receivables", description: PENDING }),
  stub({ key: "ar-customer-wise", label: "Customer-wise Receivable", group: "Receivables", description: PENDING }),
  stub({ key: "ar-customer-ledger", label: "Customer Ledger", group: "Receivables", description: PENDING }),
  stub({ key: "ar-customer-statement", label: "Customer Statement", group: "Receivables", description: PENDING }),
  stub({ key: "ar-overdue", label: "Overdue Receivables", group: "Receivables", description: PENDING }),
  stub({ key: "ar-customer-advance", label: "Customer Advance Report", group: "Receivables", description: PENDING }),
  stub({ key: "ar-reconciliation", label: "Receivable Reconciliation", group: "Receivables", description: PENDING }),

  // 4. Payables -----------------------------------------------------------
  from("purchase-register", { key: "ap-accounts-payable", label: "Accounts Payable", group: "Payables", description: "Vendor bills with taxable, GST, TDS and net payable." }),
  stub({ key: "ap-vendor-outstanding", label: "Vendor Outstanding", group: "Payables", description: PENDING }),
  from("accounts-payable-ageing", { key: "ap-payable-ageing", label: "Payable Ageing", group: "Payables", description: "Outstanding payables bucketed by age." }),
  stub({ key: "ap-bill-wise", label: "Bill-wise Payable", group: "Payables", description: PENDING }),
  from("purchase-register", { key: "ap-vendor-wise", label: "Vendor-wise Payable", group: "Payables", description: "Payable totals grouped by vendor." }),
  stub({ key: "ap-vendor-ledger", label: "Vendor Ledger", group: "Payables", description: PENDING }),
  stub({ key: "ap-vendor-statement", label: "Vendor Statement", group: "Payables", description: PENDING }),
  stub({ key: "ap-overdue", label: "Overdue Payables", group: "Payables", description: PENDING }),
  stub({ key: "ap-vendor-advance", label: "Vendor Advance Report", group: "Payables", description: PENDING }),
  stub({ key: "ap-reconciliation", label: "Payable Reconciliation", group: "Payables", description: PENDING }),

  // 5. GST ----------------------------------------------------------------
  stub({ key: "gst-gstr1-summary", label: "GSTR-1 Summary", group: "GST", description: PENDING }),
  stub({ key: "gst-gstr1-detailed", label: "GSTR-1 Detailed Register", group: "GST", description: PENDING }),
  stub({ key: "gst-b2b-sales", label: "B2B Sales Report", group: "GST", description: PENDING }),
  stub({ key: "gst-b2c-sales", label: "B2C Sales Report", group: "GST", description: PENDING }),
  stub({ key: "gst-credit-note", label: "Credit Note Register", group: "GST", description: PENDING }),
  stub({ key: "gst-debit-note", label: "Debit Note Register", group: "GST", description: PENDING }),
  stub({ key: "gst-output", label: "GST Output Report", group: "GST", description: PENDING }),
  from("expense-gst-input", { key: "gst-input-itc", label: "GST Input / ITC Report", group: "GST", description: "Input GST and ITC captured on expenses." }),
  stub({ key: "gst-eligible-itc", label: "Eligible ITC Report", group: "GST", description: PENDING }),
  stub({ key: "gst-ineligible-itc", label: "Ineligible ITC Report", group: "GST", description: PENDING }),
  stub({ key: "gst-itc-reversal", label: "ITC Reversal Report", group: "GST", description: PENDING }),
  stub({ key: "gst-gstr2b-recon", label: "GSTR-2B Reconciliation", group: "GST", description: PENDING }),
  stub({ key: "gst-rcm", label: "RCM Report", group: "GST", description: PENDING }),
  stub({ key: "gst-rate-wise", label: "GST Rate-wise Report", group: "GST", description: PENDING }),
  from("expense-raw-gst", { key: "gst-hsn-sac", label: "HSN / SAC Summary", group: "GST", description: "GST line items with HSN/SAC detail." }),
  stub({ key: "gst-gstin-wise", label: "GSTIN-wise Report", group: "GST", description: PENDING }),
  stub({ key: "gst-place-supply", label: "Place of Supply Report", group: "GST", description: PENDING }),
  stub({ key: "gst-cgst", label: "CGST Report", group: "GST", description: PENDING }),
  stub({ key: "gst-sgst", label: "SGST Report", group: "GST", description: PENDING }),
  stub({ key: "gst-igst", label: "IGST Report", group: "GST", description: PENDING }),
  stub({ key: "gst-cess", label: "Cess Report", group: "GST", description: PENDING }),
  stub({ key: "gst-liability", label: "GST Liability Report", group: "GST", description: PENDING }),
  stub({ key: "gst-payment-challan", label: "GST Payment / Challan Report", group: "GST", description: PENDING }),
  stub({ key: "gst-reconciliation", label: "GST Reconciliation Report", group: "GST", description: PENDING }),
  stub({ key: "gst-exception", label: "GST Exception Report", group: "GST", description: PENDING }),
  stub({ key: "gst-amendment", label: "GST Amendment Report", group: "GST", description: PENDING }),

  // 6. TDS / TCS ----------------------------------------------------------
  from("expense-tds", { key: "tds-deduction-register", label: "TDS Deduction Register", group: "TDS / TCS", description: "TDS deducted on expenses by section." }),
  from("expense-raw-tds", { key: "tds-section-wise", label: "Section-wise TDS Report", group: "TDS / TCS", description: "TDS line items grouped by section." }),
  stub({ key: "tds-deductee-wise", label: "Deductee-wise TDS Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-pan-wise", label: "PAN-wise TDS Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-vendor", label: "Vendor TDS Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-employee", label: "Employee TDS Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-freelancer", label: "Freelancer TDS Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-customer-receivable", label: "Customer TDS Receivable", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-challan-register", label: "TDS Challan Register", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-payment", label: "TDS Payment Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-outstanding", label: "TDS Outstanding Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-reconciliation", label: "TDS Reconciliation Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-return-summary", label: "TDS Return Summary", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-interest", label: "TDS Interest Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-late-fee", label: "TDS Late Fee Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-form16", label: "Form 16 Register", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-form16a", label: "Form 16A Register", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-correction", label: "TDS Correction Report", group: "TDS / TCS", description: PENDING }),
  stub({ key: "tds-exception", label: "TDS Exception Report", group: "TDS / TCS", description: PENDING }),

  // 7. Bank & Cash --------------------------------------------------------
  from("bank-book", { key: "bc-bank-balance", label: "Bank-wise Balance Report", group: "Bank & Cash", description: "Movement and net balance per bank account." }),
  from("cash-book", { key: "bc-cash-position", label: "Cash Position Report", group: "Bank & Cash", description: "Cash receipts, payments and net position." }),
  from("bank-reconciliation", { key: "bc-bank-recon", label: "Bank Reconciliation Statement", group: "Bank & Cash", description: "Reconciled vs unreconciled bank entries." }),
  stub({ key: "bc-unreconciled", label: "Unreconciled Bank Transactions", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-bank-difference", label: "Bank Difference Report", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-bank-charges", label: "Bank Charges Report", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-bank-interest", label: "Bank Interest Report", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-bank-transfer", label: "Bank Transfer Register", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-cheque-register", label: "Cheque Register", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-outstanding-cheques", label: "Outstanding Cheques Report", group: "Bank & Cash", description: PENDING }),
  stub({ key: "bc-utr-register", label: "UTR / Payment Reference Register", group: "Bank & Cash", description: PENDING }),

  // 8. Sales & Purchase ---------------------------------------------------
  from("sales-report", { key: "sp-sales-register", label: "Sales Register", group: "Sales & Purchase", description: "Sales invoices by payment status." }),
  stub({ key: "sp-sales-invoice-register", label: "Sales Invoice Register", group: "Sales & Purchase", description: PENDING }),
  stub({ key: "sp-customer-wise-sales", label: "Customer-wise Sales", group: "Sales & Purchase", description: PENDING }),
  stub({ key: "sp-sales-return", label: "Sales Return Register", group: "Sales & Purchase", description: PENDING }),
  stub({ key: "sp-sales-vs-collection", label: "Sales vs Collection Report", group: "Sales & Purchase", description: PENDING }),
  from("purchase-register", { key: "sp-purchase-register", label: "Purchase Register", group: "Sales & Purchase", description: "Purchase bills by vendor." }),
  stub({ key: "sp-purchase-bill-register", label: "Purchase Bill Register", group: "Sales & Purchase", description: PENDING }),
  stub({ key: "sp-vendor-wise-purchase", label: "Vendor-wise Purchase", group: "Sales & Purchase", description: PENDING }),
  stub({ key: "sp-purchase-return", label: "Purchase Return Register", group: "Sales & Purchase", description: PENDING }),
  stub({ key: "sp-purchase-vs-payment", label: "Purchase vs Payment Report", group: "Sales & Purchase", description: PENDING }),

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
  stub({ key: "ca-cancelled-entries", label: "Cancelled Entries Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-reversed-entries", label: "Reversed Entries Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-backdated-entries", label: "Backdated Entries Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-duplicate-voucher", label: "Duplicate Voucher Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-duplicate-invoice", label: "Duplicate Invoice Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-duplicate-payment", label: "Duplicate Payment Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-voucher-gap", label: "Voucher Number Gap Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-manual-journal", label: "Manual Journal Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-manual-adjustment", label: "Manual Adjustment Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-unapproved-transaction", label: "Unapproved Transaction Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-high-value", label: "High Value Transaction Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-negative-cash", label: "Negative Cash Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-negative-bank", label: "Negative Bank Balance Report", group: "CA / Audit", description: PENDING }),
  stub({ key: "ca-unreconciled-transaction", label: "Unreconciled Transaction Report", group: "CA / Audit", description: PENDING }),
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
  stub({ key: "ye-trial-balance", label: "Year-End Trial Balance", group: "Year-End", description: PENDING }),
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
