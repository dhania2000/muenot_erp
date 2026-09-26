/**
 * Expense Claims — pure, client-safe model (SPEC 127).
 *
 * Shared between the browser form and the server engine so the policy rules,
 * category caps, mileage rate and money maths can never drift apart. Contains
 * NO server imports (no db, no server-only) so it is safe to bundle into the
 * client. All authoritative recomputation on the server re-runs these same
 * functions, so a tampered browser payload is always overridden.
 */

export type ClaimStatus =
  | "Draft"
  | "Submitted"
  | "Approved"
  | "Rejected"
  | "Partially Reimbursed"
  | "Reimbursed"
  | "Cancelled"

/** A single expense line inside a claim. */
export type ClaimLine = {
  category: string
  description: string
  date: string
  /** Out-of-pocket / card amount for a normal line (ignored for mileage). */
  amount: number
  /** Mileage inputs — the amount is derived as distance × rate. */
  is_mileage?: boolean
  distance_km?: number
  mileage_rate?: number
  /** Paid on a company corporate card (already settled by the company). */
  corporate_card?: boolean
  card_last4?: string
  /** Uploaded receipt reference (blob/download-proxy url). */
  receipt_url?: string | null
}

export type ExpenseCategory = {
  key: string
  label: string
  /** Per-line cap in INR. 0 = no fixed cap (e.g. mileage is rate-driven). */
  cap: number
  mileage?: boolean
}

/** Default corporate expense policy. Caps are per line item, in INR. */
export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { key: "air_travel", label: "Air Travel", cap: 60000 },
  { key: "rail_bus", label: "Rail / Bus / Taxi (Intercity)", cap: 12000 },
  { key: "accommodation", label: "Accommodation (per night)", cap: 10000 },
  { key: "meals", label: "Meals & Entertainment", cap: 2000 },
  { key: "local_conveyance", label: "Local Conveyance", cap: 2500 },
  { key: "mileage", label: "Mileage (Own Vehicle)", cap: 0, mileage: true },
  { key: "office_supplies", label: "Office Supplies", cap: 6000 },
  { key: "communication", label: "Telephone / Internet", cap: 4000 },
  { key: "training", label: "Training & Conferences", cap: 40000 },
  { key: "other", label: "Other", cap: 5000 },
]

/** Reimbursement rate for own-vehicle mileage (INR per km). */
export const MILEAGE_RATE = 12

/** A receipt is mandatory for any single line at or above this amount (INR). */
export const RECEIPT_THRESHOLD = 500

export const CLAIM_STATUSES: ClaimStatus[] = [
  "Draft",
  "Submitted",
  "Approved",
  "Rejected",
  "Partially Reimbursed",
  "Reimbursed",
  "Cancelled",
]

export function categoryByKey(key: string): ExpenseCategory | undefined {
  return EXPENSE_CATEGORIES.find((c) => c.key === key)
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "").replace(/,/g, ""))
  return Number.isFinite(n) ? n : 0
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Authoritative amount for a line — mileage is always distance × rate. */
export function computeLineAmount(line: ClaimLine): number {
  if (line.is_mileage) {
    const rate = num(line.mileage_rate) > 0 ? num(line.mileage_rate) : MILEAGE_RATE
    return round2(Math.max(0, num(line.distance_km)) * Math.max(0, rate))
  }
  return round2(Math.max(0, num(line.amount)))
}

export type ReimbursementPlan = {
  amount: number
  reimbursedAfter: number
  remainingAfter: number
  status: "Partially Reimbursed" | "Reimbursed"
}

/**
 * Validate a (possibly partial) reimbursement against the claim's approved
 * reimbursable total and what has already been paid. `requested` defaults to
 * the full remaining balance. Throws on a non-positive or over-payment. Pure.
 */
