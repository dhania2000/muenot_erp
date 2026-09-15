import "server-only"
import { query } from "@/lib/db"

/**
 * Phase 53 — Traceability.
 *
 * Reconstructs the full accounting drill-path around a single voucher, in BOTH
 * directions, reading only the tables the existing engine already writes:
 *
 *   Source Transaction → Journal → GL → Financial Report      (forward)
 *   Financial Report → GL → Journal → Source Transaction      (reverse)
 *
 * This module owns NO authoritative table and posts nothing. It is a read-only
 * projection over `journal_entries` + `general_ledger` (both stamped with
 * `voucher_no`, `source_module`, `source_entity_type/id`, `source_reference` by
 * lib/finance-posting.ts) plus a best-effort lookup of the originating source
 * document so a voucher can always be walked back to the transaction that
 * created it and forward to the statement it rolls into.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

// Which financial statement an account rolls into. Mirrors the classification
// used by lib/finance-statements.ts: Income/Expense → P&L, the rest → Balance
// Sheet. Trial Balance always includes every account.
function statementFor(group: string, type: string): { statement: string; href: string } {
  const g = String(group || type || "").toLowerCase()
  if (g.startsWith("inc") || g.startsWith("rev") || g.startsWith("exp")) {
    return { statement: "Profit & Loss", href: "/modules/finance/financial-statements?statement=pnl" }
  }
  return { statement: "Balance Sheet", href: "/modules/finance/financial-statements?statement=balance-sheet" }
}

// Map a source module / entity type to the workspace route of its document.
// Best-effort: an unknown source degrades to no link (the reference text still
// shows), so a new source module can never break the drawer.
function sourceRoute(sourceModule: string, entityType: string): string | null {
  const key = `${sourceModule} ${entityType}`.toLowerCase()
  if (key.includes("sales") && key.includes("invoice")) return "/modules/finance/sales-invoices"
  if (key.includes("purchase")) return "/modules/finance/purchase-bills"
  if (key.includes("expense")) return "/modules/finance/expenses"
  if (key.includes("bank")) return "/modules/finance/bank-transactions"
  if (key.includes("fte")) return "/modules/finance/fte-invoices"
  if (key.includes("freelance")) return "/modules/finance/freelance-invoices"
  if (key.includes("year-end") || key.includes("year end") || key.includes("closing"))
    return "/modules/finance/year-end-closing"
  return null
}

export type TraceSourceNode = {
  present: boolean
  isManual: boolean
  sourceModule: string
  entityType: string | null
  entityId: string | null
  reference: string
  href: string | null
  /** true when the source module is non-manual but no document reference exists */
  missing: boolean
}

export type TraceJournalLine = {
  journalEntryId: string
  accountId: string | null
  accountName: string
  accountGroup: string
  debit: number
  credit: number
  gst: number
  tds: number
}

export type TraceLedgerLine = {
  ledgerId: string
  journalEntryId: string | null
  accountName: string
  debit: number
  credit: number
  balance: number
  balanceType: string
  reconciliationStatus: string
}

export type TraceReportNode = {
  accountGroup: string
  accountType: string
  statement: string
  href: string
  amount: number
}

export type JournalTrace = {
  voucherNo: string
  voucherType: string
  journalDate: string
  financialYear: string
  narration: string
  postingStatus: string
  approvalStatus: string
  source: TraceSourceNode
  journal: {
    present: boolean
    lines: TraceJournalLine[]
    totalDebit: number
    totalCredit: number
    balanced: boolean
  }
  ledger: {
    present: boolean
    lines: TraceLedgerLine[]
    totalDebit: number
    totalCredit: number
    /** true when journal totals match the GL totals for this voucher */
    matchesJournal: boolean
  }
  reports: TraceReportNode[]
}

/**
 * Build the complete Source → Journal → GL → Report chain for a voucher. Returns
 * null only when the voucher has no journal lines at all (an unknown voucher).
 */
