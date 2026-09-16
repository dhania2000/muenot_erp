import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { ensureInvestmentSchema, ACTIVE_STATUSES } from "@/lib/finance-investments"
import { emitReminder, financeRecipients, todayIso } from "@/lib/finance-automation-shared"

/**
 * Phase 11 — Investments maturity / income reminders.
 *
 * A read-only sweep over the live holdings. It never posts a voucher — the
 * actual maturity redemption or income receipt is a real bank event a human
 * records through the module — it raises deduped in-app reminders so nothing is
 * missed:
 *
 *   • Maturity — a still-active holding whose `maturity_date` has passed (or is
 *     within a short look-ahead window) needs redeeming / rolling over.
 *   • Income — an interest/coupon-bearing holding (expected_return_rate > 0)
 *     that has been held for a full year since its last recorded income event
 *     (or since acquisition) likely has income to book.
 *
 * Duplicate prevention: maturity reminders are keyed by investment + bucket
 * (`upcoming` vs `matured`); income reminders are keyed by investment + the
 * annual period they cover, so each holding raises at most one alert per event.
 */

const FEATURE = "investments"
const LINK = "/modules/finance/investments"
const MATURITY_LOOK_AHEAD_DAYS = 15
const INCOME_INTERVAL_DAYS = 365

export type InvestmentReminderResult = {
  ran_at: string
  as_of: string
  maturity: number
  income: number
  notifications: number
}

function fmt(n: number): string {
  return round2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso)
  const b = Date.parse(toIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.floor((b - a) / 86_400_000)
}

export async function runInvestmentReminders(asOfInput?: string | null): Promise<InvestmentReminderResult> {
  await ensureInvestmentSchema()
  const asOf = (asOfInput || todayIso()).slice(0, 10)
  const active = Array.from(ACTIVE_STATUSES)

  const rows = (await query(
    `SELECT investment_id, investment_name, investment_type, status,
            acquisition_date, maturity_date, expected_return_rate,
            amount, invested_amount, current_value, income_received
       FROM investments
      WHERE status IN (${active.map(() => "?").join(",")})
      ORDER BY maturity_date ASC, investment_id ASC`,
    active,
  ).catch(() => [])) as any[]

  const recipients = rows.length ? await financeRecipients(FEATURE) : []

  let maturity = 0
  let income = 0
  let notifications = 0

  for (const r of rows) {
    const id = String(r.investment_id)
    const name = r.investment_name ? ` — ${r.investment_name}` : ""
    const principal = round2(num(r.invested_amount) || num(r.amount))

    // ── Maturity ──────────────────────────────────────────────────────────
    const maturityDate = r.maturity_date ? String(r.maturity_date).slice(0, 10) : null
    if (maturityDate) {
      const days = daysBetween(asOf, maturityDate) // negative once matured
      if (days <= MATURITY_LOOK_AHEAD_DAYS) {
        const matured = maturityDate <= asOf
        const bucket = matured ? "matured" : "upcoming"
        maturity += 1
        notifications += await emitReminder(
          {
            key: `inv-maturity:${id}:${bucket}`,
            type: "finance-investment",
            title: matured ? `Investment matured: ${id}` : `Investment maturing soon: ${id}`,
            body: `${r.investment_type || "Investment"}${name} of ${fmt(principal)} ${
              matured ? "matured" : "matures"
            } on ${maturityDate}. Record the redemption / roll-over.`,
            link: LINK,
            entityType: "investments",
            entityId: id,
          },
          recipients,
        )
      }
    }

    // ── Income ────────────────────────────────────────────────────────────
    const rate = num(r.expected_return_rate)
    const acquired = r.acquisition_date ? String(r.acquisition_date).slice(0, 10) : null
    if (rate > 0 && acquired) {
      // Anchor the income period to the last completed year since acquisition.
      const heldDays = daysBetween(acquired, asOf)
      if (heldDays >= INCOME_INTERVAL_DAYS) {
        const periodsElapsed = Math.floor(heldDays / INCOME_INTERVAL_DAYS)
        const estAnnual = round2((principal * rate) / 100)
        income += 1
        notifications += await emitReminder(
          {
            key: `inv-income:${id}:${periodsElapsed}`,
            type: "finance-investment",
            title: `Investment income due: ${id}`,
            body: `${r.investment_type || "Investment"}${name} at ${rate}% p.a. — approx ${fmt(
              estAnnual,
            )} income likely accrued. Record the interest / dividend receipt.`,
            link: LINK,
            entityType: "investments",
            entityId: id,
          },
          recipients,
        )
      }
    }
  }

  return { ran_at: new Date().toISOString(), as_of: asOf, maturity, income, notifications }
}
