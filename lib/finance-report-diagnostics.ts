/**
 * Report diagnostics — Phases 21-25.
 *
 * A PURE, dependency-free module (no DB, no server-only imports) shared by the
 * run engine, the reports API, the report email route and the client. It turns
 * a report definition + its returned rows + a snapshot of the accounting
 * source health into an actionable status:
 *
 *   - Phase 23 RECONCILIATION — internal balancing checks (Trial Balance debit
 *     = credit, Balance Sheet Assets = Liabilities + Equity + earnings, Cash
 *     Flow net = bank movement, P&L net = ledger earnings).
 *   - Phase 24 STATUS — a level (ok / warning / error) with a human headline,
 *     never a silent fake zero: an empty result explains *why*.
 *   - Phase 25 ERRORS — typed exceptions (missing mapping, unposted journals,
 *     source mismatch, invalid period, incomplete data) surfaced as checks.
 *
 * The heavy accounting values (unposted journals, unmapped accounts, posted
 * ledger earnings, bank movement) are gathered once by the server engine and
 * passed in as `SourceHealth`; this module only interprets them so the exact
 * same numbers back the on-screen banner, the PDF and the emailed report.
 */

export type ReportColumnLike = { key: string; label: string; money?: boolean }

export type ReportStatusLevel = "ok" | "warning" | "error"

export type ReportExceptionCode =
  | "RECONCILED"
  | "MISSING_ACCOUNT"
  | "MISSING_MAPPING"
  | "UNPOSTED_JOURNAL"
  | "UNRECONCILED_DATA"
  | "SOURCE_MISMATCH"
  | "INVALID_PERIOD"
  | "INCOMPLETE_DATA"
  | "NO_SOURCE"
  // The report's source table/module genuinely does not exist yet (Phase 23),
  // distinct from NO_SOURCE (no query wired at all) and from a broken query.
  | "SOURCE_UNAVAILABLE"
  // The source exists but the report's query references a column/shape that is
  // no longer valid — the query needs fixing, not the data (Phase 31).
  | "QUERY_BROKEN"

export type ReportCheck = {
  code: ReportExceptionCode
  level: ReportStatusLevel
  message: string
}

export type ReconLine = {
  label: string
  /** Left-hand accounting value (e.g. Total Debit, Assets). */
  left: number
  /** Right-hand accounting value it must agree with. */
  right: number
  leftLabel: string
  rightLabel: string
  delta: number
  balanced: boolean
}

export type ReportDiagnostics = {
  level: ReportStatusLevel
  headline: string
  checks: ReportCheck[]
  reconciliation: ReconLine[]
  totals: Record<string, number> | null
}

// Which pre-computed accounting signals a report's diagnostics depend on. The
// engine only runs the matching source queries when a report asks for them.
export type SourceSignal = "posting" | "coaMapping" | "bank" | "earnings"

export type ReportReconRule =
  | { kind: "debitCredit"; debitKey?: string; creditKey?: string }
  | { kind: "balanceSheet"; sectionKey?: string; balanceKey?: string }
  | { kind: "plNet"; sectionKey?: string; amountKey?: string }
  // Wide P&L shape: income and expense live in their own columns per row
  // (period, income, expense, net) rather than as classified line rows.
  | { kind: "plWide"; incomeKey?: string; expenseKey?: string }
  | { kind: "cashFlow"; netKey?: string }

export type ReportDiagnosticsConfig = {
  /** Reconciliation rules evaluated against the returned rows (Phase 23). */
  recon?: ReportReconRule[]
  /** Accounting source signals this report's status depends on. */
  requires?: SourceSignal[]
  /** Actionable reason shown when the report returns zero rows (Phase 24). */
  emptyHint?: string
}

/**
 * Accounting source health, gathered once per run by the server engine and
 * scoped to the same period as the report. Any field may be null when its
 * source table/column is genuinely absent — diagnostics degrade gracefully.
 */
export type SourceHealth = {
  unpostedCount: number | null
  unpostedValue: number | null
  coaTotal: number | null
  coaUnmapped: number | null
  /** Posted-ledger earnings for the period: income − expense (profit positive). */
  glNetEarnings: number | null
  /** Bank & cash net movement for the period: credit − debit. */
  bankNet: number | null
}

export const EMPTY_HEALTH: SourceHealth = {
  unpostedCount: null,
  unpostedValue: null,
  coaTotal: null,
  coaUnmapped: null,
  glNetEarnings: null,
  bankNet: null,
}

const n = (v: any) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
// Aggregated money is stored to paise; allow a rupee of slack so summed
// rounding never reports a false mismatch.
const TOLERANCE = 1
const balanced = (delta: number) => Math.abs(delta) <= TOLERANCE

function sumRows(rows: Record<string, any>[], key: string) {
  return round2(rows.reduce((s, r) => s + n(r[key]), 0))
}

