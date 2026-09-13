/**
 * Expense-type taxonomy shared by the server engine (lib/finance-expenses.ts)
 * and the client-safe module config (lib/finance-module-configs.ts). Kept in a
 * dependency-free module — no "server-only" import — so both sides agree on the
 * exact strings that decide whether an expense is employee-borne or
 * vendor-borne. Changing a label here changes it everywhere.
 */

/** Expense types that are employee-borne (drive the employee snapshot + advance). */
export const EMPLOYEE_EXPENSE_TYPES = [
  "Employee Expense",
  "Reimbursement",
  "Petty Cash Expense",
  "Travel Expense",
] as const

/** Expense types that are vendor-borne (drive the vendor snapshot). */
export const VENDOR_EXPENSE_TYPES = ["Vendor Expense", "Business Expense", "Other"] as const

/** All expense types, in form-display order. */
export const ALL_EXPENSE_TYPES: string[] = [...EMPLOYEE_EXPENSE_TYPES, ...VENDOR_EXPENSE_TYPES]
