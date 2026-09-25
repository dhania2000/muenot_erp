import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { PartnerError } from "@/lib/partners/model"

/**
 * Spec30 (#173) — Affiliate tracking: pure rules.
 * ---------------------------------------------------------------------------
 * Affiliates are Spec29 partners. This module only adds what tracking needs:
 * signed click cookies, multi-touch policy, self-referral detection, the
 * conversion lifecycle and commission/payout projections. Money math and
 * attribution windows stay in lib/partners/model.ts.
 */

export const AFFILIATE_COOKIE = "ems_aff"
export const DEFAULT_ATTRIBUTION_DAYS = 30
export const MAX_ATTRIBUTION_DAYS = 90
export const MAX_LINKS_PER_PARTNER = 25

export type TouchPolicy = "last" | "first"

/** Attribution window in days from AFFILIATE_ATTRIBUTION_DAYS, clamped 1..90. */
export function attributionDays(raw: string | undefined = process.env.AFFILIATE_ATTRIBUTION_DAYS): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ATTRIBUTION_DAYS
  return Math.min(n, MAX_ATTRIBUTION_DAYS)
}

/** Multi-touch policy from AFFILIATE_TOUCH_POLICY. Defaults to last-click. */
export function touchPolicy(raw: string | undefined = process.env.AFFILIATE_TOUCH_POLICY): TouchPolicy {
  return raw === "first" ? "first" : "last"
}

// ---------------------------------------------------------------------------
// Link input
// ---------------------------------------------------------------------------

export function validateLinkInput(raw: any): { label: string | null } {
  const label = raw?.label == null ? "" : String(raw.label).trim()
  if (label.length > 80) throw new PartnerError("label must be at most 80 characters", "VALIDATION", 400)
  return { label: label || null }
}

export function validateLinkStatus(raw: unknown): "active" | "disabled" {
  if (raw === "active" || raw === "disabled") return raw
  throw new PartnerError("status must be active or disabled", "VALIDATION", 400)
}

// ---------------------------------------------------------------------------
// Click cookie: `<clickId>.<token>.<hmac>`
// The cookie never carries a partner or link id. The DB stores only
// sha256(token), so a forged, edited or replayed-after-consumption cookie
// cannot attribute anything.
// ---------------------------------------------------------------------------

function cookieKey(secret: string) {
  return `${secret}:affiliate-click`
}

export function newClickToken(): string {
  return randomBytes(24).toString("base64url")
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", cookieKey(secret)).update(payload).digest("base64url")
}

export function signClickCookie(clickId: number, token: string, secret: string): string {
  const payload = `${clickId}.${token}`
  return `${payload}.${sign(payload, secret)}`
}

export function parseClickCookie(value: unknown, secret: string): { clickId: number; token: string } | null {
  if (typeof value !== "string" || value.length > 200 || !secret) return null
  const parts = value.split(".")
  if (parts.length !== 3) return null
  const [idPart, token, sig] = parts
  if (!/^[1-9][0-9]{0,17}$/.test(idPart) || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null
  const expected = Buffer.from(sign(`${idPart}.${token}`, secret))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  const clickId = Number(idPart)
  return Number.isSafeInteger(clickId) ? { clickId, token } : null
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|curl|wget|python-requests|httpclient/i

export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_RE.test(userAgent)
}

// ---------------------------------------------------------------------------
// Multi-touch
// ---------------------------------------------------------------------------

export type ExistingTouch = { linkId: number; expiresAt: string; consumed: boolean } | null

/**
 * What to do when a visitor who may already carry a click cookie clicks a link.
 *  - no valid existing click (none, expired, consumed) → `new`
 *  - same link → `reuse` (no inflation, window NOT extended)
 *  - different link → `new` under last-click, `keep` under first-click
 */
export function decideTouch(existing: ExistingTouch, linkId: number, policy: TouchPolicy, now: Date): "new" | "reuse" | "keep" {
  if (!existing || existing.consumed || !isFuture(existing.expiresAt, now)) return "new"
  if (existing.linkId === linkId) return "reuse"
  return policy === "first" ? "keep" : "new"
}

function isFuture(sqlDateTime: string, now: Date): boolean {
  const t = Date.parse(String(sqlDateTime).replace(" ", "T") + (String(sqlDateTime).endsWith("Z") ? "" : "Z"))
  return Number.isFinite(t) && t > now.getTime()
}

export function toSqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}

