import "server-only"
import { query } from "@/lib/db"
import { financialYearFor } from "@/lib/finance-calc"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { ensureInvestmentAccounts, type AccountRole } from "@/lib/finance-accounts"

// ---------------------------------------------------------------------------
// Investments accounting engine (server-only).
//
// A dedicated lifecycle layer on top of the generic register `investments`
// table. The initial Purchase is posted by the register posting engine when an
// investment is created (Dr Investment / Cr funding contra). Every SUBSEQUENT
// lifecycle event — additional investment, interest, dividend, valuation
// adjustment, sale, redemption and maturity — turns into a balanced voucher
// through the SHARED posting engine (lib/finance-posting.postLines). Nothing
// here writes to the General Ledger directly: every posting goes Journal → GL,
// so the Trial Balance, Balance Sheet, General Ledger, Journal and P&L reports
// (which read the posted GL) all reflect it automatically.
// ---------------------------------------------------------------------------

export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const today = () => new Date().toISOString().slice(0, 10)
const dateOf = (v: any) => String(v || today()).slice(0, 10)

/** The investment types offered by the module (config + engine share these). */
export const INVESTMENT_TYPES = [
  "Fixed Deposit",
  "Bonds",
  "Mutual Funds",
  "Shares",
  "Government Securities",
  "Other Investments",
]

export const FUNDING_SOURCES = ["Bank", "Cash", "Accounts Payable", "Owner Capital"]
export const CASH_MODES = ["Bank", "Cash"]

/** Statuses in which an investment is still live and can transact. */
export const ACTIVE_STATUSES = new Set(["Active", "Impaired"])
/** Terminal statuses — the holding is closed, no further lifecycle actions. */
export const CLOSED_STATUSES = new Set(["Matured", "Sold", "Redeemed", "Closed"])

// ---------------------------------------------------------------------------
// Self-healing schema. The base `investments` table is created by
// lib/finance-ensure.ensureRegisterModuleTables; here we add the richer
// lifecycle columns and the transaction-history side table. MySQL has no
// "ADD COLUMN IF NOT EXISTS", so we probe information_schema first. Runs once
// per process.
// ---------------------------------------------------------------------------
let schemaEnsured = false

async function ensureColumn(table: string, column: string, definition: string) {
  const rows = (await query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )) as any[]
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

