import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Chart-of-accounts resolver (server-only).
//
// The posting engine works in terms of stable *roles* (receivable, sales,
// output CGST, ...) rather than hard-coded account ids. Each role maps to a
// default account_code that is seeded by the 2026-09-13 migration. A company
// may create its own account with the same code — the resolver always prefers
// the live chart_of_accounts row, so postings follow the company's own ledger.
// ---------------------------------------------------------------------------

export type AccountRole =
  | "receivable"
  | "tds_receivable"
  | "sales"
  | "output_cgst"
  | "output_sgst"
  | "output_igst"
  | "output_cess"
  | "bank"
  | "cash"
  // Purchase-side roles (Phase 33 — purchase bill posting).
  | "purchase"
  | "input_cgst"
  | "input_sgst"
  | "input_igst"
  | "input_cess"
  | "payable"
  | "tds_payable"
  // Expense-side roles (Phases 9–11 — expense posting).
  | "expense"
  | "employee_payable"
  | "vendor_payable"
  | "employee_advance"

/** Default account_code for each posting role (matches the migration seed). */
export const ROLE_DEFAULT_CODE: Record<AccountRole, string> = {
  receivable: "1200",
  tds_receivable: "1450",
  sales: "4000",
  output_cgst: "2110",
  output_sgst: "2120",
  output_igst: "2130",
  output_cess: "2140",
  bank: "1000",
  cash: "1010",
  // Purchase-side defaults.
  purchase: "5000",
  input_cgst: "1410",
  input_sgst: "1420",
  input_igst: "1430",
  input_cess: "1440",
  payable: "2000",
  tds_payable: "2150",
  // Expense-side defaults. `expense` is the generic fallback head used only when
  // an expense has no explicit Chart-of-Accounts mapping of its own.
  expense: "5100",
  employee_payable: "2200",
  vendor_payable: "2000",
  employee_advance: "1460",
}

/**
 * The purchase-side accounts are not part of the original posting-audit
 * migration seed, so seed any that are missing before a purchase bill is
 * posted. Idempotent (guarded by NOT EXISTS on the code) and safe to re-run.
 */
type CoaSeed = {
  code: string
  id: string
  name: string
  group: string
  type: string
  nature: "Debit" | "Credit"
  gst?: boolean
  tds?: boolean
}

const PURCHASE_ACCOUNT_SEEDS: CoaSeed[] = [
  { code: "5000", id: "COA-PURCHASE", name: "Purchases / Expenses", group: "Expense", type: "Direct Expense", nature: "Debit" },
  { code: "1410", id: "COA-CGST-IN", name: "Input CGST", group: "Asset", type: "Current Asset", nature: "Debit", gst: true },
  { code: "1420", id: "COA-SGST-IN", name: "Input SGST", group: "Asset", type: "Current Asset", nature: "Debit", gst: true },
  { code: "1430", id: "COA-IGST-IN", name: "Input IGST", group: "Asset", type: "Current Asset", nature: "Debit", gst: true },
  { code: "1440", id: "COA-CESS-IN", name: "Input Cess", group: "Asset", type: "Current Asset", nature: "Debit", gst: true },
  { code: "2000", id: "COA-AP", name: "Accounts Payable", group: "Liability", type: "Current Liability", nature: "Credit" },
  { code: "2150", id: "COA-TDS-PAY", name: "TDS Payable", group: "Liability", type: "Duties & Taxes", nature: "Credit", tds: true },
]

/**
 * Expense-side accounts (Phases 9–11). The generic expense head, the
 * employee-reimbursement payable and the employee-advance asset are not in the
 * original migration seed, so seed any that are missing before an expense is
 * posted. Vendor expenses reuse the shared Accounts Payable (2000) and the
 * input-GST / TDS-payable accounts already seeded on the purchase side.
 */
