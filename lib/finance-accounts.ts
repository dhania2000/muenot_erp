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
  // Net GST settlement control head (Phase 11 — GST payment accounting). The
  // per-head output accounts (2110–2140) accumulate the tax charged on sales;
  // this single "GST Payable" head is where a period's net cash payment to the
  // government is debited against Bank/Cash, so a payment never double-touches
  // the individual output-tax heads that the sales postings already own.
  | "gst_payable"
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
  // Opening-balance contra (requirements 14/15 — real opening-balance posting).
  | "opening_balance_equity"
  // Balance-sheet register roles (Fixed Assets, Loans & Advances, Investments,
  // Provisions & Accruals, Capital & Equity). Each register document posts a
  // balanced two-leg voucher against one of these control heads and a funding
  // contra (bank / cash / payable / capital), so the Balance Sheet, Trial
  // Balance and the Fixed Assets Register reflect it automatically.
  | "fixed_asset"
  | "accumulated_depreciation"
  | "depreciation_expense"
  | "loan_receivable"
  | "loan_payable"
  | "investment"
  | "provision_expense"
  | "provision_liability"
  | "share_capital"
  | "drawings"
  // Fixed-asset disposal result heads (Phase 3 — Fixed Assets lifecycle). A
  // disposal / scrap removes the asset at cost, unwinds its accumulated
  // depreciation and books the difference against proceeds as a gain (income)
  // or loss (expense) on sale of assets.
  | "disposal_gain"
  | "disposal_loss"
  // Investment income (interest / dividend), realised gain / loss on sale or
  // redemption, and downward fair-value / impairment loss on investments.
  | "investment_income"
  | "investment_gain"
  | "investment_loss"
  | "investment_impairment"