export async function traceVoucher(voucherNo: string): Promise<JournalTrace | null> {
  const vno = String(voucherNo || "").trim()
  if (!vno) return null

  const jRows = (await query(
    `SELECT journal_entry_id, voucher_no, journal_date, financial_year, voucher_type, narration,
            account_id, account_name, account_group, account_type, debit, credit, gst_amount, tds_amount,
            source_module, source_reference, source_entity_type, source_entity_id,
            approval_status, posting_status
       FROM journal_entries WHERE voucher_no = ? ORDER BY id ASC`,
    [vno],
  )) as any[]

  if (!jRows.length) return null
  const head = jRows[0]

  const glRows = (await query(
    `SELECT ledger_id, journal_entry_id, account_name, account_group, account_type,
            debit, credit, balance, balance_type, reconciliation_status
       FROM general_ledger WHERE voucher_no = ? ORDER BY id ASC`,
    [vno],
  )) as any[]

  // ── Source node ──────────────────────────────────────────────────────────
  const sourceModule = String(head.source_module || "").trim()
  const isManual = sourceModule === "" || sourceModule.toLowerCase() === "manual"
  const entityType = head.source_entity_type ? String(head.source_entity_type) : null
  const entityId = head.source_entity_id != null ? String(head.source_entity_id) : null
  const reference = String(head.source_reference || head.voucher_no || "")
  const hasDocRef = Boolean(entityId || (head.source_reference && String(head.source_reference).trim()))
  const source: TraceSourceNode = {
    present: true,
    isManual,
    sourceModule: isManual ? "Manual" : sourceModule,
    entityType,
    entityId,
    reference,
    href: isManual ? null : sourceRoute(sourceModule, entityType || ""),
    missing: !isManual && !hasDocRef,
  }

  // ── Journal node ─────────────────────────────────────────────────────────
  const journalLines: TraceJournalLine[] = jRows.map((r) => ({
    journalEntryId: String(r.journal_entry_id),
    accountId: r.account_id != null ? String(r.account_id) : null,
    accountName: String(r.account_name || ""),
    accountGroup: String(r.account_group || r.account_type || ""),
    debit: round2(r.debit),
    credit: round2(r.credit),
    gst: round2(r.gst_amount),
    tds: round2(r.tds_amount),
  }))
  const jDebit = round2(journalLines.reduce((s, l) => s + l.debit, 0))
  const jCredit = round2(journalLines.reduce((s, l) => s + l.credit, 0))

  // ── Ledger node ──────────────────────────────────────────────────────────
  const ledgerLines: TraceLedgerLine[] = glRows.map((r) => ({
    ledgerId: String(r.ledger_id),
    journalEntryId: r.journal_entry_id != null ? String(r.journal_entry_id) : null,
    accountName: String(r.account_name || ""),
    debit: round2(r.debit),
    credit: round2(r.credit),
    balance: round2(r.balance),
    balanceType: String(r.balance_type || ""),
    reconciliationStatus: String(r.reconciliation_status || "Unreconciled"),
  }))
  const glDebit = round2(ledgerLines.reduce((s, l) => s + l.debit, 0))
  const glCredit = round2(ledgerLines.reduce((s, l) => s + l.credit, 0))

  // ── Report node ──────────────────────────────────────────────────────────
  // Collapse the journal lines by account group → the statement they feed, with
  // the net movement so the drill continues into the right financial report.
  const byGroup = new Map<string, TraceReportNode>()
  for (const r of jRows) {
    const group = String(r.account_group || r.account_type || "Unclassified")
    const type = String(r.account_type || "")
    const { statement, href } = statementFor(group, type)
    const existing = byGroup.get(group)
    const delta = round2(num(r.debit) - num(r.credit))
    if (existing) existing.amount = round2(existing.amount + delta)
    else byGroup.set(group, { accountGroup: group, accountType: type, statement, href, amount: delta })
  }

  return {
    voucherNo: vno,
    voucherType: String(head.voucher_type || ""),
    journalDate: String(head.journal_date || "").slice(0, 10),
    financialYear: String(head.financial_year || ""),
    narration: String(head.narration || ""),
    postingStatus: String(head.posting_status || "Unposted"),
    approvalStatus: String(head.approval_status || ""),
    source,
    journal: {
      present: true,
      lines: journalLines,
      totalDebit: jDebit,
      totalCredit: jCredit,
      balanced: Math.abs(jDebit - jCredit) <= 0.01,
    },
    ledger: {
      present: ledgerLines.length > 0,
      lines: ledgerLines,
      totalDebit: glDebit,
      totalCredit: glCredit,
      matchesJournal: Math.abs(jDebit - glDebit) <= 0.01 && Math.abs(jCredit - glCredit) <= 0.01,
    },
    reports: Array.from(byGroup.values()),
  }
}
