import { createHmac, timingSafeEqual } from "node:crypto"
import {
  type CanonicalEventType,
  type CanonicalPaymentStatus,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type GatewayEvent,
  type PaymentGateway,
  type WebhookVerifyInput,
} from "./types"
import { GatewayError, isRetryableHttpStatus, withRetry, type RetryOptions } from "./retry"

/**
 * Cashfree (India) Payment Gateway adapter.
 * ---------------------------------------------------------------------------
 * Cashfree is REST/JSON: `POST /pg/orders` (authenticated with
 * `x-client-id` + `x-client-secret` and a pinned `x-api-version`) opens an
 * order and returns a `payment_session_id` the browser SDK uses to complete the
 * charge. Amounts are in MAJOR units (rupees) — no minor-unit conversion.
 *
 * Webhooks are authenticated by an HMAC-SHA256 signature over
 * `timestamp + rawBody`, base64-encoded, in `x-webhook-signature` with the
 * timestamp in `x-webhook-timestamp`; the shared secret is the client secret.
 * Our routing metadata rides in `order_tags` and is echoed back verbatim.
 *
 * REST over injectable `fetch` (no `cashfree-pg` SDK), mirroring the Stripe /
 * Razorpay adapters so tests never touch the network.
 */

export type CashfreeConfig = {
  /** Cashfree app id → `x-client-id`. */
  appId: string
  /** Cashfree secret key → `x-client-secret` AND webhook HMAC key. Secret. */
  secretKey: string
  /** API base, e.g. https://api.cashfree.com (sandbox: https://sandbox.cashfree.com). */
  apiBase?: string
  /** Pinned API version header (default 2023-08-01). */
  apiVersion?: string
  /** Browser return URL for the hosted/redirect flow. */
  returnUrl?: string
  /**
   * Optional webhook replay window in seconds. When > 0, a signature whose
   * `x-webhook-timestamp` is older than this is rejected. Default 0 (disabled;
   * authenticity rests on the HMAC alone, matching Cashfree's own model).
   */
  toleranceSeconds?: number
  fetchImpl?: typeof fetch
  /** Injectable clock (ms) for deterministic tolerance checks in tests. */
  now?: () => number
  retry?: RetryOptions
}

const CASHFREE_STATUS: Record<string, CanonicalPaymentStatus> = {
  paid: "succeeded",
  success: "succeeded",
  active: "pending",
  pending: "pending",
  not_attempted: "pending",
  failed: "failed",
  cancelled: "failed",
  user_dropped: "failed",
  expired: "failed",
  refunded: "refunded",
}

export class CashfreeGateway implements PaymentGateway {
  readonly name = "cashfree"
  private readonly cfg: CashfreeConfig
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(cfg: CashfreeConfig) {
    if (!cfg.appId || !cfg.secretKey) throw new Error("CashfreeGateway requires appId and secretKey.")
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch
    this.now = cfg.now ?? Date.now
  }

