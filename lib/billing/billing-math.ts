/**
 * Billing engine (pure, dependency-free financial core).
 * ---------------------------------------------------------------------------
 * Every money calculation in the billing engine lives here as pure, total
 * functions so the "financial edge cases" phase can be unit-tested without a
 * database or request context. The DB-backed service in
 * lib/billing/billing-engine.ts composes these with persistence, validation,
 * authorization and audit.
 *
 * Money convention:
 *  - All amounts are handled as decimal currency units (e.g. dollars) and are
 *    rounded to 2 dp (cents) at every observable boundary via `round2` to avoid
 *    binary-float drift. Intermediate sums may hold more precision but every
 *    persisted/returned figure is cent-rounded.
 *  - Never emit negative charges from a discount/tax/credit: each component is
 *    clamped so an invoice total can never go below zero from over-application.
 */

// ── Rounding ──────────────────────────────────────────────────────────────

/** Round to 2 decimal places (cents) using round-half-away-from-zero. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  // Scale, add a tiny epsilon in the number's direction to defeat 1.005-style
  // float representation errors, then round.
  const sign = n < 0 ? -1 : 1
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100
}

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)

// ── Line items ──────────────────────────────────────────────────────────────

export type DiscountType = "percent" | "fixed"

export type LineInput = {
  description?: string
  quantity: number
  unitAmount: number
  taxable?: boolean
  /** Line kind, purely informational for totalling. */
  lineType?: "subscription" | "one_time" | "proration" | "adjustment"
}

export type ComputedLine = LineInput & {
  taxable: boolean
  lineType: "subscription" | "one_time" | "proration" | "adjustment"
  amount: number
}

/** Extend a single line: amount = round2(quantity * unitAmount). */
export function computeLine(line: LineInput): ComputedLine {
  const quantity = Number(line.quantity)
  const unitAmount = Number(line.unitAmount)
  const amount = round2((Number.isFinite(quantity) ? quantity : 0) * (Number.isFinite(unitAmount) ? unitAmount : 0))
  return {
    description: line.description,
    quantity,
    unitAmount,
    taxable: line.taxable !== false,
    lineType: line.lineType ?? "one_time",
    amount,
  }
}

// ── Discounts & coupons ───────────────────────────────────────────────────

export type Discount = { type: DiscountType; value: number }

/**
 * Discount amount for a base, clamped to [0, base]. Percentages are clamped to
 * 0–100; fixed amounts never exceed the base (no negative invoice).
 */
export function computeDiscount(base: number, discount: Discount | null | undefined): number {
  const b = nonNeg(base)
  if (!discount || b === 0) return 0
  const value = nonNeg(discount.value)
  if (discount.type === "percent") {
    return round2((b * clamp(value, 0, 100)) / 100)
  }
  return round2(Math.min(value, b))
}

export type Coupon = {
  discount_type: DiscountType
  value: number
  currency?: string
  min_amount?: number | null
  valid_from?: string | null
  valid_until?: string | null
  is_active?: boolean
  max_redemptions?: number | null
  times_redeemed?: number
}

export type CouponEvaluation = {
  applicable: boolean
  reason: string | null
  discount: number
}

/**
 * Evaluate a coupon against an order at a given date. Pure: performs no I/O and
 * enforces active flag, date window, redemption cap and minimum spend. Returns
 * the clamped discount amount when applicable.
 */
