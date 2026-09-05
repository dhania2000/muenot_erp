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
]

export const FINANCE_REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(
  FINANCE_REPORTS.map((r) => [r.key, r]),
)