  mapStatus(providerStatus: string): CanonicalPaymentStatus {
    return CASHFREE_STATUS[String(providerStatus).toLowerCase().trim()] ?? "pending"
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const meta = input.metadata ?? {}
    // order_tags values MUST be strings; carry tenant/invoice routing here.
    const orderTags: Record<string, string> = {}
    for (const [k, v] of Object.entries(meta)) orderTags[k] = String(v)

    const body = {
      order_id: input.reference,
      order_amount: round2(input.amount),
      order_currency: String(input.currency).toUpperCase(),
      order_note: input.description ?? `Payment ${input.reference}`,
      customer_details: {
        customer_id: str(meta.customer_id) || `cust_${input.reference}`,
        customer_email: input.customerEmail ?? undefined,
        customer_name: input.customerName ?? undefined,
        // Cashfree requires a phone; use a well-formed placeholder when absent.
        customer_phone: str(meta.phone) || "9999999999",
      },
      order_meta: this.cfg.returnUrl ? { return_url: this.cfg.returnUrl } : undefined,
      order_tags: Object.keys(orderTags).length ? orderTags : undefined,
    }

    const order = await withRetry(async () => {
      const headers: Record<string, string> = {
        "x-client-id": this.cfg.appId,
        "x-client-secret": this.cfg.secretKey,
        "x-api-version": this.cfg.apiVersion ?? "2023-08-01",
        "Content-Type": "application/json",
        Accept: "application/json",
      }
      // Cashfree dedups order creation on this header, so a retry is safe.
      if (input.idempotencyKey) headers["x-idempotency-key"] = input.idempotencyKey

      let res: Response
      try {
        res = await this.fetchImpl(`${this.cfg.apiBase ?? "https://api.cashfree.com"}/pg/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      } catch (cause) {
        throw new GatewayError("Cashfree request failed to send", { retryable: true, gateway: this.name, cause })
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new GatewayError(`Cashfree order create failed (${res.status}): ${text}`, {
          retryable: isRetryableHttpStatus(res.status),
          status: res.status,
          gateway: this.name,
        })
      }
      return (await res.json()) as any
    }, this.cfg.retry)

    return {
      gateway: this.name,
      // Correlate on OUR order_id (echoed on the webhook as data.order.order_id).
      providerId: String(order.order_id ?? input.reference),
      status: this.mapStatus(order.order_status ?? "active"),
      amount: round2(Number(order.order_amount ?? input.amount)),
      currency: String(order.order_currency ?? input.currency).toUpperCase(),
      clientParams: {
        paymentSessionId: order.payment_session_id,
        orderId: order.order_id ?? input.reference,
        cfOrderId: order.cf_order_id,
      },
      raw: order,
    }
  }

  verifyWebhook(input: WebhookVerifyInput): boolean {
    const signature = input.headers["x-webhook-signature"]
    const timestamp = input.headers["x-webhook-timestamp"]
    if (!signature || !timestamp || !this.cfg.secretKey) return false

    const tolerance = this.cfg.toleranceSeconds ?? 0
    if (tolerance > 0) {
      const ts = Number(timestamp)
      const nowSec = Math.floor(this.now() / 1000)
      const ageSeconds = Math.abs(nowSec - ts)
      if (!Number.isFinite(ageSeconds) || ageSeconds > tolerance) return false
    }

    const expected = createHmac("sha256", this.cfg.secretKey)
      .update(`${timestamp}${input.rawBody}`, "utf8")
      .digest("base64")
    return safeEqualBase64(expected, signature)
  }

  parseEvent(rawBody: string): GatewayEvent {
    const payload = JSON.parse(rawBody) as any
    const eventType = String(payload?.type ?? "")
    const order = payload?.data?.order ?? {}
    const payment = payload?.data?.payment ?? {}
    const refund = payload?.data?.refund ?? null

    let type: CanonicalEventType
    switch (eventType) {
      case "PAYMENT_SUCCESS_WEBHOOK":
        type = "payment.succeeded"
        break
      case "PAYMENT_FAILED_WEBHOOK":
      case "PAYMENT_USER_DROPPED_WEBHOOK":
        type = "payment.failed"
        break
      case "REFUND_STATUS_WEBHOOK":
        type = String(refund?.refund_status ?? "").toUpperCase() === "SUCCESS" ? "refund.succeeded" : "unknown"
        break
      default:
        type = "unknown"
    }

    const metadata: Record<string, string> = {}
    for (const [k, v] of Object.entries(order.order_tags ?? {})) metadata[k] = String(v)

    const currency =
      String(payment.payment_currency ?? order.order_currency ?? refund?.refund_currency ?? "").toUpperCase() || null

    const isRefund = type === "refund.succeeded"
    const rawAmount = isRefund ? refund?.refund_amount : payment.payment_amount ?? order.order_amount

    return {
      id: String(
        payment.cf_payment_id ??
          refund?.cf_refund_id ??
          `${eventType}:${order.order_id ?? ""}:${payload?.event_time ?? ""}`,
      ),
      gateway: this.name,
      type,
      providerPaymentId: payment.cf_payment_id != null ? String(payment.cf_payment_id) : null,
      providerOrderId: order.order_id != null ? String(order.order_id) : null,
      providerRefundId: isRefund && refund?.cf_refund_id != null ? String(refund.cf_refund_id) : null,
      reference: order.order_id != null ? String(order.order_id) : null,
      metadata,
      amount: rawAmount != null ? round2(Number(rawAmount)) : null,
      currency,
      status: this.mapStatus(
        payment.payment_status ?? (isRefund ? "refunded" : order.order_status ?? ""),
      ),
      occurredAt: payload?.event_time ? new Date(String(payload.event_time)).toISOString() : null,
      raw: payload,
    }
  }
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

function str(v: unknown): string {
  return v == null ? "" : String(v)
}

function safeEqualBase64(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "base64")
    const bb = Buffer.from(b, "base64")
    if (ba.length === 0 || ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}
