import { createHmac, timingSafeEqual } from "node:crypto"
import {
  type CanonicalEventType,
  type CanonicalPaymentStatus,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type GatewayEvent,
  type PaymentGateway,
  type WebhookVerifyInput,
  fromMinorUnits,
  toMinorUnits,
} from "./types"
import { GatewayError, isRetryableHttpStatus, withRetry, type RetryOptions } from "./retry"

/**
 * SPEC 21 — Stripe adapter (Phase 2).
 * ---------------------------------------------------------------------------
 * Translates Stripe's PaymentIntents API, the `Stripe-Signature` scheme
 * (`t=<ts>,v1=<hmac>` over `"<ts>.<body>"`) and `payment_intent.*`/`charge.*`
 * events into the canonical contract. Amounts are in cents; `metadata` carries
 * our reference/tenant and is echoed back on webhooks. REST over `fetch` — no
 * `stripe` SDK — with an injectable transport for tests.
 */

export type StripeConfig = {
  secretKey: string
  webhookSecret: string
  publishableKey?: string
  apiBase?: string
  /** Signature tolerance in seconds (default 300). */
  toleranceSeconds?: number
  fetchImpl?: typeof fetch
  /** Injectable clock (ms) for deterministic tolerance checks in tests. */
  now?: () => number
  retry?: RetryOptions
}

const STRIPE_STATUS: Record<string, CanonicalPaymentStatus> = {
  requires_payment_method: "pending",
  requires_confirmation: "pending",
  requires_action: "pending",
  requires_capture: "authorized",
  processing: "pending",
  succeeded: "succeeded",
  canceled: "failed",
}

const STRIPE_EVENT: Record<string, CanonicalEventType> = {
  "payment_intent.succeeded": "payment.succeeded",
  "payment_intent.payment_failed": "payment.failed",
  "payment_intent.canceled": "payment.failed",
  "payment_intent.processing": "payment.pending",
  "charge.refunded": "refund.succeeded",
  "refund.updated": "refund.succeeded",
}

export class StripeGateway implements PaymentGateway {
  readonly name = "stripe"
  private readonly cfg: StripeConfig
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(cfg: StripeConfig) {
    if (!cfg.secretKey) throw new Error("StripeGateway requires a secretKey.")
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch
    this.now = cfg.now ?? Date.now
  }

  mapStatus(providerStatus: string): CanonicalPaymentStatus {
    return STRIPE_STATUS[String(providerStatus).toLowerCase()] ?? "pending"
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // Stripe's API is form-encoded, including nested metadata[...] keys.
    const form = new URLSearchParams()
    form.set("amount", String(toMinorUnits(input.amount, input.currency)))
    form.set("currency", String(input.currency).toLowerCase())
    form.set("description", input.description ?? `Payment ${input.reference}`)
    if (input.customerEmail) form.set("receipt_email", input.customerEmail)
    form.set("metadata[reference]", input.reference)
    for (const [k, v] of Object.entries(input.metadata ?? {})) form.set(`metadata[${k}]`, String(v))

    const intent = await withRetry(async () => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.cfg.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      }
      // Idempotency-Key makes a retried create return the SAME PaymentIntent.
      if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey

      let res: Response
      try {
        res = await this.fetchImpl(`${this.cfg.apiBase ?? "https://api.stripe.com/v1"}/payment_intents`, {
          method: "POST",
          headers,
          body: form.toString(),
        })
      } catch (cause) {
        throw new GatewayError("Stripe request failed to send", { retryable: true, gateway: this.name, cause })
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new GatewayError(`Stripe PaymentIntent create failed (${res.status}): ${text}`, {
          retryable: isRetryableHttpStatus(res.status),
          status: res.status,
          gateway: this.name,
        })
      }
      return (await res.json()) as any
    }, this.cfg.retry)

    return {
      gateway: this.name,
      providerId: String(intent.id),
      status: this.mapStatus(intent.status ?? "requires_payment_method"),
      amount: fromMinorUnits(intent.amount, input.currency),
      currency: String(intent.currency ?? input.currency).toUpperCase(),
      clientParams: {
        publishableKey: this.cfg.publishableKey ?? undefined,
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
      },
      raw: intent,
    }
  }

  verifyWebhook(input: WebhookVerifyInput): boolean {
    const header = input.headers["stripe-signature"]
    if (!header || !this.cfg.webhookSecret) return false

    // Header format: "t=1614556800,v1=hex,v1=hex2" (multiple v1s during rotation).
    let timestamp = ""
    const signatures: string[] = []
    for (const part of header.split(",")) {
      const [key, value] = part.split("=")
      if (key === "t") timestamp = value
      else if (key === "v1" && value) signatures.push(value)
    }
    if (!timestamp || signatures.length === 0) return false

    // Replay protection: reject stale timestamps outside the tolerance window.
    const tolerance = this.cfg.toleranceSeconds ?? 300
    const ageSeconds = Math.abs(Math.floor(this.now() / 1000) - Number(timestamp))
    if (!Number.isFinite(ageSeconds) || ageSeconds > tolerance) return false

    const expected = createHmac("sha256", this.cfg.webhookSecret)
      .update(`${timestamp}.${input.rawBody}`, "utf8")
      .digest("hex")
    return signatures.some((sig) => safeEqualHex(expected, sig))
  }

  parseEvent(rawBody: string): GatewayEvent {
    const payload = JSON.parse(rawBody) as any
    const eventType = String(payload?.type ?? "")
    const type = STRIPE_EVENT[eventType] ?? "unknown"
    const object = payload?.data?.object ?? {}
    const currency = String(object.currency ?? "").toUpperCase() || null

    const metadata: Record<string, string> = {}
    for (const [k, v] of Object.entries(object.metadata ?? {})) metadata[k] = String(v)

    const isRefund = type === "refund.succeeded"
    // charge.refunded carries the net refunded amount under amount_refunded.
    const rawAmount = isRefund
      ? object.amount_refunded ?? object.amount
      : object.amount_received ?? object.amount

    return {
      id: String(payload?.id ?? object.id ?? ""),
      gateway: this.name,
      type,
      providerPaymentId: object.payment_intent
        ? String(object.payment_intent)
        : object.id
          ? String(object.id)
          : null,
      providerOrderId: object.payment_intent ? String(object.payment_intent) : object.id ? String(object.id) : null,
      providerRefundId: isRefund && object.object === "refund" ? String(object.id) : null,
      reference: metadata.reference ?? null,
      metadata,
      amount: rawAmount != null && currency ? fromMinorUnits(rawAmount, currency) : null,
      currency,
      status: this.mapStatus(object.status ?? (type === "payment.succeeded" ? "succeeded" : "")),
      occurredAt: payload?.created ? new Date(Number(payload.created) * 1000).toISOString() : null,
      raw: payload,
    }
  }
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex")
    const bb = Buffer.from(b, "hex")
    if (ba.length === 0 || ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}