export function evaluateCoupon(
  coupon: Coupon | null | undefined,
  base: number,
  opts: { onDate?: string; currency?: string } = {},
): CouponEvaluation {
  const none = (reason: string): CouponEvaluation => ({ applicable: false, reason, discount: 0 })
  if (!coupon) return none("Coupon not found")
  const b = nonNeg(base)
  const onDate = (opts.onDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
  if (coupon.is_active === false) return none("Coupon is not active")
  if (coupon.valid_from && onDate < coupon.valid_from.slice(0, 10)) return none("Coupon is not yet valid")
  if (coupon.valid_until && onDate > coupon.valid_until.slice(0, 10)) return none("Coupon has expired")
  if (
    coupon.max_redemptions != null &&
    Number(coupon.times_redeemed ?? 0) >= Number(coupon.max_redemptions)
  ) {
    return none("Coupon redemption limit reached")
  }
  if (opts.currency && coupon.currency && opts.currency !== coupon.currency) {
    return none("Coupon currency mismatch")
  }
  if (coupon.min_amount != null && b < Number(coupon.min_amount)) {
    return none(`Order below coupon minimum of ${Number(coupon.min_amount)}`)
  }
  const discount = computeDiscount(b, { type: coupon.discount_type, value: coupon.value })
  if (discount <= 0) return none("Coupon yields no discount")
  return { applicable: true, reason: null, discount }
}

// ── Tax ───────────────────────────────────────────────────────────────────

/** Tax on a base at a percentage rate, clamped to a non-negative rate. */
export function computeTax(taxableBase: number, ratePercent: number): number {
  const b = nonNeg(taxableBase)
  const rate = nonNeg(ratePercent)
  return round2((b * rate) / 100)
}

// ── Credits ─────────────────────────────────────────────────────────────────

/**
 * Apply available account credit to an amount due. Never applies more than the
 * amount due or the available balance; both are floored at zero.
 */
export function applyCredit(
  amountDue: number,
  creditAvailable: number,
): { applied: number; remainingDue: number; remainingCredit: number } {
  const due = nonNeg(amountDue)
  const credit = nonNeg(creditAvailable)
  const applied = round2(Math.min(due, credit))
  return {
    applied,
    remainingDue: round2(due - applied),
    remainingCredit: round2(credit - applied),
  }
}

// ── Invoice totalling ─────────────────────────────────────────────────────

export type InvoiceComputationInput = {
  lines: LineInput[]
  /** Order-level discount applied to the subtotal before tax. */
  discount?: Discount | null
  /** Coupon discount amount already evaluated (in currency units). */
  couponDiscount?: number
  /** Tax rate percentage applied to the taxable base after discounts. */
  taxRatePercent?: number
  /** Signed manual adjustment applied after tax (can be +/-). */
  adjustment?: number
  /** Account credit available to consume against the post-tax total. */
  creditAvailable?: number
  /** When true, prices are tax-inclusive: tax is extracted, not added. */
  taxInclusive?: boolean
}

export type InvoiceTotals = {
  subtotal: number
  discountTotal: number
  couponDiscount: number
  discountedSubtotal: number
  taxableBase: number
  taxTotal: number
  adjustmentTotal: number
  creditApplied: number
  total: number
  /** Total before credit is applied (what the invoice face value is). */
  invoiceTotal: number
  amountDue: number
}

/**
 * Compute an invoice's full money breakdown from its lines and modifiers.
 * Order of operations:
 *   1. subtotal = Σ line amounts
 *   2. discounts (order discount + coupon) reduce subtotal, clamped to subtotal
 *   3. tax applies to the *taxable* portion of the discounted subtotal
 *   4. adjustment (signed) applies after tax
 *   5. invoiceTotal is floored at zero
 *   6. credit is applied against invoiceTotal to yield amountDue
 */
export function computeInvoice(input: InvoiceComputationInput): InvoiceTotals {
  const lines = (input.lines ?? []).map(computeLine)
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))

  const orderDiscount = computeDiscount(subtotal, input.discount)
  const couponDiscount = round2(clamp(nonNeg(input.couponDiscount ?? 0), 0, subtotal - orderDiscount))
  const discountTotal = round2(orderDiscount + couponDiscount)
  const discountedSubtotal = round2(Math.max(0, subtotal - discountTotal))

  // Taxable proportion: the share of the discounted subtotal that came from
  // taxable lines. Discounts are spread pro-rata across taxable & non-taxable.
  const taxableGross = round2(lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0))
  const taxableShare = subtotal > 0 ? taxableGross / subtotal : 0
  const taxableBase = round2(discountedSubtotal * taxableShare)

  const rate = nonNeg(input.taxRatePercent ?? 0)
  let taxTotal: number
  let baseForTotal: number
  if (input.taxInclusive) {
    // Prices already include tax: extract the tax component from the taxable base.
    taxTotal = round2(taxableBase - taxableBase / (1 + rate / 100))
    baseForTotal = discountedSubtotal // total already includes tax
  } else {
    taxTotal = computeTax(taxableBase, rate)
    baseForTotal = round2(discountedSubtotal + taxTotal)
  }

  const adjustmentTotal = round2(Number.isFinite(input.adjustment as number) ? (input.adjustment as number) : 0)
  const invoiceTotal = round2(Math.max(0, baseForTotal + adjustmentTotal))

  const { applied: creditApplied, remainingDue } = applyCredit(invoiceTotal, input.creditAvailable ?? 0)

  return {
    subtotal,
    discountTotal,
    couponDiscount,
    discountedSubtotal,
    taxableBase,
    taxTotal,
    adjustmentTotal,
    creditApplied,
    total: invoiceTotal,
    invoiceTotal,
    amountDue: remainingDue,
  }
}

