/**
 * SPEC 21 — Payment gateway abstraction (Phase 1: provider interface).
 * ---------------------------------------------------------------------------
 * Muenot must be able to charge through Razorpay today and Stripe (or any
 * future provider) tomorrow WITHOUT the billing engine knowing which one is
 * in use. This module defines the seam:
 *
 *   - Canonical, provider-neutral types (status, event, money) that the
 *     billing engine speaks.
 *   - A `PaymentGateway` interface every adapter implements.
 *
 * Business logic (lib/billing/*) depends ONLY on these types and the
 * interface — never on `razorpay`/`stripe` shapes. Each adapter translates its
 * provider's quirks (minor-unit amounts, status vocabulary, webhook signature
 * scheme, event envelope) into this canonical form and back.
 */

/** Registered provider key, e.g. "razorpay" | "stripe". Open for new providers. */
export type GatewayName = string

/** Provider-neutral payment lifecycle. Adapters map their vocab onto this. */
export type CanonicalPaymentStatus =
  | "created" // intent/order exists, no money moved yet
  | "pending" // authorized or processing, not yet settled
  | "authorized" // funds held, capture outstanding
  | "succeeded" // captured / settled
  | "failed" // declined / errored / cancelled
  | "refunded" // fully refunded

/** Provider-neutral webhook event category. */
export type CanonicalEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.pending"
  | "refund.succeeded"
  | "unknown"

/** Input to open a charge. Amounts are ALWAYS in major units (e.g. 12.50). */
export type CreatePaymentInput = {
  amount: number
  currency: string
  /** Our own reference (invoice/payment no) — echoed back on the webhook. */
  reference: string
  description?: string
  customerEmail?: string | null
  customerName?: string | null
  /**
   * Opaque key/values persisted with the charge and returned on every webhook.
   * MUST carry whatever the app needs to route the event back — at minimum the
   * tenant id and invoice id. Values are stringified by adapters.
   */
  metadata?: Record<string, string | number>
  /** Dedup key so a retried create cannot open two charges. */
  idempotencyKey?: string
}

/** Result of opening a charge, normalized across providers. */
export type CreatePaymentResult = {
  gateway: GatewayName
  /** Primary provider handle (Razorpay order id / Stripe PaymentIntent id). */
  providerId: string
  status: CanonicalPaymentStatus
  amount: number
  currency: string
  /**
   * Everything the browser/checkout needs to complete the charge (public key,
   * order id, client secret, …). Shape is provider-specific by design — only
   * the client that renders that provider's checkout reads it.
   */
  clientParams: Record<string, unknown>
  raw: unknown
}

/** A verified, normalized inbound webhook event. */
export type GatewayEvent = {
  /** Provider event id — the idempotency key for inbound processing. */
  id: string
  gateway: GatewayName
  type: CanonicalEventType
  /** Provider payment/charge id (Razorpay payment id / Stripe PI id). */
  providerPaymentId: string | null
  /** Provider order/intent id used to correlate with the opened charge. */
  providerOrderId: string | null
  providerRefundId: string | null
  /** Our reference echoed back through metadata/notes, if present. */
  reference: string | null
  /** Full metadata bag echoed by the provider (tenant id, invoice id, …). */
  metadata: Record<string, string>
  amount: number | null
  currency: string | null
  status: CanonicalPaymentStatus
  /** ISO timestamp of when the provider says it happened, if present. */
  occurredAt: string | null
  raw: unknown
}

/** Raw request material an adapter needs to authenticate a webhook. */
export type WebhookVerifyInput = {
  rawBody: string
  /** Header map with LOWERCASED keys. */
  headers: Record<string, string>
}

/**
 * The contract every provider adapter fulfils. Deliberately small: open a
 * charge, authenticate an inbound webhook, turn it into a canonical event, and
 * translate a raw provider status. Anything provider-specific stays inside the
 * adapter.
 */
export interface PaymentGateway {
  readonly name: GatewayName
  /** Open a charge with the provider. Handles its own transport + retries. */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>
  /** True when the webhook signature/authenticity checks out. */
  verifyWebhook(input: WebhookVerifyInput): boolean
  /** Parse a raw webhook body into a canonical event. */
  parseEvent(rawBody: string): GatewayEvent
  /** Map a raw provider status string onto the canonical status. */
  mapStatus(providerStatus: string): CanonicalPaymentStatus
}

// ── Money helpers (major ↔ minor units) ──────────────────────────────────────

/** Currencies with no minor unit — amounts are NOT multiplied by 100. */
const ZERO_DECIMAL = new Set([
  "JPY", "KRW", "VND", "CLP", "XOF", "XAF", "BIF", "DJF", "GNF", "KMF", "MGA",
  "PYG", "RWF", "UGX", "VUV", "XPF",
])

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 0 : 2
}

/** 12.50 USD → 1250 (cents). Rounds to the nearest minor unit. */
export function toMinorUnits(amount: number, currency: string): number {
  const factor = 10 ** currencyExponent(currency)
  return Math.round((Number(amount) || 0) * factor)
}

/** 1250 cents → 12.5 USD, rounded to 2dp. */
export function fromMinorUnits(minor: number, currency: string): number {
  const factor = 10 ** currencyExponent(currency)
  const major = (Number(minor) || 0) / factor
  return Math.round((major + Number.EPSILON) * 100) / 100
}
