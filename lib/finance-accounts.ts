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