// ── Proration (upgrade / downgrade / mid-cycle changes) ─────────────────────

const DAY_MS = 86_400_000

function toUTC(dateStr: string): number {
  return new Date(`${String(dateStr).slice(0, 10)}T00:00:00.000Z`).getTime()
}

/** Whole days from `from` to `to` (>= 0 clamps handled by callers). */
export function daysBetween(fromStr: string, toStr: string): number {
  return Math.round((toUTC(toStr) - toUTC(fromStr)) / DAY_MS)
}

export type ProrationInput = {
  periodStart: string
  periodEnd: string
  changeDate: string
  amount: number
}

/**
 * The unused (remaining) value of a period's charge as of `changeDate`, on a
 * whole-day basis. Used to credit back the old plan when switching mid-cycle.
 *
 *   unused = amount * remainingDays / totalDays
 *
 * Clamped so it is always within [0, amount]. A zero/negative-length period
 * yields 0 to avoid divide-by-zero.
 */
export function unusedProration(input: ProrationInput): number {
  const totalDays = daysBetween(input.periodStart, input.periodEnd)
  if (totalDays <= 0) return 0
  const change = clamp(daysBetween(input.periodStart, input.changeDate), 0, totalDays)
  const remainingDays = totalDays - change
  return round2((nonNeg(input.amount) * remainingDays) / totalDays)
}

/** The used (consumed) value of a period's charge as of `changeDate`. */
export function usedProration(input: ProrationInput): number {
  const total = round2(nonNeg(input.amount))
  return round2(total - unusedProration(input))
}

export type PlanChangeInput = {
  oldAmount: number
  newAmount: number
  periodStart: string
  periodEnd: string
  changeDate: string
}

export type PlanChangeResult = {
  kind: "upgrade" | "downgrade" | "no_change"
  /** Credit for the unused portion of the old plan. */
  unusedCredit: number
  /** Charge for the remaining portion of the new plan. */
  remainingCharge: number
  /** Net amount owed now (positive) or credited back (negative). */
  netAmount: number
}

/**
 * Compute the proration for an immediate mid-cycle plan change. The customer is
 * credited the unused portion of the old plan and charged the prorated portion
 * of the new plan for the remainder of the current period.
 *
 *   netAmount = remainingCharge(new) - unusedCredit(old)
 *
 * A positive net is billed now (typical upgrade); a negative net becomes a
 * credit to the account balance (typical downgrade).
 */
export function computePlanChange(input: PlanChangeInput): PlanChangeResult {
  const unusedCredit = unusedProration({
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    changeDate: input.changeDate,
    amount: input.oldAmount,
  })
  const remainingCharge = unusedProration({
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    changeDate: input.changeDate,
    amount: input.newAmount,
  })
  const netAmount = round2(remainingCharge - unusedCredit)
  const kind: PlanChangeResult["kind"] =
    netAmount > 0 ? "upgrade" : netAmount < 0 ? "downgrade" : "no_change"
  return { kind, unusedCredit, remainingCharge, netAmount }
}

