import { query } from "@/lib/db"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { ensureRegisterPostingAccounts, ensureCapitalEquityAccounts, type AccountRole } from "@/lib/finance-accounts"
import { provisionKind } from "@/lib/finance-provisions"

// ---------------------------------------------------------------------------
// Balance-sheet register posting engine (server-only).
//
// The five transactional register modules — Fixed Assets, Loans & Advances,
// Investments, Provisions & Accruals and Capital & Equity — each turn a single
// document into a balanced two-leg voucher (Journal + General Ledger) through
// the shared posting engine. Money is read from the stored, server-owned row,
// never from the browser, and every posting is idempotent: a create posts, an
// amount change reverses-and-reposts, a draft/reversed/zero row unwinds, and a
// transient posting error leaves the row "Unposted" for the next save to retry.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Map a user-facing funding source to a posting role for the contra leg. */
function contraRole(source: string | null | undefined): AccountRole {
  switch (String(source || "").trim().toLowerCase()) {
    case "cash":
      return "cash"
    case "accounts payable":
    case "payable":
    case "on credit":
      return "payable"
    case "owner capital":
    case "capital":
    case "equity":
      return "share_capital"
    default:
      return "bank"
  }
}

/**
 * Map a user-facing equity head name (the Capital & Equity "Transfer from / to"
 * picker) to its posting role for the counter leg of an internal appropriation.
 */
function equityRole(name: string | null | undefined): AccountRole | null {
  const s = String(name || "").trim().toLowerCase()
  if (!s) return null
  if (s.includes("retained")) return "retained_earnings"
  if (s.includes("reserve")) return "reserves"
  if (s.includes("partner")) return "partner_capital"
  if (s.includes("drawing")) return "drawings"
  if (s.includes("adjust")) return "equity_adjustment"
  if (s.includes("share") || s.includes("capital") || s.includes("equity")) return "share_capital"
  return null
}

/** Statuses that must NOT hold an active posting for any register module. */
const UNPOSTABLE_STATUSES = new Set(["Reversed", "Cancelled", "Draft", "Written Off", "Void"])

type PostSpec = {
  /** Signed amount that drives the posting; <= 0 unwinds any prior voucher. */
  amount: number
  lines: PostingLine[]
  entityType: string
  voucherType: string
  narration: string
  sourceModule: string
  date: string
  financialYear: string | null
  partyId?: string | null
  partyName?: string | null
}

/**
 * Per-module definition: the table + business-key column, and a pure function
 * that turns a stored row into the balanced posting spec for that document.
 */
type RegisterModule = {
  table: string
  idColumn: string
  build: (row: Record<string, any>) => PostSpec
}

const today = () => new Date().toISOString().slice(0, 10)
const dateOf = (v: any) => String(v || today()).slice(0, 10)

