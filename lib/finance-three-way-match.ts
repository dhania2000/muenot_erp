import { num, round2 } from "@/lib/finance-calc"

/**
 * SPEC 141 / Spec37 (#201) — Purchase three-way matching *rules*.
 *
 * Pure, side-effect-free, database-free control logic that compares the three
 * procurement documents keyed by their stable IDs:
 *
 *   Purchase order  (what was ORDERED)  — quantity, unit price, taxable value
 *   Goods receipt   (what was RECEIVED) — accepted quantity, accepted value
 *   Vendor bill     (what was INVOICED) — billed quantity, unit price, taxable
 *
 * The same logic runs in the server guards (lib/finance-three-way-match-server)
 * and under Vitest with no MySQL. It never touches the database, session or
 * clock — every input is passed in — so the exact numbers a checker sees are
 * the exact numbers that hold or release payment.
 *
 * A dimension is `matched` when the invoice equals the order/receipt, only
 * `within_tolerance` when it differs by no more than the configured slack
 * (e.g. currency rounding), and an `exception` when it breaches the slack. Any
 * exception holds the bill's payment until an authorised checker approves it.
 */

// ---------------------------------------------------------------------------
// Configurable tolerances (per tenant). Percent fields are relative; the
// absolute amount slack absorbs currency rounding on the taxable value.
// ---------------------------------------------------------------------------

export type MatchTolerances = {
  /** Allowed over-billing of quantity, as a percent of the accepted quantity. */
  quantityPercent: number
  /** Allowed unit-price deviation from the PO price, as a percent. */
  pricePercent: number
  /** Allowed over-billing of value, as a percent of the received value. */
  amountPercent: number
  /** Absolute value slack (document currency) — absorbs rounding. */
  amountAbsolute: number
}

export const DEFAULT_TOLERANCES: MatchTolerances = {
  quantityPercent: 0,
  pricePercent: 0,
  amountPercent: 0,
  amountAbsolute: 1,
}

const TOLERANCE_BOUNDS = {
  quantityPercent: [0, 100],
  pricePercent: [0, 100],
  amountPercent: [0, 100],
  amountAbsolute: [0, 1_000_000],
} as const