export type TermChangeInput = {
  oldAmount: number
  /** Full price of the NEW term (billed in full because the period restarts). */
  newAmount: number
  periodStart: string
  periodEnd: string
  changeDate: string
}

/**
 * Proration when the billing TERM changes (e.g. monthly → five-year). Periods of
 * different lengths cannot be prorated against each other, so the period
 * restarts on the change date: the customer is credited the unused portion of
 * the old period and charged the full new term.
 */
export function computeTermChange(input: TermChangeInput): PlanChangeResult {
  const unusedCredit = unusedProration({
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    changeDate: input.changeDate,
    amount: input.oldAmount,
  })
  const remainingCharge = round2(nonNeg(input.newAmount))
  const netAmount = round2(remainingCharge - unusedCredit)
  const kind: PlanChangeResult["kind"] =
    netAmount > 0 ? "upgrade" : netAmount < 0 ? "downgrade" : "no_change"
  return { kind, unusedCredit, remainingCharge, netAmount }
}

/**
 * Whether a coupon may be applied to one more invoice for a subscription.
 * `once` coupons may only discount a single invoice per subscription; the
 * global max_redemptions cap is enforced atomically at reservation time.
 */
export function couponAllowedForSubscription(
  duration: string | null | undefined,
  priorUsesOnSubscription: number,
): { ok: boolean; reason: string | null } {
  if (duration === "once" && priorUsesOnSubscription > 0) {
    return { ok: false, reason: "This coupon has already been used on this subscription." }
  }
  return { ok: true, reason: null }
}

// ── Refunds ─────────────────────────────────────────────────────────────────

export type RefundableInput = {
  amountPaid: number
  amountRefunded: number
}

/** Maximum amount still refundable on an invoice/payment. */
export function refundableAmount(input: RefundableInput): number {
  return round2(Math.max(0, nonNeg(input.amountPaid) - nonNeg(input.amountRefunded)))
}

/** Validate a requested refund against what remains refundable. */
export function validateRefund(
  requested: number,
  input: RefundableInput,
): { ok: boolean; reason: string | null; amount: number } {
  const max = refundableAmount(input)
  const amount = round2(nonNeg(requested))
  if (amount <= 0) return { ok: false, reason: "Refund amount must be greater than zero", amount: 0 }
  if (amount > max) return { ok: false, reason: `Refund exceeds refundable amount of ${max}`, amount }
  return { ok: true, reason: null, amount }
}

// ── Invoice status derivation ───────────────────────────────────────────────

export type InvoiceStatus =
  | "draft"
  | "open"
  | "partially_paid"
  | "paid"
  | "refunded"
  | "void"
  | "uncollectible"

export type InvoiceMoneyState = {
  total: number
  amountPaid: number
  amountRefunded: number
  creditApplied?: number
}

/**
 * Derive an invoice's collection status from its money state. `void` and
 * `uncollectible` are sticky terminal states set explicitly by the service and
 * are passed through here.
 */
export function deriveInvoiceStatus(
  state: InvoiceMoneyState,
  opts: { finalized: boolean; sticky?: "void" | "uncollectible" | null } = { finalized: true },
): InvoiceStatus {
  if (opts.sticky) return opts.sticky
  if (!opts.finalized) return "draft"
  const total = round2(nonNeg(state.total))
  const paid = round2(nonNeg(state.amountPaid) + nonNeg(state.creditApplied ?? 0))
  const refunded = round2(nonNeg(state.amountRefunded))
  if (total > 0 && refunded >= round2(paid) && paid > 0) return "refunded"
  if (paid >= total && total >= 0 && paid > 0) return "paid"
  if (total === 0) return "paid"
  if (paid > 0) return "partially_paid"
  return "open"
}
