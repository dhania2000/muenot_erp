/**
 * Spec29 (#172) — Partner & reseller management: pure rules.
 * ---------------------------------------------------------------------------
 * Everything here is side-effect free so validation, attribution, commission
 * eligibility, settlement and clawback math are unit-testable without a DB.
 * Money is handled in integer cents to avoid float drift; the store converts
 * to/from DECIMAL(12,2).
 */

export const PARTNER_KINDS = ["referral", "reseller"] as const
export type PartnerKind = (typeof PARTNER_KINDS)[number]

export const PARTNER_STATUSES = ["active", "suspended", "terminated"] as const
export type PartnerStatus = (typeof PARTNER_STATUSES)[number]

/** Who owns the customer relationship for a referred tenant. */
export const OWNERSHIPS = ["platform", "partner"] as const
export type Ownership = (typeof OWNERSHIPS)[number]

export type ReferralStatus = "active" | "cancelled" | "transferred"

export const MAX_SHARE_BPS = 5000
export const MAX_REFUND_WINDOW_DAYS = 365

export class PartnerError extends Error {
  status: number
  code: string
  constructor(message: string, code = "PARTNER_ERROR", status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type ContractTerms = {
  revenueShareBps: number
  refundWindowDays: number
  contractStart: string
  contractEnd: string | null
  eligibilityMonths: number | null
}

export type PartnerInput = {
  name: string
  kind: PartnerKind
  contactEmail: string | null
  terms: ContractTerms
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
}

function intInRange(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** Validate a (possibly partial) set of contract terms, merged over `base`. */
export function validateTerms(raw: any, base?: ContractTerms): ContractTerms {
  const src = raw ?? {}
  const pick = <K extends keyof ContractTerms>(k: K) => (k in src ? src[k] : base?.[k])

  const bps = intInRange(pick("revenueShareBps"), 0, MAX_SHARE_BPS)
  if (bps === null) throw new PartnerError(`revenueShareBps must be an integer 0-${MAX_SHARE_BPS}`, "INVALID_TERMS")

  const windowDays = intInRange(pick("refundWindowDays") ?? 30, 0, MAX_REFUND_WINDOW_DAYS)
  if (windowDays === null) {
    throw new PartnerError(`refundWindowDays must be an integer 0-${MAX_REFUND_WINDOW_DAYS}`, "INVALID_TERMS")
  }

  const start = pick("contractStart")
  if (!isValidDate(start)) throw new PartnerError("contractStart must be YYYY-MM-DD", "INVALID_TERMS")

  const endRaw = pick("contractEnd") ?? null
  if (endRaw !== null && !isValidDate(endRaw)) throw new PartnerError("contractEnd must be YYYY-MM-DD", "INVALID_TERMS")
  if (endRaw !== null && endRaw < start) throw new PartnerError("contractEnd must be on/after contractStart", "INVALID_TERMS")

  const monthsRaw = pick("eligibilityMonths") ?? null
  const months = monthsRaw === null ? null : intInRange(monthsRaw, 1, 120)
  if (monthsRaw !== null && months === null) {
    throw new PartnerError("eligibilityMonths must be an integer 1-120 or null", "INVALID_TERMS")
  }

  return { revenueShareBps: bps, refundWindowDays: windowDays, contractStart: start, contractEnd: endRaw, eligibilityMonths: months }
}

export function validatePartnerInput(raw: any): PartnerInput {
  const name = typeof raw?.name === "string" ? raw.name.trim() : ""
  if (name.length < 2 || name.length > 160) throw new PartnerError("name must be 2-160 characters", "INVALID_PARTNER")
  const kind = raw?.kind ?? "referral"
  if (!PARTNER_KINDS.includes(kind)) throw new PartnerError("kind must be referral or reseller", "INVALID_PARTNER")
  let contactEmail: string | null = null
  if (raw?.contactEmail != null && raw.contactEmail !== "") {
    const e = String(raw.contactEmail).trim().toLowerCase()
    if (e.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw new PartnerError("contactEmail is invalid", "INVALID_PARTNER")
    }
    contactEmail = e
  }
  return { name, kind, contactEmail, terms: validateTerms(raw?.terms) }
}

/**
 * Status transitions. `terminated` is final; suspension is reversible.
 */
export function assertStatusTransition(from: PartnerStatus, to: PartnerStatus): void {
  if (!PARTNER_STATUSES.includes(to)) throw new PartnerError("Invalid status", "INVALID_STATUS")
  if (from === to) return
  if (from === "terminated") throw new PartnerError("A terminated partner cannot be reactivated", "PARTNER_TERMINATED", 409)
}

// ---------------------------------------------------------------------------
// Referral codes (signup attribution)
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const REFERRAL_CODE_LENGTH = 10

/** Unambiguous (no 0/O/1/I) random code a partner shares with prospects. */
export function generateReferralCode(): string {
  const bytes = new Uint8Array(REFERRAL_CODE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

/** Normalize user-supplied codes; anything malformed is treated as "no code". */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const code = raw.trim().toUpperCase()
  return /^[A-Z0-9]{6,16}$/.test(code) ? code : null
}

export function positiveId(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function toCents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "0"))
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

export function fromCents(c: number): string {
  const sign = c < 0 ? "-" : ""
  const a = Math.abs(c)
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`
}

/** Commission on a net amount, rounded DOWN so the platform never overpays. */
export function commissionCents(netCents: number, bps: number): number {
  if (netCents <= 0 || bps <= 0) return 0
  return Math.floor((netCents * bps) / 10000)
}

// ---------------------------------------------------------------------------
// Dates (all compared as UTC calendar days)
// ---------------------------------------------------------------------------

export function dayOf(v: string | Date | null | undefined): string | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = String(v)
  if (DATE_RE.test(s.slice(0, 10))) return s.slice(0, 10)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export type ReferralRecord = {
  id: number
  partnerId: number
  tenantId: number
  status: ReferralStatus
  attributedAt: string
  endedAt: string | null
}

/**
 * The referral that owned a tenant on a given day. A referral covers
 * [attributed day, ended day) — so after a transfer on day D, invoices issued
 * on D belong to the NEW partner, and a cancelled referral earns nothing for
 * invoices issued on/after its end day.
 */
export function referralOnDay(referrals: ReferralRecord[], day: string): ReferralRecord | null {
  const hits = referrals.filter((r) => {
    const from = dayOf(r.attributedAt)
    const to = dayOf(r.endedAt)
    return from !== null && from <= day && (to === null || day < to)
  })
  if (!hits.length) return null
  // Latest attribution wins; ties on the same day fall back to the newest id.
  return hits.sort((a, b) => {
    const da = dayOf(a.attributedAt)!
    const db = dayOf(b.attributedAt)!
    if (da !== db) return da < db ? 1 : -1
    return b.id - a.id
  })[0]
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export type InvoiceRecord = {
  id: number
  tenantId: number
  amount: unknown
  refundedAmount: unknown
  status: "open" | "paid" | "void"
  issuedAt: string | null
  periodStart: string | null
  paidAt: string | null
}

export type PartnerRecord = {
  id: number
  status: PartnerStatus
  terms: ContractTerms
}

export type SettlementDecision =
  | { eligible: true; partnerId: number; referralId: number; amountCents: number; shareBps: number }
  | { eligible: false; reason: string; retry: boolean }

/**
 * Decide whether a single invoice earns a commission NOW.
 *  - The invoice must be verified paid (status `paid` with a `paid_at`).
 *  - The partner's refund window must have fully elapsed since payment.
 *  - A referral must have owned the tenant on the invoice's issue day, and the
 *    issue day must fall inside the contract and eligibility windows.
 *  - Suspended partners are deferred (retry later), never paid while suspended.
 * `retry` tells the caller whether the same invoice may become eligible later.
 */
export function decideSettlement(
  invoice: InvoiceRecord,
  referrals: ReferralRecord[],
  partnersById: Map<number, PartnerRecord>,
  today: string,
): SettlementDecision {
  if (invoice.status !== "paid") return { eligible: false, reason: "not_paid", retry: invoice.status === "open" }
  const paidDay = dayOf(invoice.paidAt)
  if (!paidDay) return { eligible: false, reason: "payment_unverified", retry: true }

  const issueDay = dayOf(invoice.issuedAt) ?? dayOf(invoice.periodStart) ?? paidDay
  const referral = referralOnDay(referrals, issueDay)
  if (!referral) return { eligible: false, reason: "not_attributed", retry: false }

  const partner = partnersById.get(referral.partnerId)
  if (!partner) return { eligible: false, reason: "partner_missing", retry: false }

  const t = partner.terms
  if (issueDay < t.contractStart || (t.contractEnd !== null && issueDay > t.contractEnd)) {
    return { eligible: false, reason: "outside_contract", retry: false }
  }
  if (t.eligibilityMonths !== null) {
    const attributedDay = dayOf(referral.attributedAt)!
    if (issueDay >= addMonths(attributedDay, t.eligibilityMonths)) {
      return { eligible: false, reason: "eligibility_expired", retry: false }
    }
  }

  if (today < addDays(paidDay, t.refundWindowDays)) return { eligible: false, reason: "refund_window_open", retry: true }
  if (partner.status === "suspended") return { eligible: false, reason: "partner_suspended", retry: true }

  const net = toCents(invoice.amount) - toCents(invoice.refundedAmount)
  const amountCents = commissionCents(net, t.revenueShareBps)
  if (amountCents <= 0) return { eligible: false, reason: "nothing_to_pay", retry: false }

  return { eligible: true, partnerId: partner.id, referralId: referral.id, amountCents, shareBps: t.revenueShareBps }
}

/**
 * Clawback needed after a refund/void of an already-settled invoice. Returns a
 * NEGATIVE cents delta (or 0). `ledgerCents` is the partner's current net for
 * the invoice (commission + prior clawbacks), `shareBps` the snapshot used at
 * settlement, so later term changes never rewrite past economics.
 */
export function clawbackCents(input: {
  invoiceAmount: unknown
  refundedAmount: unknown
  voided: boolean
  shareBps: number
  ledgerCents: number
}): number {
  const net = input.voided ? 0 : toCents(input.invoiceAmount) - toCents(input.refundedAmount)
  const target = commissionCents(net, input.shareBps)
  const delta = target - input.ledgerCents
  return delta < 0 ? delta : 0
}

// ---------------------------------------------------------------------------
// Partner-facing projections (never expose customer secrets)
// ---------------------------------------------------------------------------

export type DashboardReferral = {
  id: number
  customerName: string
  ownership: Ownership
  status: ReferralStatus
  source: "platform" | "signup" | "affiliate"
  attributedAt: string | null
  endedAt: string | null
}

export type DashboardCommission = {
  id: number
  invoiceNumber: string
  kind: "commission" | "clawback"
  amount: string
  currency: string
  shareBps: number
  settledAt: string | null
}

/** Explicit allow-list projection — anything not listed never leaves the server. */
export function toDashboardReferral(r: any): DashboardReferral {
  return {
    id: Number(r.id),
    customerName: String(r.tenant_name ?? ""),
    ownership: r.ownership === "partner" ? "partner" : "platform",
    status: r.status === "cancelled" || r.status === "transferred" ? r.status : "active",
    source: r.source === "signup" || r.source === "affiliate" ? r.source : "platform",
    attributedAt: dayOf(r.attributed_at),
    endedAt: dayOf(r.ended_at),
  }
}

export function toDashboardCommission(r: any): DashboardCommission {
  return {
    id: Number(r.id),
    invoiceNumber: String(r.invoice_number ?? ""),
    kind: r.kind === "clawback" ? "clawback" : "commission",
    amount: fromCents(toCents(r.amount)),
    currency: String(r.currency ?? "USD"),
    shareBps: Number(r.share_bps ?? 0),
    settledAt: dayOf(r.settled_at),
  }
}

export function summarize(commissions: DashboardCommission[]) {
  let earned = 0
  let clawedBack = 0
  for (const c of commissions) {
    const cents = toCents(c.amount)
    if (c.kind === "commission") earned += cents
    else clawedBack += cents
  }
  return { earned: fromCents(earned), clawedBack: fromCents(clawedBack), net: fromCents(earned + clawedBack) }
}
