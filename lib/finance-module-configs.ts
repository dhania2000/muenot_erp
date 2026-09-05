import { num, round2, financialYearFor, autoPaymentStatus } from "@/lib/finance-calc"
import type { FieldDef, FieldType, ModuleConfig } from "@/lib/finance-schema"

/** Terse field builder. */
function fld(section: string, key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef {
  return { section, key, label, type, ...extra }
}

const UNITS = ["Nos", "Hours", "Days", "Months", "Lot", "Project", "Kg", "Units"]
const PAYMENT_MODES = ["Bank Transfer", "Cash", "UPI", "Cheque", "Card", "NEFT", "RTGS"]
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"]
const PAYMENT_STATUSES = ["Unpaid", "Partially Paid", "Paid", "Overdue"]

const PAYMENT_BADGE = { Paid: "default", "Partially Paid": "secondary", Unpaid: "outline", Overdue: "destructive" } as const

// ---------------------------------------------------------------------------
// 1. Purchase Bills — PO Number is entered manually (comes from the PO upstream)
// ---------------------------------------------------------------------------
const purchaseBills: ModuleConfig = {
  key: "purchase-bills",
  table: "purchase_bills",
  label: "Purchase Bills",
  subtitle: "Finance management",
  addLabel: "New bill",
  idColumn: "po_number",
  idPrefix: "PB",
  editableId: true,
  dateColumn: "bill_date",
  financialYearColumn: "financial_year",
  statusColumn: "payment_status",
  searchColumns: ["po_number", "vendor_name", "project_name", "description"],
  fields: [
    fld("Bill details", "po_number", "PO Number", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Bill details", "bill_date", "Bill date", "date", { required: true }),
    fld("Bill details", "bill_type", "Bill type", "select", { options: ["Purchase Bill", "Debit Note", "Credit Note", "Import Bill"] }),
    fld("Bill details", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Bill details", "vendor_id", "Vendor ID", "text"),
    fld("Bill details", "vendor_name", "Vendor name", "text", { required: true }),
    fld("Bill details", "project_id", "Project ID", "text"),
    fld("Bill details", "project_name", "Project name", "text"),
    fld("Bill details", "description", "Description", "textarea"),
    fld("Line item & taxes", "hsn_sac", "HSN / SAC", "text"),
    fld("Line item & taxes", "quantity", "Quantity", "number"),
    fld("Line item & taxes", "unit", "Unit", "select", { options: UNITS, optional: true }),
    fld("Line item & taxes", "rate", "Rate", "number"),
    fld("Line item & taxes", "taxable_amount", "Taxable amount (or lump sum)", "number", { placeholder: "auto from qty × rate" }),
    fld("Line item & taxes", "discount", "Discount", "number"),
    fld("Line item & taxes", "cgst_percent", "CGST %", "number"),
    fld("Line item & taxes", "sgst_percent", "SGST %", "number"),
    fld("Line item & taxes", "igst_percent", "IGST %", "number"),
    fld("Line item & taxes", "other_tax_cess", "Other tax / cess", "number"),
    fld("Line item & taxes", "cgst_amount", "CGST amount", "number", { computed: true, money: true }),
    fld("Line item & taxes", "sgst_amount", "SGST amount", "number", { computed: true, money: true }),
    fld("Line item & taxes", "igst_amount", "IGST amount", "number", { computed: true, money: true }),
    fld("Line item & taxes", "gross_bill_amount", "Gross bill amount", "number", { computed: true, money: true }),
    fld("TDS & payable", "tds_applicable", "TDS applicable", "checkbox"),
    fld("TDS & payable", "tds_section", "TDS section", "text", { placeholder: "194C" }),
    fld("TDS & payable", "tds_rate", "TDS rate %", "number"),
    fld("TDS & payable", "tds_amount", "TDS amount", "number", { computed: true, money: true }),
    fld("TDS & payable", "net_payable", "Net payable", "number", { computed: true, money: true }),
    fld("TDS & payable", "outstanding_amount", "Outstanding amount", "number", { computed: true, money: true }),
    fld("Payment tracking", "due_date", "Due date", "date"),
    fld("Payment tracking", "amount_paid", "Amount paid", "number"),
    fld("Payment tracking", "payment_status", "Payment status", "select", { options: PAYMENT_STATUSES, optional: true, emptyLabel: "Auto" }),
    fld("Payment tracking", "payment_date", "Payment date", "date"),
    fld("Payment tracking", "payment_reference", "Payment reference", "text"),
    fld("ITC & notes", "itc_eligible", "ITC eligible", "checkbox"),
    fld("ITC & notes", "itc_claimed", "ITC claimed", "checkbox"),
    fld("ITC & notes", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const qty = num(v.quantity), rate = num(v.rate), discount = num(v.discount)
    const base = qty > 0 && rate > 0 ? qty * rate : num(v.taxable_amount) + discount
    const taxable = round2(Math.max(base - discount, 0))
    const cgst = round2((taxable * num(v.cgst_percent)) / 100)
    const sgst = round2((taxable * num(v.sgst_percent)) / 100)
    const igst = round2((taxable * num(v.igst_percent)) / 100)
    const cess = round2(num(v.other_tax_cess))
    const gross = round2(taxable + cgst + sgst + igst + cess)
    const tds = v.tds_applicable ? round2((taxable * num(v.tds_rate)) / 100) : 0
    const net = round2(gross - tds)
    const paid = round2(num(v.amount_paid))
    return {
      taxable_amount: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, other_tax_cess: cess,
      gross_bill_amount: gross, tds_amount: tds, net_payable: net, amount_paid: paid,
      outstanding_amount: round2(net - paid),
      payment_status: autoPaymentStatus(net, paid, v.payment_status),
      financial_year: v.financial_year || financialYearFor(v.bill_date),
    }
  },
  tableColumns: [
    { key: "po_number", label: "PO Number", mono: true },
    { key: "bill_date", label: "Date" },
    { key: "vendor_name", label: "Vendor", sub: "project_name" },
    { key: "gross_bill_amount", label: "Gross", align: "right", money: true },
    { key: "net_payable", label: "Net Payable", align: "right", money: true },
    { key: "outstanding_amount", label: "Outstanding", align: "right", money: true },
    { key: "payment_status", label: "Payment", badge: { ...PAYMENT_BADGE } },
  ],
  kpis: [
    { label: "Total Billed", key: "total_billed", money: true, icon: "Receipt" },
    { label: "Net Payable", key: "total_payable", money: true, icon: "Coins" },
    { label: "Paid", key: "total_paid", money: true, icon: "Wallet" },
    { label: "Outstanding", key: "total_outstanding", money: true, icon: "Clock" },
  ],
  summarySelect:
    "COALESCE(SUM(gross_bill_amount),0) total_billed, COALESCE(SUM(net_payable),0) total_payable, COALESCE(SUM(amount_paid),0) total_paid, COALESCE(SUM(outstanding_amount),0) total_outstanding, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 2. Expenses
// ---------------------------------------------------------------------------
const expenses: ModuleConfig = {
  key: "expenses",
  table: "expenses",
  label: "Expenses",
  subtitle: "Finance management",
  addLabel: "New expense",
  idColumn: "expense_id",
  idPrefix: "EXP",
  dateColumn: "expense_date",
  financialYearColumn: "financial_year",
  statusColumn: "approval_status",
  searchColumns: ["expense_id", "party_name", "expense_category", "expense_head", "description"],
  fields: [
    fld("Expense details", "expense_date", "Expense date", "date", { required: true }),
    fld("Expense details", "expense_type", "Expense type", "select", { options: ["Direct", "Indirect", "Capital", "Operational", "Recurring"] }),
    fld("Expense details", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Expense details", "party_id", "Employee / Vendor ID", "text"),
    fld("Expense details", "party_name", "Employee / Vendor name", "text", { required: true }),
    fld("Expense details", "project_id", "Project ID", "text"),
    fld("Expense details", "project_name", "Project name", "text"),
    fld("Expense details", "expense_category", "Expense category", "text"),
    fld("Expense details", "expense_head", "Expense head", "text"),
    fld("Expense details", "description", "Description", "textarea"),
    fld("Expense details", "bill_receipt_no", "Bill / Receipt no.", "text"),
    fld("Payment & tax", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Payment & tax", "bank_cash_account_id", "Bank / Cash account ID", "text"),
    fld("Payment & tax", "taxable_amount", "Taxable amount", "number"),
    fld("Payment & tax", "cgst_amount", "CGST amount", "number"),
    fld("Payment & tax", "sgst_amount", "SGST amount", "number"),
    fld("Payment & tax", "igst_amount", "IGST amount", "number"),
    fld("Payment & tax", "tds_applicable", "TDS applicable", "checkbox"),
    fld("Payment & tax", "tds_section", "TDS section", "text"),
    fld("Payment & tax", "tds_rate", "TDS rate %", "number"),
    fld("Payment & tax", "tds_amount", "TDS amount", "number", { computed: true, money: true }),
    fld("Payment & tax", "gross_amount", "Gross amount", "number", { computed: true, money: true }),
    fld("Payment & tax", "net_payable", "Net payable", "number", { computed: true, money: true }),
    fld("Approval & status", "approval_status", "Approval status", "select", { options: ["Pending", "Approved", "Rejected"] }),
    fld("Approval & status", "approved_by", "Approved by", "text"),
    fld("Approval & status", "reimbursement_status", "Reimbursement status", "select", { options: ["Not Applicable", "Pending", "Reimbursed"] }),
    fld("Approval & status", "payment_date", "Payment date", "date"),
    fld("Approval & status", "payment_reference", "Payment reference", "text"),
    fld("Approval & status", "gst_credit_eligible", "GST credit eligible", "checkbox"),
    fld("Approval & status", "cost_centre", "Cost centre", "text"),
    fld("Approval & status", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const taxable = round2(num(v.taxable_amount))
    const cgst = round2(num(v.cgst_amount)), sgst = round2(num(v.sgst_amount)), igst = round2(num(v.igst_amount))
    const gross = round2(taxable + cgst + sgst + igst)
    const tds = v.tds_applicable ? round2((taxable * num(v.tds_rate)) / 100) : 0
    return {
      taxable_amount: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
      gross_amount: gross, tds_amount: tds, net_payable: round2(gross - tds),
      financial_year: v.financial_year || financialYearFor(v.expense_date),
    }
  },
  tableColumns: [
    { key: "expense_id", label: "Expense ID", mono: true },
    { key: "expense_date", label: "Date" },
    { key: "party_name", label: "Payee", sub: "expense_category" },
    { key: "gross_amount", label: "Gross", align: "right", money: true },
    { key: "net_payable", label: "Net Payable", align: "right", money: true },
    { key: "approval_status", label: "Approval", badge: { Approved: "default", Pending: "secondary", Rejected: "destructive" } },
    { key: "reimbursement_status", label: "Reimbursement", badge: { Reimbursed: "default", Pending: "secondary", "Not Applicable": "outline" } },
  ],
  kpis: [
    { label: "Gross Expense", key: "total_gross", money: true, icon: "Receipt" },
    { label: "Net Payable", key: "total_net", money: true, icon: "Coins" },
    { label: "TDS Deducted", key: "total_tds", money: true, icon: "Landmark" },
    { label: "Records", key: "total_rows", icon: "FileText" },
  ],
  summarySelect:
    "COALESCE(SUM(gross_amount),0) total_gross, COALESCE(SUM(net_payable),0) total_net, COALESCE(SUM(tds_amount),0) total_tds, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 3. FTE Invoices (payroll-style)
// ---------------------------------------------------------------------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

const fteInvoices: ModuleConfig = {
  key: "fte-invoices",
  table: "fte_invoices",
  label: "FTE Invoices",
  subtitle: "Finance management",
  addLabel: "New FTE invoice",
  idColumn: "fte_invoice_id",
  idPrefix: "FTE",
  trackingId: true,
  dateColumn: "invoice_date",
  financialYearColumn: "financial_year",
  statusColumn: "status",
  searchColumns: ["fte_invoice_id", "employee_name", "department", "designation", "project_name"],
  fields: [
    fld("Employee & period", "invoice_date", "Invoice date", "date", { required: true }),
    fld("Employee & period", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Employee & period", "month", "Month", "select", { options: MONTHS, optional: true }),
    fld("Employee & period", "employee_id", "Employee ID", "text"),
    fld("Employee & period", "employee_name", "Employee name", "text", { required: true }),
    fld("Employee & period", "employment_type", "Employment type", "select", { options: ["Full-time", "Part-time", "Contract", "Intern"] }),
    fld("Employee & period", "department", "Department", "text"),
    fld("Employee & period", "designation", "Designation", "text"),
    fld("Employee & period", "project_id", "Project ID", "text"),
    fld("Employee & period", "project_name", "Project name", "text"),
    fld("Attendance & basis", "billing_basis", "Billing basis", "select", { options: ["Monthly", "Daily", "Hourly"] }),
    fld("Attendance & basis", "working_days", "Working days", "number"),
    fld("Attendance & basis", "paid_days", "Paid days", "number"),
    fld("Attendance & basis", "leave_days", "Leave days", "number"),
    fld("Attendance & basis", "holiday_days", "Holiday days", "number"),
    fld("Earnings", "gross_billing", "Gross billing / salary", "number"),
    fld("Earnings", "overtime_extra", "Overtime / extra", "number"),
    fld("Earnings", "bonus_incentive", "Bonus / incentive", "number"),
    fld("Earnings", "other_earnings", "Other earnings", "number"),
    fld("Earnings", "gross_earnings", "Gross earnings", "number", { computed: true, money: true }),
    fld("Deductions", "pf_deduction", "PF deduction", "number"),
    fld("Deductions", "esi_deduction", "ESI deduction", "number"),
    fld("Deductions", "professional_tax", "Professional tax", "number"),
    fld("Deductions", "tds", "TDS", "number"),
    fld("Deductions", "other_deductions", "Other deductions", "number"),
    fld("Deductions", "total_deductions", "Total deductions", "number", { computed: true, money: true }),
    fld("Deductions", "net_payable", "Net payable", "number", { computed: true, money: true }),
    fld("Payment & status", "payment_due_date", "Payment due date", "date"),
    fld("Payment & status", "payment_date", "Payment date", "date"),
    fld("Payment & status", "payment_reference", "Payment reference", "text"),
    fld("Payment & status", "status", "Status", "select", { options: ["Draft", "Approved", "Paid", "On Hold"] }),
    fld("Payment & status", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const ge = round2(num(v.gross_billing) + num(v.overtime_extra) + num(v.bonus_incentive) + num(v.other_earnings))
    const td = round2(num(v.pf_deduction) + num(v.esi_deduction) + num(v.professional_tax) + num(v.tds) + num(v.other_deductions))
    return {
      gross_earnings: ge, total_deductions: td, net_payable: round2(ge - td),
      financial_year: v.financial_year || financialYearFor(v.invoice_date),
    }
  },
  tableColumns: [
    { key: "fte_invoice_id", label: "FTE Invoice ID", mono: true },
    { key: "invoice_date", label: "Date" },
    { key: "employee_name", label: "Employee", sub: "department" },
    { key: "gross_earnings", label: "Gross", align: "right", money: true },
    { key: "net_payable", label: "Net Payable", align: "right", money: true },
    { key: "status", label: "Status", badge: { Paid: "default", Approved: "default", Draft: "secondary", "On Hold": "outline" } },
  ],
  kpis: [
    { label: "Gross Earnings", key: "total_gross", money: true, icon: "Coins" },
    { label: "Deductions", key: "total_deductions", money: true, icon: "Landmark" },
    { label: "Net Payable", key: "total_net", money: true, icon: "Wallet" },
    { label: "Records", key: "total_rows", icon: "Users" },
  ],
  summarySelect:
    "COALESCE(SUM(gross_earnings),0) total_gross, COALESCE(SUM(total_deductions),0) total_deductions, COALESCE(SUM(net_payable),0) total_net, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 4. Freelance Invoices
// ---------------------------------------------------------------------------
const freelanceInvoices: ModuleConfig = {
  key: "freelance-invoices",
  table: "freelance_invoices",
  label: "Freelance Invoices",
  subtitle: "Finance management",
  addLabel: "New freelance invoice",
  idColumn: "freelance_invoice_id",
  idPrefix: "FRL",
  trackingId: true,
  dateColumn: "invoice_date",
  financialYearColumn: "financial_year",
  statusColumn: "payment_status",
  searchColumns: ["freelance_invoice_id", "freelancer_name", "project_name", "work_description"],
  fields: [
    fld("Freelancer & period", "invoice_date", "Invoice date", "date", { required: true }),
    fld("Freelancer & period", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Freelancer & period", "billing_period", "Billing period", "text", { placeholder: "Apr 2026" }),
    fld("Freelancer & period", "freelancer_id", "Freelancer ID", "text"),
    fld("Freelancer & period", "freelancer_name", "Freelancer name", "text", { required: true }),
    fld("Freelancer & period", "project_id", "Project ID", "text"),
    fld("Freelancer & period", "project_name", "Project name", "text"),
    fld("Freelancer & period", "work_description", "Work description", "textarea"),
    fld("Billing", "units_deliverables", "Units / deliverables", "number"),
    fld("Billing", "unit", "Unit", "select", { options: UNITS, optional: true }),
    fld("Billing", "rate", "Rate", "number"),
    fld("Billing", "gross_amount", "Gross amount", "number", { computed: true, money: true }),
    fld("TDS & payable", "tds_applicable", "TDS applicable", "checkbox"),
    fld("TDS & payable", "tds_section", "TDS section", "text", { placeholder: "194J" }),
    fld("TDS & payable", "tds_rate", "TDS rate %", "number"),
    fld("TDS & payable", "tds_amount", "TDS amount", "number", { computed: true, money: true }),
    fld("TDS & payable", "other_adjustment", "Other adjustment", "number"),
    fld("TDS & payable", "net_payable", "Net payable", "number", { computed: true, money: true }),
    fld("Payment & status", "invoice_bill_reference", "Invoice / Bill reference", "text"),
    fld("Payment & status", "due_date", "Due date", "date"),
    fld("Payment & status", "payment_date", "Payment date", "date"),
    fld("Payment & status", "payment_reference", "Payment reference", "text"),
    fld("Payment & status", "payment_status", "Payment status", "select", { options: PAYMENT_STATUSES }),
    fld("Payment & status", "approval_status", "Approval status", "select", { options: ["Pending", "Approved", "Rejected"] }),
    fld("Payment & status", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const units = num(v.units_deliverables), rate = num(v.rate)
    const gross = round2(units > 0 && rate > 0 ? units * rate : num(v.gross_amount))
    const tds = v.tds_applicable ? round2((gross * num(v.tds_rate)) / 100) : 0
    return {
      gross_amount: gross, tds_amount: tds, net_payable: round2(gross - tds + num(v.other_adjustment)),
      financial_year: v.financial_year || financialYearFor(v.invoice_date),
    }
  },
  tableColumns: [
    { key: "freelance_invoice_id", label: "Invoice ID", mono: true },
    { key: "invoice_date", label: "Date" },
    { key: "freelancer_name", label: "Freelancer", sub: "project_name" },
    { key: "gross_amount", label: "Gross", align: "right", money: true },
    { key: "net_payable", label: "Net Payable", align: "right", money: true },
    { key: "payment_status", label: "Payment", badge: { ...PAYMENT_BADGE } },
    { key: "approval_status", label: "Approval", badge: { Approved: "default", Pending: "secondary", Rejected: "destructive" } },
  ],
  kpis: [
    { label: "Gross Billed", key: "total_gross", money: true, icon: "Receipt" },
    { label: "TDS Deducted", key: "total_tds", money: true, icon: "Landmark" },
    { label: "Net Payable", key: "total_net", money: true, icon: "Wallet" },
    { label: "Records", key: "total_rows", icon: "FileText" },
  ],
  summarySelect:
    "COALESCE(SUM(gross_amount),0) total_gross, COALESCE(SUM(tds_amount),0) total_tds, COALESCE(SUM(net_payable),0) total_net, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 5. Bank Transactions
// ---------------------------------------------------------------------------
const bankTransactions: ModuleConfig = {
  key: "bank-transactions",
  table: "bank_transactions",
  label: "Bank Transactions",
  subtitle: "Finance management",
  addLabel: "New transaction",
  idColumn: "transaction_id",
  idPrefix: "BTX",
  dateColumn: "transaction_date",
  financialYearColumn: "financial_year",
  statusColumn: "reconciliation_status",
  searchColumns: ["transaction_id", "account_name", "party_name", "reference_no", "narration"],
  fields: [
    fld("Transaction", "transaction_date", "Transaction date", "date", { required: true }),
    fld("Transaction", "value_date", "Value date", "date"),
    fld("Transaction", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Transaction", "bank_cash_account_id", "Bank / Cash account ID", "text"),
    fld("Transaction", "account_name", "Account name", "text", { required: true }),
    fld("Transaction", "transaction_type", "Transaction type", "select", { options: ["Receipt", "Payment", "Contra", "Journal"] }),
    fld("Transaction", "voucher_type", "Voucher type", "select", { options: ["Cash", "Bank", "Journal", "Sales", "Purchase"], optional: true }),
    fld("Transaction", "reference_no", "Reference no.", "text"),
    fld("Parties & heads", "party_id", "Party ID", "text"),
    fld("Parties & heads", "party_name", "Party name", "text"),
    fld("Parties & heads", "account_head_id", "Account head ID", "text"),
    fld("Parties & heads", "account_head", "Account head", "text"),
    fld("Parties & heads", "project_id", "Project ID", "text"),
    fld("Parties & heads", "project_name", "Project name", "text"),
    fld("Amounts", "debit", "Debit", "number"),
    fld("Amounts", "credit", "Credit", "number"),
    fld("Amounts", "amount", "Amount", "number", { computed: true, money: true }),
    fld("Amounts", "gst_amount", "GST amount", "number"),
    fld("Amounts", "tds_amount", "TDS amount", "number"),
    fld("Reconciliation", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Reconciliation", "cheque_utr_reference", "Cheque / UTR / reference", "text"),
    fld("Reconciliation", "narration", "Narration", "textarea"),
    fld("Reconciliation", "reconciliation_status", "Reconciliation status", "select", { options: ["Unreconciled", "Reconciled", "Pending"] }),
    fld("Reconciliation", "reconciliation_date", "Reconciliation date", "date"),
    fld("Reconciliation", "journal_entry_id", "Journal entry ID", "text"),
    fld("Reconciliation", "attachment_link", "Attachment / document link", "text"),
  ],
  compute: (v) => {
    const debit = round2(num(v.debit)), credit = round2(num(v.credit))
    return {
      debit, credit, amount: round2(credit > 0 ? credit : debit),
      financial_year: v.financial_year || financialYearFor(v.transaction_date),
    }
  },
  tableColumns: [
    { key: "transaction_id", label: "Transaction ID", mono: true },
    { key: "transaction_date", label: "Date" },
    { key: "account_name", label: "Account", sub: "party_name" },
    { key: "transaction_type", label: "Type" },
    { key: "debit", label: "Debit", align: "right", money: true },
    { key: "credit", label: "Credit", align: "right", money: true },
    { key: "reconciliation_status", label: "Reconciliation", badge: { Reconciled: "default", Pending: "secondary", Unreconciled: "outline" } },
  ],
  kpis: [
    { label: "Total Debit", key: "total_debit", money: true, icon: "Coins" },
    { label: "Total Credit", key: "total_credit", money: true, icon: "Wallet" },
    { label: "Net Movement", key: "net_movement", money: true, icon: "TrendingUp" },
    { label: "Records", key: "total_rows", icon: "Banknote" },
  ],
  summarySelect:
    "COALESCE(SUM(debit),0) total_debit, COALESCE(SUM(credit),0) total_credit, COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) net_movement, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 6. Bank & Cash (master data — finance accounts)
// ---------------------------------------------------------------------------
const bankCash: ModuleConfig = {
  key: "bank-cash",
  table: "finance_accounts",
  label: "Bank & Cash",
  subtitle: "Finance masters",
  addLabel: "New account",
  idColumn: "finance_account_id",
  idPrefix: "ACC",
  statusColumn: "reconciliation_status",
  searchColumns: ["finance_account_id", "account_name", "bank_name", "account_number"],
  fields: [
    fld("Account", "account_name", "Account name", "text", { required: true }),
    fld("Account", "account_type", "Account type", "select", { options: ["Bank", "Cash", "Wallet", "UPI"] }),
    fld("Account", "bank_name", "Bank name", "text"),
    fld("Account", "branch", "Branch", "text"),
    fld("Account", "account_number", "Account number", "text"),
    fld("Account", "ifsc", "IFSC", "text"),
    fld("Account", "upi_wallet_id", "UPI / Wallet ID", "text"),
    fld("Account", "currency", "Currency", "select", { options: CURRENCIES }),
    fld("Balances", "opening_balance", "Opening balance", "number"),
    fld("Balances", "opening_balance_date", "Opening balance date", "date"),
    fld("Balances", "current_book_balance", "Current book balance", "number"),
    fld("Balances", "bank_statement_balance", "Bank statement balance", "number"),
    fld("Balances", "difference", "Difference", "number", { computed: true, money: true }),
    fld("Status", "reconciliation_status", "Reconciliation status", "select", { options: ["Reconciled", "Unreconciled", "Pending"] }),
    fld("Status", "last_reconciliation_date", "Last reconciliation date", "date"),
    fld("Status", "primary_account", "Primary account", "checkbox"),
    fld("Status", "active_status", "Active status", "select", { options: ["Active", "Inactive"] }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => ({ difference: round2(num(v.bank_statement_balance) - num(v.current_book_balance)) }),
  tableColumns: [
    { key: "finance_account_id", label: "Account ID", mono: true },
    { key: "account_name", label: "Account", sub: "bank_name" },
    { key: "account_type", label: "Type" },
    { key: "current_book_balance", label: "Book Balance", align: "right", money: true },
    { key: "bank_statement_balance", label: "Statement", align: "right", money: true },
    { key: "reconciliation_status", label: "Reconciliation", badge: { Reconciled: "default", Pending: "secondary", Unreconciled: "outline" } },
    { key: "active_status", label: "Status", badge: { Active: "default", Inactive: "outline" } },
  ],
  kpis: [
    { label: "Book Balance", key: "total_book", money: true, icon: "Wallet" },
    { label: "Statement Balance", key: "total_statement", money: true, icon: "Banknote" },
    { label: "Difference", key: "total_difference", money: true, icon: "TrendingUp" },
    { label: "Accounts", key: "total_rows", icon: "Landmark" },
  ],
  summarySelect:
    "COALESCE(SUM(current_book_balance),0) total_book, COALESCE(SUM(bank_statement_balance),0) total_statement, COALESCE(SUM(difference),0) total_difference, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 7. Chart of Accounts (master data)
// ---------------------------------------------------------------------------
const chartOfAccounts: ModuleConfig = {
  key: "chart-of-accounts",
  table: "chart_of_accounts",
  label: "Chart of Accounts",
  subtitle: "Finance masters",
  addLabel: "New account",
  idColumn: "account_id",
  idPrefix: "COA",
  statusColumn: "active_status",
  searchColumns: ["account_id", "account_code", "account_name", "account_type"],
  fields: [
    fld("Account", "account_code", "Account code", "text"),
    fld("Account", "account_name", "Account name", "text", { required: true }),
    fld("Account", "account_group", "Account group", "select", { options: ["Asset", "Liability", "Equity", "Income", "Expense"] }),
    fld("Account", "account_type", "Account type", "text"),
    fld("Account", "parent_account_id", "Parent account ID", "text"),
    fld("Account", "nature", "Nature", "select", { options: ["Debit", "Credit"] }),
    fld("Balances", "opening_balance", "Opening balance", "number"),
    fld("Balances", "opening_balance_type", "Opening balance type", "select", { options: ["Debit", "Credit"] }),
    fld("Settings", "gst_applicable", "GST applicable", "checkbox"),
    fld("Settings", "tds_applicable", "TDS applicable", "checkbox"),
    fld("Settings", "tax_category", "Tax category", "text"),
    fld("Settings", "bank_cash_account", "Bank / Cash account", "checkbox"),
    fld("Settings", "reconciliation_required", "Reconciliation required", "checkbox"),
    fld("Settings", "active_status", "Active status", "select", { options: ["Active", "Inactive"] }),
    fld("Settings", "effective_from", "Effective from", "date"),
    fld("Settings", "effective_to", "Effective to", "date"),
    fld("Settings", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "account_id", label: "Account ID", mono: true },
    { key: "account_code", label: "Code" },
    { key: "account_name", label: "Account", sub: "account_group" },
    { key: "account_type", label: "Type" },
    { key: "nature", label: "Nature" },
    { key: "active_status", label: "Status", badge: { Active: "default", Inactive: "outline" } },
  ],
  kpis: [
    { label: "Total Accounts", key: "total_rows", icon: "BookOpen" },
    { label: "Opening Balance", key: "total_opening", money: true, icon: "Coins" },
  ],
  summarySelect: "COUNT(*) total_rows, COALESCE(SUM(opening_balance),0) total_opening",
}

// ---------------------------------------------------------------------------
// 8. Customer / Vendor (master data)
// ---------------------------------------------------------------------------
const customersVendors: ModuleConfig = {
  key: "customers-vendors",
  table: "customers_vendors",
  label: "Customer / Vendor",
  subtitle: "Finance masters",
  addLabel: "New party",
  idColumn: "party_id",
  idPrefix: "CV",
  statusColumn: "status",
  searchColumns: ["party_id", "customer_name", "legal_name", "gstin", "pan", "city", "mobile"],
  fields: [
    fld("Identity", "customer_name", "Customer name", "text", { required: true }),
    fld("Identity", "legal_name", "Name (as registered)", "text"),
    fld("Identity", "party_type", "Party type", "select", { options: ["Customer", "Vendor", "Both"] }),
    fld("Identity", "party_category", "Party category", "text"),
    fld("Identity", "gstin", "GSTIN", "text"),
    fld("Identity", "pan", "PAN", "text"),
    fld("Identity", "tan", "TAN", "text"),
    fld("Contact", "contact_person", "Contact person", "text"),
    fld("Contact", "official_email", "Official email", "text"),
    fld("Contact", "invoice_email", "Invoice email", "text"),
    fld("Contact", "alternate_email", "Personal / alternate email", "text"),
    fld("Contact", "mobile", "Mobile", "text"),
    fld("Contact", "alternate_mobile", "Alternate mobile", "text"),
    fld("Address", "billing_address", "Billing address", "textarea"),
    fld("Address", "city", "City", "text"),
    fld("Address", "state", "State", "text"),
    fld("Address", "state_code", "State code", "text"),
    fld("Address", "pin_code", "PIN code", "text"),
    fld("Address", "country", "Country", "text"),
    fld("Commercial", "payment_terms_days", "Payment terms (days)", "number"),
    fld("Commercial", "credit_limit", "Credit limit", "number"),
    fld("Commercial", "currency", "Currency", "select", { options: CURRENCIES }),
    fld("Banking", "bank_name", "Bank name", "text"),
    fld("Banking", "bank_branch", "Bank branch", "text"),
    fld("Banking", "bank_account_no", "Bank account no.", "text"),
    fld("Banking", "ifsc", "IFSC", "text"),
    fld("Banking", "account_holder_name", "Account holder name", "text"),
    fld("Tax & status", "tds_section", "TDS section", "text"),
    fld("Tax & status", "tds_rate", "TDS rate %", "number"),
    fld("Tax & status", "gst_registration_type", "GST registration type", "select", { options: ["Regular", "Composition", "Unregistered", "SEZ", "Overseas"] }),
    fld("Tax & status", "status", "Status", "select", { options: ["Active", "Inactive"] }),
    fld("Tax & status", "notes", "Notes", "textarea"),
  ],
  tableColumns: [
    { key: "party_id", label: "Party ID", mono: true },
    { key: "customer_name", label: "Name", sub: "party_type" },
    { key: "gstin", label: "GSTIN", mono: true },
    { key: "city", label: "City", sub: "state" },
    { key: "mobile", label: "Mobile" },
    { key: "status", label: "Status", badge: { Active: "default", Inactive: "outline" } },
  ],
  kpis: [
    { label: "Total Parties", key: "total_rows", icon: "Users" },
    { label: "Credit Limit", key: "total_credit", money: true, icon: "Coins" },
  ],
  summarySelect: "COUNT(*) total_rows, COALESCE(SUM(credit_limit),0) total_credit",
}

// ---------------------------------------------------------------------------
// 9. GST Filing
// ---------------------------------------------------------------------------
const gstFiling: ModuleConfig = {
  key: "gst-filing",
  table: "gst_filings",
  label: "GST Filing",
  subtitle: "Tax compliance",
  addLabel: "New GST entry",
  idColumn: "gst_filing_id",
  idPrefix: "GST",
  dateColumn: "due_date",
  financialYearColumn: "financial_year",
  statusColumn: "filing_status",
  searchColumns: ["gst_filing_id", "gstin", "legal_name", "recipient_name", "invoice_number", "arn"],
  fields: [
    fld("Return", "financial_year", "Financial year", "text", { required: true, placeholder: "2026-27" }),
    fld("Return", "return_period", "Return period", "text", { placeholder: "Apr-2026" }),
    fld("Return", "gstin", "GSTIN", "text"),
    fld("Return", "legal_name", "Legal name", "text"),
    fld("Return", "return_type", "Return type", "select", { options: ["GSTR-1", "GSTR-3B", "GSTR-9", "GSTR-2B", "CMP-08"] }),
    fld("Return", "filing_frequency", "Filing frequency", "select", { options: ["Monthly", "Quarterly", "Annual"] }),
    fld("Return", "filing_status", "Filing status", "select", { options: ["Pending", "Filed", "Overdue"] }),
    fld("Return", "due_date", "Due date", "date"),
    fld("Invoice", "invoice_type", "Invoice type", "select", { options: ["B2B", "B2C", "Export", "Nil Rated", "Exempt"], optional: true }),
    fld("Invoice", "supply_category", "Supply category", "text"),
    fld("Invoice", "recipient_gstin", "Recipient GSTIN / UIN", "text"),
    fld("Invoice", "recipient_name", "Recipient name", "text"),
    fld("Invoice", "name_as_in_master", "Name as in master", "text"),
    fld("Invoice", "invoice_number", "Invoice number", "text"),
    fld("Invoice", "invoice_date", "Invoice date", "date"),
    fld("Invoice", "total_invoice_value", "Total invoice value", "number"),
    fld("Invoice", "place_of_supply", "Place of supply", "text"),
    fld("Invoice", "supply_type", "Supply type", "select", { options: ["Intra-State", "Inter-State"], optional: true }),
    fld("Tax", "tax_rate", "Tax rate (%)", "number"),
    fld("Tax", "taxable_value", "Taxable value", "number"),
    fld("Tax", "cess_amount", "Cess amount", "number"),
    fld("Tax", "igst", "IGST", "number"),
    fld("Tax", "cgst", "CGST", "number"),
    fld("Tax", "sgst", "SGST", "number"),
    fld("Tax", "total_tax", "Total tax", "number", { computed: true, money: true }),
    fld("ITC", "itc_eligible", "ITC eligible", "checkbox"),
    fld("ITC", "itc_igst", "ITC IGST", "number"),
    fld("ITC", "itc_cgst", "ITC CGST", "number"),
    fld("ITC", "itc_sgst", "ITC SGST", "number"),
    fld("ITC", "itc_cess", "ITC Cess", "number"),
    fld("ITC", "itc_total", "ITC total", "number", { computed: true, money: true }),
    fld("ITC", "itc_reversal", "ITC reversal", "number"),
    fld("ITC", "net_itc", "Net ITC", "number", { computed: true, money: true }),
    fld("Liability", "tds", "TDS", "number"),
    fld("Liability", "tcs", "TCS", "number"),
    fld("Liability", "interest", "Interest", "number"),
    fld("Liability", "late_fee", "Late fee", "number"),
    fld("Liability", "total_liability", "Total liability", "number", { computed: true, money: true }),
    fld("Payment & filing", "payment_required", "Payment required", "checkbox"),
    fld("Payment & filing", "payment_status", "Payment status", "select", { options: ["Pending", "Paid"], optional: true }),
    fld("Payment & filing", "payment_date", "Payment date", "date"),
    fld("Payment & filing", "challan_cin", "Challan / CIN", "text"),
    fld("Payment & filing", "validation_status", "Validation status", "select", { options: ["Valid", "Invalid", "Pending"], optional: true }),
    fld("Payment & filing", "validation_error_count", "Validation error count", "number"),
    fld("Payment & filing", "validation_message", "Validation message", "textarea"),
    fld("Payment & filing", "arn", "ARN", "text"),
    fld("Payment & filing", "filing_date", "Filing date", "date"),
    fld("Payment & filing", "document_link", "Document link", "text"),
    fld("Payment & filing", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => {
    const totalTax = round2(num(v.igst) + num(v.cgst) + num(v.sgst))
    const itcTotal = round2(num(v.itc_igst) + num(v.itc_cgst) + num(v.itc_sgst) + num(v.itc_cess))
    const netItc = round2(itcTotal - num(v.itc_reversal))
    const liability = round2(Math.max(totalTax - netItc, 0) + num(v.interest) + num(v.late_fee))
    return { total_tax: totalTax, itc_total: itcTotal, net_itc: netItc, total_liability: liability }
  },
  tableColumns: [
    { key: "gst_filing_id", label: "Filing ID", mono: true },
    { key: "return_period", label: "Period" },
    { key: "return_type", label: "Return" },
    { key: "gstin", label: "GSTIN", mono: true },
    { key: "total_tax", label: "Total Tax", align: "right", money: true },
    { key: "total_liability", label: "Liability", align: "right", money: true },
    { key: "filing_status", label: "Status", badge: { Filed: "default", Pending: "secondary", Overdue: "destructive" } },
  ],
  kpis: [
    { label: "Total Tax", key: "total_tax", money: true, icon: "Landmark" },
    { label: "Net ITC", key: "total_net_itc", money: true, icon: "Coins" },
    { label: "Total Liability", key: "total_liability", money: true, icon: "Clock" },
    { label: "Filings", key: "total_rows", icon: "FileText" },
  ],
  summarySelect:
    "COALESCE(SUM(total_tax),0) total_tax, COALESCE(SUM(net_itc),0) total_net_itc, COALESCE(SUM(total_liability),0) total_liability, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 10. TDS Filing
// ---------------------------------------------------------------------------
const tdsFiling: ModuleConfig = {
  key: "tds-filing",
  table: "tds_filings",
  label: "TDS Filing",
  subtitle: "Tax compliance",
  addLabel: "New TDS entry",
  idColumn: "tds_filing_id",
  idPrefix: "TDS",
  dateColumn: "filing_due_date",
  financialYearColumn: "financial_year",
  statusColumn: "return_status",
  searchColumns: ["tds_filing_id", "deductee_name", "pan", "tan", "section", "invoice_id"],
  fields: [
    fld("Return", "financial_year", "Financial year", "text", { required: true, placeholder: "2026-27" }),
    fld("Return", "quarter", "Quarter", "select", { options: ["Q1", "Q2", "Q3", "Q4"] }),
    fld("Return", "month", "Month", "select", { options: MONTHS, optional: true }),
    fld("Return", "tan", "TAN", "text"),
    fld("Return", "invoice_id", "Invoice ID", "text"),
    fld("Deductee", "deductee_id", "Deductee ID", "text"),
    fld("Deductee", "deductee_name", "Deductee name", "text", { required: true }),
    fld("Deductee", "pan", "PAN", "text"),
    fld("Deductee", "section", "Section", "text", { placeholder: "194C" }),
    fld("Deductee", "payment_type", "Payment type", "select", { options: ["Salary", "Contractor", "Professional", "Rent", "Commission", "Interest"], optional: true }),
    fld("Amounts", "gross_amount", "Gross amount", "number"),
    fld("Amounts", "tds_rate", "TDS rate %", "number"),
    fld("Amounts", "tds_amount", "TDS amount", "number", { computed: true, money: true }),
    fld("Amounts", "interest", "Interest", "number"),
    fld("Amounts", "late_fee", "Late fee", "number"),
    fld("Amounts", "total_liability", "Total liability", "number", { computed: true, money: true }),
    fld("Amounts", "tds_paid", "TDS paid", "number"),
    fld("Amounts", "balance_payable_refund", "Balance payable / refund", "number", { computed: true, money: true }),
    fld("Challan & filing", "challan_no", "Challan no.", "text"),
    fld("Challan & filing", "challan_date", "Challan date", "date"),
    fld("Challan & filing", "payment_reference", "Payment reference", "text"),
    fld("Challan & filing", "return_type", "Return type", "select", { options: ["24Q", "26Q", "27Q", "27EQ"], optional: true }),
    fld("Challan & filing", "filing_due_date", "Filing due date", "date"),
    fld("Challan & filing", "filing_date", "Filing date", "date"),
    fld("Challan & filing", "acknowledgement_no", "Acknowledgement no.", "text"),
    fld("Challan & filing", "return_status", "Return status", "select", { options: ["Pending", "Filed", "Overdue"] }),
    fld("Challan & filing", "correction_required", "Correction required", "checkbox"),
    fld("Challan & filing", "correction_date", "Correction date", "date"),
    fld("Challan & filing", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => {
    const tds = round2((num(v.gross_amount) * num(v.tds_rate)) / 100)
    const liability = round2(tds + num(v.interest) + num(v.late_fee))
    return { tds_amount: tds, total_liability: liability, balance_payable_refund: round2(liability - num(v.tds_paid)) }
  },
  tableColumns: [
    { key: "tds_filing_id", label: "Filing ID", mono: true },
    { key: "section", label: "Section" },
    { key: "deductee_name", label: "Deductee", sub: "pan" },
    { key: "gross_amount", label: "Gross", align: "right", money: true },
    { key: "tds_amount", label: "TDS", align: "right", money: true },
    { key: "return_status", label: "Status", badge: { Filed: "default", Pending: "secondary", Overdue: "destructive" } },
  ],
  kpis: [
    { label: "Gross Amount", key: "total_gross", money: true, icon: "Coins" },
    { label: "TDS Deducted", key: "total_tds", money: true, icon: "Landmark" },
    { label: "Total Liability", key: "total_liability", money: true, icon: "Clock" },
    { label: "Balance", key: "total_balance", money: true, icon: "Wallet" },
  ],
  summarySelect:
    "COALESCE(SUM(gross_amount),0) total_gross, COALESCE(SUM(tds_amount),0) total_tds, COALESCE(SUM(total_liability),0) total_liability, COALESCE(SUM(balance_payable_refund),0) total_balance",
}

export const FINANCE_MODULE_CONFIGS: Record<string, ModuleConfig> = {
  "purchase-bills": purchaseBills,
  "expenses": expenses,
  "fte-invoices": fteInvoices,
  "freelance-invoices": freelanceInvoices,
  "bank-transactions": bankTransactions,
  "bank-cash": bankCash,
  "chart-of-accounts": chartOfAccounts,
  "customers-vendors": customersVendors,
  "gst-filing": gstFiling,
  "tds-filing": tdsFiling,
}
