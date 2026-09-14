import "server-only"
import { query } from "@/lib/db"
import { ROLE_DEFAULT_CODE, type AccountRole } from "@/lib/finance-accounts"

// ---------------------------------------------------------------------------
// Configuration-based account mapping (server-only).
//
// The posting engine resolves stable *roles* (receivable, sales, output CGST,
// …) to a Chart-of-Accounts head. Historically the only mapping was the
// hard-coded `ROLE_DEFAULT_CODE` → account_code table in lib/finance-accounts.
// This adds a persisted, admin-editable override layer: a row in
// `finance_account_config` for a role points that role at an explicit
// account_id, and the resolver prefers it over the code default.
//
//   DB override (this table)  ─┐
//                              ├─►  resolveAccount(role)
//   ROLE_DEFAULT_CODE (code)  ─┘   (DB wins when present + points at an
//                                   Active account; otherwise fall back to the
//                                   seeded code so postings never break)
//
// One source of truth: both the technical "Account Mapping" screen and the
// friendlier "Company Defaults" screen write the same role rows here, so there
// is never a second, competing mapping to keep in sync.
// ---------------------------------------------------------------------------

let configTableEnsured = false

/** Self-healing schema for the mapping table. Runs once per process. */
export async function ensureAccountConfigTable(): Promise<void> {
  if (configTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS finance_account_config (
       id INT AUTO_INCREMENT PRIMARY KEY,
       config_type VARCHAR(30) NOT NULL DEFAULT 'role',
       config_key  VARCHAR(60) NOT NULL,
       account_id  VARCHAR(40) DEFAULT NULL,
       updated_by  INT DEFAULT NULL,
       updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_account_config (config_type, config_key)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  configTableEnsured = true
}

/** Every posting role that can be re-mapped, grouped for the UI. */
export const ACCOUNT_ROLE_GROUPS: { group: string; roles: { role: AccountRole; label: string }[] }[] = [
  {
    group: "Sales & Receivables",
    roles: [
      { role: "sales", label: "Sales Revenue" },
      { role: "receivable", label: "Accounts Receivable" },
      { role: "tds_receivable", label: "TDS Receivable" },
      { role: "output_cgst", label: "Output CGST" },
      { role: "output_sgst", label: "Output SGST" },
      { role: "output_igst", label: "Output IGST" },
      { role: "output_cess", label: "Output Cess" },
    ],
  },
  {
    group: "Purchases & Payables",
    roles: [
      { role: "purchase", label: "Purchases / Expenses" },
      { role: "payable", label: "Accounts Payable" },
      { role: "tds_payable", label: "TDS Payable" },
      { role: "input_cgst", label: "Input CGST" },
      { role: "input_sgst", label: "Input SGST" },
      { role: "input_igst", label: "Input IGST" },
      { role: "input_cess", label: "Input Cess" },
    ],
  },
  {
    group: "Expenses & Employees",
    roles: [
      { role: "expense", label: "General Expense head" },
      { role: "employee_payable", label: "Employee Reimbursements Payable" },
      { role: "vendor_payable", label: "Vendor Payable" },
      { role: "employee_advance", label: "Employee Advances" },
    ],
  },
  {
    group: "Bank, Cash & Equity",
    roles: [
      { role: "bank", label: "Default Bank" },
      { role: "cash", label: "Default Cash" },
      { role: "opening_balance_equity", label: "Opening Balance Equity" },
    ],
  },
]

/**
 * The friendly "Company Defaults" subset — the handful of heads most companies
 * care about day to day. These write the SAME role rows as the full mapping, so
 * the two screens can never disagree.
 */
export const COMPANY_DEFAULT_ROLES: { role: AccountRole; label: string; hint: string }[] = [
  { role: "bank", label: "Default Bank Account", hint: "Used when a document has no explicit bank selected." },
  { role: "cash", label: "Default Cash Account", hint: "Used for cash receipts and payments." },
  { role: "sales", label: "Default Sales Account", hint: "Revenue head for sales invoices." },
  { role: "purchase", label: "Default Purchase Account", hint: "Expense head for purchase bills." },
  { role: "expense", label: "Default Expense Account", hint: "Fallback head for expenses with no mapping." },
  { role: "receivable", label: "Default Receivable Control", hint: "Debtors control head." },
  { role: "payable", label: "Default Payable Control", hint: "Creditors control head." },
]

const ALL_ROLES = Object.keys(ROLE_DEFAULT_CODE) as AccountRole[]

export type RoleMappingRow = {
  role: AccountRole
  account_id: string | null
  /** The account currently in force (override if set + valid, else code default). */
  effective_account_id: string | null
  effective_account_code: string | null
  effective_account_name: string | null
  default_code: string
  /** True when the effective account comes from the DB override, not the code. */
  overridden: boolean
  active: boolean
}

/**
 * Resolve the effective account_id for a role, honouring the DB override when
 * it is present AND still points at an existing account. Returns null when
 * neither the override nor the default code resolves to a row (the caller's
 * hard resolver then throws a clear "missing account" error).
 */
export async function getRoleOverrideAccountId(role: AccountRole): Promise<string | null> {
  await ensureAccountConfigTable()
  const rows = (await query(
    `SELECT c.account_id
       FROM finance_account_config c
       JOIN chart_of_accounts a ON a.account_id = c.account_id
      WHERE c.config_type = 'role' AND c.config_key = ?
      LIMIT 1`,
    [role],
  )) as any[]
  return rows?.[0]?.account_id ? String(rows[0].account_id) : null
}

/** Load the full mapping table for the UI (all roles, override + effective). */
export async function getAccountMappings(): Promise<RoleMappingRow[]> {
  await ensureAccountConfigTable()
  const overrides = (await query(
    `SELECT config_key, account_id FROM finance_account_config WHERE config_type = 'role'`,
  )) as any[]
  const overrideByRole = new Map<string, string>()
  for (const o of overrides) if (o.account_id) overrideByRole.set(String(o.config_key), String(o.account_id))

  const codes = ALL_ROLES.map((r) => ROLE_DEFAULT_CODE[r])
  const overrideIds = Array.from(overrideByRole.values())

  // Resolve every default code and every override id in two batched lookups.
  const codeRows = codes.length
    ? ((await query(
        `SELECT account_id, account_code, account_name, active_status
           FROM chart_of_accounts
          WHERE account_code IN (${codes.map(() => "?").join(",")})`,
        codes,
      )) as any[])
    : []
  const idRows = overrideIds.length
    ? ((await query(
        `SELECT account_id, account_code, account_name, active_status
           FROM chart_of_accounts
          WHERE account_id IN (${overrideIds.map(() => "?").join(",")})`,
        overrideIds,
      )) as any[])
    : []

  const byCode = new Map<string, any>()
  for (const r of codeRows) if (!byCode.has(String(r.account_code))) byCode.set(String(r.account_code), r)
  const byId = new Map<string, any>()
  for (const r of idRows) byId.set(String(r.account_id), r)

  return ALL_ROLES.map((role) => {
    const defaultCode = ROLE_DEFAULT_CODE[role]
    const overrideId = overrideByRole.get(role) ?? null
    const overrideRow = overrideId ? byId.get(overrideId) : null
    const effective = overrideRow ?? byCode.get(defaultCode) ?? null
    return {
      role,
      account_id: overrideId,
      effective_account_id: effective ? String(effective.account_id) : null,
      effective_account_code: effective ? (effective.account_code ?? null) : null,
      effective_account_name: effective ? (effective.account_name ?? null) : null,
      default_code: defaultCode,
      overridden: Boolean(overrideRow),
      active: effective ? String(effective.active_status ?? "Active") === "Active" : false,
    }
  })
}

/**
 * Persist a role → account override. Passing a blank/null account_id clears the
 * override (the role falls back to its seeded default code). Validates that the
 * role is real and the account exists and is Active — a mapping must never
 * point the posting engine at a missing or archived head.
 */
export async function setRoleMapping(
  role: string,
  accountId: string | null,
  updatedBy: number | null,
): Promise<{ ok: boolean; error?: string }> {
  await ensureAccountConfigTable()
  if (!ALL_ROLES.includes(role as AccountRole)) {
    return { ok: false, error: `Unknown posting role "${role}".` }
  }
  const id = (accountId ?? "").toString().trim()
  if (!id) {
    await query(`DELETE FROM finance_account_config WHERE config_type = 'role' AND config_key = ?`, [role])
    return { ok: true }
  }
  const [acct] = (await query(
    `SELECT account_id, active_status FROM chart_of_accounts WHERE account_id = ? LIMIT 1`,
    [id],
  )) as any[]
  if (!acct) return { ok: false, error: "The selected account does not exist." }
  if (String(acct.active_status ?? "Active") !== "Active") {
    return { ok: false, error: "The selected account is not Active and cannot be mapped to a posting role." }
  }
  await query(
    `INSERT INTO finance_account_config (config_type, config_key, account_id, updated_by)
       VALUES ('role', ?, ?, ?)
     ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), updated_by = VALUES(updated_by)`,
    [role, id, updatedBy],
  )
  return { ok: true }
}
