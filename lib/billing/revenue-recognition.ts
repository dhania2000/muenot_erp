import "server-only"
import { query } from "@/lib/db"
import { tenantSelect, tenantInsert, tenantUpdate, currentTenantId } from "@/lib/tenant-scope"
import { round2 } from "@/lib/billing/billing-math"
import { buildRecognitionSchedule } from "@/lib/billing/revenue-schedule"
import { buildRecognitionJournal, postJournal } from "@/lib/billing/platform-ledger"
import type { SessionPayload } from "@/lib/auth"

/**
 * Deferred revenue & recognition (DB service).
 * ---------------------------------------------------------------------------
 * When the platform bills a prepaid multi-month subscription up front, the
 * net-of-tax revenue is deferred and recognized straight-line across the
 * service months (#240-241). This module persists the schedule (built by the
 * pure lib/billing/revenue-schedule.ts) and, as each month falls due, posts a
 * Dr Deferred Revenue / Cr Revenue journal to the platform seller ledger.
 *
 * Everything is tenant-scoped and idempotent: a schedule is created once per
 * invoice, and each month recognizes at most once (guarded by a `recognized`
 * flag and the platform-ledger's own idempotent posting).
 */

let schemaReady: Promise<void> | null = null
export function ensureRevenueRecognitionSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS deferred_revenue_schedules (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_id INT NOT NULL,
          invoice_id INT NOT NULL,
          subscription_id INT NULL,
          currency VARCHAR(8) NOT NULL DEFAULT 'INR',
          total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
          months INT NOT NULL DEFAULT 1,
          start_date DATE NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_defrev_invoice (tenant_id, invoice_id),
          KEY idx_defrev_tenant (tenant_id)
        )
      `)
      await query(`
        CREATE TABLE IF NOT EXISTS deferred_revenue_entries (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_id INT NOT NULL,
          schedule_id INT NOT NULL,
          period_month CHAR(7) NOT NULL,
          period_start DATE NOT NULL,
          period_end DATE NOT NULL,
          amount DECIMAL(14,2) NOT NULL DEFAULT 0,
          recognized TINYINT NOT NULL DEFAULT 0,
          recognized_at DATE NULL,
          journal_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_defrev_entries_sched (schedule_id),
          KEY idx_defrev_entries_due (tenant_id, recognized, period_start)
        )
      `)
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

export type CreateScheduleInput = {
  invoiceId: number
  subscriptionId?: number | null
  amount: number
  months: number
  startDate: string
  currency?: string
}

/**
 * Create the deferred-revenue schedule for a prepaid invoice. Idempotent per
 * invoice: a second call returns the existing schedule id without duplicating.
 * `amount` is the net-of-tax revenue to spread.
 */
export async function createSchedule(input: CreateScheduleInput): Promise<{ scheduleId: number; created: boolean }> {
  await ensureRevenueRecognitionSchema()
  const tenantId = currentTenantId()
  const existing = await query<any[]>(
    `SELECT id FROM deferred_revenue_schedules WHERE tenant_id = ? AND invoice_id = ? LIMIT 1`,
    [tenantId, input.invoiceId],
  )
  if (existing[0]) return { scheduleId: Number(existing[0].id), created: false }

  const amount = round2(Math.abs(input.amount))
  const months = Math.max(1, Math.floor(input.months))
  const periods = buildRecognitionSchedule({ amount, startDate: input.startDate, months })
  if (periods.length === 0) return { scheduleId: 0, created: false }

  const { insertId } = await tenantInsert("deferred_revenue_schedules", {
    invoice_id: input.invoiceId,
    subscription_id: input.subscriptionId ?? null,
    currency: input.currency ?? "INR",
    total_amount: amount,
    months,
    start_date: String(input.startDate).slice(0, 10),
    status: "active",
  })
  for (const p of periods) {
    await tenantInsert("deferred_revenue_entries", {
      schedule_id: insertId,
      period_month: p.periodMonth,
      period_start: p.periodStart,
      period_end: p.periodEnd,
      amount: p.amount,
      recognized: 0,
    })
  }
  return { scheduleId: insertId, created: true }
}

/**
 * Recognize every scheduled month whose service period has started on or before
 * `asOfDate` and is not yet recognized. Posts one recognition journal per entry
 * to the platform ledger and flags the entry. Idempotent — already-recognized
 * entries are skipped and posting is itself idempotent.
 */
export async function recognizeDue(
  asOfDate: string,
  session?: SessionPayload | null,
): Promise<{ recognizedCount: number; recognizedAmount: number }> {
  await ensureRevenueRecognitionSchema()
  const asOf = String(asOfDate).slice(0, 10)
  const due = await tenantSelect<any[]>("deferred_revenue_entries", {
    where: "recognized = 0 AND period_start <= ?",
    params: [asOf],
    tail: "ORDER BY period_start ASC, id ASC",
  })
  let recognizedCount = 0
  let recognizedAmount = 0
  for (const entry of due) {
    const amount = round2(Number(entry.amount) || 0)
    const posting = await postJournal(
      {
        sourceType: "recognition",
        sourceId: entry.id,
        eventType: "revenue_recognized",
        entryDate: entry.period_start,
        memo: `Revenue recognition ${entry.period_month}`,
        lines: buildRecognitionJournal(amount),
      },
      session,
    )
    await tenantUpdate(
      "deferred_revenue_entries",
      { recognized: 1, recognized_at: asOf, journal_id: posting.journalId || null },
      "id = ?",
      [entry.id],
    )
    recognizedCount++
    recognizedAmount = round2(recognizedAmount + amount)
  }
  return { recognizedCount, recognizedAmount }
}

/** Deferred (unrecognized) vs recognized balance for the tenant. */
export async function getDeferredBalance(): Promise<{
  deferred: number
  recognized: number
  total: number
}> {
  await ensureRevenueRecognitionSchema()
  const rows = await tenantSelect<any[]>("deferred_revenue_entries", {
    columns:
      "SUM(CASE WHEN recognized = 0 THEN amount ELSE 0 END) AS deferred, SUM(CASE WHEN recognized = 1 THEN amount ELSE 0 END) AS recognized, SUM(amount) AS total",
  })
  const r = rows[0] ?? {}
  return {
    deferred: round2(Number(r.deferred) || 0),
    recognized: round2(Number(r.recognized) || 0),
    total: round2(Number(r.total) || 0),
  }
}

export async function listSchedules(limit = 100): Promise<any[]> {
  await ensureRevenueRecognitionSchema()
  return tenantSelect<any[]>("deferred_revenue_schedules", {
    tail: `ORDER BY id DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  })
}