export const REGISTER_MODULES: Record<string, RegisterModule> = {
  // Dr Fixed Assets (cost) ; Cr funding contra (bank / cash / payable / capital)
  "fixed-assets": {
    table: "fixed_assets",
    idColumn: "asset_id",
    build: (r) => {
      const amount = round2(num(r.cost))
      return {
        amount,
        lines: [
          { role: "fixed_asset", debit: amount, credit: 0 },
          { role: contraRole(r.funding_source), debit: 0, credit: amount },
        ],
        entityType: "fixed_asset",
        voucherType: "Fixed Asset",
        narration: `Fixed asset acquisition ${r.asset_id}${r.asset_name ? ` — ${r.asset_name}` : ""}`,
        sourceModule: "Fixed Assets",
        date: dateOf(r.acquisition_date),
        financialYear: r.financial_year ?? null,
        partyName: r.custodian || null,
      }
    },
  },
  // Given: Dr Loans & Advances (asset) ; Cr bank/cash
  // Taken: Dr bank/cash ; Cr Loans Payable (liability)
  "loans-advances": {
    table: "loans_advances",
    idColumn: "loan_id",
    build: (r) => {
      const amount = round2(num(r.principal))
      const taken = String(r.direction || "").toLowerCase().includes("taken")
      const contra = contraRole(r.funding_source)
      const lines: PostingLine[] = taken
        ? [
            { role: contra, debit: amount, credit: 0 },
            { role: "loan_payable", debit: 0, credit: amount },
          ]
        : [
            { role: "loan_receivable", debit: amount, credit: 0 },
            { role: contra, debit: 0, credit: amount },
          ]
      return {
        amount,
        lines,
        entityType: "loan_advance",
        voucherType: taken ? "Loan Taken" : "Loan / Advance",
        narration: `${taken ? "Loan taken" : "Loan / advance given"} ${r.loan_id}${r.party_name ? ` — ${r.party_name}` : ""}`,
        sourceModule: "Loans & Advances",
        date: dateOf(r.disbursement_date),
        financialYear: r.financial_year ?? null,
        partyName: r.party_name || null,
      }
    },
  },
  // Dr Investments ; Cr bank/cash
  "investments": {
    table: "investments",
    idColumn: "investment_id",
    build: (r) => {
      const amount = round2(num(r.amount))
      return {
        amount,
        lines: [
          { role: "investment", accountId: r.coa_account || null, debit: amount, credit: 0 },
          { role: contraRole(r.funding_source), debit: 0, credit: amount },
        ],
        entityType: "investment",
        voucherType: "Investment",
        narration: `Investment ${r.investment_id}${r.investment_name ? ` — ${r.investment_name}` : ""}`,
        sourceModule: "Investments",
        date: dateOf(r.acquisition_date),
        financialYear: r.financial_year ?? null,
      }
    },
  },
  // Type-aware initial recognition (Phase 6):
  //   Provision       → Dr Expense            ; Cr Provision Liability
  //   Accrual (exp)    → Dr Expense            ; Cr Accrued Liability
  //   Accrual (income) → Dr Accrued Asset      ; Cr Income
  //   Prepaid Expense  → Dr Prepaid Asset      ; Cr funding (bank/cash/payable)
  // For a recurring provision/accrual `amount` is the per-period charge and this
  // recognition posts the first period; later periods are booked by the
  // periodic-posting engine. For a prepaid, `amount` is the total and this
  // recognition books the asset, which is then amortised into expense.
  "provisions-accruals": {
    table: "provisions_accruals",
    idColumn: "provision_id",
    build: (r) => {
      const amount = round2(num(r.amount))
      const kind = provisionKind(r)
      const acct = r.account_id || null
      let lines: PostingLine[]
      let voucherType: string
      if (kind === "prepaid") {
        lines = [
          { role: "prepaid_asset", debit: amount, credit: 0 },
          { role: contraRole(r.funding_source), debit: 0, credit: amount },
        ]
        voucherType = "Prepaid Expense"
      } else if (kind === "accrual") {
        const income = String(r.accrual_nature || "").trim().toLowerCase() === "income"
        lines = income
          ? [
              { role: "accrued_asset", debit: amount, credit: 0 },
              { role: "accrued_income", accountId: acct, debit: 0, credit: amount },
            ]
          : [
              { role: "provision_expense", accountId: acct, debit: amount, credit: 0 },
              { role: "accrued_liability", debit: 0, credit: amount },
            ]
        voucherType = income ? "Accrued Income" : "Accrued Expense"
      } else {
        lines = [
          { role: "provision_expense", accountId: acct, debit: amount, credit: 0 },
          { role: "provision_liability", debit: 0, credit: amount },
        ]
        voucherType = "Provision"
      }
      return {
        amount,
        lines,
        entityType: "provision_accrual",
        voucherType,
        narration: `${voucherType} ${r.provision_id}${r.provision_name ? ` — ${r.provision_name}` : ""}`,
        sourceModule: "Provisions & Accruals",
        date: dateOf(r.provision_date || r.start_date),
        financialYear: r.financial_year ?? null,
        partyName: r.related_party || null,
      }
    },
  },
  // Capital & Equity (Phase 7). Seven entry types, each a balanced two-leg
  // voucher through the shared engine — no separate accounting store:
  //   External (cash-affecting):
  //     Capital Contribution / Share Capital → Dr Bank/Cash ; Cr Share Capital
  //     Partner Capital                      → Dr Bank/Cash ; Cr Partners' Capital
  //     Capital Withdrawal                   → Dr Drawings   ; Cr Bank/Cash
  //   Internal appropriation / transfer (equity-to-equity, no cash):
  //     Reserves          → Dr Retained Earnings ; Cr Reserves            (Increase)
  //     Retained Earnings → Dr Reserves          ; Cr Retained Earnings   (Increase)
  //     Equity Adjustment → Dr Retained Earnings ; Cr Equity Adjustments  (Increase)
  //   `direction` (Increase / Decrease) flips the two legs; `transfer_source`
  //   overrides the counter equity head. Retained Earnings reuses the SAME 3910
  //   head as the Year-End Closing engine.
  "capital-equity": {
    table: "capital_equity",
    idColumn: "entry_id",
    build: (r) => {
      const amount = round2(num(r.amount))
      const type = String(r.entry_type || "").trim()
      const key = type.toLowerCase()
      const contra = contraRole(r.mode)

      let lines: PostingLine[]
      if (key.includes("withdrawal") || key.includes("drawing") || key.includes("dividend")) {
        // Owner / partner takes value out of the business.
        lines = [
          { role: "drawings", debit: amount, credit: 0 },
          { role: contra, debit: 0, credit: amount },
        ]
      } else if (key.includes("partner")) {
        lines = [
          { role: contra, debit: amount, credit: 0 },
          { role: "partner_capital", debit: 0, credit: amount },
        ]
      } else if (key.includes("share") || key.includes("contribution")) {
        lines = [
          { role: contra, debit: amount, credit: 0 },
          { role: "share_capital", debit: 0, credit: amount },
        ]
      } else {
        // Internal equity appropriation / transfer (Reserves, Retained Earnings,
        // Equity Adjustment): both legs are equity heads, no cash moves.
        const primary: AccountRole = key.includes("reserve")
          ? "reserves"
          : key.includes("retained")
            ? "retained_earnings"
            : "equity_adjustment"
        const defaultSource: AccountRole = primary === "retained_earnings" ? "reserves" : "retained_earnings"
        const source = equityRole(r.transfer_source) ?? defaultSource
        const decrease = String(r.direction || "").trim().toLowerCase().startsWith("decrease")
        lines = decrease
          ? [
              { role: primary, debit: amount, credit: 0 },
              { role: source, debit: 0, credit: amount },
            ]
          : [
              { role: source, debit: amount, credit: 0 },
              { role: primary, debit: 0, credit: amount },
            ]
      }

      return {
        amount,
        lines,
        entityType: "capital_equity",
        voucherType: type || "Capital",
        narration: `${type || "Capital"} ${r.entry_id}${r.contributor_name ? ` — ${r.contributor_name}` : ""}`,
        sourceModule: "Capital & Equity",
        date: dateOf(r.entry_date),
        financialYear: r.financial_year ?? null,
        partyName: r.contributor_name || null,
      }
    },
  },
}