/** Clamp arbitrary input into a safe, complete tolerance set. */
export function normalizeTolerances(raw: Partial<Record<keyof MatchTolerances, unknown>> | null | undefined): MatchTolerances {
  const out = { ...DEFAULT_TOLERANCES }
  if (raw) {
    for (const key of Object.keys(TOLERANCE_BOUNDS) as (keyof MatchTolerances)[]) {
      if (raw[key] == null || String(raw[key]).trim() === "") continue
      const [lo, hi] = TOLERANCE_BOUNDS[key]
      out[key] = Math.min(hi, Math.max(lo, round2(num(raw[key]))))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Mismatch taxonomy.
// ---------------------------------------------------------------------------

export type MismatchCategory =
  | "no_receipt"
  | "quantity_over"
  | "price_variance"
  | "amount_over"
  | "currency_mismatch"
  | "tax_mismatch"
  | "duplicate_bill"

export const MISMATCH_LABELS: Record<MismatchCategory, string> = {
  no_receipt: "No goods received",
  quantity_over: "Billed quantity exceeds received",
  price_variance: "Unit price differs from PO",
  amount_over: "Billed value exceeds received",
  currency_mismatch: "Currency differs from PO",
  tax_mismatch: "Tax rate differs from PO",
  duplicate_bill: "Duplicate vendor bill",
}

export type MatchDimensionStatus = "matched" | "within_tolerance" | "exception"

export type MatchDimension = "receipt" | "quantity" | "price" | "amount" | "currency" | "tax" | "duplicate"

export type MatchVariance = {
  dimension: MatchDimension
  label: string
  status: MatchDimensionStatus
  expected: number
  actual: number
  variance: number
  variancePercent: number
  tolerance: number
  category: MismatchCategory | null
  message: string | null
}

export type MatchStatus = "matched" | "matched_within_tolerance" | "exception"

/** One goods receipt on the PO, keyed by its stable GRN id (split receipts). */
export type MatchReceipt = {
  grnId: string
  receiptDate: string | null
  receivedQuantity: number
  acceptedQuantity: number
  rejectedQuantity: number
  receivedValue: number
}

/** Document-level context shown next to the variances as comparison evidence. */
export type MatchContext = {
  orderedQuantity: number
  acceptedQuantity: number
  billedQuantity: number
  cumulativeBilledQuantity: number
  receivedValue: number
  billTaxable: number
  cumulativeBilledTaxable: number
  /** Accepted quantity is still below the ordered quantity. */
  partialDelivery: boolean
  receipts: MatchReceipt[]
}

export type MatchResult = {
  status: MatchStatus
  paymentHold: boolean
  variances: MatchVariance[]
  exceptions: MatchVariance[]
  categories: MismatchCategory[]
  context?: MatchContext
}

export type MatchInput = {
  // Purchase order (ordered)
  orderedQuantity: unknown
  poUnitPrice: unknown
  poTaxable: unknown
  poCurrency?: unknown
  poGstRate?: unknown
  // Goods receipt aggregate (received across every GRN on the PO)
  grnCount: number
  acceptedQuantity: unknown
  receivedValue: unknown
  // Vendor bill (invoiced)
  billedQuantity: unknown
  billUnitPrice: unknown
  billTaxable: unknown
  billCurrency?: unknown
  billGstRate?: unknown
  /** Quantity already billed on OTHER bills against the same PO. */
  otherBilledQuantity?: unknown
  /** Taxable value already billed on OTHER bills against the same PO. */
  otherBilledTaxable?: unknown
  /** True when another bill with the same vendor bill number already exists. */
  duplicateBill?: boolean
  /** Per-GRN breakdown (split receipts) — evidence only; totals drive the match. */
  receipts?: MatchReceipt[]
}

const str = (v: unknown) => String(v ?? "").trim()

function pct(variance: number, base: number): number {
  if (!(Math.abs(base) > 0)) return variance === 0 ? 0 : 100
  return round2((variance / Math.abs(base)) * 100)
}

/**
 * Compare the three documents and return a fully-explained match result.
 * `expected`/`actual` on every dimension are the exact numbers to display as
 * comparison evidence; the returned messages are safe to show a checker.
 */
export function evaluateThreeWayMatch(input: MatchInput, tolerancesRaw?: Partial<MatchTolerances> | null): MatchResult {
  const tol = normalizeTolerances(tolerancesRaw)
  const variances: MatchVariance[] = []

  const grnCount = Math.max(0, Math.trunc(num(input.grnCount)))
  const acceptedQty = Math.max(0, num(input.acceptedQuantity))
  const receivedValue = round2(Math.max(0, num(input.receivedValue)))
  const billedQty = Math.max(0, num(input.billedQuantity))
  const billTaxable = round2(Math.max(0, num(input.billTaxable)))
  const otherQty = Math.max(0, num(input.otherBilledQuantity))
  const otherTaxable = round2(Math.max(0, num(input.otherBilledTaxable)))

  // 1. Receipt existence — nothing can be matched (or paid) before goods land.
  variances.push(
    grnCount <= 0
      ? {
          dimension: "receipt",
          label: "Goods received",
          status: "exception",
          expected: 1,
          actual: 0,
          variance: -1,
          variancePercent: -100,
          tolerance: 0,
          category: "no_receipt",
          message: "No goods receipt has been posted against this purchase order.",
        }
      : {
          dimension: "receipt",
          label: "Goods received",
          status: "matched",
          expected: grnCount,
          actual: grnCount,
          variance: 0,
          variancePercent: 0,
          tolerance: 0,
          category: null,
          message: null,
        },
  )

  // 2. Currency — an invoice in a different currency to the PO cannot be matched.
  const poCur = str(input.poCurrency).toUpperCase()
  const billCur = str(input.billCurrency).toUpperCase()
  if (poCur && billCur) {
    const mismatch = poCur !== billCur
    variances.push({
      dimension: "currency",
      label: "Currency",
      status: mismatch ? "exception" : "matched",
      expected: 0,
      actual: 0,
      variance: 0,
      variancePercent: 0,
      tolerance: 0,
      category: mismatch ? "currency_mismatch" : null,
      message: mismatch ? `Bill currency ${billCur} does not match purchase order currency ${poCur}.` : null,
    })
  }

  // 3. Tax rate — the invoiced GST rate must equal the PO's rate.
  const poRate = num(input.poGstRate)
  const billRate = num(input.billGstRate)
  if (str(input.billGstRate) !== "" && str(input.poGstRate) !== "") {
    const diff = round2(billRate - poRate)
    const mismatch = Math.abs(diff) > 0.001
    variances.push({
      dimension: "tax",
      label: "Tax rate",
      status: mismatch ? "exception" : "matched",
      expected: round2(poRate),
      actual: round2(billRate),
      variance: diff,
      variancePercent: pct(diff, poRate),
      tolerance: 0,
      category: mismatch ? "tax_mismatch" : null,
      message: mismatch ? `Bill GST rate ${round2(billRate)}% does not match purchase order rate ${round2(poRate)}%.` : null,
    })
  }

  // 4. Price — invoiced unit price vs the PO unit price (net of discount).
  const poUnit = round2(num(input.poUnitPrice))
  const billUnit = round2(num(input.billUnitPrice))
  if (poUnit > 0 && billUnit > 0) {
    const variance = round2(billUnit - poUnit)
    const variancePct = pct(variance, poUnit)
    // A unit price derived from a rounded line total (e.g. 100.00 / 7) can drift
    // by a paisa; accept it when the line-value effect stays within the absolute
    // currency-rounding slack.
    const roundingOnly = billedQty > 0 && round2(Math.abs(variance) * billedQty) <= tol.amountAbsolute + 1e-9 && Math.abs(variance) <= 0.01 + 1e-9
    const withinTol = Math.abs(variancePct) <= tol.pricePercent + 1e-9 || roundingOnly
    variances.push({
      dimension: "price",
      label: "Unit price",
      status: variance === 0 ? "matched" : withinTol ? "within_tolerance" : "exception",
      expected: poUnit,
      actual: billUnit,
      variance,
      variancePercent: variancePct,
      tolerance: tol.pricePercent,
      category: withinTol ? null : "price_variance",
      message: withinTol
        ? null
        : `Bill unit price ${billUnit.toFixed(2)} differs from purchase order price ${poUnit.toFixed(2)} by ${variancePct.toFixed(2)}%.`,
    })
  }

  // 5. Quantity — cumulative billed quantity must not exceed accepted quantity.
  const cumulativeQty = round2(otherQty + billedQty)
  {
    const variance = round2(cumulativeQty - acceptedQty)
    const qtyTol = round2(Math.max(0, acceptedQty * (tol.quantityPercent / 100)))
    const over = variance > qtyTol + 1e-9
    const status: MatchDimensionStatus = variance <= 1e-9 ? "matched" : over ? "exception" : "within_tolerance"
    variances.push({
      dimension: "quantity",
      label: "Quantity billed vs received",
      status,
      expected: round2(acceptedQty),
      actual: cumulativeQty,
      variance,
      variancePercent: pct(variance, acceptedQty),
      tolerance: qtyTol,
      category: over ? "quantity_over" : null,
      message: over
        ? `Billed quantity ${cumulativeQty} exceeds accepted quantity ${round2(acceptedQty)} on this purchase order.`
        : null,
    })
  }

  // 6. Amount — cumulative billed value must not exceed the accepted value.
  const cumulativeTaxable = round2(otherTaxable + billTaxable)
  {
    const variance = round2(cumulativeTaxable - receivedValue)
    const amtTol = round2(Math.max(tol.amountAbsolute, receivedValue * (tol.amountPercent / 100)))
    const over = variance > amtTol + 1e-9
    const status: MatchDimensionStatus = variance <= 1e-9 ? "matched" : over ? "exception" : "within_tolerance"
    variances.push({
      dimension: "amount",
      label: "Value billed vs received",
      status,
      expected: receivedValue,
      actual: cumulativeTaxable,
      variance,
      variancePercent: pct(variance, receivedValue),
      tolerance: amtTol,
      category: over ? "amount_over" : null,
      message: over
        ? `Billed value ${cumulativeTaxable.toFixed(2)} exceeds received-but-unbilled value ${receivedValue.toFixed(2)} on this purchase order.`
        : null,
    })
  }

  // 7. Duplicate — the same vendor bill number already booked for this vendor.
  if (input.duplicateBill) {
    variances.push({
      dimension: "duplicate",
      label: "Duplicate bill",
      status: "exception",
      expected: 0,
      actual: 1,
      variance: 1,
      variancePercent: 100,
      tolerance: 0,
      category: "duplicate_bill",
      message: "Another vendor bill with the same bill number already exists for this vendor.",
    })
  }

  const exceptions = variances.filter((v) => v.status === "exception")
  const categories = Array.from(new Set(exceptions.map((v) => v.category).filter((c): c is MismatchCategory => c != null)))
  const hasTolerance = variances.some((v) => v.status === "within_tolerance")
  const status: MatchStatus = exceptions.length > 0 ? "exception" : hasTolerance ? "matched_within_tolerance" : "matched"

  const orderedQty = Math.max(0, num(input.orderedQuantity))
  const receipts = (input.receipts ?? []).map((r) => ({
    grnId: str(r.grnId),
    receiptDate: r.receiptDate ? str(r.receiptDate) : null,
    receivedQuantity: round2(num(r.receivedQuantity)),
    acceptedQuantity: round2(num(r.acceptedQuantity)),
    rejectedQuantity: round2(num(r.rejectedQuantity)),
    receivedValue: round2(num(r.receivedValue)),
  }))
  const context: MatchContext = {
    orderedQuantity: round2(orderedQty),
    acceptedQuantity: round2(acceptedQty),
    billedQuantity: round2(billedQty),
    cumulativeBilledQuantity: cumulativeQty,
    receivedValue,
    billTaxable,
    cumulativeBilledTaxable: cumulativeTaxable,
    partialDelivery: grnCount > 0 && acceptedQty + 1e-9 < orderedQty,
    receipts,
  }

  return { status, paymentHold: exceptions.length > 0, variances, exceptions, categories, context }
}

// ---------------------------------------------------------------------------
// Request validation (shared by the API routes; pure so it is unit-tested).
// ---------------------------------------------------------------------------

export type ResolvePayload = { decision: "approve" | "reject"; note: string }

/** A checker override must name a decision and justify it in writing. */
export function parseResolvePayload(body: unknown): { ok: true; value: ResolvePayload } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const decision = str(b.decision).toLowerCase()
  if (decision !== "approve" && decision !== "reject") {
    return { ok: false, error: "decision must be 'approve' or 'reject'." }
  }
  const note = str(b.note)
  if (note.length < 10) return { ok: false, error: "A justification note of at least 10 characters is required for every override." }
  if (note.length > 2000) return { ok: false, error: "The justification note must be 2000 characters or fewer." }
  return { ok: true, value: { decision, note } }
}

/**
 * Strict tolerance validation for the settings API: unlike normalizeTolerances
 * (which clamps for safe reads), a write with a non-numeric or out-of-range
 * value is rejected so an admin never silently saves a different number.
 */
export function validateTolerancePayload(
  body: unknown,
): { ok: true; value: MatchTolerances } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const out = { ...DEFAULT_TOLERANCES }
  for (const key of Object.keys(TOLERANCE_BOUNDS) as (keyof MatchTolerances)[]) {
    if (b[key] == null || str(b[key]) === "") return { ok: false, error: `${key} is required.` }
    const n = Number(b[key])
    const [lo, hi] = TOLERANCE_BOUNDS[key]
    if (!Number.isFinite(n) || n < lo || n > hi) return { ok: false, error: `${key} must be a number between ${lo} and ${hi}.` }
    out[key] = round2(n)
  }
  return { ok: true, value: out }
}

/** A short, stable human summary of the match outcome. */
export function summarizeMatch(result: MatchResult): string {
  if (result.status === "matched") return "Fully matched"
  if (result.status === "matched_within_tolerance") return "Matched within tolerance"
  return `Exception: ${result.categories.map((c) => MISMATCH_LABELS[c]).join(", ")}`
}