/** Default account_code for each posting role (matches the migration seed). */
export const ROLE_DEFAULT_CODE: Record<AccountRole, string> = {
  receivable: "1200",
  tds_receivable: "1450",
  sales: "4000",
  output_cgst: "2110",
  output_sgst: "2120",
  output_igst: "2130",
  output_cess: "2140",
  gst_payable: "2160",
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
  // Equity control head that balances every opening-balance voucher.
  opening_balance_equity: "3900",
  // Balance-sheet register control heads.
  fixed_asset: "1700",
  accumulated_depreciation: "1710",
  depreciation_expense: "5200",
  loan_receivable: "1480",
  loan_payable: "2300",
  investment: "1600",
  provision_expense: "5300",
  provision_liability: "2400",
  share_capital: "3000",
  drawings: "3100",
  // Gain / loss on sale of fixed assets.
  disposal_gain: "4200",
  disposal_loss: "5210",
  // Investment income and realised / unrealised gain-loss heads.
  investment_income: "4300",
  investment_gain: "4310",
  investment_loss: "5310",
  investment_impairment: "5320",
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

/**
 * GST payment control head (Phase 11). Seeded on demand the first time a GST
 * payment is posted; a company that already has a 2160 account keeps its own.
 */
const GST_PAYMENT_ACCOUNT_SEEDS: CoaSeed[] = [
  { code: "2160", id: "COA-GST-PAY", name: "GST Payable (Net)", group: "Liability", type: "Duties & Taxes", nature: "Credit", gst: true },
]

/**
 * Balance-sheet register control heads. These back the Fixed Assets, Loans &
 * Advances, Investments, Provisions & Accruals and Capital & Equity modules.
 * Seeded on demand the first time one of those documents is posted; a company
 * that already keeps its own head at the same code keeps its own (the resolver
 * prefers the live chart_of_accounts row).
 */
const REGISTER_ACCOUNT_SEEDS: CoaSeed[] = [
  { code: "1700", id: "COA-FIXED-ASSET", name: "Fixed Assets", group: "Asset", type: "Fixed Asset", nature: "Debit" },
  { code: "1710", id: "COA-ACC-DEPR", name: "Accumulated Depreciation", group: "Asset", type: "Fixed Asset", nature: "Credit" },
  { code: "5200", id: "COA-DEPR-EXP", name: "Depreciation Expense", group: "Expense", type: "Indirect Expense", nature: "Debit" },
  { code: "1480", id: "COA-LOAN-RECV", name: "Loans & Advances (Asset)", group: "Asset", type: "Current Asset", nature: "Debit" },
  { code: "2300", id: "COA-LOAN-PAY", name: "Loans Payable", group: "Liability", type: "Long Term Liability", nature: "Credit" },
  { code: "1600", id: "COA-INVESTMENT", name: "Investments", group: "Asset", type: "Investment", nature: "Debit" },
  { code: "5300", id: "COA-PROV-EXP", name: "Provisions & Accruals Expense", group: "Expense", type: "Indirect Expense", nature: "Debit" },
  { code: "2400", id: "COA-PROV-LIAB", name: "Provisions & Accruals", group: "Liability", type: "Current Liability", nature: "Credit" },
  { code: "3000", id: "COA-CAPITAL", name: "Share Capital & Equity", group: "Equity", type: "Capital", nature: "Credit" },
  { code: "3100", id: "COA-DRAWINGS", name: "Drawings", group: "Equity", type: "Capital", nature: "Debit" },
]

/**
 * Fixed-asset disposal result heads (Phase 3). The gain head is an income
 * account (credit nature), the loss head an expense account (debit nature).
 * Seeded on demand the first time an asset is disposed / scrapped; a company
 * that already keeps its own head at the same code keeps its own.
 */
const FIXED_ASSET_DISPOSAL_SEEDS: CoaSeed[] = [
  { code: "4200", id: "COA-ASSET-GAIN", name: "Gain on Sale of Fixed Assets", group: "Income", type: "Indirect Income", nature: "Credit" },
  { code: "5210", id: "COA-ASSET-LOSS", name: "Loss on Sale of Fixed Assets", group: "Expense", type: "Indirect Expense", nature: "Debit" },
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

let gstPaymentAccountsEnsured = false

export async function ensureGstPaymentAccounts(): Promise<void> {
  if (gstPaymentAccountsEnsured) return
  await seedAccounts(GST_PAYMENT_ACCOUNT_SEEDS)
  gstPaymentAccountsEnsured = true
}

let registerAccountsEnsured = false

/**
 * Seed the balance-sheet register control heads (and the shared Accounts
 * Payable used as a funding contra) before a Fixed Asset / Loan / Investment /
 * Provision / Capital document is posted. Idempotent and safe to re-run.
 */
export async function ensureRegisterPostingAccounts(): Promise<void> {
  if (registerAccountsEnsured) return
  await seedAccounts(REGISTER_ACCOUNT_SEEDS)
  // Accounts Payable (2000) is a valid funding contra for asset acquisitions on
  // credit, so make sure the purchase-side heads exist too.
  await seedAccounts(PURCHASE_ACCOUNT_SEEDS)
  registerAccountsEnsured = true
}

let fixedAssetAccountsEnsured = false

/**
 * Seed every Chart-of-Accounts head the Fixed Assets lifecycle posts to: the
 * register control heads (Fixed Assets 1700, Accumulated Depreciation 1710,
 * Depreciation Expense 5200), the funding contras (bank / cash / payable) and
 * the disposal gain / loss heads. Idempotent and safe to re-run.
 */
export async function ensureFixedAssetAccounts(): Promise<void> {
  if (fixedAssetAccountsEnsured) return
  await ensureRegisterPostingAccounts()
  await seedAccounts(FIXED_ASSET_DISPOSAL_SEEDS)
  fixedAssetAccountsEnsured = true
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
    `SELECT account_id, account_code, account_name, account_group, account_type, nature, active_status
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
    active_status: row.active_status ?? null,
  }
}

export type ResolvedAccount = {
  account_id: string
  account_code: string | null
  account_name: string
  account_group: string | null
  account_type: string | null
  nature: string | null
  /** Lifecycle state — the posting engine refuses new postings unless Active. */
  active_status: string | null
}

/**
 * Resolve a posting role to a live chart_of_accounts row by its default code.
 * Prefers Active accounts; throws a clear error when the account is missing so
 * a posting can never silently target a non-existent ledger.
 */
export async function resolveAccount(role: AccountRole): Promise<ResolvedAccount> {
  const code = ROLE_DEFAULT_CODE[role]

  // Configuration-based mapping takes precedence over the seeded code default
  // (lib/finance-account-config.ts). When an admin has mapped this role to an
  // explicit account, resolve that account directly; otherwise fall through to
  // the code default so postings always land somewhere sensible.
  const { getRoleOverrideAccountId } = await import("@/lib/finance-account-config")
  const overrideId = await getRoleOverrideAccountId(role).catch(() => null)
  if (overrideId) {
    const overridden = await resolveAccountById(overrideId)
    if (overridden) return overridden
  }

  const rows = (await query(
    `SELECT account_id, account_code, account_name, account_group, account_type, nature, active_status
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
    active_status: row.active_status ?? null,
  }
}

/** True when an account's natural balance sits on the debit side. */
export function isDebitNature(account: Pick<ResolvedAccount, "account_group" | "nature">): boolean {
  if (account.nature) return account.nature.toLowerCase() === "debit"
  const g = (account.account_group || "").toLowerCase()
  return g === "asset" || g === "expense"
}