async function postSpec(
  mod: RegisterModule,
  row: Record<string, any>,
  opts: { createdBy?: number | null; reverse?: boolean } = {},
) {
  await ensureRegisterPostingAccounts()
  // Capital & Equity posts to the extended equity heads (partners' capital,
  // reserves, retained earnings, equity adjustments) that are not in the base
  // register seed, so make sure they exist before the voucher is posted.
  if (mod.table === "capital_equity") await ensureCapitalEquityAccounts()
  const spec = mod.build(row)
  return postLines(spec.lines, {
    entityType: spec.entityType,
    entityId: Number(row.id),
    entityRef: String(row[mod.idColumn] || row.id),
    date: spec.date,
    financialYear: spec.financialYear,
    partyId: spec.partyId ?? null,
    partyName: spec.partyName ?? null,
    voucherType: spec.voucherType,
    narration: opts.reverse ? `Reversal of ${spec.narration}` : spec.narration,
    sourceModule: spec.sourceModule,
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

/**
 * Idempotently keep a register document's Journal + General Ledger posting in
 * sync with its stored amount. Keyed off the row's `voucher_no` + `posted_amount`
 * and the frozen `posted_snapshot` used for a faithful reversal.
 */
export async function syncRegisterPosting(
  moduleKey: string,
  businessId: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ action: "posted" | "reposted" | "reversed" | "skipped" | "error"; voucherNo?: string }> {
  const mod = REGISTER_MODULES[moduleKey]
  if (!mod) return { action: "skipped" }

  const [row] = (await query(`SELECT * FROM ${mod.table} WHERE ${mod.idColumn} = ? LIMIT 1`, [businessId])) as any[]
  if (!row) return { action: "skipped" }

  const spec = mod.build(row)
  const amount = round2(spec.amount)
  const status = String(row.status || "").trim()
  const existingVoucher = row.voucher_no ? String(row.voucher_no) : null
  const postedAmount = round2(num(row.posted_amount))

  let postedSnapshot: Record<string, any> = row
  if (row.posted_snapshot) {
    try {
      postedSnapshot = { ...JSON.parse(String(row.posted_snapshot)), id: row.id, [mod.idColumn]: row[mod.idColumn] }
    } catch {
      postedSnapshot = row
    }
  }

  const reverseExisting = async () => {
    if (!existingVoucher) return
    await postSpec(mod, postedSnapshot, { createdBy: opts.createdBy ?? null, reverse: true })
    await query(
      `UPDATE ${mod.table}
          SET reversal_voucher_no = ?, voucher_no = NULL, posting_status = 'Unposted', posted_amount = 0, posted_snapshot = NULL
        WHERE id = ?`,
      [existingVoucher, row.id],
    )
  }

  try {
    if (amount <= 0 || UNPOSTABLE_STATUSES.has(status)) {
      if (existingVoucher) {
        await reverseExisting()
        return { action: "reversed" }
      }
      return { action: "skipped" }
    }

    if (existingVoucher && Math.abs(postedAmount - amount) <= 0.01) {
      return { action: "skipped", voucherNo: existingVoucher }
    }

    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postSpec(mod, row, { createdBy: opts.createdBy ?? null })
    await query(
      `UPDATE ${mod.table}
          SET voucher_no = ?, posting_status = 'Posted', posted_at = NOW(), posted_amount = ?, posted_snapshot = ?
        WHERE id = ?`,
      [result.voucherNo, amount, JSON.stringify(row), row.id],
    )
    return { action: reposted ? "reposted" : "posted", voucherNo: result.voucherNo }
  } catch (error) {
    console.log("[v0] register posting failed for", moduleKey, businessId, (error as Error)?.message)
    await query(`UPDATE ${mod.table} SET posting_status = 'Unposted' WHERE id = ?`, [row.id]).catch(() => {})
    return { action: "error" }
  }
}

/** Reverse and clear a register document's posting (used when it is deleted). */
export async function reverseRegisterPosting(moduleKey: string, row: Record<string, any>): Promise<void> {
  const mod = REGISTER_MODULES[moduleKey]
  if (!mod || !row?.voucher_no) return
  let toReverse: Record<string, any> = row
  if (row.posted_snapshot) {
    try {
      toReverse = { ...JSON.parse(String(row.posted_snapshot)), id: row.id, [mod.idColumn]: row[mod.idColumn] }
    } catch {
      toReverse = row
    }
  }
  try {
    await postSpec(mod, toReverse, { reverse: true })
  } catch (error) {
    console.log("[v0] register reversal failed for", moduleKey, row?.[mod.idColumn], (error as Error)?.message)
  }
}
