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
 * Razorpay adapter (Phase 2).
 * ---------------------------------------------------------------------------
 * Translates Razorpay's Orders API, `X-Razorpay-Signature` HMAC scheme and
 * `payment.*`/`refund.*` webhook envelope into the canonical PaymentGateway
 * contract. Amounts on the wire are in paise (minor units); `notes` carries our
 * metadata and is echoed back on webhooks. No `razorpay` SDK dependency — we
 * call the REST API over `fetch`, which is injectable for tests.
 */

export type RazorpayConfig = {
  keyId: string
  keySecret: string
  /** Secret configured on the Razorpay webhook (separate from the API secret). */
  webhookSecret: string
  apiBase?: string
  /** Injectable transport (defaults to global fetch) — swapped in tests. */
  fetchImpl?: typeof fetch
  retry?: RetryOptions
}

const RAZORPAY_STATUS: Record<string, CanonicalPaymentStatus> = {
  created: "created",
  authorized: "authorized",
  captured: "succeeded",
  refunded: "refunded",
  failed: "failed",
}

const RAZORPAY_EVENT: Record<string, CanonicalEventType> = {
  "payment.captured": "payment.succeeded",
  "payment.authorized": "payment.pending",
  "payment.failed": "payment.failed",
  "refund.created": "refund.succeeded",
  "refund.processed": "refund.succeeded",
}

export class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay"
  private readonly cfg: RazorpayConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: RazorpayConfig) {
    if (!cfg.keyId || !cfg.keySecret) throw new Error("RazorpayGateway requires keyId and keySecret.")
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch
  }

  mapStatus(providerStatus: string): CanonicalPaymentStatus {
    return RAZORPAY_STATUS[String(providerStatus).toLowerCase()] ?? "pending"
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const authorization = "Basic " + Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64")
    const notes: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.metadata ?? {})) notes[k] = String(v)
    notes.reference = input.reference

    const body = {
      amount: toMinorUnits(input.amount, input.currency),
      currency: String(input.currency).toUpperCase(),
      receipt: input.reference,
      notes,
    }

    const order = await withRetry(async () => {
      const headers: Record<string, string> = {
        Authorization: authorization,
        "Content-Type": "application/json",
      }
      // Razorpay dedups order creation on the receipt when this header is set.
      if (input.idempotencyKey) headers["X-Razorpay-Idempotency-Key"] = input.idempotencyKey

      let res: Response
      try {
        res = await this.fetchImpl(`${this.cfg.apiBase ?? "https://api.razorpay.com/v1"}/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      } catch (cause) {
        // Transport-level failure (DNS/reset/timeout) — safe to retry.
        throw new GatewayError("Razorpay request failed to send", { retryable: true, gateway: this.name, cause })
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new GatewayError(`Razorpay order create failed (${res.status}): ${text}`, {
          retryable: isRetryableHttpStatus(res.status),
          status: res.status,
          gateway: this.name,
        })
      }
      return (await res.json()) as any
    }, this.cfg.retry)

    return {
      gateway: this.name,
      providerId: String(order.id),
      status: this.mapStatus(order.status ?? "created"),
      amount: fromMinorUnits(order.amount, input.currency),
      currency: String(order.currency ?? input.currency).toUpperCase(),
      clientParams: {
        key: this.cfg.keyId,
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        name: input.customerName ?? undefined,
        description: input.description ?? undefined,
        prefill: input.customerEmail ? { email: input.customerEmail } : undefined,
      },
      raw: order,
    }
  }

  verifyWebhook(input: WebhookVerifyInput): boolean {
    const signature = input.headers["x-razorpay-signature"]
    if (!signature || !this.cfg.webhookSecret) return false
    const expected = createHmac("sha256", this.cfg.webhookSecret).update(input.rawBody, "utf8").digest("hex")
    return safeEqualHex(expected, signature)
  }

  /**
   * Verify the checkout hand-back signature returned to the browser after a
   * successful Razorpay payment: HMAC(`order_id|payment_id`, keySecret). Not
   * part of the interface — Razorpay-specific client-callback verification.
   */
  verifyPaymentSignature(args: { orderId: string; paymentId: string; signature: string }): boolean {
    const expected = createHmac("sha256", this.cfg.keySecret)
      .update(`${args.orderId}|${args.paymentId}`, "utf8")
      .digest("hex")
    return safeEqualHex(expected, args.signature)
  }

  parseEvent(rawBody: string): GatewayEvent {
    const payload = JSON.parse(rawBody) as any
    const eventName = String(payload?.event ?? "")
    const type = RAZORPAY_EVENT[eventName] ?? "unknown"

    const payment = payload?.payload?.payment?.entity ?? null
    const refund = payload?.payload?.refund?.entity ?? null
    const entity = refund ?? payment ?? {}
    const currency = String(entity.currency ?? "").toUpperCase() || null
    const notes: Record<string, string> = {}
    for (const [k, v] of Object.entries(entity.notes ?? {})) notes[k] = String(v)

    return {
      // Razorpay does not send a stable event id in the body; synthesize a
      // deterministic one so redelivered events dedupe identically.
      id: String(payload?.id ?? `${eventName}:${entity.id ?? ""}:${entity.created_at ?? ""}`),
      gateway: this.name,
      type,
      providerPaymentId: refund ? String(refund.payment_id ?? "") || null : payment ? String(payment.id) : null,
      providerOrderId: payment?.order_id ? String(payment.order_id) : null,
      providerRefundId: refund ? String(refund.id) : null,
      reference: notes.reference ?? null,
      metadata: notes,
      amount: entity.amount != null && currency ? fromMinorUnits(entity.amount, currency) : null,
      currency,
      status: this.mapStatus(entity.status ?? (type === "payment.succeeded" ? "captured" : "")),
      occurredAt: entity.created_at ? new Date(Number(entity.created_at) * 1000).toISOString() : null,
      raw: payload,
    }
  }
}

/** Constant-time compare of two hex strings; false on any length/format mismatch. */
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