export type ClickRecord = {
  id: number
  linkId: number
  partnerId: number
  tokenHash: string
  expiresAt: string
  consumedAt: string | null
  linkStatus: string
  partnerStatus: string
}

export type ClickRejection = "expired" | "consumed" | "link_inactive" | "partner_inactive"

/** Server-side validity of a click at signup time (cookie maxAge is irrelevant). */
export function evaluateClick(click: ClickRecord, now: Date): ClickRejection | null {
  if (click.consumedAt) return "consumed"
  if (!isFuture(click.expiresAt, now)) return "expired"
  if (click.linkStatus !== "active") return "link_inactive"
  if (click.partnerStatus !== "active") return "partner_inactive"
  return null
}

// ---------------------------------------------------------------------------
// Self-referral
// ---------------------------------------------------------------------------

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com",
])

/** Canonical mailbox identity: lowercased, +tags stripped, Gmail dots removed. */
export function canonicalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const email = raw.trim().toLowerCase()
  const at = email.lastIndexOf("@")
  if (at < 1 || at === email.length - 1) return null
  let local = email.slice(0, at)
  let domain = email.slice(at + 1)
  local = local.split("+")[0]
  if (domain === "googlemail.com") domain = "gmail.com"
  if (domain === "gmail.com") local = local.replace(/\./g, "")
  return local ? `${local}@${domain}` : null
}

export type SelfReferralInput = {
  registrantEmail: string
  sessionUserId: number | null
  partnerContactEmail: string | null
  members: { userId: number; email: string | null }[]
}

export type SelfReferralReason = "self_referral_session" | "self_referral_email" | "self_referral_domain"

/**
 * An affiliate must not earn on their own business. Blocks when the browser
 * that signs up is already logged in as one of the partner's members, when the
 * registrant's mailbox matches the partner's contact or any member (ever), or
 * when it shares the partner's own (non-free-mail) company domain.
 */
export function detectSelfReferral(input: SelfReferralInput): SelfReferralReason | null {
  if (input.sessionUserId != null && input.members.some((m) => m.userId === input.sessionUserId)) {
    return "self_referral_session"
  }
  const reg = canonicalEmail(input.registrantEmail)
  if (!reg) return null
  const known = [input.partnerContactEmail, ...input.members.map((m) => m.email)]
    .map(canonicalEmail)
    .filter((e): e is string => Boolean(e))
  if (known.includes(reg)) return "self_referral_email"
  const regDomain = reg.split("@")[1]
  const contact = canonicalEmail(input.partnerContactEmail)
  if (contact && !FREE_MAIL.has(regDomain) && contact.split("@")[1] === regDomain) return "self_referral_domain"
  return null
}

// ---------------------------------------------------------------------------
// Conversion lifecycle
// ---------------------------------------------------------------------------

export const CONVERSION_STATES = ["referred", "trial", "converted", "paid", "cancelled", "rejected"] as const
export type ConversionState = (typeof CONVERSION_STATES)[number]

const RANK: Record<string, number> = { referred: 0, trial: 1, converted: 2, paid: 3 }

export type ConversionSignals = {
  subscriptionStatus: string | null
  mrr: number
  firstPaidInvoice: { id: number; paidAt: string } | null
  referralActive: boolean
}

export type ConversionRow = {
  state: ConversionState
  trialAt: string | null
  convertedAt: string | null
  paidAt: string | null
  firstPaidInvoiceId: number | null
  cancelledAt: string | null
}

/**
 * Advance a conversion. Monotonic: states never move backwards and a stage
 * timestamp, once set, never changes. `cancelled` (subscription cancelled or
 * attribution ended) and `rejected` are terminal. Returns null when unchanged.
 */
