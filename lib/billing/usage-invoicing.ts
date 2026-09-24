import "server-only"
/**
 * Usage-based billing — persistence + reconciliation (Spec 5).
 * ---------------------------------------------------------------------------
 * Composes the pure core in lib/billing/usage-billing.ts with the database:
 *
 *   - usage_allowances       : per-tenant plan allowance + overage rate per
 *                              meter (tenant-visible plan configuration).
 *   - usage_billing_ledger   : per (subscription, billing period, meter) record
 *                              of how many overage units / how much money has
 *                              already been invoiced. This is what makes
 *                              reconciliation idempotent — a re-run bills only
 *                              the delta above what the ledger already recorded,
 *                              so late events add exactly the new overage and a
 *                              duplicate run charges nothing.
 *
 * All access is tenant-scoped (tenant_id derived from session context, never
 * trusted from input) and both tables are registered in lib/tenant-tables.ts so
 * the isolation guard protects them.
 */
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"
import type { SessionPayload } from "@/lib/auth"
import { getMeter, getPeriodUsage, isMeterKey, METER_CATALOG } from "@/lib/billing/usage-metering"
import { reconcileUsageLines, type UsageBillingItem } from "@/lib/billing/usage-billing"
import { createInvoice } from "@/lib/billing/billing-engine"
import { getSubscriptionView } from "@/lib/billing/subscription-engine"

let schemaEnsured = false