export function planReimbursement(
  reimbursableTotal: number,
  alreadyReimbursed: number,
  requested?: number | null,
): ReimbursementPlan {
  const total = round2(Math.max(0, num(reimbursableTotal)))
  const paid = round2(Math.max(0, num(alreadyReimbursed)))
  const remaining = round2(total - paid)
  if (remaining <= 0) throw new Error("This claim has already been fully reimbursed.")
  const amount = requested == null || requested === ("" as unknown) ? remaining : round2(num(requested))
  if (!(amount > 0)) throw new Error("A positive reimbursement amount is required.")
  if (amount > remaining + 0.005) {
    throw new Error(`Reimbursement ${amount} exceeds the remaining balance ${remaining}.`)
  }
  const reimbursedAfter = round2(paid + amount)
  const remainingAfter = round2(total - reimbursedAfter)
  return {
    amount,
    reimbursedAfter,
    remainingAfter,
    status: remainingAfter <= 0.005 ? "Reimbursed" : "Partially Reimbursed",
  }
}

export type ClaimTotals = {
  gross: number
  /** Employee out-of-pocket (reimbursable) — everything not on a corporate card. */
  reimbursable: number
  /** Amount already settled by the company via corporate card. */
  corporateCard: number
  mileage: number
}

export function computeClaimTotals(lines: ClaimLine[]): ClaimTotals {
  let gross = 0
  let corporateCard = 0
  let mileage = 0
  for (const line of lines) {
    const amt = computeLineAmount(line)
    gross += amt
    if (line.corporate_card) corporateCard += amt
    if (line.is_mileage) mileage += amt
  }
  gross = round2(gross)
  corporateCard = round2(corporateCard)
  return { gross, corporateCard, mileage: round2(mileage), reimbursable: round2(gross - corporateCard) }
}

export type PolicyViolation = {
  line: number // 1-based index, 0 = claim-level
  severity: "error" | "warning"
  message: string
}

/**
 * Validate a claim against the corporate policy. `error` violations block
 * submission; `warning` violations are allowed but flagged to the approver.
 * A future dev can source caps/rate/threshold from settings and pass them in.
 */
export function validateClaim(
  lines: ClaimLine[],
  opts: { today?: string } = {},
): PolicyViolation[] {
  const out: PolicyViolation[] = []
  const today = opts.today ?? new Date().toISOString().slice(0, 10)

  if (!lines || lines.length === 0) {
    out.push({ line: 0, severity: "error", message: "A claim needs at least one expense line." })
    return out
  }

  lines.forEach((line, i) => {
    const n = i + 1
    const cat = categoryByKey(line.category)
    const amount = computeLineAmount(line)

    if (!line.category || !cat) {
      out.push({ line: n, severity: "error", message: `Line ${n}: choose an expense category.` })
    }
    if (!line.date) {
      out.push({ line: n, severity: "error", message: `Line ${n}: an expense date is required.` })
    } else if (line.date > today) {
      out.push({ line: n, severity: "warning", message: `Line ${n}: the expense date is in the future.` })
    }

    if (line.is_mileage) {
      if (num(line.distance_km) <= 0) {
        out.push({ line: n, severity: "error", message: `Line ${n}: enter the distance travelled (km).` })
      }
    } else if (amount <= 0) {
      out.push({ line: n, severity: "error", message: `Line ${n}: the amount must be greater than zero.` })
    }

    // Category cap breach — allowed, but flagged for approver justification.
    if (cat && cat.cap > 0 && amount > cat.cap) {
      out.push({
        line: n,
        severity: "warning",
        message: `Line ${n}: ${cat.label} of ${amount.toLocaleString("en-IN")} exceeds the policy cap of ${cat.cap.toLocaleString("en-IN")}.`,
      })
    }

    // Receipt mandatory above the threshold (mileage and card lines exempt: the
    // card statement is the record for card spend; mileage is self-declared).
    const receiptRequired = !line.is_mileage && !line.corporate_card && amount >= RECEIPT_THRESHOLD
    if (receiptRequired && !line.receipt_url) {
      out.push({
        line: n,
        severity: "error",
        message: `Line ${n}: a receipt is required for amounts of ${RECEIPT_THRESHOLD.toLocaleString("en-IN")} or more.`,
      })
    }
  })

  return out
}

export function hasBlockingViolations(violations: PolicyViolation[]): boolean {
  return violations.some((v) => v.severity === "error")
}

export const STATUS_TONE: Record<ClaimStatus, string> = {
  Draft: "bg-muted text-muted-foreground",
  Submitted: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  Approved: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  "Partially Reimbursed": "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300",
  Reimbursed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  Cancelled: "bg-muted text-muted-foreground line-through",
}