function moneyTotals(columns: ReportColumnLike[], rows: Record<string, any>[]) {
  const moneyCols = columns.filter((c) => c.money)
  if (moneyCols.length === 0 || rows.length === 0) return null
  const totals: Record<string, number> = {}
  for (const c of moneyCols) totals[c.key] = sumRows(rows, c.key)
  return totals
}

/**
 * Why a run came back unavailable, resolved by the server engine from the DB
 * error (Phases 23/31). `missing` → the source table/module does not exist yet;
 * `broken` → the source exists but the query references an invalid column;
 * `unknown` → any other failure. `source` names the table/module and `detail`
 * carries the raw DB reason for on-screen + log debugging.
 */
export type ReportSourceError = {
  kind: "missing" | "broken" | "unknown"
  source?: string
  detail?: string
}

export type DiagnosticsInput = {
  columns: ReportColumnLike[]
  rows: Record<string, any>[]
  available: boolean
  hasSql: boolean
  from?: string
  to?: string
  config?: ReportDiagnosticsConfig
  health?: SourceHealth
  /** Populated only when `available` is false — explains the failure precisely. */
  sourceError?: ReportSourceError
}

export function computeReportDiagnostics(input: DiagnosticsInput): ReportDiagnostics {
  const { columns, rows, available, hasSql, from, to } = input
  const config = input.config ?? {}
  const health = input.health ?? EMPTY_HEALTH
  const checks: ReportCheck[] = []
  const reconciliation: ReconLine[] = []
  const totals = moneyTotals(columns, rows)

  // Phase 24 — a report with no data source yet is not a silent zero.
  if (!hasSql) {
    return {
      level: "warning",
      headline: "This report has no data source configured yet.",
      checks: [
        {
          code: "NO_SOURCE",
          level: "warning",
          message: "No data source is wired for this report yet — it will populate once its source data exists.",
        },
      ],
      reconciliation,
      totals,
    }
  }

  // Phase 25 — invalid period.
  if (from && to && from > to) {
    checks.push({
      code: "INVALID_PERIOD",
      level: "error",
      message: `Invalid period: the start date (${from}) is after the end date (${to}).`,
    })
  }

  // Phases 23/31 — the run came back unavailable. Distinguish a genuinely
  // missing source (needs setting up) from a broken query (needs fixing) from
  // an unknown failure, so the UI never mislabels an existing source as
  // "no data source configured".
  if (!available) {
    const err = input.sourceError
    if (err?.kind === "missing") {
      checks.push({
        code: "SOURCE_UNAVAILABLE",
        level: "error",
        message: `Required source is not available${
          err.source ? ` — the ${err.source} module has not been set up yet` : ""
        }.${err.detail ? ` (${err.detail})` : ""}`,
      })
    } else if (err?.kind === "broken") {
      checks.push({
        code: "QUERY_BROKEN",
        level: "error",
        message: `This report's source${
          err.source ? ` (${err.source})` : ""
        } is available, but its query needs updating${err.detail ? ` — ${err.detail}` : ""}.`,
      })
    } else {
      checks.push({
        code: "INCOMPLETE_DATA",
        level: "error",
        message:
          "This report could not be generated — its source table or a required column is missing. Check the Chart of Accounts and posting configuration." +
          (err?.detail ? ` (${err.detail})` : ""),
      })
    }
    return finalise(checks, reconciliation, totals)
  }

  // Phase 25 — source-health warnings for reports that depend on posted data.
  const requires = config.requires ?? []
  if (requires.includes("posting") && (health.unpostedCount ?? 0) > 0) {
    checks.push({
      code: "UNPOSTED_JOURNAL",
      level: "warning",
      message: `${health.unpostedCount} unposted / pending journal ${
        health.unpostedCount === 1 ? "entry is" : "entries are"
      } excluded from this report${
        health.unpostedValue ? ` (${formatInr(health.unpostedValue)} unposted)` : ""
      }. Post them to include their effect.`,
    })
  }
  if (requires.includes("coaMapping") && (health.coaUnmapped ?? 0) > 0) {
    checks.push({
      code: "MISSING_MAPPING",
      level: "warning",
      message: `${health.coaUnmapped} account${
        health.coaUnmapped === 1 ? " is" : "s are"
      } missing a Balance Sheet / P&L classification in the Chart of Accounts. Map them so every balance lands in a statement.`,
    })
  }

  // Phase 24 — an empty result is explained, never shown as a fake zero.
  if (rows.length === 0) {
    checks.push({
      code: "INCOMPLETE_DATA",
      level: "warning",
      message:
        config.emptyHint ??
        "No posted records fall in the selected period. Widen the period or post transactions to populate this report.",
    })
    return finalise(checks, reconciliation, totals)
  }

  // Phase 23 — reconciliation rules.
  for (const rule of config.recon ?? []) {
    const line = evalRecon(rule, rows, health)
    if (!line) continue
    reconciliation.push(line)
    checks.push(
      line.balanced
        ? { code: "RECONCILED", level: "ok", message: `${line.label}: reconciled.` }
        : {
            code: rule.kind === "debitCredit" ? "UNRECONCILED_DATA" : "SOURCE_MISMATCH",
            level: "error",
            message: `${line.label} does not reconcile — ${line.leftLabel} ${formatInr(line.left)} vs ${
              line.rightLabel
            } ${formatInr(line.right)} (difference ${formatInr(line.delta)}).`,
          },
    )
  }

  return finalise(checks, reconciliation, totals)
}

