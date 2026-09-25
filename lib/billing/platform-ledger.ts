import "server-only"
import { query } from "@/lib/db"
import { tenantSelect, currentTenantId } from "@/lib/tenant-scope"
import { nextRecordId } from "@/lib/record-ids"
import { round2 } from "@/lib/billing/billing-math"
import type { SessionPayload } from "@/lib/auth"

/**
 * Platform seller ledger (SaaS provider's own books).
 * ---------------------------------------------------------------------------
 * Muenot both runs the ERP internally and SELLS it as SaaS. When it bills a
 * customer tenant for their subscription, that is the *platform's* revenue and
 * receivable — it must NEVER touch the customer's own ERP finance ledger
 * (lib/finance-*, `general_ledger`), which records the customer's business.
 *
 * This module keeps the two sets of books strictly separate: the platform's
 * double-entry journal lives in its own `platform_journal` / `platform_journal_lines`
 * tables, scoped by the same `tenant_id` (i.e. "the platform's account with
 * this customer"). Every billing event — invoice, payment, refund, credit,
 * revenue recognition — posts a balanced journal here and only here.
 *
 * Postings are idempotent per (source_type, source_id, event_type): re-running
 * reconciliation, retrying a webhook, or replaying a cron never double-posts.
 */

export const PLATFORM_ACCOUNTS = {
  AR: { code: "1100", name: "Accounts Receivable" },
  CASH: { code: "1000", name: "Cash & Bank Clearing" },
  REVENUE: { code: "4000", name: "Subscription Revenue" },
  DEFERRED: { code: "2300", name: "Deferred Revenue" },
  GST_OUTPUT: { code: "2200", name: "GST Output Payable" },
  CUSTOMER_CREDIT: { code: "2400", name: "Customer Credit Liability" },
  REFUNDS: { code: "5000", name: "Refunds & Sales Returns" },
  CREDIT_EXPENSE: { code: "5100", name: "Credits & Adjustments" },
} as const

type Account = { code: string; name: string }

export type JournalLine = {
  account_code: string
  account_name: string
  debit: number
  credit: number
}

export type SourceType = "invoice" | "payment" | "refund" | "credit" | "recognition"

/**
 * Accumulates balanced double-entry lines. `debit`/`credit` amounts are always
 * non-negative; a negative input (e.g. a credit note) is posted to the opposite
 * side with its absolute value so debits and credits stay clean and balanced.
 */
class JournalBuilder {
  private lines: JournalLine[] = []
  debit(account: Account, amount: number) {
    this.post(account, amount, true)
    return this
  }
  credit(account: Account, amount: number) {
    this.post(account, amount, false)
    return this
  }
  private post(account: Account, amount: number, asDebit: boolean) {
    const amt = round2(amount)
    if (amt === 0) return
    const debitSide = amt > 0 ? asDebit : !asDebit
    const value = Math.abs(amt)
    this.lines.push({
      account_code: account.code,
      account_name: account.name,
      debit: debitSide ? value : 0,
      credit: debitSide ? 0 : value,
    })
  }
  build(): JournalLine[] {
    return this.lines
  }
}

export function totalDebit(lines: JournalLine[]): number {
  return round2(lines.reduce((s, l) => s + l.debit, 0))
}
export function totalCredit(lines: JournalLine[]): number {
  return round2(lines.reduce((s, l) => s + l.credit, 0))
}
export function isBalanced(lines: JournalLine[]): boolean {
  return totalDebit(lines) === totalCredit(lines)
}

// ── Pure journal builders (unit-testable without a DB) ──────────────────────

type InvoiceLike = {
  total: number
  tax_total?: number | null
  credit_applied?: number | null
}

/**
 * Invoice posting. Dr Accounts Receivable for the gross total; Cr Revenue (or
 * Deferred Revenue for a prepaid multi-month subscription) for the net-of-tax
 * portion; Cr GST Output Payable for the tax. Any account credit the customer
 * applied moves Dr Customer Credit / Cr AR so AR reflects the cash actually due.
 * A credit note (negative total) reverses every leg automatically.
 */