export async function ensureInvestmentSchema(): Promise<void> {
  if (schemaEnsured) return

  const [baseTable] = (await query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'investments' LIMIT 1`,
  )) as any[]
  if (!baseTable) {
    const { ensureRegisterModuleTables } = await import("@/lib/finance-ensure")
    await ensureRegisterModuleTables()
  }

  const additions: Array<[string, string]> = [
    ["institution", "VARCHAR(190) DEFAULT NULL"],
    ["coa_account", "VARCHAR(40) DEFAULT NULL"],
    ["coa_account_name", "VARCHAR(190) DEFAULT NULL"],
    ["documents", "TEXT DEFAULT NULL"],
    // Running lifecycle figures owned by the engine (never client-written).
    ["invested_amount", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["income_received", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["realised_gain", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["closed_date", "DATE DEFAULT NULL"],
    ["closed_value", "DECIMAL(16,2) NOT NULL DEFAULT 0"],
    ["closed_reason", "VARCHAR(40) DEFAULT NULL"],
  ]
  for (const [col, def] of additions) await ensureColumn("investments", col, def)

  // One row per lifecycle event, keyed to the posted voucher, giving the
  // holding a full transaction history.
  await query(`CREATE TABLE IF NOT EXISTS investment_transactions (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    investment_id    VARCHAR(30) NOT NULL,
    txn_type         VARCHAR(40) NOT NULL,
    txn_date         DATE DEFAULT NULL,
    amount           DECIMAL(16,2) NOT NULL DEFAULT 0,
    quantity         DECIMAL(16,4) NOT NULL DEFAULT 0,
    income_amount    DECIMAL(16,2) NOT NULL DEFAULT 0,
    gain_amount      DECIMAL(16,2) NOT NULL DEFAULT 0,
    proceeds         DECIMAL(16,2) NOT NULL DEFAULT 0,
    voucher_no       VARCHAR(40) DEFAULT NULL,
    financial_year   VARCHAR(12) DEFAULT NULL,
    notes            TEXT DEFAULT NULL,
    created_by       INT DEFAULT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_itxn_investment (investment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

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

export async function loadInvestment(investmentId: string): Promise<Record<string, any> | null> {
  const [row] = (await query(`SELECT * FROM investments WHERE investment_id = ? LIMIT 1`, [investmentId])) as any[]
  return row ?? null
}

/** Invested principal on the books — falls back to the original purchase amount. */
function investedOf(row: Record<string, any>): number {
  return round2(num(row.invested_amount) || num(row.amount))
}

/** Carrying / fair value — falls back to invested principal when not yet set. */
function currentValueOf(row: Record<string, any>): number {
  const cv = num(row.current_value)
  return round2(cv > 0 ? cv : investedOf(row))
}

async function insertTxn(t: {
  investmentId: string
  type: string
  date: string
  amount?: number
  quantity?: number
  income?: number
  gain?: number
  proceeds?: number
  voucherNo?: string | null
  notes?: string | null
  createdBy?: number | null
}) {
  await query(
    `INSERT INTO investment_transactions
       (investment_id, txn_type, txn_date, amount, quantity, income_amount, gain_amount, proceeds, voucher_no, financial_year, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      t.investmentId, t.type, t.date, round2(num(t.amount)), num(t.quantity), round2(num(t.income)),
      round2(num(t.gain)), round2(num(t.proceeds)), t.voucherNo ?? null, financialYearFor(t.date),
      t.notes ?? null, t.createdBy ?? null,
    ],
  )
}

// ---------------------------------------------------------------------------
// Detail read — the holding, its lifecycle transactions and derived stats.
// ---------------------------------------------------------------------------

export type InvestmentDetail = {
  investment: Record<string, any>
  transactions: Record<string, any>[]
  stats: {
    purchaseValue: number
    investedAmount: number
    currentValue: number
    unrealisedGain: number
    realisedGain: number
    incomeReceived: number
    quantity: number
    totalReturn: number
  }
}

export async function getInvestmentDetail(investmentId: string): Promise<InvestmentDetail | null> {
  await ensureInvestmentSchema()
  const [investment] = (await query(
    `SELECT x.*, u.name AS created_by_name
       FROM investments x
       LEFT JOIN users u ON u.id = x.created_by
      WHERE x.investment_id = ? LIMIT 1`,
    [investmentId],
  )) as any[]
  if (!investment) return null

  const transactions = (await query(
    `SELECT * FROM investment_transactions WHERE investment_id = ? ORDER BY txn_date ASC, id ASC`,
    [investmentId],
  )) as any[]

  const invested = investedOf(investment)
  const currentValue = currentValueOf(investment)
  const realisedGain = round2(num(investment.realised_gain))
  const income = round2(num(investment.income_received))

  return {
    investment,
    transactions,
    stats: {
      purchaseValue: round2(num(investment.amount)),
      investedAmount: invested,
      currentValue,
      unrealisedGain: round2(currentValue - invested),
      realisedGain,
      incomeReceived: income,
      quantity: num(investment.units),
      totalReturn: round2(realisedGain + income + (currentValue - invested)),
    },
  }
}

// ---------------------------------------------------------------------------
// Lifecycle actions. Every posting flows through postLines (Journal → GL).
// ---------------------------------------------------------------------------

type ActionResult = { ok: boolean; voucherNo?: string; error?: string; result?: number }

/**
 * Additional investment / top-up into an existing holding.
 *   Dr Investment (COA head)     amount
 *   Cr Bank / Cash / Payable     amount
 */
export async function addInvestment(
  investmentId: string,
  payload: { amount: number; quantity?: number; date?: string | null; fundingSource?: string | null; notes?: string | null; createdBy?: number | null },
): Promise<ActionResult> {
  await ensureInvestmentSchema()
  await ensureInvestmentAccounts()
  const row = await loadInvestment(investmentId)
  if (!row) return { ok: false, error: "Investment not found" }
  if (CLOSED_STATUSES.has(String(row.status))) return { ok: false, error: `A ${row.status} investment cannot take further investment` }

  const amount = round2(num(payload.amount))
  if (amount <= 0) return { ok: false, error: "Amount must be greater than zero" }
  const date = dateOf(payload.date)
  const source = payload.fundingSource || row.funding_source || "Bank"

  const lines: PostingLine[] = [
    { role: "investment", accountId: row.coa_account || null, debit: amount, credit: 0 },
    { role: contraRole(source), debit: 0, credit: amount },
  ]

  try {
    const result = await postLines(lines, {
      entityType: "investment_addition",
      entityId: Number(row.id),
      entityRef: investmentId,
      date,
      financialYear: financialYearFor(date),
      partyName: row.institution || null,
      voucherType: "Investment",
      narration: `Additional investment in ${investmentId}${row.investment_name ? ` — ${row.investment_name}` : ""}`,
      sourceModule: "Investments",
      createdBy: payload.createdBy ?? null,
    })
    await query(
      `UPDATE investments
          SET invested_amount = ? , units = units + ?, current_value = ? WHERE id = ?`,
      [round2(investedOf(row) + amount), num(payload.quantity), round2(currentValueOf(row) + amount), row.id],
    )
    await insertTxn({ investmentId, type: "Additional Investment", date, amount, quantity: num(payload.quantity), voucherNo: result.voucherNo, notes: payload.notes, createdBy: payload.createdBy })
    return { ok: true, voucherNo: result.voucherNo }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * Record interest or dividend income received.
 *   Dr Bank / Cash               amount
 *   Cr Investment Income         amount
 */
export async function recordIncome(
  investmentId: string,
  payload: { kind: "Interest" | "Dividend"; amount: number; date?: string | null; mode?: string | null; notes?: string | null; createdBy?: number | null },
): Promise<ActionResult> {
  await ensureInvestmentSchema()
  await ensureInvestmentAccounts()
  const row = await loadInvestment(investmentId)
  if (!row) return { ok: false, error: "Investment not found" }

  const amount = round2(num(payload.amount))
  if (amount <= 0) return { ok: false, error: "Amount must be greater than zero" }
  const kind = payload.kind === "Dividend" ? "Dividend" : "Interest"
  const date = dateOf(payload.date)
  const mode = payload.mode || "Bank"

  const lines: PostingLine[] = [
    { role: contraRole(mode), debit: amount, credit: 0 },
    { role: "investment_income", debit: 0, credit: amount },
  ]

  try {
    const result = await postLines(lines, {
      entityType: "investment_income",
      entityId: Number(row.id),
      entityRef: investmentId,
      date,
      financialYear: financialYearFor(date),
      partyName: row.institution || null,
      voucherType: kind === "Dividend" ? "Dividend" : "Interest",
      narration: `${kind} income on ${investmentId}${row.investment_name ? ` — ${row.investment_name}` : ""}`,
      sourceModule: "Investments",
      createdBy: payload.createdBy ?? null,
    })
    await query(`UPDATE investments SET income_received = income_received + ? WHERE id = ?`, [amount, row.id])
    await insertTxn({ investmentId, type: kind, date, income: amount, voucherNo: result.voucherNo, notes: payload.notes, createdBy: payload.createdBy })
    return { ok: true, voucherNo: result.voucherNo }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * Fair-value / valuation adjustment to the carrying value.
 *   Upward   Dr Investment              delta ; Cr Fair Value Gain (income)
 *   Downward Dr Impairment Loss (exp)   delta ; Cr Investment
 * Updates the holding's current value; the invested principal is untouched.
 */
export async function revalueInvestment(
  investmentId: string,
  payload: { newValue: number; date?: string | null; notes?: string | null; createdBy?: number | null },
): Promise<ActionResult> {
  await ensureInvestmentSchema()
  await ensureInvestmentAccounts()
  const row = await loadInvestment(investmentId)
  if (!row) return { ok: false, error: "Investment not found" }
  if (CLOSED_STATUSES.has(String(row.status))) return { ok: false, error: `A ${row.status} investment cannot be revalued` }

  const newValue = round2(num(payload.newValue))
  if (newValue < 0) return { ok: false, error: "New value cannot be negative" }
  const oldValue = currentValueOf(row)
  const delta = round2(newValue - oldValue)
  if (delta === 0) return { ok: false, error: "New value is unchanged" }
  const date = dateOf(payload.date)

  const lines: PostingLine[] =
    delta > 0
      ? [
          { role: "investment", accountId: row.coa_account || null, debit: delta, credit: 0 },
          { role: "investment_gain", debit: 0, credit: delta },
        ]
      : [
          { role: "investment_impairment", debit: round2(-delta), credit: 0 },
          { role: "investment", accountId: row.coa_account || null, debit: 0, credit: round2(-delta) },
        ]

  try {
    const result = await postLines(lines, {
      entityType: "investment_revaluation",
      entityId: Number(row.id),
      entityRef: investmentId,
      date,
      financialYear: financialYearFor(date),
      partyName: row.institution || null,
      voucherType: "Valuation Adjustment",
      narration: `Valuation adjustment on ${investmentId}${row.investment_name ? ` — ${row.investment_name}` : ""} (${oldValue} → ${newValue})`,
      sourceModule: "Investments",
      createdBy: payload.createdBy ?? null,
    })
    await query(
      `UPDATE investments
          SET current_value = ?, status = CASE WHEN ? < 0 THEN 'Impaired' ELSE status END
        WHERE id = ?`,
      [newValue, delta, row.id],
    )
    await insertTxn({ investmentId, type: "Valuation Adjustment", date, amount: newValue, gain: delta, voucherNo: result.voucherNo, notes: payload.notes, createdBy: payload.createdBy })
    return { ok: true, voucherNo: result.voucherNo, result: delta }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/**
 * Dispose a holding — Sale, Redemption or Maturity. Removes the invested cost
 * portion, books the cash proceeds and the resulting realised gain / loss.
 * Supports partial disposals via `costPortion` (defaults to the full invested
 * amount); a full disposal closes the holding.
 *
 *   Cr Investment                cost portion
 *   Dr Bank / Cash               proceeds
 *   Dr Loss on Investments       (cost − proceeds)   when proceeds < cost
 *   Cr Gain on Investments       (proceeds − cost)   when proceeds > cost
 */
export async function disposeInvestment(
  investmentId: string,
  payload: {
    kind: "Sale" | "Redemption" | "Maturity"
    proceeds: number
    costPortion?: number | null
    quantity?: number | null
    date?: string | null
    mode?: string | null
    notes?: string | null
    createdBy?: number | null
  },
): Promise<ActionResult> {
  await ensureInvestmentSchema()
  await ensureInvestmentAccounts()
  const row = await loadInvestment(investmentId)
  if (!row) return { ok: false, error: "Investment not found" }
  if (CLOSED_STATUSES.has(String(row.status))) return { ok: false, error: `Investment is already ${row.status}` }

  const kind = payload.kind
  const invested = investedOf(row)
  const requested = payload.costPortion !== undefined && payload.costPortion !== null && payload.costPortion !== ("" as any)
    ? round2(num(payload.costPortion))
    : invested
  const cost = round2(Math.min(Math.max(requested, 0), invested))
  if (cost <= 0) return { ok: false, error: "Nothing invested to dispose" }
  const proceeds = round2(num(payload.proceeds))
  if (proceeds < 0) return { ok: false, error: "Proceeds cannot be negative" }
  const date = dateOf(payload.date)
  const mode = payload.mode || "Bank"
  const gainLoss = round2(proceeds - cost) // >0 gain, <0 loss
  const isFull = round2(invested - cost) <= 0.01

  const lines: PostingLine[] = []
  lines.push({ role: "investment", accountId: row.coa_account || null, debit: 0, credit: cost })
  if (proceeds > 0) lines.push({ role: contraRole(mode), debit: proceeds, credit: 0 })
  if (gainLoss < 0) lines.push({ role: "investment_loss", debit: round2(-gainLoss), credit: 0 })
  if (gainLoss > 0) lines.push({ role: "investment_gain", debit: 0, credit: round2(gainLoss) })

  const statusFor: Record<string, string> = { Sale: "Sold", Redemption: "Redeemed", Maturity: "Matured" }

  try {
    const result = await postLines(lines, {
      entityType: "investment_disposal",
      entityId: Number(row.id),
      entityRef: investmentId,
      date,
      financialYear: financialYearFor(date),
      partyName: row.institution || null,
      voucherType: kind,
      narration: `${kind} of investment ${investmentId}${row.investment_name ? ` — ${row.investment_name}` : ""}`,
      sourceModule: "Investments",
      createdBy: payload.createdBy ?? null,
    })
    const newInvested = round2(invested - cost)
    const newCurrent = round2(Math.max(currentValueOf(row) - cost, 0))
    const totalQty = num(row.units)
    const disposedQty = payload.quantity != null && payload.quantity !== ("" as any)
      ? num(payload.quantity)
      : isFull
        ? totalQty
        : round2(totalQty * (invested > 0 ? cost / invested : 0))
    await query(
      `UPDATE investments
          SET invested_amount = ?, current_value = ?, units = GREATEST(units - ?, 0),
              realised_gain = realised_gain + ?,
              status = CASE WHEN ? THEN ? ELSE status END,
              closed_date = CASE WHEN ? THEN ? ELSE closed_date END,
              closed_value = CASE WHEN ? THEN ? ELSE closed_value END,
              closed_reason = CASE WHEN ? THEN ? ELSE closed_reason END
        WHERE id = ?`,
      [
        newInvested, newCurrent, disposedQty, gainLoss,
        isFull ? 1 : 0, statusFor[kind] || "Closed",
        isFull ? 1 : 0, date,
        isFull ? 1 : 0, proceeds,
        isFull ? 1 : 0, kind,
        row.id,
      ],
    )
    await insertTxn({
      investmentId, type: kind, date, amount: cost, quantity: disposedQty,
      gain: gainLoss, proceeds, voucherNo: result.voucherNo, notes: payload.notes, createdBy: payload.createdBy,
    })
    return { ok: true, voucherNo: result.voucherNo, result: gainLoss }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