export async function ensureUsageBillingSchema(): Promise<void> {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS usage_allowances (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      meter_key VARCHAR(60) NOT NULL,
      allowance DECIMAL(18,4) NOT NULL DEFAULT 0,
      overage_rate DECIMAL(18,6) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_usage_allowances (tenant_id, meter_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS usage_billing_ledger (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT UNSIGNED NOT NULL,
      subscription_id BIGINT UNSIGNED NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      meter_key VARCHAR(60) NOT NULL,
      billed_units DECIMAL(18,4) NOT NULL DEFAULT 0,
      billed_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
      invoice_id BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_usage_ledger (tenant_id, subscription_id, period_start, meter_key),
      KEY idx_usage_ledger_sub (tenant_id, subscription_id, period_start)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

// ── Allowances (tenant-visible plan configuration) ───────────────────────────

export type Allowance = {
  meterKey: string
  label: string
  unit: string
  allowance: number
  overageRate: number
  currency: string
  isActive: boolean
}

type AllowanceRow = {
  meter_key: string
  allowance: number
  overage_rate: number
  currency: string
  is_active: number
}

/** All configured allowances for the current tenant, keyed by meter. */
export async function getAllowanceMap(): Promise<Map<string, AllowanceRow>> {
  const tenantId = currentTenantId()
  await ensureUsageBillingSchema()
  const rows = await query<AllowanceRow[]>(
    `SELECT meter_key, allowance, overage_rate, currency, is_active
       FROM usage_allowances WHERE tenant_id = ?`,
    [tenantId],
  )
  const map = new Map<string, AllowanceRow>()
  for (const r of rows) map.set(r.meter_key, r)
  return map
}

/** Allowances joined with meter metadata for display. Only counter meters. */
export async function listAllowances(): Promise<Allowance[]> {
  const map = await getAllowanceMap()
  return METER_CATALOG.filter((m) => m.kind === "counter").map((m) => {
    const row = map.get(m.key)
    return {
      meterKey: m.key,
      label: m.label,
      unit: m.unit,
      allowance: row ? Number(row.allowance) : 0,
      overageRate: row ? Number(row.overage_rate) : 0,
      currency: row?.currency ?? "USD",
      isActive: row ? Boolean(row.is_active) : false,
    }
  })
}

export type AllowanceInput = {
  meterKey: string
  allowance: number
  overageRate: number
  currency?: string
  isActive?: boolean
}

/** Create or update a tenant's allowance + overage rate for a meter. */
export async function setAllowance(input: AllowanceInput): Promise<void> {
  if (!isMeterKey(input.meterKey)) throw new Error("Unknown meter")
  const meter = getMeter(input.meterKey)
  if (meter?.kind !== "counter") throw new Error("Allowances apply to metered (counter) resources only")
  const allowance = Number(input.allowance)
  const overageRate = Number(input.overageRate)
  if (!Number.isFinite(allowance) || allowance < 0) throw new Error("Invalid allowance")
  if (!Number.isFinite(overageRate) || overageRate < 0) throw new Error("Invalid overage rate")
  const tenantId = currentTenantId()
  await ensureUsageBillingSchema()
  await query(
    `INSERT INTO usage_allowances (tenant_id, meter_key, allowance, overage_rate, currency, is_active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       allowance = VALUES(allowance),
       overage_rate = VALUES(overage_rate),
       currency = VALUES(currency),
       is_active = VALUES(is_active)`,
    [
      tenantId,
      input.meterKey,
      allowance,
      overageRate,
      String(input.currency || "USD").trim(),
      input.isActive === false ? 0 : 1,
    ],
  )
}

export async function clearAllowance(meterKey: string): Promise<void> {
  const tenantId = currentTenantId()
  await ensureUsageBillingSchema()
  await query(`DELETE FROM usage_allowances WHERE tenant_id = ? AND meter_key = ?`, [tenantId, meterKey])
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export type ReconcileResult = {
  subscriptionId: number
  periodStart: string
  periodEnd: string
  invoiceId: number | null
  lines: Array<{ meterKey: string; quantity: number; amount: number }>
  total: number
  /** True when there was nothing new to bill (zero-usage / duplicate run). */
  noop: boolean
}

type LedgerRow = { meter_key: string; billed_units: number }

/**
 * Reconcile a subscription's metered usage for its CURRENT billing period into
 * at most one invoice with one line per metric. Idempotent: overage already
 * recorded in usage_billing_ledger is subtracted, so:
 *   - a first run bills the full overage,
 *   - a re-run after late events bills only the incremental overage,
 *   - a duplicate run with no new usage creates no invoice,
 *   - a mid-cycle upgrade (larger allowance) reduces or removes overage.
 *
 * Only meters with a configured, active allowance carrying a positive overage
 * rate are billed. Tenant scope is enforced throughout.
 */
export async function reconcileSubscriptionUsage(
  subscriptionId: number,
  session: SessionPayload,
  options: { finalize?: boolean } = {},
): Promise<ReconcileResult> {
  const tenantId = currentTenantId()
  await ensureUsageBillingSchema()

  const sub = await getSubscriptionView(subscriptionId)
  if (!sub) throw new Error("Subscription not found")

  const periodStart = sub.current_period_start
  const periodEnd = sub.current_period_end

  const [usage, allowanceMap, ledgerRows] = await Promise.all([
    // Usage summed over [periodStart, periodEnd). Usage on the renewal date
    // belongs to the next period.
    getPeriodUsage(periodStart, periodEnd),
    getAllowanceMap(),
    query<LedgerRow[]>(
      `SELECT meter_key, billed_units FROM usage_billing_ledger
        WHERE tenant_id = ? AND subscription_id = ? AND period_start = ?`,
      [tenantId, subscriptionId, periodStart],
    ),
  ])

  const billedByMeter = new Map<string, number>()
  for (const r of ledgerRows) billedByMeter.set(r.meter_key, Number(r.billed_units))

  const items: UsageBillingItem[] = []
  for (const [meterKey, row] of allowanceMap) {
    if (!row.is_active) continue
    const meter = getMeter(meterKey)
    if (!meter || meter.kind !== "counter") continue
    items.push({
      meterKey,
      label: meter.label,
      unit: meter.unit,
      used: Number(usage.get(meterKey) ?? 0),
      allowance: Number(row.allowance),
      overageRate: Number(row.overage_rate),
      alreadyBilledUnits: billedByMeter.get(meterKey) ?? 0,
    })
  }

  const { lines, total } = reconcileUsageLines(items)

  if (lines.length === 0) {
    return {
      subscriptionId,
      periodStart,
      periodEnd,
      invoiceId: null,
      lines: [],
      total: 0,
      noop: true,
    }
  }

  const invoice = await createInvoice(
    {
      invoice_type: "one_time",
      subscription_id: subscriptionId,
      customer_name: (sub as any).customer_name ?? sub.plan_name,
      currency: sub.currency,
      period_start: periodStart,
      period_end: periodEnd,
      memo: `Usage overage — ${periodStart} to ${periodEnd}`,
      finalize: options.finalize !== false,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_amount: l.unitAmount,
        line_type: "usage",
        taxable: true,
      })),
    },
    session,
  )

  // Record what we just billed so the NEXT reconciliation only bills the delta.
  // billed_units accumulates the cumulative overage billed for the period.
  for (const l of lines) {
    await query(
      `INSERT INTO usage_billing_ledger
         (tenant_id, subscription_id, period_start, period_end, meter_key, billed_units, billed_amount, invoice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         billed_units = billed_units + VALUES(billed_units),
         billed_amount = billed_amount + VALUES(billed_amount),
         invoice_id = VALUES(invoice_id),
         period_end = VALUES(period_end)`,
      [tenantId, subscriptionId, periodStart, periodEnd, l.meterKey, l.quantity, l.amount, invoice.id],
    )
  }

  return {
    subscriptionId,
    periodStart,
    periodEnd,
    invoiceId: invoice.id,
    lines: lines.map((l) => ({ meterKey: l.meterKey, quantity: l.quantity, amount: l.amount })),
    total,
    noop: false,
  }
}
