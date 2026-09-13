import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

const INVOICE_STATUSES = ["Paid", "Pending", "Ready", "Overdue", "Partially Paid"]
const RECEIVABLE_STATUSES = ["Pending", "Ready", "Overdue", "Partially Paid"]
const RECONCILIATION_STATUSES = ["Reconciled", "Unreconciled", "Exception"]

const MASTER_MODULE_LABELS: Record<string, string> = {
  "sales-invoices": "Sales Invoice",
  "purchase-bills": "Purchase Bills",
  "expenses": "Expenses",
  "fte-invoices": "FTE Invoice",
  "freelance-invoices": "Freelance Invoice",
  "bank-transactions": "Bank Transactions",
  "bank-cash": "Bank & Cash",
  "chart-of-accounts": "Chart of Accounts",
  "customers-vendors": "Customer / Vendor",
}

export async function GET() {
  const session = await requireFeature("finance.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Top KPI strip: Sales Billing, Receivables, Payables, Expenses, Bank Balance, Net Cash Flow
  const [kpiRow] = (await query(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'sales-invoices'), 0) AS sales_billing,
       COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'sales-invoices' AND status IN (?, ?, ?, ?)), 0) AS receivables,
       COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'purchase-bills' AND status <> 'Paid'), 0) AS payables,
       COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'expenses'), 0) AS expenses,
       COALESCE((SELECT SUM(amount) FROM finance_records WHERE module_key = 'bank-cash'), 0) AS bank_balance,
       COALESCE((SELECT SUM(credit) - SUM(debit) FROM finance_records WHERE module_key = 'bank-transactions'), 0) AS net_cash_flow`,
    RECEIVABLE_STATUSES,
  )) as any[]

  // Invoice status breakdown (always includes all standard statuses, zero-filled)
  const invoiceRows = (await query(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
     FROM finance_records WHERE module_key = 'sales-invoices' GROUP BY status`,
  )) as any[]
  const invoiceByStatus = Object.fromEntries(invoiceRows.map((r) => [r.status, r]))
  const invoiceStatus = INVOICE_STATUSES.map((status) => ({
    status,
    count: Number(invoiceByStatus[status]?.count ?? 0),
    amount: Number(invoiceByStatus[status]?.amount ?? 0),
  }))

  // Bank reconciliation breakdown
  const reconciliationRows = (await query(
    `SELECT reconciliation_status AS status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
     FROM finance_records WHERE module_key = 'bank-transactions' GROUP BY reconciliation_status`,
  )) as any[]
  const reconciliationByStatus = Object.fromEntries(reconciliationRows.map((r) => [r.status, r]))
  const bankReconciliation = RECONCILIATION_STATUSES.map((status) => ({
    status,
    count: Number(reconciliationByStatus[status]?.count ?? 0),
    amount: Number(reconciliationByStatus[status]?.amount ?? 0),
  }))

  // Finance master module record counts
  const moduleCountRows = (await query(
    `SELECT module_key, COUNT(*) AS count FROM finance_records GROUP BY module_key`,
  )) as any[]
  const moduleCounts = Object.fromEntries(moduleCountRows.map((r) => [r.module_key, Number(r.count)]))
  const financeMasterModules = Object.entries(MASTER_MODULE_LABELS).map(([key, label]) => ({
    key,
    module: label,
    records: moduleCounts[key] ?? 0,
    status: "Active",
  }))

  // Master record summary (cross-module masters)
  const [employeeRow] = (await query(
    `SELECT COUNT(*) AS count FROM hr_employees WHERE employment_status = 'Active'`,
  )) as any[]
  const masterRecordSummary = [
    { master: "Employees", records: Number(employeeRow?.count ?? 0), type: "Source" },
    { master: "Customers / Vendors", records: moduleCounts["customers-vendors"] ?? 0, type: "Master" },
    { master: "Chart of Accounts", records: moduleCounts["chart-of-accounts"] ?? 0, type: "Accounts" },
    { master: "Bank / Cash Accounts", records: moduleCounts["bank-cash"] ?? 0, type: "Active" },
  ]

  // Recent bank transactions
  const recentTransactions = await query(
    `SELECT record_id, reference_no, record_date, account_name, party_name, record_type, debit, credit, reconciliation_status
     FROM finance_records WHERE module_key = 'bank-transactions'
     ORDER BY record_date DESC, record_id DESC LIMIT 10`,
  )

  return NextResponse.json({
    kpis: {
      salesBilling: Number(kpiRow?.sales_billing ?? 0),
      receivables: Number(kpiRow?.receivables ?? 0),
      payables: Number(kpiRow?.payables ?? 0),
      expenses: Number(kpiRow?.expenses ?? 0),
      bankBalance: Number(kpiRow?.bank_balance ?? 0),
      netCashFlow: Number(kpiRow?.net_cash_flow ?? 0),
    },
    invoiceStatus,
    bankReconciliation,
    financeMasterModules,
    masterRecordSummary,
    recentTransactions,
  })
}
