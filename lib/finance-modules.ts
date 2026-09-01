/**
 * Single source of truth for every Finance sub-module that shares the
 * generic finance_records table. Adding a module here automatically makes
 * it valid for the records API, the bulk Excel import API, and the
 * Finance Dashboard UI (sidebar label + add-record form).
 */
export const FINANCE_MODULES: Record<string, { label: string; prefix: string }> = {
  "sales-invoices": { label: "Sales Invoices", prefix: "INV" },
  "purchase-bills": { label: "Purchase Bills", prefix: "FIN" },
  "expenses": { label: "Expenses", prefix: "FIN" },
  "fte-invoices": { label: "FTE Invoices", prefix: "FIN" },
  "freelance-invoices": { label: "Freelance Invoices", prefix: "FIN" },
  "bank-transactions": { label: "Bank Transactions", prefix: "FIN" },
  "bank-cash": { label: "Bank & Cash", prefix: "FIN" },
  "chart-of-accounts": { label: "Chart of Accounts", prefix: "FIN" },
  "customers-vendors": { label: "Customer / Vendor", prefix: "FIN" },
  "gst-filing": { label: "GST Filing", prefix: "GST" },
  "tds-filing": { label: "TDS Filing", prefix: "TDS" },
  "journal-entries": { label: "Journal Entries", prefix: "JE" },
  "general-ledger": { label: "General Ledger", prefix: "GL" },
  "financial-reports": { label: "Financial Reports", prefix: "RPT" },
}

export const FINANCE_MODULE_KEYS = Object.keys(FINANCE_MODULES)

export function financeModulePrefix(moduleKey: string) {
  return FINANCE_MODULES[moduleKey]?.prefix || "FIN"
}