export function buildInvoiceJournal(inv: InvoiceLike, opts: { deferred?: boolean } = {}): JournalLine[] {
  const total = round2(inv.total)
  const tax = round2(inv.tax_total ?? 0)
  const creditApplied = round2(inv.credit_applied ?? 0)
  const revenuePortion = round2(total - tax)
  const b = new JournalBuilder()
  b.debit(PLATFORM_ACCOUNTS.AR, total)
  b.credit(opts.deferred ? PLATFORM_ACCOUNTS.DEFERRED : PLATFORM_ACCOUNTS.REVENUE, revenuePortion)
  b.credit(PLATFORM_ACCOUNTS.GST_OUTPUT, tax)
  if (creditApplied > 0) {
    b.debit(PLATFORM_ACCOUNTS.CUSTOMER_CREDIT, creditApplied)
    b.credit(PLATFORM_ACCOUNTS.AR, creditApplied)
  }
  return b.build()
}

/** Payment received: Dr Cash / Cr Accounts Receivable. */
export function buildPaymentJournal(amount: number): JournalLine[] {
  return new JournalBuilder().debit(PLATFORM_ACCOUNTS.CASH, amount).credit(PLATFORM_ACCOUNTS.AR, amount).build()
}

/**
 * Refund: Dr Refunds & Sales Returns (contra revenue). Credit Cash for a money
 * refund, or Customer Credit when the refund is issued as store credit.
 */
export function buildRefundJournal(amount: number, opts: { asCredit?: boolean } = {}): JournalLine[] {
  const b = new JournalBuilder().debit(PLATFORM_ACCOUNTS.REFUNDS, amount)
  if (opts.asCredit) b.credit(PLATFORM_ACCOUNTS.CUSTOMER_CREDIT, amount)
  else b.credit(PLATFORM_ACCOUNTS.CASH, amount)
  return b.build()
}

/** Account credit granted: Dr Credits & Adjustments / Cr Customer Credit. */
export function buildCreditGrantJournal(amount: number): JournalLine[] {
  return new JournalBuilder()
    .debit(PLATFORM_ACCOUNTS.CREDIT_EXPENSE, amount)
    .credit(PLATFORM_ACCOUNTS.CUSTOMER_CREDIT, amount)
    .build()
}

/** Revenue recognition tick: Dr Deferred Revenue / Cr Revenue. */
export function buildRecognitionJournal(amount: number): JournalLine[] {
  return new JournalBuilder()
    .debit(PLATFORM_ACCOUNTS.DEFERRED, amount)
    .credit(PLATFORM_ACCOUNTS.REVENUE, amount)
    .build()
}