const EXPENSE_ACCOUNT_SEEDS: CoaSeed[] = [
  { code: "5100", id: "COA-EXPENSE", name: "General Expenses", group: "Expense", type: "Indirect Expense", nature: "Debit" },
  { code: "2200", id: "COA-EMP-PAY", name: "Employee Reimbursements Payable", group: "Liability", type: "Current Liability", nature: "Credit" },
  { code: "1460", id: "COA-EMP-ADV", name: "Employee Advances", group: "Asset", type: "Current Asset", nature: "Debit" },
]

async function seedAccounts(seeds: CoaSeed[]): Promise<void> {
  for (const a of seeds) {
    await query(
      `INSERT INTO chart_of_accounts
         (account_id, account_code, account_name, account_group, account_type, nature,
          bank_cash_account, gst_applicable, tds_applicable, active_status)
       SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, 'Active' FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = ?)`,
      [a.id, a.code, a.name, a.group, a.type, a.nature, a.gst ? 1 : 0, a.tds ? 1 : 0, a.code],
    )
  }
}

let purchaseAccountsEnsured = false

export async function ensurePurchasePostingAccounts(): Promise<void> {
  if (purchaseAccountsEnsured) return
  await seedAccounts(PURCHASE_ACCOUNT_SEEDS)
  purchaseAccountsEnsured = true
}

let expenseAccountsEnsured = false

export async function ensureExpensePostingAccounts(): Promise<void> {
  if (expenseAccountsEnsured) return
  // Expenses reuse the purchase-side input-GST / AP / TDS accounts, so ensure
  // both seed sets are present.
  await seedAccounts(PURCHASE_ACCOUNT_SEEDS)
  await seedAccounts(EXPENSE_ACCOUNT_SEEDS)
  expenseAccountsEnsured = true
}

/** Resolve a live Chart-of-Accounts row by its `account_id` (explicit head). */
export async function resolveAccountById(accountId: string): Promise<ResolvedAccount | null> {
  if (!accountId) return null
  const rows = (await query(
    `SELECT account_id, account_code, account_name, account_group, account_type, nature
       FROM chart_of_accounts
      WHERE account_id = ?
      ORDER BY (active_status = 'Active') DESC, id ASC
      LIMIT 1`,
    [accountId],
  )) as any[]
  const row = rows?.[0]
  if (!row) return null
  return {
    account_id: row.account_id,
    account_code: row.account_code ?? null,
    account_name: row.account_name ?? accountId,
    account_group: row.account_group ?? null,
    account_type: row.account_type ?? null,
    nature: row.nature ?? null,
  }
}

export type ResolvedAccount = {
  account_id: string
  account_code: string | null
  account_name: string
  account_group: string | null
  account_type: string | null
  nature: string | null
}

/**
 * Resolve a posting role to a live chart_of_accounts row by its default code.
 * Prefers Active accounts; throws a clear error when the account is missing so
 * a posting can never silently target a non-existent ledger.
 */
export async function resolveAccount(role: AccountRole): Promise<ResolvedAccount> {
  const code = ROLE_DEFAULT_CODE[role]
  const rows = (await query(
    `SELECT account_id, account_code, account_name, account_group, account_type, nature
       FROM chart_of_accounts
      WHERE account_code = ?
      ORDER BY (active_status = 'Active') DESC, id ASC
      LIMIT 1`,
    [code],
  )) as any[]
  const row = rows?.[0]
  if (!row) {
    throw new Error(
      `Chart of Accounts is missing account code ${code} (role "${role}"). ` +
        `Run the 2026-09-13-add-finance-posting-audit.sql migration or create the account.`,
    )
  }
  return {
    account_id: row.account_id,
    account_code: row.account_code ?? null,
    account_name: row.account_name ?? String(role),
    account_group: row.account_group ?? null,
    account_type: row.account_type ?? null,
    nature: row.nature ?? null,
  }
}

/** True when an account's natural balance sits on the debit side. */
export function isDebitNature(account: Pick<ResolvedAccount, "account_group" | "nature">): boolean {
  if (account.nature) return account.nature.toLowerCase() === "debit"
  const g = (account.account_group || "").toLowerCase()
  return g === "asset" || g === "expense"
}