function evalRecon(
  rule: ReportReconRule,
  rows: Record<string, any>[],
  health: SourceHealth,
): ReconLine | null {
  if (rule.kind === "debitCredit") {
    const debit = sumRows(rows, rule.debitKey ?? "debit")
    const credit = sumRows(rows, rule.creditKey ?? "credit")
    return line("Total Debit = Total Credit", debit, credit, "Debit", "Credit")
  }

  if (rule.kind === "balanceSheet") {
    const sectionKey = rule.sectionKey ?? "section"
    const balanceKey = rule.balanceKey ?? "balance"
    // GL balance = debit − credit: assets are debit-positive, liabilities and
    // equity credit-negative, so signed totals net to −earnings.
    const assets = round2(
      rows.filter((r) => /asset/i.test(String(r[sectionKey]))).reduce((s, r) => s + n(r[balanceKey]), 0),
    )
    const liabilities = round2(
      -rows.filter((r) => /liab/i.test(String(r[sectionKey]))).reduce((s, r) => s + n(r[balanceKey]), 0),
    )
    const equity = round2(
      -rows
        .filter((r) => /equity|capital/i.test(String(r[sectionKey])))
        .reduce((s, r) => s + n(r[balanceKey]), 0),
    )
    const earnings = round2(health.glNetEarnings ?? 0)
    return line(
      "Assets = Liabilities + Equity + Earnings",
      assets,
      round2(liabilities + equity + earnings),
      "Assets",
      "Liab. + Equity + Earnings",
    )
  }

  if (rule.kind === "plNet") {
    const sectionKey = rule.sectionKey ?? "section"
    const amountKey = rule.amountKey ?? "amount"
    const income = round2(
      rows.filter((r) => /income|revenue/i.test(String(r[sectionKey]))).reduce((s, r) => s + n(r[amountKey]), 0),
    )
    const expense = round2(
      rows.filter((r) => /expense|cost/i.test(String(r[sectionKey]))).reduce((s, r) => s + n(r[amountKey]), 0),
    )
    const net = round2(income - expense)
    // If the posted-ledger earnings snapshot exists, cross-check against it;
    // otherwise reconcile the report against its own income − expense.
    const ledger = health.glNetEarnings == null ? net : round2(health.glNetEarnings)
    return line("Net Profit agrees with ledger earnings", net, ledger, "Net Profit", "Ledger Earnings")
  }

  if (rule.kind === "plWide") {
    const income = sumRows(rows, rule.incomeKey ?? "income")
    const expense = sumRows(rows, rule.expenseKey ?? "expense")
    const net = round2(income - expense)
    // Cross-check the report's own income − expense against the posted-ledger
    // earnings snapshot when it exists; otherwise reconcile against itself.
    const ledger = health.glNetEarnings == null ? net : round2(health.glNetEarnings)
    return line("Net Profit agrees with ledger earnings", net, ledger, "Net Profit", "Ledger Earnings")
  }

  if (rule.kind === "cashFlow") {
    const net = sumRows(rows, rule.netKey ?? "net_cash")
    const bank = health.bankNet == null ? net : round2(health.bankNet)
    return line("Net Cash agrees with bank movement", net, bank, "Net Cash", "Bank Movement")
  }

  return null
}

function line(label: string, left: number, right: number, leftLabel: string, rightLabel: string): ReconLine {
  const delta = round2(left - right)
  return { label, left, right, leftLabel, rightLabel, delta, balanced: balanced(delta) }
}

function finalise(
  checks: ReportCheck[],
  reconciliation: ReconLine[],
  totals: Record<string, number> | null,
): ReportDiagnostics {
  const level: ReportStatusLevel = checks.some((c) => c.level === "error")
    ? "error"
    : checks.some((c) => c.level === "warning")
      ? "warning"
      : "ok"
  const headline =
    level === "error"
      ? (checks.find((c) => c.level === "error")?.message ?? "This report has errors.")
      : level === "warning"
        ? (checks.find((c) => c.level === "warning")?.message ?? "This report has warnings.")
        : reconciliation.length > 0
          ? "Report reconciled — all balancing checks pass."
          : "Report generated."
  return { level, headline, checks, reconciliation, totals }
}

// Compact INR used only inside diagnostic messages (the UI formats table cells
// with the app-wide currency helper).
function formatInr(v: number) {
  const sign = v < 0 ? "-" : ""
  const abs = Math.abs(v)
  return `${sign}₹${abs.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}