// ── Schema ──────────────────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null
export function ensurePlatformLedgerSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS platform_journal (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_id INT NOT NULL,
          entry_no VARCHAR(32) NOT NULL,
          source_type VARCHAR(24) NOT NULL,
          source_id VARCHAR(64) NOT NULL,
          event_type VARCHAR(32) NOT NULL,
          entry_date DATE NOT NULL,
          memo VARCHAR(255) NULL,
          total_debit DECIMAL(14,2) NOT NULL DEFAULT 0,
          total_credit DECIMAL(14,2) NOT NULL DEFAULT 0,
          created_by VARCHAR(64) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_platform_journal_src (tenant_id, source_type, source_id, event_type),
          KEY idx_platform_journal_tenant (tenant_id, entry_date)
        )
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS platform_journal_lines (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_id INT NOT NULL,
          journal_id INT NOT NULL,
          account_code VARCHAR(16) NOT NULL,
          account_name VARCHAR(64) NOT NULL,
          debit DECIMAL(14,2) NOT NULL DEFAULT 0,
          credit DECIMAL(14,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_platform_journal_lines_journal (journal_id),
          KEY idx_platform_journal_lines_acct (tenant_id, account_code)
        )
      `)
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

// ── Posting (idempotent, tenant-scoped) ─────────────────────────────────────

export type PostJournalInput = {
  sourceType: SourceType
  sourceId: string | number
  eventType: string
  entryDate: string
  memo?: string | null
  lines: JournalLine[]
}

export type PostJournalResult = {
  journalId: number
  entryNo: string
  posted: boolean // false when it already existed (idempotent no-op)
}

/**
 * Persist a balanced journal for the current tenant. No-ops (returns the
 * existing entry) when the same (source_type, source_id, event_type) was already
 * posted, guaranteeing idempotency under retries/replays. Rejects unbalanced
 * journals so the platform books can never drift.
 */
export async function postJournal(
  input: PostJournalInput,
  session?: SessionPayload | null,
): Promise<PostJournalResult> {
  const lines = input.lines.filter((l) => l.debit !== 0 || l.credit !== 0)
  if (lines.length === 0) return { journalId: 0, entryNo: "", posted: false }
  if (!isBalanced(lines)) {
    throw new Error(
      `platform-ledger: refusing to post unbalanced journal (Dr ${totalDebit(lines)} != Cr ${totalCredit(lines)})`,
    )
  }
  await ensurePlatformLedgerSchema()
  const tenantId = currentTenantId()
  const sourceId = String(input.sourceId)

  const existing = await query<any[]>(
    `SELECT id, entry_no FROM platform_journal
      WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND event_type = ? LIMIT 1`,
    [tenantId, input.sourceType, sourceId, input.eventType],
  )
  if (existing[0]) {
    return { journalId: Number(existing[0].id), entryNo: String(existing[0].entry_no), posted: false }
  }

  const entryNo = await nextRecordId("PJNL", { digits: 6 })
  const dr = totalDebit(lines)
  const cr = totalCredit(lines)
  const res = await query<any>(
    `INSERT INTO platform_journal
      (tenant_id, entry_no, source_type, source_id, event_type, entry_date, memo, total_debit, total_credit, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      entryNo,
      input.sourceType,
      sourceId,
      input.eventType,
      String(input.entryDate).slice(0, 10),
      input.memo ?? null,
      dr,
      cr,
      session?.userId != null ? String(session.userId) : null,
    ],
  )
  const journalId = Number(res?.insertId ?? 0)
  for (const l of lines) {
    await query(
      `INSERT INTO platform_journal_lines
        (tenant_id, journal_id, account_code, account_name, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tenantId, journalId, l.account_code, l.account_name, l.debit, l.credit],
    )
  }
  return { journalId, entryNo, posted: true }
}

// ── Read model ──────────────────────────────────────────────────────────────

export type AccountBalance = {
  account_code: string
  account_name: string
  debit: number
  credit: number
  balance: number // Dr positive, Cr negative
}

/** Trial balance across the tenant's platform ledger (all balanced to zero). */
export async function getPlatformTrialBalance(): Promise<{
  accounts: AccountBalance[]
  totalDebit: number
  totalCredit: number
  balanced: boolean
}> {
  await ensurePlatformLedgerSchema()
  const rows = await tenantSelect<any[]>("platform_journal_lines", {
    columns:
      "account_code, MAX(account_name) AS account_name, SUM(debit) AS debit, SUM(credit) AS credit",
    tail: "GROUP BY account_code ORDER BY account_code",
  })
  const accounts: AccountBalance[] = rows.map((r) => {
    const debit = round2(Number(r.debit) || 0)
    const credit = round2(Number(r.credit) || 0)
    return {
      account_code: String(r.account_code),
      account_name: String(r.account_name),
      debit,
      credit,
      balance: round2(debit - credit),
    }
  })
  const td = round2(accounts.reduce((s, a) => s + a.debit, 0))
  const tc = round2(accounts.reduce((s, a) => s + a.credit, 0))
  return { accounts, totalDebit: td, totalCredit: tc, balanced: td === tc }
}

/** Recent journal headers for the tenant's platform ledger. */
export async function listPlatformJournal(limit = 100): Promise<any[]> {
  await ensurePlatformLedgerSchema()
  return tenantSelect<any[]>("platform_journal", {
    tail: `ORDER BY entry_date DESC, id DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  })
}
