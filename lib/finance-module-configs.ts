import { num, round2, financialYearFor, autoPaymentStatus, computePurchaseBill, computeExpense, accountingPeriodFor, fiscalQuarterFor } from "@/lib/finance-calc"
import { EMPLOYEE_EXPENSE_TYPES, VENDOR_EXPENSE_TYPES } from "@/lib/finance-expense-types"
import type { FieldDef, FieldType, ModuleConfig } from "@/lib/finance-schema"

/** Terse field builder. */
function fld(section: string, key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef {
  return { section, key, label, type, ...extra }
}

const UNITS = ["Nos", "Hours", "Days", "Months", "Lot", "Project", "Kg", "Units"]
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * The twelve "MMM YYYY" months that belong to a financial year label such as
 * "2026-27", starting from April of the start year through March of the next
 * (Apr 2026 … Mar 2027). Returns an empty list when the label has no parseable
 * start year, so the billing-period picker stays empty until an FY is set.
 */
export function monthsForFinancialYear(fy?: string | null): string[] {
  const match = String(fy ?? "").match(/\d{4}/)
  if (!match) return []
  const startYear = Number(match[0])
  const out: string[] = []
  for (let i = 3; i < 3 + 12; i++) {
    const monthIdx = i % 12
    const year = i < 12 ? startYear : startYear + 1
    out.push(`${MONTH_ABBR[monthIdx]} ${year}`)
  }
  return out
}
const PAYMENT_MODES = ["Bank Transfer", "Cash", "UPI", "Cheque", "Card", "NEFT", "RTGS"]
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"]
const PAYMENT_STATUSES = ["Unpaid", "Partially Paid", "Paid", "Overdue"]

const PAYMENT_BADGE = { Paid: "default", "Partially Paid": "secondary", Unpaid: "outline", Overdue: "destructive" } as const

// ---------------------------------------------------------------------------
// 1. Purchase Bills
// ---------------------------------------------------------------------------
// The Bill ID (PB-2026-000001) is server-generated, immutable and never entered
// by hand — it is the module's business key (idColumn) but is NOT a form field.
// PO Number is an optional upstream reference. The vendor is resolved from the
// Vendor master (party picker + server snapshot); its GSTIN / PAN / TAN / state
// and tax profile are frozen onto the bill. Every monetary field is recomputed
// server-side by computePurchaseBillServerFields (see lib/finance-purchase-bills).
const SUPPLY_TYPES = ["Intra-State", "Inter-State"]
const BILL_TYPES = ["Purchase Bill", "Debit Note", "Credit Note", "Import Bill"]

const purchaseBills: ModuleConfig = {
  key: "purchase-bills",
  table: "purchase_bills",
  label: "Purchase Bills",
  subtitle: "Finance transaction",
  addLabel: "New bill",
  idColumn: "bill_id",
  idPrefix: "PB",
  dateColumn: "bill_date",
  financialYearColumn: "financial_year",
  statusColumn: "payment_status",
  pdfPath: "/api/finance/purchase-bills",
  searchColumns: ["bill_id", "bill_number", "po_number", "vendor_name", "vendor_gstin", "project_name", "description"],
  partyLookup: {
    label: "Vendor",
    sourceKey: "customers-vendors",
    idField: "vendor_id",
    nameField: "vendor_name",
    sourceIdColumn: "party_id",
    sourceNameColumn: "customer_name",
    // Phase 2/3 — pull the vendor's identity, verified GST data, address, tax
    // profile and commercial terms so nothing is re-entered. The server
    // re-snapshots authoritatively on save.
    autofill: {
      legal_name: "vendor_legal_name",
      gstin: "vendor_gstin",
      pan: "vendor_pan",
      tan: "vendor_tan",
      state: "vendor_state",
      state_code: "vendor_state_code",
      gst_registration_type: "gst_registration_type",
      gst_verification_status: "gst_status",
      billing_address: "billing_address",
      payment_terms_days: "payment_terms",
      currency: "currency",
      tds_applicable: "tds_applicable",
      tds_section: "tds_section",
      tds_rate: "tds_rate",
    },
  },
  fields: [
    // Phase 4 — BILL INFORMATION (Bill ID is auto/immutable, shown in the title).
    fld("Bill information", "bill_number", "Bill number (vendor invoice no.)", "text", { required: true }),
    fld("Bill information", "bill_date", "Bill date", "date", { required: true }),
    fld("Bill information", "due_date", "Due date", "date", { placeholder: "Auto from payment terms" }),
    fld("Bill information", "bill_type", "Bill type", "select", { options: BILL_TYPES }),
    fld("Bill information", "financial_year", "Financial year", "text", { placeholder: "Auto from bill date" }),
    fld("Bill information", "accounting_period", "Accounting period", "text", { placeholder: "Apr-2026" }),
    fld("Bill information", "po_number", "PO number", "text", { placeholder: "Optional reference" }),
    fld("Bill information", "grn_number", "GRN number", "text", { placeholder: "Optional reference" }),
    // Phase 4 — VENDOR (snapshot autofilled from master; do not re-enter).
    fld("Vendor", "vendor_name", "Vendor", "text", { required: true, placeholder: "Pick from Vendor master" }),
    fld("Vendor", "vendor_id", "Vendor ID", "text", { placeholder: "Auto" }),
    fld("Vendor", "vendor_legal_name", "Legal name", "text"),
    fld("Vendor", "vendor_gstin", "Vendor GSTIN", "text"),
    fld("Vendor", "vendor_pan", "Vendor PAN", "text"),
    fld("Vendor", "vendor_tan", "Vendor TAN", "text"),
    fld("Vendor", "gst_registration_type", "GST registration type", "text"),
    fld("Vendor", "gst_status", "GST verification status", "text"),
    fld("Vendor", "vendor_state", "Vendor state", "text"),
    fld("Vendor", "vendor_state_code", "Vendor state code", "text"),
    // Phase 4 / 9 — BILLING & place of supply.
    fld("Billing", "billing_address", "Billing address", "textarea"),
    fld("Billing", "supply_location", "Supply / service location", "text"),
    fld("Billing", "place_of_supply", "Place of supply", "text", { placeholder: "Defaults to vendor state" }),
    fld("Billing", "place_of_supply_code", "Place of supply code", "text"),
    fld("Billing", "supply_type", "Supply type", "select", { options: SUPPLY_TYPES, optional: true, emptyLabel: "Auto (from states)" }),
    // Phase 4 — ITEMS / SERVICES.
    fld("Items / Services", "description", "Description", "textarea"),
    fld("Items / Services", "hsn_sac", "HSN / SAC", "text"),
    fld("Items / Services", "quantity", "Quantity", "number"),
    fld("Items / Services", "unit", "Unit", "select", { options: UNITS, optional: true }),
    fld("Items / Services", "rate", "Rate", "number"),
    fld("Items / Services", "discount", "Discount", "number"),
    fld("Items / Services", "taxable_amount", "Taxable value (or lump sum)", "number", { placeholder: "auto from qty × rate" }),
    // Phase 4 — TAX. A single GST rate + supply type drives the CGST/SGST/IGST
    // split; explicit percents are honoured when no rate is given.
    fld("Tax", "gst_rate", "GST rate %", "number", { placeholder: "e.g. 18" }),
    fld("Tax", "cgst_percent", "CGST % (manual)", "number"),
    fld("Tax", "sgst_percent", "SGST % (manual)", "number"),
    fld("Tax", "igst_percent", "IGST % (manual)", "number"),
    fld("Tax", "other_tax_cess", "Other tax / cess", "number"),
    fld("Tax", "itc_eligible", "ITC eligible", "checkbox"),
    fld("Tax", "itc_claimed", "ITC claimed", "checkbox"),
    // Phase 4 — TDS.
    fld("TDS", "tds_applicable", "TDS applicable", "checkbox"),
    fld("TDS", "tds_section", "TDS section", "text", { placeholder: "194C" }),
    fld("TDS", "tds_rate", "TDS rate %", "number"),
    // Computed money (Phase 5 — server authoritative).
    fld("Tax", "cgst_amount", "CGST amount", "number", { computed: true, money: true }),
    fld("Tax", "sgst_amount", "SGST amount", "number", { computed: true, money: true }),
    fld("Tax", "igst_amount", "IGST amount", "number", { computed: true, money: true }),
    fld("Tax", "gross_bill_amount", "Gross bill amount", "number", { computed: true, money: true }),
    fld("TDS", "tds_base", "TDS base", "number", { computed: true, money: true }),
    fld("TDS", "tds_amount", "TDS amount", "number", { computed: true, money: true }),
    fld("TDS", "net_payable", "Net payable", "number", { computed: true, money: true }),
    fld("TDS", "outstanding_amount", "Outstanding amount", "number", { computed: true, money: true }),
    // Phase 33–37 — accounting posting linkage (server-owned, read only).
    fld("Accounting", "posting_status", "Posting status", "text", { computed: true }),
    fld("Accounting", "voucher_no", "Journal voucher no.", "text", { computed: true }),
    // Phase 4 — ACCOUNTING.
    fld("Accounting", "expense_account", "Expense / asset account", "text"),
    fld("Accounting", "payable_account", "Payable account", "text"),
    fld("Accounting", "project_id", "Project ID", "text"),
    fld("Accounting", "project_name", "Project name", "text"),
    fld("Accounting", "cost_centre", "Cost centre", "text"),
    fld("Accounting", "department", "Department", "text"),
    // Phase 4 — PAYMENT TRACKING.
    fld("Payment tracking", "amount_paid", "Amount paid", "number"),
    fld("Payment tracking", "payment_status", "Payment status", "select", { options: PAYMENT_STATUSES, optional: true, emptyLabel: "Auto" }),
    fld("Payment tracking", "payment_date", "Payment date", "date"),
    fld("Payment tracking", "payment_reference", "Payment reference", "text"),
    fld("Payment tracking", "currency", "Currency", "select", { options: CURRENCIES, optional: true }),
    fld("Payment tracking", "payment_terms", "Payment terms (days)", "text"),
    // Phase 4 — DOCUMENTS.
    fld("Documents", "bill_attachment_url", "Invoice / bill attachment (URL)", "text"),
    fld("Documents", "po_document_url", "PO document (URL)", "text"),
    fld("Documents", "grn_document_url", "GRN document (URL)", "text"),
    fld("Documents", "supporting_docs_url", "Supporting documents", "textarea"),
    // Phase 4 — NOTES.
    fld("Notes", "notes", "Notes", "textarea"),
  ],
  // Live client mirror of the server money engine (Phase 5). The server
  // recalculates authoritatively and resolves supply type from vendor vs
  // company state, so stored numbers never trust the browser.
  compute: (v) => computePurchaseBill(v),
  tableColumns: [
    { key: "bill_id", label: "Bill ID", mono: true },
    { key: "bill_date", label: "Date", sub: "bill_number" },
    { key: "vendor_name", label: "Vendor", sub: "project_name" },
    { key: "gross_bill_amount", label: "Gross", align: "right", money: true },
    { key: "net_payable", label: "Net Payable", align: "right", money: true },
    { key: "outstanding_amount", label: "Outstanding", align: "right", money: true },
    { key: "payment_status", label: "Payment", badge: { ...PAYMENT_BADGE } },
    { key: "posting_status", label: "Posting", badge: { Posted: "default", Unposted: "outline" } },
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
// Employee-borne vs vendor-borne types decide which lookup + snapshot section
// the dynamic form shows; the exact strings are shared with the server engine.
const EMP_TYPES: string[] = [...EMPLOYEE_EXPENSE_TYPES]
const VEN_TYPES: string[] = [...VENDOR_EXPENSE_TYPES]
const ALL_EXPENSE_TYPES = [...EMP_TYPES, ...VEN_TYPES]
const APPROVAL_STATUSES = ["Pending", "Approved", "Rejected"]
const REIMBURSEMENT_STATUSES = ["Not Applicable", "Pending", "Reimbursed"]
const ITC_STATUSES = ["Not Applicable", "Eligible", "Ineligible"]

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
  searchColumns: [
    "expense_id", "party_name", "employee_name", "vendor_name", "expense_category",
    "expense_head", "description", "vendor_invoice_number", "bill_receipt_no",
    "reference_number", "project_name",
  ],
  // Column-backed dropdown filters exposed by the list toolbar (Phase 27).
  filters: [
    { type: "select", key: "expense_type", label: "Type", options: ALL_EXPENSE_TYPES },
    { type: "select", key: "approval_status", label: "Approval", options: APPROVAL_STATUSES },
    { type: "select", key: "payment_status", label: "Payment", options: PAYMENT_STATUSES },
    { type: "select", key: "reimbursement_status", label: "Reimbursement", options: REIMBURSEMENT_STATUSES },
  ],
  // Multi-source master pickers (Phases 4–10). Selecting a row fills the id +
  // name fields and copies the mapped snapshot columns into the form. Employee
  // and Vendor pickers toggle on the chosen expense type (Phase 12).
  lookups: [
    {
      key: "employee",
      label: "Employee",
      path: "/api/finance/expenses/lookups?type=employee",
      sourceIdColumn: "employee_id",
      sourceNameColumn: "employee_name",
      sourceSubColumn: "department",
      idField: "employee_id",
      nameField: "employee_name",
      autofill: {
        department: "department",
        designation: "designation",
        employment_type: "employment_type",
        official_email: "employee_email",
        mobile: "employee_mobile",
        reporting_manager: "employee_manager",
      },
      visibleWhen: { field: "expense_type", in: EMP_TYPES },
      required: true,
    },
    {
      key: "vendor",
      label: "Vendor",
      path: "/api/finance/expenses/lookups?type=vendor",
      sourceIdColumn: "party_id",
      sourceNameColumn: "customer_name",
      sourceSubColumn: "gstin",
      idField: "vendor_id",
      nameField: "vendor_name",
      autofill: {
        legal_name: "vendor_legal_name",
        gstin: "vendor_gstin",
        gst_registration_type: "gst_registration_type",
        pan: "vendor_pan",
        state: "vendor_state",
        state_code: "vendor_state_code",
        payment_terms_days: "payment_terms",
        currency: "currency",
        tds_section: "tds_section",
        tds_rate: "tds_rate",
      },
      visibleWhen: { field: "expense_type", in: VEN_TYPES },
      required: true,
    },
    {
      key: "project",
      label: "Project / Cost centre",
      path: "/api/finance/expenses/lookups?type=project",
      sourceIdColumn: "project_id",
      sourceNameColumn: "project_name",
      sourceSubColumn: "client_name",
      idField: "project_id",
      nameField: "project_name",
      autofill: { client_name: "client_name", status: "project_status" },
    },
    {
      key: "account",
      label: "Expense head (Chart of Accounts)",
      path: "/api/finance/expenses/lookups?type=account",
      sourceIdColumn: "account_id",
      sourceNameColumn: "account_name",
      sourceSubColumn: "account_code",
      idField: "expense_head_account_id",
      nameField: "expense_head",
      autofill: {},
    },
    {
      key: "bank",
      label: "Bank / Cash account",
      path: "/api/finance/expenses/lookups?type=bank",
      sourceIdColumn: "finance_account_id",
      sourceNameColumn: "account_name",
      sourceSubColumn: "bank_name",
      idField: "bank_cash_account_id",
      nameField: "bank_cash_account_name",
      autofill: {},
    },
  ],
  uploadPath: "/api/finance/expenses/documents/upload",
  duplicateCheck: true,
  fields: [
    // --- Expense details -----------------------------------------------------
    fld("Expense details", "expense_type", "Expense type", "select", { options: ALL_EXPENSE_TYPES, required: true }),
    fld("Expense details", "expense_date", "Expense date", "date", { required: true }),
    fld("Expense details", "expense_category", "Expense category", "text"),
    fld("Expense details", "description", "Description", "textarea"),
    fld("Expense details", "bill_receipt_no", "Bill / Receipt no.", "text"),
    fld("Expense details", "reference_number", "Reference number", "text"),
    fld("Expense details", "financial_year", "Financial year", "text", { placeholder: "Auto (2026-27)" }),
    fld("Expense details", "accounting_period", "Accounting period", "text", { placeholder: "Auto (Apr 2026)" }),

    // --- Employee snapshot (employee-borne types) ----------------------------
    fld("Employee", "employee_id", "Employee ID", "text", { hidden: true, visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "employee_name", "Employee name", "text", { required: true, visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "department", "Department", "text", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "designation", "Designation", "text", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "employment_type", "Employment type", "text", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "employee_email", "Official email", "text", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "employee_mobile", "Mobile", "text", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Employee", "employee_manager", "Reporting manager", "text", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),

    // --- Vendor snapshot (vendor-borne types) --------------------------------
    fld("Vendor", "vendor_id", "Vendor ID", "text", { hidden: true, visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "vendor_name", "Vendor name", "text", { required: true, visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "vendor_legal_name", "Legal name", "text", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "vendor_gstin", "GSTIN", "text", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "gst_registration_type", "GST registration type", "text", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "vendor_pan", "PAN", "text", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "vendor_state", "State", "text", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "vendor_invoice_number", "Vendor invoice no.", "text", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Vendor", "payment_terms", "Payment terms (days)", "number", { visibleWhen: { field: "expense_type", in: VEN_TYPES } }),

    // --- Project / cost centre (Operations) ----------------------------------
    fld("Project & cost centre", "project_id", "Project ID", "text", { hidden: true }),
    fld("Project & cost centre", "project_name", "Project name", "text"),
    fld("Project & cost centre", "client_name", "Client", "text"),
    fld("Project & cost centre", "project_status", "Project status", "text", { hidden: true }),
    fld("Project & cost centre", "cost_centre", "Cost centre", "text"),

    // --- Expense head → Chart of Accounts ------------------------------------
    fld("Expense head", "expense_head_account_id", "Expense head account ID", "text", { hidden: true }),
    fld("Expense head", "expense_head", "Expense head", "text"),
    fld("Expense head", "hsn_sac", "HSN / SAC", "text"),

    // --- Amount & GST --------------------------------------------------------
    fld("Amount & GST", "quantity", "Quantity", "number", { placeholder: "1" }),
    fld("Amount & GST", "rate", "Rate", "number"),
    fld("Amount & GST", "discount", "Discount", "number"),
    fld("Amount & GST", "taxable_amount", "Taxable amount", "number"),
    fld("Amount & GST", "gst_applicable", "GST applicable", "checkbox"),
    fld("Amount & GST", "gst_rate", "GST rate %", "number", { visibleWhen: { field: "gst_applicable", in: ["1"] } }),
    fld("Amount & GST", "supply_type", "Supply type", "select", { options: SUPPLY_TYPES, optional: true, visibleWhen: { field: "gst_applicable", in: ["1"] } }),
    fld("Amount & GST", "cess_amount", "Cess amount", "number", { visibleWhen: { field: "gst_applicable", in: ["1"] } }),
    fld("Amount & GST", "gst_credit_eligible", "GST credit (ITC) eligible", "checkbox", { visibleWhen: { field: "gst_applicable", in: ["1"] } }),
    fld("Amount & GST", "cgst_amount", "CGST amount", "number", { computed: true, money: true }),
    fld("Amount & GST", "sgst_amount", "SGST amount", "number", { computed: true, money: true }),
    fld("Amount & GST", "igst_amount", "IGST amount", "number", { computed: true, money: true }),
    fld("Amount & GST", "gst_amount", "Total GST", "number", { computed: true, money: true }),
    fld("Amount & GST", "gross_amount", "Gross amount", "number", { computed: true, money: true }),

    // --- TDS -----------------------------------------------------------------
    fld("TDS", "tds_applicable", "TDS applicable", "checkbox"),
    fld("TDS", "tds_section", "TDS section", "text", { visibleWhen: { field: "tds_applicable", in: ["1"] } }),
    fld("TDS", "tds_rate", "TDS rate %", "number", { visibleWhen: { field: "tds_applicable", in: ["1"] } }),
    fld("TDS", "tds_amount", "TDS amount", "number", { computed: true, money: true }),

    // --- Advance & adjustment (employee-borne only) --------------------------
    fld("Advance & adjustment", "advance_amount", "Advance amount", "number", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Advance & adjustment", "other_adjustment", "Other adjustment", "number", { visibleWhen: { field: "expense_type", in: EMP_TYPES } }),
    fld("Advance & adjustment", "advance_adjusted", "Advance adjusted", "number", { computed: true, money: true }),
    fld("Advance & adjustment", "remaining_advance", "Remaining advance", "number", { computed: true, money: true }),
    fld("Advance & adjustment", "additional_reimbursement", "Additional reimbursement", "number", { computed: true, money: true }),

    // --- Payment -------------------------------------------------------------
    fld("Payment", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Payment", "bank_cash_account_id", "Bank / Cash account ID", "text", { hidden: true }),
    fld("Payment", "bank_cash_account_name", "Bank / Cash account", "text"),
    fld("Payment", "amount_paid", "Amount paid", "number"),
    fld("Payment", "payment_date", "Payment date", "date"),
    fld("Payment", "payment_reference", "Payment reference", "text"),
    fld("Payment", "net_payable", "Net payable", "number", { computed: true, money: true }),
    fld("Payment", "outstanding_amount", "Outstanding", "number", { computed: true, money: true }),
    fld("Payment", "payment_status", "Payment status", "text", { computed: true }),
    fld("Payment", "itc_status", "ITC status", "text", { hidden: true }),

    // --- Approval & reimbursement --------------------------------------------
    fld("Approval & reimbursement", "approval_status", "Approval status", "select", { options: APPROVAL_STATUSES }),
    fld("Approval & reimbursement", "approved_by", "Approved by", "text"),
    fld("Approval & reimbursement", "reimbursement_status", "Reimbursement status", "select", { options: REIMBURSEMENT_STATUSES }),

    // --- Documents (Phase 22) ------------------------------------------------
    fld("Documents", "receipt_url", "Receipt", "text", { upload: true, placeholder: "Upload a receipt" }),
    fld("Documents", "vendor_invoice_url", "Vendor invoice", "text", { upload: true, placeholder: "Upload the vendor invoice", visibleWhen: { field: "expense_type", in: VEN_TYPES } }),
    fld("Documents", "supporting_docs_url", "Supporting documents", "text", { upload: true, placeholder: "Upload supporting files" }),

    // --- Notes ---------------------------------------------------------------
    fld("Notes", "notes", "Notes", "textarea"),
  ],
  // Client-side mirror of the authoritative server recalculation (Phase 15), so
  // the "Calculated automatically" box previews the same money the server saves.
  compute: (v) => computeExpense(v),
  tableColumns: [
    { key: "expense_id", label: "Expense ID", mono: true },
    { key: "expense_date", label: "Date" },
    { key: "party_name", label: "Payee", sub: "expense_type" },
    { key: "expense_head", label: "Expense head", sub: "expense_category" },
    { key: "gross_amount", label: "Gross", align: "right", money: true },
    { key: "net_payable", label: "Net Payable", align: "right", money: true },
    { key: "outstanding_amount", label: "Outstanding", align: "right", money: true },
    { key: "payment_status", label: "Payment", badge: PAYMENT_BADGE },
    { key: "approval_status", label: "Approval", badge: { Approved: "default", Pending: "secondary", Rejected: "destructive" } },
  ],
  kpis: [
    { label: "Gross Expense", key: "total_gross", money: true, icon: "Receipt" },
    { label: "Net Payable", key: "total_net", money: true, icon: "Coins" },
    { label: "Outstanding", key: "total_outstanding", money: true, icon: "Wallet" },
    { label: "TDS Deducted", key: "total_tds", money: true, icon: "Landmark" },
  ],
  summarySelect:
    "COALESCE(SUM(gross_amount),0) total_gross, COALESCE(SUM(net_payable),0) total_net, COALESCE(SUM(tds_amount),0) total_tds, COALESCE(SUM(outstanding_amount),0) total_outstanding, COUNT(*) total_rows",
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
  invoiceActions: true,
  pdfPath: "/api/finance/fte-invoices",
  emailField: "employee_email",
  dateColumn: "invoice_date",
  financialYearColumn: "financial_year",
  statusColumn: "status",
  searchColumns: ["fte_invoice_id", "employee_name", "department", "designation", "project_name"],
  // Master pickers: Employee is sourced from HR (hr_employees) and Project from
  // Operations (operations_projects), reusing the shared expense lookups route.
  // Selecting a row fills the id + name fields and autofills the empty snapshot
  // columns (department, designation, employment type, email) so the invoice
  // never duplicates or hand-types master data.
  lookups: [
    {
      key: "employee",
      label: "Employee",
      path: "/api/finance/expenses/lookups?type=employee",
      sourceIdColumn: "employee_id",
      sourceNameColumn: "employee_name",
      sourceSubColumn: "department",
      idField: "employee_id",
      nameField: "employee_name",
      autofill: {
        department: "department",
        designation: "designation",
        employment_type: "employment_type",
        official_email: "employee_email",
      },
      required: true,
    },
    {
      key: "project",
      label: "Project",
      path: "/api/finance/expenses/lookups?type=project",
      sourceIdColumn: "project_id",
      sourceNameColumn: "project_name",
      sourceSubColumn: "client_name",
      idField: "project_id",
      nameField: "project_name",
      autofill: {},
    },
  ],
  fields: [
    fld("Employee & period", "invoice_date", "Invoice date", "date", { required: true }),
    fld("Employee & period", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Employee & period", "month", "Month", "select", { options: MONTHS, optional: true }),
    fld("Employee & period", "employee_id", "Employee ID", "text"),
    fld("Employee & period", "employee_name", "Employee name", "text", { required: true }),
    fld("Employee & period", "employee_email", "Employee email", "text", { placeholder: "name@example.com" }),
    fld("Employee & period", "employee_pan", "Employee PAN", "text", { placeholder: "AAAAA0000A", optional: true, help: "Used on the 24Q payee return; missing/invalid PAN triggers the higher §206AA rate." }),
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
      employee_pan: String(v.employee_pan || "").replace(/\s+/g, "").toUpperCase(),
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
  invoiceActions: true,
  pdfPath: "/api/finance/freelance-invoices",
  dateColumn: "invoice_date",
  financialYearColumn: "financial_year",
  statusColumn: "payment_status",
  searchColumns: ["freelance_invoice_id", "freelancer_name", "project_name", "work_description"],
  // Master pickers: Freelancer is sourced from HR (hr_employees) and Project
  // from Operations (operations_projects), reusing the shared expense lookups
  // route. Selecting a row fills the id + name fields and autofills the email
  // snapshot so the invoice never duplicates or hand-types master data.
  lookups: [
    {
      key: "freelancer",
      label: "Freelancer",
      path: "/api/finance/expenses/lookups?type=employee",
      sourceIdColumn: "employee_id",
      sourceNameColumn: "employee_name",
      sourceSubColumn: "department",
      idField: "freelancer_id",
      nameField: "freelancer_name",
      autofill: {},
      // Offer both of the freelancer's emails as a dropdown; default to official.
      optionSources: { field: "freelancer_email", from: ["official_email", "personal_email"] },
      required: true,
    },
    {
      key: "project",
      label: "Project",
      path: "/api/finance/expenses/lookups?type=project",
      sourceIdColumn: "project_id",
      sourceNameColumn: "project_name",
      sourceSubColumn: "client_name",
      idField: "project_id",
      nameField: "project_name",
      autofill: {},
    },
  ],
  fields: [
    fld("Freelancer & period", "invoice_date", "Invoice date", "date", { required: true }),
    fld("Freelancer & period", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Freelancer & period", "billing_period", "Billing period", "select", { financialYearMonths: true, optional: true, emptyLabel: "Select month" }),
    fld("Freelancer & period", "freelancer_id", "Freelancer ID", "text"),
    fld("Freelancer & period", "freelancer_name", "Freelancer name", "text", { required: true }),
    fld("Freelancer & period", "freelancer_email", "Freelancer email", "select", { dynamicOptions: true, optional: true, emptyLabel: "Select email" }),
    fld("Freelancer & period", "freelancer_pan", "Freelancer PAN", "text", { placeholder: "AAAAA0000A", optional: true, help: "Used on the 26Q/27Q return; missing/invalid PAN triggers the higher §206AA rate." }),
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
      freelancer_pan: String(v.freelancer_pan || "").replace(/\s+/g, "").toUpperCase(),
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
// Transaction types drive the debit/credit meaning and which contra/tax fields
// are relevant. The Bank/Cash account, parties, account head and project are
// all resolved from their authoritative masters (never hand-typed), and a
// posted transaction is projected into the SAME Journal + General Ledger engine
// used by Purchase Bills — Bank Transactions never own a parallel accounting.
const BANK_TRANSACTION_TYPES = ["Receipt", "Payment", "Transfer", "Bank Charge", "Interest", "Refund", "Adjustment", "Other"]
const BANK_VOUCHER_TYPES = ["Bank", "Cash", "Contra", "Journal", "Receipt", "Payment"]
const BANK_PARTY_TYPES = ["Customer", "Vendor", "Employee", "Other"]
const BANK_SOURCE_MODULES = ["Sales Invoice", "Purchase Bill", "Expense", "FTE", "Freelance", "Payment", "Journal", "Other"]
const BANK_RECON_STATUSES = ["Unreconciled", "Pending", "Reconciled"]
// GST / TDS only make sense on cash movements that carry tax — never on a plain
// bank-to-bank transfer (Phase 10).
const BANK_TAX_TYPES = BANK_TRANSACTION_TYPES.filter((t) => t !== "Transfer")

const bankTransactions: ModuleConfig = {
  key: "bank-transactions",
  table: "bank_transactions",
  label: "Bank Transactions",
  subtitle: "Finance management",
  addLabel: "New transaction",
  idColumn: "transaction_id",
  idPrefix: "BT",
  dateColumn: "transaction_date",
  financialYearColumn: "financial_year",
  statusColumn: "reconciliation_status",
  searchColumns: ["transaction_id", "account_name", "party_name", "account_head", "reference_no", "cheque_utr_reference", "source_transaction_id", "narration"],
  uploadPath: "/api/finance/module/bank-transactions/upload",
  // Master pickers (Phases 3–6). Bank/Cash from the Finance accounts master
  // (active only), the party from the right master by party type (Customer →
  // Clients, Vendor → Vendors, Employee → HR), the account head from the Chart
  // of Accounts, the project from Operations, and — for a transfer — the second
  // Bank/Cash account. Selecting a row fills the id + name fields and never lets
  // a random name be typed.
  lookups: [
    {
      key: "bank_cash",
      label: "Bank / Cash account",
      path: "/api/finance/expenses/lookups?type=bank",
      sourceIdColumn: "finance_account_id",
      sourceNameColumn: "account_name",
      sourceSubColumn: "bank_name",
      idField: "bank_cash_account_id",
      nameField: "account_name",
      autofill: {},
      required: true,
    },
    {
      key: "customer",
      label: "Customer",
      path: "/api/finance/expenses/lookups?type=client",
      sourceIdColumn: "client_code",
      sourceNameColumn: "client_name",
      sourceSubColumn: "company_name",
      idField: "party_id",
      nameField: "party_name",
      autofill: {},
      visibleWhen: { field: "party_type", in: ["Customer"] },
    },
    {
      key: "vendor",
      label: "Vendor",
      path: "/api/finance/expenses/lookups?type=vendor",
      sourceIdColumn: "party_id",
      sourceNameColumn: "customer_name",
      sourceSubColumn: "gstin",
      idField: "party_id",
      nameField: "party_name",
      autofill: {},
      visibleWhen: { field: "party_type", in: ["Vendor"] },
    },
    {
      key: "employee",
      label: "Employee",
      path: "/api/finance/expenses/lookups?type=employee",
      sourceIdColumn: "employee_id",
      sourceNameColumn: "employee_name",
      sourceSubColumn: "department",
      idField: "party_id",
      nameField: "party_name",
      autofill: {},
      visibleWhen: { field: "party_type", in: ["Employee"] },
    },
    {
      key: "account_head",
      label: "Account head",
      path: "/api/finance/expenses/lookups?type=coa",
      sourceIdColumn: "account_id",
      sourceNameColumn: "account_name",
      sourceSubColumn: "account_group",
      idField: "account_head_id",
      nameField: "account_head",
      autofill: {},
      visibleWhen: { field: "transaction_type", in: BANK_TAX_TYPES },
    },
    {
      key: "project",
      label: "Project",
      path: "/api/finance/expenses/lookups?type=project",
      sourceIdColumn: "project_id",
      sourceNameColumn: "project_name",
      sourceSubColumn: "client_name",
      idField: "project_id",
      nameField: "project_name",
      autofill: {},
    },
    {
      key: "counter_account",
      label: "Transfer to / from account",
      path: "/api/finance/expenses/lookups?type=bank",
      sourceIdColumn: "finance_account_id",
      sourceNameColumn: "account_name",
      sourceSubColumn: "bank_name",
      idField: "counter_account_id",
      nameField: "counter_account_name",
      autofill: {},
      visibleWhen: { field: "transaction_type", in: ["Transfer"] },
    },
  ],
  fields: [
    // TRANSACTION — the period fields (FY / month / quarter / accounting period)
    // are all derived server-side from the transaction date (Phases 67/68).
    fld("Transaction", "transaction_date", "Transaction date", "date", { required: true }),
    fld("Transaction", "value_date", "Value date", "date"),
    fld("Transaction", "transaction_type", "Transaction type", "select", { options: BANK_TRANSACTION_TYPES, required: true }),
    fld("Transaction", "voucher_type", "Voucher type", "select", { options: BANK_VOUCHER_TYPES, optional: true, emptyLabel: "Auto" }),
    fld("Transaction", "reference_no", "Reference no.", "text", { placeholder: "Optional reference" }),
    fld("Transaction", "financial_year", "Financial year", "text", { placeholder: "Auto from date" }),
    fld("Transaction", "month", "Month", "select", { options: MONTHS, optional: true, emptyLabel: "Auto from date" }),
    fld("Transaction", "quarter", "Quarter", "text", { placeholder: "Auto from date" }),
    fld("Transaction", "accounting_period", "Accounting period", "text", { placeholder: "Auto (Apr-2026)" }),
    // BANK / CASH — resolved from the Bank & Cash master (active accounts only).
    fld("Bank / Cash account", "account_name", "Account name", "text", { required: true, placeholder: "Pick from Bank & Cash" }),
    fld("Bank / Cash account", "bank_cash_account_id", "Bank / Cash account ID", "text", { placeholder: "Auto" }),
    fld("Bank / Cash account", "counter_account_name", "Transfer counter account", "text", { visibleWhen: { field: "transaction_type", in: ["Transfer"] }, placeholder: "Pick the other account" }),
    fld("Bank / Cash account", "counter_account_id", "Counter account ID", "text", { visibleWhen: { field: "transaction_type", in: ["Transfer"] }, placeholder: "Auto" }),
    // PARTY & HEADS — smart party picker + Chart-of-Accounts head + Project.
    fld("Parties & heads", "party_type", "Party type", "select", { options: BANK_PARTY_TYPES, optional: true, emptyLabel: "Not linked" }),
    fld("Parties & heads", "party_id", "Party ID", "text", { placeholder: "Auto from master" }),
    fld("Parties & heads", "party_name", "Party name", "text", { placeholder: "Auto (or type for Other)" }),
    fld("Parties & heads", "account_head", "Account head", "text", { visibleWhen: { field: "transaction_type", in: BANK_TAX_TYPES }, placeholder: "Pick from Chart of Accounts" }),
    fld("Parties & heads", "account_head_id", "Account head ID", "text", { visibleWhen: { field: "transaction_type", in: BANK_TAX_TYPES }, placeholder: "Auto" }),
    fld("Parties & heads", "project_id", "Project ID", "text", { placeholder: "Auto" }),
    fld("Parties & heads", "project_name", "Project name", "text", { placeholder: "Auto from Project master" }),
    // AMOUNTS — debit = withdrawal (money out), credit = deposit (money in).
    // Exactly one is entered; the server rejects both being non-zero.
    fld("Amounts", "debit", "Debit (withdrawal)", "number"),
    fld("Amounts", "credit", "Credit (deposit)", "number"),
    fld("Amounts", "amount", "Amount", "number", { computed: true, money: true }),
    fld("Amounts", "gst_amount", "GST amount", "number", { visibleWhen: { field: "transaction_type", in: BANK_TAX_TYPES } }),
    fld("Amounts", "tds_amount", "TDS amount", "number", { visibleWhen: { field: "transaction_type", in: BANK_TAX_TYPES } }),
    // SOURCE — link back to the finance document this movement settles.
    fld("Source", "source_module", "Source module", "select", { options: BANK_SOURCE_MODULES, optional: true, emptyLabel: "Not linked" }),
    fld("Source", "source_transaction_id", "Source transaction ID", "text", { placeholder: "e.g. PB-2026-000001" }),
    // PAYMENT & RECONCILIATION.
    fld("Reconciliation", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Reconciliation", "cheque_utr_reference", "Cheque / UTR / reference", "text"),
    fld("Reconciliation", "narration", "Narration", "textarea"),
    fld("Reconciliation", "reconciliation_status", "Reconciliation status", "select", { options: BANK_RECON_STATUSES, default: "Unreconciled" }),
    fld("Reconciliation", "reconciliation_date", "Reconciliation date", "date"),
    fld("Reconciliation", "attachment_link", "Attachment / document link", "text", { upload: true }),
    // POSTING — server-owned, shown read-only in the detail view.
    fld("Posting", "posting_status", "Posting status", "text", { hidden: true }),
    fld("Posting", "voucher_no", "Voucher no.", "text", { hidden: true }),
    fld("Posting", "journal_entry_id", "Journal entry ID", "text", { hidden: true }),
  ],
  compute: (v) => {
    const debit = round2(num(v.debit)), credit = round2(num(v.credit))
    const date = v.transaction_date
    return {
      debit, credit, amount: round2(credit > 0 ? credit : debit),
      financial_year: v.financial_year || financialYearFor(date),
      month: v.month || (date ? MONTHS[new Date(date).getMonth()] : ""),
      quarter: fiscalQuarterFor(date),
      accounting_period: accountingPeriodFor(date),
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
    { key: "posting_status", label: "Posting", badge: { Posted: "default", Unposted: "outline" } },
  ],
  kpis: [
    { label: "Total Debit", key: "total_debit", money: true, icon: "Coins" },
    { label: "Total Credit", key: "total_credit", money: true, icon: "Wallet" },
    { label: "Net Movement", key: "net_movement", money: true, icon: "TrendingUp" },
    { label: "Records", key: "total_rows", icon: "Banknote" },
  ],
  summarySelect:
    "COALESCE(SUM(debit),0) total_debit, COALESCE(SUM(credit),0) total_credit, COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) net_movement, COUNT(*) total_rows",
  importSpec: {
    title: "Import bank statement",
    description:
      "Upload an .xlsx or .csv statement exported from your bank. Pick the account, map the columns and review before importing.",
    templateName: "bank-statement-template.xlsx",
    accountBound: true,
    columns: [
      { key: "transaction_date", label: "Transaction date", type: "date", required: true, aliases: ["transactiondate", "date", "txndate", "transdate", "postingdate", "postdate"] },
      { key: "value_date", label: "Value date", type: "date", aliases: ["valuedate", "valuedt", "valuedate"] },
      { key: "reference_no", label: "Reference / Cheque no.", type: "text", aliases: ["referenceno", "refno", "reference", "chequeno", "chqno", "instrumentno", "utr", "utrno", "chequeutrreference"] },
      { key: "party_name", label: "Party", type: "text", aliases: ["partyname", "party", "payee", "payer", "beneficiary"] },
      { key: "narration", label: "Narration / Description", type: "text", aliases: ["narration", "description", "particulars", "remarks", "details", "transactiondetails", "transactionremarks", "naration"] },
      { key: "debit", label: "Debit / Withdrawal", type: "number", aliases: ["debit", "withdrawal", "withdrawalamt", "withdrawalamount", "withdrawals", "dr", "dramount", "paidout", "paymentamount", "debitamount"] },
      { key: "credit", label: "Credit / Deposit", type: "number", aliases: ["credit", "deposit", "depositamt", "depositamount", "deposits", "cr", "cramount", "paidin", "receiptamount", "creditamount"] },
    ],
  },
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
  detailPath: "/modules/finance/bank-cash",
  searchColumns: ["finance_account_id", "account_name", "bank_name", "account_number", "upi_wallet_id"],
  filters: [
    { type: "select", key: "account_type", label: "Type", options: ["Bank", "Cash", "Wallet", "UPI"] },
    { type: "select", key: "active_status", label: "Status", options: ["Active", "Inactive", "Closed"] },
    { type: "select", key: "reconciliation_status", label: "Reconciliation", options: ["Reconciled", "Unreconciled", "Pending"] },
    { type: "number_range", keyMin: "balance_min", keyMax: "balance_max", column: "current_book_balance", label: "Balance" },
  ],
  fields: [
    fld("Account", "account_name", "Account name", "text", { required: true }),
    fld("Account", "account_type", "Account type", "select", { options: ["Bank", "Cash", "Wallet", "UPI"] }),
    fld("Account", "bank_name", "Bank name", "text", { visibleWhen: { field: "account_type", in: ["Bank"] } }),
    fld("Account", "branch", "Branch", "text", { visibleWhen: { field: "account_type", in: ["Bank"] } }),
    fld("Account", "account_number", "Account number", "text", { visibleWhen: { field: "account_type", in: ["Bank"] } }),
    fld("Account", "ifsc", "IFSC", "text", { visibleWhen: { field: "account_type", in: ["Bank"] } }),
    fld("Account", "upi_wallet_id", "UPI / Wallet ID", "text", { visibleWhen: { field: "account_type", in: ["Wallet", "UPI"] } }),
    fld("Account", "account_holder", "Account holder name", "text"),
    fld("Account", "currency", "Currency", "select", { options: CURRENCIES }),
    fld("Balances", "opening_balance", "Opening balance", "number"),
    fld("Balances", "opening_balance_date", "Opening balance date", "date"),
    // Server-authoritative: recomputed from this account's bank transactions as
    // Opening + Credits − Debits (see lib/finance-account-master). Shown as a
    // read-only computed figure, never hand-keyed.
    fld("Balances", "current_book_balance", "Current book balance", "number", { computed: true, money: true }),
    fld("Balances", "bank_statement_balance", "Bank statement balance", "number"),
    fld("Balances", "difference", "Difference", "number", { computed: true, money: true }),
    fld("Status", "reconciliation_status", "Reconciliation status", "select", { options: ["Reconciled", "Unreconciled", "Pending"] }),
    fld("Status", "last_reconciliation_date", "Last reconciliation date", "date"),
    fld("Status", "primary_account", "Primary account", "checkbox"),
    fld("Status", "active_status", "Active status", "select", { options: ["Active", "Inactive", "Closed"] }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => ({ difference: round2(num(v.bank_statement_balance) - num(v.current_book_balance)) }),
  tableColumns: [
    { key: "finance_account_id", label: "Account ID", mono: true },
    { key: "account_name", label: "Account", sub: "bank_name" },
    { key: "account_type", label: "Type" },
    { key: "account_number", label: "Account no.", mono: true, mask: true },
    { key: "current_book_balance", label: "Book Balance", align: "right", money: true },
    { key: "bank_statement_balance", label: "Statement", align: "right", money: true },
    { key: "reconciliation_status", label: "Reconciliation", badge: { Reconciled: "default", Pending: "secondary", Unreconciled: "outline" } },
    { key: "active_status", label: "Status", badge: { Active: "default", Inactive: "outline", Closed: "destructive" } },
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
// The five top-level account types map to the existing `account_group` column
// (kept singular — the posting engine's isDebitNature() keys off "asset" /
// "expense"). The finer classification maps to the existing `account_type`
// column, which the Journal / General Ledger snapshot, so both stay backward
// compatible with every downstream link.
export const COA_ACCOUNT_TYPES = ["Asset", "Liability", "Equity", "Income", "Expense"] as const

// Sub-types offered per account type. The first group of each list is the most
// common; legacy seed values (singular "Current Asset", "Duties & Taxes", …)
// are appended so an existing row's stored sub-type always stays selectable.
export const COA_SUB_TYPES_BY_TYPE: Record<string, string[]> = {
  Asset: ["Current Assets", "Fixed Assets", "Bank", "Cash", "Receivables", "Current Asset", "Fixed Asset"],
  Liability: ["Current Liabilities", "Long Term Liabilities", "Payables", "Taxes", "Current Liability", "Duties & Taxes"],
  Equity: ["Equity"],
  Income: ["Revenue", "Other Income", "Direct Income", "Indirect Income"],
  Expense: ["Operating Expenses", "Cost of Sales", "Other Expenses", "Taxes", "Direct Expense", "Indirect Expense"],
}

/** Flat, de-duplicated union of every sub-type (used by the select fallback). */
export const COA_SUB_TYPES = Array.from(
  new Set(Object.values(COA_SUB_TYPES_BY_TYPE).flat()),
)

/** An account's natural balance side is fixed by its top-level type. */
export function natureForAccountType(accountGroup: string | null | undefined): "Debit" | "Credit" {
  const g = (accountGroup || "").toLowerCase()
  return g === "asset" || g === "expense" ? "Debit" : "Credit"
}

const chartOfAccounts: ModuleConfig = {
  key: "chart-of-accounts",
  table: "chart_of_accounts",
  label: "Chart of Accounts",
  subtitle: "Finance masters",
  addLabel: "New account",
  idColumn: "account_id",
  idPrefix: "COA",
  statusColumn: "active_status",
  financialYearColumn: "financial_year",
  searchColumns: ["account_id", "account_code", "account_name", "account_type", "account_group"],
  // Nature + opening-balance side follow the account type automatically, and the
  // financial year is derived from the opening-balance date when left blank, so
  // none of these are ever hand-entered.
  compute: (r) => {
    const nature = natureForAccountType(r.account_group)
    const out: Record<string, any> = { nature, opening_balance_type: nature }
    const obDate = (r.opening_balance_date ?? "").toString().trim()
    const fy = (r.financial_year ?? "").toString().trim()
    if (obDate && !fy) out.financial_year = financialYearFor(obDate)
    return out
  },
  fields: [
    fld("Account", "account_name", "Account name", "text", { required: true }),
    fld("Account", "account_code", "Account code", "text", { placeholder: "Unique code, e.g. 1200" }),
    fld("Account", "account_group", "Account type", "select", { options: [...COA_ACCOUNT_TYPES], required: true }),
    fld("Account", "account_type", "Sub type", "select", { options: COA_SUB_TYPES, optional: true }),
    fld("Account", "parent_account_id", "Parent account", "text", { optional: true }),
    fld("Account", "nature", "Nature", "select", { options: ["Debit", "Credit"], computed: true }),
    fld("Account", "remarks", "Description", "textarea", { optional: true }),
    fld("Balances", "opening_balance", "Opening balance", "number"),
    fld("Balances", "opening_balance_type", "Opening balance type", "select", { options: ["Debit", "Credit"], computed: true }),
    fld("Balances", "opening_balance_date", "Opening balance date", "date", { optional: true }),
    fld("Balances", "financial_year", "Financial year", "text", { optional: true, placeholder: "Auto from opening date" }),
  fld("Settings", "active_status", "Status", "select", { options: ["Active", "Inactive", "Archived"] }),
  fld("Settings", "gst_applicable", "GST applicable", "checkbox"),
    fld("Settings", "tds_applicable", "TDS applicable", "checkbox"),
    fld("Settings", "tax_category", "Tax category", "text"),
    fld("Settings", "bank_cash_account", "Bank / Cash account", "checkbox"),
    fld("Settings", "reconciliation_required", "Reconciliation required", "checkbox"),
    fld("Settings", "effective_from", "Effective from", "date"),
    fld("Settings", "effective_to", "Effective to", "date"),
    // Reporting-classification overrides (requirement 71). Blank = auto-derive
    // from the account type/code/name in lib/finance-classification.ts.
    fld("Classification", "bs_group", "Balance Sheet group", "text", { optional: true, placeholder: "Auto" }),
    fld("Classification", "pnl_group", "Profit & Loss group", "text", { optional: true, placeholder: "Auto" }),
    fld("Classification", "cashflow_group", "Cash Flow group", "text", { optional: true, placeholder: "Auto" }),
  ],
  tableColumns: [
    { key: "account_id", label: "Account ID", mono: true },
    { key: "account_code", label: "Code" },
    { key: "account_name", label: "Account", sub: "account_group" },
    { key: "account_type", label: "Sub type" },
    { key: "nature", label: "Nature" },
    { key: "active_status", label: "Status", badge: { Active: "default", Inactive: "outline", Archived: "destructive" } },
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
// The Vendor master keeps the historical `customers_vendors` table and its
// `party_id` / `customer_name` columns so every downstream link (Clients,
// Sales Invoices, Payments, GST/TDS filing) keeps resolving. Only the presented
// surface is vendor-first: new records get a VEN- id and party_type is fixed to
// "Vendor" (Customers are managed from the Clients master, not here).
const VENDOR_CATEGORIES = [
  "Goods Supplier", "Service Provider", "Contractor", "Professional",
  "Rent / Landlord", "Utility", "Transporter", "Import Vendor", "Other",
]
const customersVendors: ModuleConfig = {
  key: "customers-vendors",
  table: "customers_vendors",
  label: "Vendors",
  subtitle: "Finance master",
  addLabel: "New vendor",
  idColumn: "party_id",
  idPrefix: "VEN",
  statusColumn: "status",
  detailPath: "/modules/finance/customers-vendors",
  searchColumns: ["party_id", "customer_name", "legal_name", "gstin", "pan", "city", "mobile"],
  filters: [
    { type: "select", key: "status", label: "Status", options: ["Active", "Inactive", "On Hold", "Archived"] },
    { type: "select", key: "vendor_category", label: "Category", options: VENDOR_CATEGORIES },
    { type: "select", key: "gst_verification_status", label: "GST status", options: ["Verified", "Unverified", "Failed", "Cancelled"] },
  ],
  // Outstanding payable is derived from the vendor's open purchase bills.
  extraSelect:
    "(SELECT COALESCE(SUM(pb.outstanding_amount),0) FROM purchase_bills pb WHERE pb.vendor_id = x.party_id) AS outstanding_amount",
  gstin: {
    column: "gstin",
    lookupPath: "/api/finance/vendors/gstin-lookup",
    autofill: { name: "customer_name", legalName: "legal_name", pan: "pan", address: "registered_address", state: "state" },
    statusField: "gst_verification_status",
  },
  ifsc: {
    column: "ifsc",
    lookupPath: "/api/finance/vendors/ifsc-lookup",
    autofill: { bank: "bank_name", branch: "bank_branch" },
  },
  fields: [
    fld("Identity", "customer_name", "Vendor name", "text", { required: true }),
    fld("Identity", "legal_name", "Legal name (as registered)", "text"),
    fld("Identity", "trade_name", "Trade name", "text"),
    fld("Identity", "party_type", "Party type", "text", { hidden: true, default: "Vendor" }),
    fld("Identity", "vendor_category", "Vendor category", "select", { options: VENDOR_CATEGORIES, optional: true }),
    fld("Identity", "gstin", "GSTIN", "text", { placeholder: "15-character GSTIN" }),
    fld("Identity", "pan", "PAN", "text"),
    fld("Identity", "tan", "TAN", "text"),
    fld("Contact", "contact_person", "Contact person", "text"),
    fld("Contact", "official_email", "Official email", "text"),
    fld("Contact", "invoice_email", "Invoice email", "text"),
    fld("Contact", "alternate_email", "Personal / alternate email", "text"),
    fld("Contact", "mobile", "Mobile", "text"),
    fld("Contact", "alternate_mobile", "Alternate mobile", "text"),
    fld("Address", "registered_address", "Registered address", "textarea"),
    fld("Address", "billing_address", "Billing / correspondence address", "textarea"),
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
    fld("Banking", "upi_id", "UPI ID", "text"),
    fld("Tax & compliance", "tds_applicable", "TDS applicable", "checkbox"),
    fld("Tax & compliance", "tds_section", "TDS section", "text", { placeholder: "194C" }),
    fld("Tax & compliance", "tds_rate", "TDS rate %", "number"),
    fld("Tax & compliance", "gst_registration_type", "GST registration type", "select", { options: ["Regular", "Composition", "Unregistered", "SEZ", "Overseas"] }),
    fld("Tax & compliance", "kyc_status", "KYC status", "select", { options: ["Pending", "Verified", "Rejected"], optional: true }),
    fld("Tax & compliance", "status", "Status", "select", { options: ["Active", "Inactive", "On Hold", "Archived"] }),
    fld("Tax & compliance", "notes", "Notes", "textarea"),
    // GST-network verification snapshot: server-populated, read-only in the form
    // but persisted and shown in the detail view.
    fld("GST verification", "gst_verification_status", "Verification status", "text", { hidden: true }),
    fld("GST verification", "gst_trade_name", "GST trade name", "text", { hidden: true }),
    fld("GST verification", "gst_status", "GST portal status", "text", { hidden: true }),
    fld("GST verification", "gst_taxpayer_type", "Taxpayer type", "text", { hidden: true }),
    fld("GST verification", "business_constitution", "Business constitution", "text", { hidden: true }),
    fld("GST verification", "gst_registration_date", "GST registration date", "text", { hidden: true }),
    fld("GST verification", "gst_cancellation_date", "GST cancellation date", "text", { hidden: true }),
    fld("GST verification", "gst_block_status", "e-Way bill block status", "text", { hidden: true }),
    fld("GST verification", "gst_verified_at", "Verified at", "text", { hidden: true }),
    fld("GST verification", "gst_verification_source", "Verification source", "text", { hidden: true }),
  ],
  tableColumns: [
    { key: "party_id", label: "Vendor ID", mono: true },
    { key: "customer_name", label: "Vendor", sub: "vendor_category" },
    { key: "gstin", label: "GSTIN", mono: true },
    { key: "gst_verification_status", label: "GST", badge: { Verified: "default", Unverified: "outline", Failed: "destructive", Cancelled: "destructive" } },
    { key: "city", label: "City", sub: "state" },
    { key: "outstanding_amount", label: "Outstanding", align: "right", money: true },
    { key: "status", label: "Status", badge: { Active: "default", Inactive: "outline", "On Hold": "secondary", Archived: "destructive" } },
  ],
  kpis: [
    { label: "Total Vendors", key: "total_rows", icon: "Users" },
    { label: "Active", key: "active_rows", icon: "TrendingUp" },
    { label: "GST Verified", key: "verified_rows", icon: "Landmark" },
    { label: "TDS Applicable", key: "tds_rows", icon: "Coins" },
  ],
  summarySelect:
    "COUNT(*) total_rows, " +
    "COALESCE(SUM(status='Active'),0) active_rows, " +
    "COALESCE(SUM(gst_verification_status='Verified'),0) verified_rows, " +
    "COALESCE(SUM(tds_applicable=1),0) tds_rows",
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

// ---------------------------------------------------------------------------
// 11. Journal Entries — double-entry vouchers (JE-#### id, editable)
// ---------------------------------------------------------------------------
const ACCOUNT_GROUPS = ["Asset", "Liability", "Equity", "Income", "Expense"]
const VOUCHER_TYPES = ["Journal", "Payment", "Receipt", "Contra", "Sales", "Purchase"]
const SOURCE_MODULES = ["Manual", "Sales Invoices", "Purchase Bills", "Expenses", "FTE Invoices", "Freelance Invoices", "Bank Transactions", "GST Filing", "TDS Filing"]

const journalEntries: ModuleConfig = {
  key: "journal-entries",
  table: "journal_entries",
  label: "Journal Entries",
  subtitle: "Finance management",
  addLabel: "New journal entry",
  idColumn: "journal_entry_id",
  idPrefix: "JE",
  editableId: true,
  dateColumn: "journal_date",
  financialYearColumn: "financial_year",
  statusColumn: "approval_status",
  searchColumns: ["journal_entry_id", "reference_no", "account_name", "party_name", "project_name", "narration"],
  fields: [
    fld("Entry", "journal_entry_id", "Journal Entry ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Entry", "journal_date", "Journal date", "date", { required: true }),
    fld("Entry", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Entry", "reference_type", "Reference type", "select", { options: ["Manual", "System", "Adjustment", "Opening", "Closing"], optional: true }),
    fld("Entry", "reference_no", "Reference no.", "text"),
    fld("Entry", "voucher_type", "Voucher type", "select", { options: VOUCHER_TYPES, optional: true }),
    fld("Entry", "narration", "Narration", "textarea"),
    fld("Account", "account_id", "Account ID", "text"),
    fld("Account", "account_name", "Account name", "text", { required: true }),
    fld("Account", "account_group", "Account group", "select", { options: ACCOUNT_GROUPS, optional: true }),
    fld("Account", "account_type", "Account type", "text"),
    fld("Parties & project", "party_id", "Party ID", "text"),
    fld("Parties & project", "party_name", "Party name", "text"),
    fld("Parties & project", "project_id", "Project ID", "text"),
    fld("Parties & project", "project_name", "Project name", "text"),
    fld("Amounts", "debit", "Debit", "number"),
    fld("Amounts", "credit", "Credit", "number"),
    fld("Amounts", "net_amount", "Net amount", "number", { computed: true, money: true }),
    fld("Amounts", "gst_amount", "GST amount", "number"),
    fld("Amounts", "tds_amount", "TDS amount", "number"),
    fld("Payment", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Payment", "cheque_utr_reference", "Cheque / UTR / reference", "text"),
    fld("Source & approval", "source_module", "Source module", "select", { options: SOURCE_MODULES, optional: true }),
    fld("Source & approval", "source_reference", "Source reference", "text"),
    fld("Source & approval", "approval_status", "Approval status", "select", { options: ["Pending", "Approved", "Rejected"] }),
    fld("Source & approval", "approved_by", "Approved by", "text"),
    fld("Source & approval", "posting_status", "Posting status", "select", { options: ["Unposted", "Posted"] }),
    fld("Source & approval", "posting_date", "Posting date", "date"),
  ],
  compute: (v) => {
    const debit = round2(num(v.debit)), credit = round2(num(v.credit))
    return {
      debit, credit, net_amount: round2(debit - credit),
      financial_year: v.financial_year || financialYearFor(v.journal_date),
    }
  },
  tableColumns: [
    { key: "journal_entry_id", label: "Journal Entry ID", mono: true },
    { key: "journal_date", label: "Date" },
    { key: "account_name", label: "Account", sub: "account_group" },
    { key: "voucher_type", label: "Voucher" },
    { key: "debit", label: "Debit", align: "right", money: true },
    { key: "credit", label: "Credit", align: "right", money: true },
    { key: "approval_status", label: "Approval", badge: { Approved: "default", Pending: "secondary", Rejected: "destructive" } },
    { key: "posting_status", label: "Posting", badge: { Posted: "default", Unposted: "outline" } },
  ],
  kpis: [
    { label: "Total Debit", key: "total_debit", money: true, icon: "Coins" },
    { label: "Total Credit", key: "total_credit", money: true, icon: "Wallet" },
    { label: "Net Amount", key: "net_amount", money: true, icon: "ArrowLeftRight" },
    { label: "Entries", key: "total_rows", icon: "BookOpen" },
  ],
  summarySelect:
    "COALESCE(SUM(debit),0) total_debit, COALESCE(SUM(credit),0) total_credit, COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) net_amount, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 12. General Ledger — posted ledger lines with running balance (GL-#### id)
// ---------------------------------------------------------------------------
const generalLedger: ModuleConfig = {
  key: "general-ledger",
  table: "general_ledger",
  label: "General Ledger",
  subtitle: "Finance management",
  addLabel: "New ledger entry",
  idColumn: "ledger_id",
  idPrefix: "GL",
  editableId: true,
  dateColumn: "transaction_date",
  financialYearColumn: "financial_year",
  statusColumn: "reconciliation_status",
  searchColumns: ["ledger_id", "reference_no", "account_name", "party_name", "project_name", "description"],
  fields: [
    fld("Entry", "ledger_id", "Ledger ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Entry", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Entry", "transaction_date", "Transaction date", "date", { required: true }),
    fld("Entry", "value_date", "Value date", "date"),
    fld("Entry", "month", "Month", "select", { options: MONTHS, optional: true }),
    fld("Account", "account_id", "Account ID", "text"),
    fld("Account", "account_name", "Account name", "text", { required: true }),
    fld("Account", "account_group", "Account group", "select", { options: ACCOUNT_GROUPS, optional: true }),
    fld("Account", "account_type", "Account type", "text"),
    fld("Transaction", "transaction_type", "Transaction type", "select", { options: ["Debit", "Credit", "Journal", "Opening", "Contra"], optional: true }),
    fld("Transaction", "voucher_type", "Voucher type", "select", { options: VOUCHER_TYPES, optional: true }),
    fld("Transaction", "reference_no", "Reference no.", "text"),
    fld("Parties & project", "party_id", "Party ID", "text"),
    fld("Parties & project", "party_name", "Party name", "text"),
    fld("Parties & project", "project_id", "Project ID", "text"),
    fld("Parties & project", "project_name", "Project name", "text"),
    fld("Parties & project", "description", "Description", "textarea"),
    fld("Amounts", "debit", "Debit", "number"),
    fld("Amounts", "credit", "Credit", "number"),
    fld("Amounts", "amount", "Amount", "number", { computed: true, money: true }),
    fld("Amounts", "gst_amount", "GST amount", "number"),
    fld("Amounts", "tds_amount", "TDS amount", "number"),
    fld("Amounts", "balance", "Balance", "number"),
    fld("Amounts", "balance_type", "Balance type", "select", { options: ["Debit", "Credit"], optional: true }),
    fld("Payment & reconciliation", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Payment & reconciliation", "cheque_utr_reference", "Cheque / UTR / reference", "text"),
    fld("Payment & reconciliation", "source_module", "Source module", "select", { options: SOURCE_MODULES, optional: true }),
    fld("Payment & reconciliation", "source_reference", "Source reference", "text"),
    fld("Payment & reconciliation", "reconciliation_status", "Reconciliation status", "select", { options: ["Unreconciled", "Reconciled", "Pending"] }),
    fld("Payment & reconciliation", "reconciliation_date", "Reconciliation date", "date"),
    fld("Payment & reconciliation", "journal_entry_id", "Journal entry ID", "text"),
    fld("Payment & reconciliation", "attachment_link", "Attachment / document link", "text"),
  ],
  compute: (v) => {
    const debit = round2(num(v.debit)), credit = round2(num(v.credit))
    return {
      debit, credit, amount: round2(credit > 0 ? credit : debit),
      financial_year: v.financial_year || financialYearFor(v.transaction_date),
    }
  },
  tableColumns: [
    { key: "ledger_id", label: "Ledger ID", mono: true },
    { key: "transaction_date", label: "Date" },
    { key: "account_name", label: "Account", sub: "account_group" },
    { key: "debit", label: "Debit", align: "right", money: true },
    { key: "credit", label: "Credit", align: "right", money: true },
    { key: "balance", label: "Balance", align: "right", money: true },
    { key: "reconciliation_status", label: "Reconciliation", badge: { Reconciled: "default", Pending: "secondary", Unreconciled: "outline" } },
  ],
  kpis: [
    { label: "Total Debit", key: "total_debit", money: true, icon: "Coins" },
    { label: "Total Credit", key: "total_credit", money: true, icon: "Wallet" },
    { label: "Net Movement", key: "net_movement", money: true, icon: "TrendingUp" },
    { label: "Entries", key: "total_rows", icon: "BookOpen" },
  ],
  summarySelect:
    "COALESCE(SUM(debit),0) total_debit, COALESCE(SUM(credit),0) total_credit, COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) net_movement, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 13. Credit Notes — issued against sales invoices (CN-#### id)
// ---------------------------------------------------------------------------
const creditNotes: ModuleConfig = {
  key: "credit-notes",
  table: "credit_notes",
  label: "Credit Notes",
  subtitle: "Finance management",
  addLabel: "New credit note",
  idColumn: "credit_note_id",
  idPrefix: "CN",
  editableId: true,
  dateColumn: "note_date",
  financialYearColumn: "financial_year",
  statusColumn: "status",
  searchColumns: ["credit_note_id", "client_name", "original_invoice_no", "project_name", "reason", "description"],
  fields: [
    fld("Credit note", "credit_note_id", "Credit note ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Credit note", "note_date", "Note date", "date", { required: true }),
    fld("Credit note", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Credit note", "original_invoice_no", "Original invoice no.", "text"),
    fld("Credit note", "reason", "Reason", "select", { options: ["Sales Return", "Rate Difference", "Discount", "Cancellation", "Damaged Goods", "Other"], optional: true }),
    fld("Party", "client_id", "Client ID", "text"),
    fld("Party", "client_name", "Client name", "text", { required: true }),
    fld("Party", "project_id", "Project ID", "text"),
    fld("Party", "project_name", "Project name", "text"),
    fld("Party", "description", "Description", "textarea"),
    fld("Line & tax", "hsn_sac", "HSN / SAC", "text"),
    fld("Line & tax", "quantity", "Quantity", "number"),
    fld("Line & tax", "unit", "Unit", "select", { options: UNITS, optional: true }),
    fld("Line & tax", "rate", "Rate", "number"),
    fld("Line & tax", "discount", "Discount", "number"),
    fld("Line & tax", "taxable_amount", "Taxable amount", "number", { placeholder: "auto from qty × rate" }),
    fld("Line & tax", "cgst_percent", "CGST %", "number"),
    fld("Line & tax", "sgst_percent", "SGST %", "number"),
    fld("Line & tax", "igst_percent", "IGST %", "number"),
    fld("Line & tax", "other_tax_cess", "Other tax / cess", "number"),
    fld("Line & tax", "cgst_amount", "CGST amount", "number", { computed: true, money: true }),
    fld("Line & tax", "sgst_amount", "SGST amount", "number", { computed: true, money: true }),
    fld("Line & tax", "igst_amount", "IGST amount", "number", { computed: true, money: true }),
    fld("Line & tax", "credit_note_total", "Credit note total", "number", { computed: true, money: true }),
    fld("Adjustment", "adjusted_amount", "Adjusted amount", "number"),
    fld("Adjustment", "balance_amount", "Balance amount", "number", { computed: true, money: true }),
    fld("Adjustment", "adjustment_status", "Adjustment status", "select", { options: ["Open", "Partially Adjusted", "Adjusted", "Refunded"], optional: true }),
    fld("Adjustment", "refund_date", "Refund date", "date"),
    fld("Adjustment", "refund_reference", "Refund reference", "text"),
    fld("Status", "status", "Status", "select", { options: ["Draft", "Issued", "Cancelled"] }),
    fld("Status", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const qty = num(v.quantity), rate = num(v.rate), discount = num(v.discount)
    const base = qty > 0 && rate > 0 ? qty * rate : num(v.taxable_amount) + discount
    const taxable = round2(Math.max(base - discount, 0))
    const cgst = round2((taxable * num(v.cgst_percent)) / 100)
    const sgst = round2((taxable * num(v.sgst_percent)) / 100)
    const igst = round2((taxable * num(v.igst_percent)) / 100)
    const cess = round2(num(v.other_tax_cess))
    const total = round2(taxable + cgst + sgst + igst + cess)
    const adjusted = round2(num(v.adjusted_amount))
    return {
      taxable_amount: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, other_tax_cess: cess,
      credit_note_total: total, adjusted_amount: adjusted, balance_amount: round2(total - adjusted),
      financial_year: v.financial_year || financialYearFor(v.note_date),
    }
  },
  tableColumns: [
    { key: "credit_note_id", label: "Credit Note ID", mono: true },
    { key: "note_date", label: "Date" },
    { key: "client_name", label: "Client", sub: "original_invoice_no" },
    { key: "credit_note_total", label: "Total", align: "right", money: true },
    { key: "balance_amount", label: "Balance", align: "right", money: true },
    { key: "adjustment_status", label: "Adjustment", badge: { Adjusted: "default", "Partially Adjusted": "secondary", Refunded: "default", Open: "outline" } },
    { key: "status", label: "Status", badge: { Issued: "default", Draft: "secondary", Cancelled: "destructive" } },
  ],
  kpis: [
    { label: "Total Credit", key: "total_credit", money: true, icon: "Receipt" },
    { label: "Adjusted", key: "total_adjusted", money: true, icon: "Wallet" },
    { label: "Balance", key: "total_balance", money: true, icon: "Clock" },
    { label: "Notes", key: "total_rows", icon: "FileText" },
  ],
  summarySelect:
    "COALESCE(SUM(credit_note_total),0) total_credit, COALESCE(SUM(adjusted_amount),0) total_adjusted, COALESCE(SUM(balance_amount),0) total_balance, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 14. Payments — inbound / outbound settlement ledger (PAY-#### id)
// ---------------------------------------------------------------------------
const payments: ModuleConfig = {
  key: "payments",
  table: "payments",
  label: "Payments",
  subtitle: "Finance management",
  addLabel: "New payment",
  idColumn: "payment_id",
  idPrefix: "PAY",
  editableId: true,
  dateColumn: "payment_date",
  financialYearColumn: "financial_year",
  statusColumn: "status",
  searchColumns: ["payment_id", "party_name", "reference_no", "project_name", "cheque_utr_reference"],
  fields: [
    fld("Payment", "payment_id", "Payment ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Payment", "payment_date", "Payment date", "date", { required: true }),
    fld("Payment", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Payment", "payment_direction", "Direction", "select", { options: ["Inbound", "Outbound"] }),
    fld("Payment", "party_type", "Party type", "select", { options: ["Customer", "Vendor", "Employee", "Freelancer", "Other"], optional: true }),
    fld("Payment", "party_id", "Party ID", "text"),
    fld("Payment", "party_name", "Party name", "text", { required: true }),
    fld("Reference", "reference_type", "Reference type", "select", { options: ["Invoice", "Purchase Bill", "Advance", "Expense", "Credit Note", "Order", "Other"], optional: true }),
    fld("Reference", "reference_no", "Reference no.", "text"),
    fld("Reference", "project_id", "Project ID", "text"),
    fld("Reference", "project_name", "Project name", "text"),
    fld("Amount", "payment_mode", "Payment mode", "select", { options: PAYMENT_MODES, optional: true }),
    fld("Amount", "bank_cash_account", "Bank / Cash account", "text"),
    fld("Amount", "amount", "Amount", "number", { required: true }),
    fld("Amount", "tds_deducted", "TDS deducted", "number"),
    fld("Amount", "other_charges", "Other charges", "number"),
    fld("Amount", "net_amount", "Net amount", "number", { computed: true, money: true }),
    fld("Amount", "currency", "Currency", "select", { options: CURRENCIES, optional: true }),
    fld("Amount", "exchange_rate", "Exchange rate", "number"),
    fld("Settlement", "cheque_utr_reference", "Cheque / UTR reference", "text"),
    fld("Settlement", "clearance_date", "Clearance date", "date"),
    fld("Settlement", "status", "Status", "select", { options: ["Pending", "Cleared", "Bounced", "Cancelled"] }),
    fld("Settlement", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const amount = round2(num(v.amount))
    const tds = round2(num(v.tds_deducted))
    const charges = round2(num(v.other_charges))
    return {
      amount, tds_deducted: tds, other_charges: charges,
      net_amount: round2(amount - tds - charges),
      financial_year: v.financial_year || financialYearFor(v.payment_date),
    }
  },
  tableColumns: [
    { key: "payment_id", label: "Payment ID", mono: true },
    { key: "payment_date", label: "Date" },
    { key: "party_name", label: "Party", sub: "reference_no" },
    { key: "payment_direction", label: "Direction", badge: { Inbound: "default", Outbound: "secondary" } },
    { key: "net_amount", label: "Net Amount", align: "right", money: true },
    { key: "payment_mode", label: "Mode" },
    { key: "status", label: "Status", badge: { Cleared: "default", Pending: "secondary", Bounced: "destructive", Cancelled: "outline" } },
  ],
  kpis: [
    { label: "Inbound", key: "total_inbound", money: true, icon: "TrendingUp" },
    { label: "Outbound", key: "total_outbound", money: true, icon: "ArrowLeftRight" },
    { label: "Net Flow", key: "net_flow", money: true, icon: "Wallet" },
    { label: "Payments", key: "total_rows", icon: "CreditCard" },
  ],
  summarySelect:
    "COALESCE(SUM(CASE WHEN payment_direction='Inbound' THEN net_amount ELSE 0 END),0) total_inbound, COALESCE(SUM(CASE WHEN payment_direction='Outbound' THEN net_amount ELSE 0 END),0) total_outbound, COALESCE(SUM(CASE WHEN payment_direction='Inbound' THEN net_amount ELSE -net_amount END),0) net_flow, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 15. Proposals & Estimates — pre-sales quotes (PRO-#### id)
// ---------------------------------------------------------------------------
const proposals: ModuleConfig = {
  key: "proposals",
  table: "proposals",
  label: "Proposals & Estimates",
  subtitle: "Finance management",
  addLabel: "New proposal",
  idColumn: "proposal_id",
  idPrefix: "PRO",
  editableId: true,
  dateColumn: "proposal_date",
  financialYearColumn: "financial_year",
  statusColumn: "stage",
  searchColumns: ["proposal_id", "client_name", "title", "project_name", "description"],
  fields: [
    fld("Proposal", "proposal_id", "Proposal ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Proposal", "proposal_date", "Proposal date", "date", { required: true }),
    fld("Proposal", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Proposal", "valid_till", "Valid till", "date"),
    fld("Proposal", "title", "Title", "text", { required: true }),
    fld("Party", "client_id", "Client ID", "text"),
    fld("Party", "client_name", "Client name", "text", { required: true }),
    fld("Party", "project_id", "Project ID", "text"),
    fld("Party", "project_name", "Project name", "text"),
    fld("Party", "owner", "Owner", "text"),
    fld("Party", "description", "Description", "textarea"),
    fld("Amounts", "currency", "Currency", "select", { options: CURRENCIES, optional: true }),
    fld("Amounts", "subtotal", "Subtotal", "number"),
    fld("Amounts", "discount", "Discount", "number"),
    fld("Amounts", "tax_percent", "Tax %", "number"),
    fld("Amounts", "tax_amount", "Tax amount", "number", { computed: true, money: true }),
    fld("Amounts", "grand_total", "Grand total", "number", { computed: true, money: true }),
    fld("Status", "stage", "Stage", "select", { options: ["Draft", "Sent", "Under Review", "Accepted", "Rejected", "Expired"] }),
    fld("Status", "acceptance_date", "Acceptance date", "date"),
    fld("Status", "converted_invoice_no", "Converted invoice no.", "text"),
    fld("Status", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const subtotal = round2(num(v.subtotal))
    const discount = round2(num(v.discount))
    const taxable = Math.max(subtotal - discount, 0)
    const tax = round2((taxable * num(v.tax_percent)) / 100)
    return {
      subtotal, discount, tax_amount: tax, grand_total: round2(taxable + tax),
      financial_year: v.financial_year || financialYearFor(v.proposal_date),
    }
  },
  tableColumns: [
    { key: "proposal_id", label: "Proposal ID", mono: true },
    { key: "proposal_date", label: "Date" },
    { key: "client_name", label: "Client", sub: "title" },
    { key: "grand_total", label: "Grand Total", align: "right", money: true },
    { key: "valid_till", label: "Valid Till" },
    { key: "stage", label: "Stage", badge: { Accepted: "default", Sent: "secondary", "Under Review": "secondary", Draft: "outline", Rejected: "destructive", Expired: "destructive" } },
  ],
  kpis: [
    { label: "Total Value", key: "total_value", money: true, icon: "FileText" },
    { label: "Accepted Value", key: "accepted_value", money: true, icon: "TrendingUp" },
    { label: "Open Value", key: "open_value", money: true, icon: "Clock" },
    { label: "Proposals", key: "total_rows", icon: "BookOpen" },
  ],
  summarySelect:
    "COALESCE(SUM(grand_total),0) total_value, COALESCE(SUM(CASE WHEN stage='Accepted' THEN grand_total ELSE 0 END),0) accepted_value, COALESCE(SUM(CASE WHEN stage IN ('Draft','Sent','Under Review') THEN grand_total ELSE 0 END),0) open_value, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 16. Orders — sales / purchase orders (ORD-#### id). Powers the top-level
// Orders module via the shared config-driven CRUD engine.
// ---------------------------------------------------------------------------
const orders: ModuleConfig = {
  key: "orders",
  table: "orders",
  label: "Orders",
  subtitle: "Order management",
  addLabel: "New order",
  idColumn: "order_id",
  idPrefix: "ORD",
  editableId: true,
  dateColumn: "order_date",
  financialYearColumn: "financial_year",
  statusColumn: "fulfillment_status",
  searchColumns: ["order_id", "party_name", "reference_no", "project_name", "item_summary"],
  fields: [
    fld("Order", "order_id", "Order ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Order", "order_date", "Order date", "date", { required: true }),
    fld("Order", "financial_year", "Financial year", "text", { placeholder: "2026-27" }),
    fld("Order", "order_type", "Order type", "select", { options: ["Sales Order", "Purchase Order", "Service Order"] }),
    fld("Order", "reference_no", "Reference no.", "text"),
    fld("Party", "party_type", "Party type", "select", { options: ["Customer", "Vendor"], optional: true }),
    fld("Party", "party_id", "Party ID", "text"),
    fld("Party", "party_name", "Party name", "text", { required: true }),
    fld("Party", "project_id", "Project ID", "text"),
    fld("Party", "project_name", "Project name", "text"),
    fld("Items", "item_summary", "Item summary", "textarea"),
    fld("Items", "quantity", "Quantity", "number"),
    fld("Items", "unit", "Unit", "select", { options: UNITS, optional: true }),
    fld("Items", "rate", "Rate", "number"),
    fld("Items", "subtotal", "Subtotal", "number", { placeholder: "auto from qty × rate" }),
    fld("Items", "discount", "Discount", "number"),
    fld("Items", "tax_percent", "Tax %", "number"),
    fld("Items", "tax_amount", "Tax amount", "number", { computed: true, money: true }),
    fld("Items", "total_amount", "Total amount", "number", { computed: true, money: true }),
    fld("Fulfillment & payment", "expected_date", "Expected date", "date"),
    fld("Fulfillment & payment", "delivery_date", "Delivery date", "date"),
    fld("Fulfillment & payment", "fulfillment_status", "Fulfillment status", "select", { options: ["Pending", "Processing", "Shipped", "Delivered", "Cancelled"] }),
    fld("Fulfillment & payment", "amount_received", "Amount received", "number"),
    fld("Fulfillment & payment", "outstanding_amount", "Outstanding amount", "number", { computed: true, money: true }),
    fld("Fulfillment & payment", "payment_status", "Payment status", "select", { options: PAYMENT_STATUSES, optional: true, emptyLabel: "Auto" }),
    fld("Fulfillment & payment", "notes", "Notes", "textarea"),
  ],
  compute: (v) => {
    const qty = num(v.quantity), rate = num(v.rate), discount = num(v.discount)
    const base = qty > 0 && rate > 0 ? qty * rate : num(v.subtotal)
    const subtotal = round2(base)
    const taxable = Math.max(subtotal - discount, 0)
    const tax = round2((taxable * num(v.tax_percent)) / 100)
    const total = round2(taxable + tax)
    const received = round2(num(v.amount_received))
    return {
      subtotal, tax_amount: tax, total_amount: total,
      amount_received: received, outstanding_amount: round2(total - received),
      payment_status: autoPaymentStatus(total, received, v.payment_status),
      financial_year: v.financial_year || financialYearFor(v.order_date),
    }
  },
  tableColumns: [
    { key: "order_id", label: "Order ID", mono: true },
    { key: "order_date", label: "Date" },
    { key: "party_name", label: "Party", sub: "order_type" },
    { key: "total_amount", label: "Total", align: "right", money: true },
    { key: "outstanding_amount", label: "Outstanding", align: "right", money: true },
    { key: "fulfillment_status", label: "Fulfillment", badge: { Delivered: "default", Shipped: "secondary", Processing: "secondary", Pending: "outline", Cancelled: "destructive" } },
    { key: "payment_status", label: "Payment", badge: { ...PAYMENT_BADGE } },
  ],
  kpis: [
    { label: "Order Value", key: "total_value", money: true, icon: "Receipt" },
    { label: "Received", key: "total_received", money: true, icon: "Wallet" },
    { label: "Outstanding", key: "total_outstanding", money: true, icon: "Clock" },
    { label: "Orders", key: "total_rows", icon: "FileText" },
  ],
  summarySelect:
    "COALESCE(SUM(total_amount),0) total_value, COALESCE(SUM(amount_received),0) total_received, COALESCE(SUM(outstanding_amount),0) total_outstanding, COUNT(*) total_rows",
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
  "journal-entries": journalEntries,
  "general-ledger": generalLedger,
  "credit-notes": creditNotes,
  "payments": payments,
  "proposals": proposals,
  "orders": orders,
}