export function advanceConversion(cur: ConversionRow, s: ConversionSignals, nowSql: string): ConversionRow | null {
  if (cur.state === "cancelled" || cur.state === "rejected") return null
  const next: ConversionRow = { ...cur }
  let target = 0
  if (s.subscriptionStatus === "trialing") target = 1
  if ((s.subscriptionStatus === "active" || s.subscriptionStatus === "past_due") && s.mrr > 0) target = 2
  if (s.firstPaidInvoice) target = 3
  const rank = Math.max(RANK[cur.state] ?? 0, target)

  if (rank >= 1 && target === 1 && !next.trialAt) next.trialAt = nowSql
  if (rank >= 2 && !next.convertedAt) next.convertedAt = nowSql
  if (rank >= 3 && s.firstPaidInvoice && !next.paidAt) {
    next.paidAt = s.firstPaidInvoice.paidAt
    next.firstPaidInvoiceId = s.firstPaidInvoice.id
  }
  next.state = (Object.keys(RANK).find((k) => RANK[k] === rank) ?? "referred") as ConversionState

  if (s.subscriptionStatus === "canceled" || !s.referralActive) {
    next.state = "cancelled"
    next.cancelledAt = nowSql
  }

  const changed = (Object.keys(next) as (keyof ConversionRow)[]).some((k) => next[k] !== cur[k])
  return changed ? next : null
}

// ---------------------------------------------------------------------------
// Commission & payout projections
// ---------------------------------------------------------------------------

export type LedgerEntry = {
  id: number
  kind: "commission" | "clawback"
  amountCents: number
  currency: string
  payoutStatus: "pending" | "paid" | null
}

export type CommissionTotals = {
  currency: string
  pendingCents: number
  availableCents: number
  inPayoutCents: number
  paidOutCents: number
  clawedBackCents: number
}

/**
 * Commission states per currency:
 *  - pending: verified-paid invoices still inside the refund window (estimate)
 *  - available: settled ledger entries not yet in a payout (net of clawbacks)
 *  - inPayout / paidOut: entries locked in a pending / paid payout
 */
export function commissionTotals(ledger: LedgerEntry[], pending: { currency: string; cents: number }[]): CommissionTotals[] {
  const by = new Map<string, CommissionTotals>()
  const get = (c: string) => {
    if (!by.has(c)) by.set(c, { currency: c, pendingCents: 0, availableCents: 0, inPayoutCents: 0, paidOutCents: 0, clawedBackCents: 0 })
    return by.get(c)!
  }
  for (const p of pending) get(p.currency).pendingCents += p.cents
  for (const e of ledger) {
    const t = get(e.currency)
    if (e.kind === "clawback") t.clawedBackCents += -e.amountCents
    if (e.payoutStatus === "paid") t.paidOutCents += e.amountCents
    else if (e.payoutStatus === "pending") t.inPayoutCents += e.amountCents
    else t.availableCents += e.amountCents
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

export function validateCurrency(raw: unknown): string {
  const c = raw == null || raw === "" ? "USD" : String(raw).trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(c)) throw new PartnerError("currency must be a 3-letter code", "VALIDATION", 400)
  return c
}

export type PayoutStatus = "pending" | "paid" | "void"

export function assertPayoutTransition(from: PayoutStatus, action: "mark_paid" | "void"): PayoutStatus {
  if (from !== "pending") {
    throw new PartnerError(`Payout is already ${from}`, "INVALID_PAYOUT_TRANSITION", 409)
  }
  return action === "mark_paid" ? "paid" : "void"
}

export function validatePayoutAction(raw: any): { action: "mark_paid" | "void"; reference: string | null; reason: string | null } {
  const action = raw?.action
  if (action !== "mark_paid" && action !== "void") {
    throw new PartnerError("action must be mark_paid or void", "VALIDATION", 400)
  }
  const reference = raw?.reference == null ? "" : String(raw.reference).trim()
  const reason = raw?.reason == null ? "" : String(raw.reason).trim()
  if (action === "mark_paid" && (reference.length < 3 || reference.length > 120)) {
    throw new PartnerError("A payment reference (3-120 chars) is required", "VALIDATION", 400)
  }
  if (action === "void" && (reason.length < 3 || reason.length > 300)) {
    throw new PartnerError("A void reason (3-300 chars) is required", "VALIDATION", 400)
  }
  return { action, reference: reference || null, reason: reason || null }
}
