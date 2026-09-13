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
   *  date range filter when the report has `dateColumn`, else dropped. */
  sql: string
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
// The Expenses reporting suite (Phases 1–12, 19, 20) is a finance-domain
// group so it surfaces on the Financial Reports page as its own category.
const FINANCE_DOMAIN_GROUPS = new Set(["Finance", "Expenses"])
export const FINANCE_ONLY_REPORTS = FINANCE_REPORTS.filter((r) => FINANCE_DOMAIN_GROUPS.has(r.group))
export const GENERAL_REPORTS = FINANCE_REPORTS.filter((r) => !FINANCE_DOMAIN_GROUPS.has(r.group))

export const FINANCE_ONLY_REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(
  FINANCE_ONLY_REPORTS.map((r) => [r.key, r]),
)
export const GENERAL_REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(
  GENERAL_REPORTS.map((r) => [r.key, r]),
)
