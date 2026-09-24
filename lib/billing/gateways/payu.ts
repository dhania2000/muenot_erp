import { createHash, timingSafeEqual } from "node:crypto"
import {
  type CanonicalEventType,
  type CanonicalPaymentStatus,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type GatewayEvent,
  type PaymentGateway,
  type WebhookVerifyInput,
} from "./types"

/**
 * PayU (India) adapter.
 * ---------------------------------------------------------------------------
 * PayU's classic flow is a merchant-hosted form POST to `/_payment`, not a REST
 * "create order" call: the merchant signs the request with SHA-512 over a fixed
 * field sequence keyed by the merchant SALT, the browser posts the signed form
 * to PayU's hosted checkout, and PayU later fires a server-to-server webhook
 * (and browser redirect) carrying a *reverse* SHA-512 hash we re-derive to
 * authenticate the callback. Amounts travel in MAJOR units (rupees) as a
 * 2-decimal string — there is no minor-unit conversion.
 *
 * Because there is no server round-trip to open the charge, `createPayment`
 * performs no network I/O: it builds and signs the form fields and returns them
 * as `clientParams` for the browser to post. All money movement is confirmed
 * through the verified webhook, exactly like the other adapters.
 *
 * Our routing metadata (tenant id, invoice id) is carried in PayU's echoed
 * `udf1..udf5` user-defined fields — the only values PayU signs and returns —
 * and reconstructed into canonical `metadata` on the way back.
 */

export type PayUConfig = {
  /** PayU merchant key (public-ish; appears in the form). */
  merchantKey: string
  /** PayU merchant SALT — signs requests AND authenticates callbacks. Secret. */
  merchantSalt: string
  /** Hosted checkout base, e.g. https://secure.payu.in (test: https://test.payu.in). */
  apiBase?: string
  /** Where PayU redirects the browser on success/failure (hosted checkout needs both). */
  successUrl?: string
  failureUrl?: string
}

const PAYU_STATUS: Record<string, CanonicalPaymentStatus> = {
  success: "succeeded",
  captured: "succeeded",
  failure: "failed",
  failed: "failed",
  cancel: "failed",
  cancelled: "failed",
  usercancelled: "failed",
  pending: "pending",
  "in progress": "pending",
}

export class PayUGateway implements PaymentGateway {
  readonly name = "payu"
  private readonly cfg: PayUConfig

  constructor(cfg: PayUConfig) {
    if (!cfg.merchantKey || !cfg.merchantSalt) {
      throw new Error("PayUGateway requires merchantKey and merchantSalt.")
    }
    this.cfg = cfg
  }

  mapStatus(providerStatus: string): CanonicalPaymentStatus {
    return PAYU_STATUS[String(providerStatus).toLowerCase().trim()] ?? "pending"
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const key = this.cfg.merchantKey
    const txnid = input.reference
    const amount = formatAmount(input.amount)
    const productinfo = input.description ?? `Payment ${input.reference}`
    const firstname = (input.customerName ?? "Customer").split(" ")[0]
    const email = input.customerEmail ?? ""

    // PayU only echoes/signs udf1..udf5, so our routing keys must live there.
    const meta = input.metadata ?? {}
    const udf1 = str(meta.tenant_id ?? meta.tenantId)
    const udf2 = str(meta.invoice_id ?? meta.invoiceId)
    const udf3 = str(meta.invoice_no ?? meta.invoiceNo)
    const udf4 = ""
    const udf5 = ""

    const hash = this.requestHash({ key, txnid, amount, productinfo, firstname, email, udf1, udf2, udf3, udf4, udf5 })

    const params: Record<string, string> = {
      key,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      phone: str(meta.phone),
      udf1,
      udf2,
      udf3,
      udf4,
      udf5,
      surl: this.cfg.successUrl ?? "",
      furl: this.cfg.failureUrl ?? "",
      hash,
    }

    return {
      gateway: this.name,
      // No provider id exists until PayU issues a mihpayid post-payment; the
      // txnid IS our correlation handle and is echoed back on the webhook.
      providerId: txnid,
      status: "created",
      amount: input.amount,
      currency: String(input.currency).toUpperCase(),
      clientParams: {
        action: `${this.cfg.apiBase ?? "https://secure.payu.in"}/_payment`,
        method: "POST",
        params,
      },
      raw: { params },
    }
  }

  verifyWebhook(input: WebhookVerifyInput): boolean {
    const fields = parseFormBody(input.rawBody)
    const provided = String(fields.hash ?? "")
    if (!provided) return false
    // PayU signs its own merchant key into the callback; reject foreign keys.
    if (fields.key && fields.key !== this.cfg.merchantKey) return false
    const expected = this.responseHash(fields)
    return safeEqualHex(expected, provided)
  }

  parseEvent(rawBody: string): GatewayEvent {
    const f = parseFormBody(rawBody)
    const rawStatus = String(f.status ?? "").toLowerCase().trim()
    const isRefund =
      String(f.action ?? "").toLowerCase() === "refund" ||
      f.refund_amount != null ||
      f.request_id != null // PayU refund S2S carries request_id + refund fields

    let type: CanonicalEventType
    if (isRefund) {
      type = rawStatus === "success" || rawStatus === "refunded" || rawStatus === "queued" ? "refund.succeeded" : "unknown"
    } else if (rawStatus === "success") {
      type = "payment.succeeded"
    } else if (rawStatus === "failure" || rawStatus === "failed" || rawStatus.includes("cancel")) {
      type = "payment.failed"
    } else if (rawStatus === "pending" || rawStatus === "in progress") {
      type = "payment.pending"
    } else {
      type = "unknown"
    }

    const metadata: Record<string, string> = {}
    if (f.udf1) metadata.tenant_id = String(f.udf1)
    if (f.udf2) metadata.invoice_id = String(f.udf2)
    if (f.udf3) metadata.invoice_no = String(f.udf3)
    for (let i = 1; i <= 5; i++) {
      const v = f[`udf${i}`]
      if (v != null && v !== "") metadata[`udf${i}`] = String(v)
    }

    const amountStr = isRefund ? f.refund_amount ?? f.amount : f.amount
    const amount = amountStr != null && amountStr !== "" ? round2(Number(amountStr)) : null

    return {
      id: String(f.mihpayid ?? f.txnid ?? `${type}:${f.txnid ?? ""}`),
      gateway: this.name,
      type,
      providerPaymentId: f.mihpayid ? String(f.mihpayid) : null,
      providerOrderId: f.txnid ? String(f.txnid) : null,
      providerRefundId: isRefund ? String(f.refund_id ?? f.request_id ?? "") || null : null,
      reference: f.txnid ? String(f.txnid) : null,
      metadata,
      amount,
      currency: null, // PayU callbacks omit currency; the settled invoice owns it.
      status: this.mapStatus(rawStatus),
      occurredAt: f.addedon ? new Date(String(f.addedon)).toISOString() : null,
      raw: f,
    }
  }

  /** SHA-512 over the request field sequence keyed by SALT. */
  private requestHash(a: {
    key: string
    txnid: string
    amount: string
    productinfo: string
    firstname: string
    email: string
    udf1: string
    udf2: string
    udf3: string
    udf4: string
    udf5: string
  }): string {
    // key|txnid|amount|productinfo|firstname|email|udf1..udf5|udf6..udf10(empty)|SALT
    const seq = [
      a.key, a.txnid, a.amount, a.productinfo, a.firstname, a.email,
      a.udf1, a.udf2, a.udf3, a.udf4, a.udf5,
      "", "", "", "", "",
      this.cfg.merchantSalt,
    ]
    return sha512(seq.join("|"))
  }

  /** SHA-512 over the REVERSED sequence — how PayU signs its callback. */
  private responseHash(f: Record<string, string>): string {
    const base = [
      this.cfg.merchantSalt,
      String(f.status ?? ""),
      "", "", "", "", "", // udf10..udf6 (unused)
      String(f.udf5 ?? ""),
      String(f.udf4 ?? ""),
      String(f.udf3 ?? ""),
      String(f.udf2 ?? ""),
      String(f.udf1 ?? ""),
      String(f.email ?? ""),
      String(f.firstname ?? ""),
      String(f.productinfo ?? ""),
      String(f.amount ?? ""),
      String(f.txnid ?? ""),
      String(f.key ?? this.cfg.merchantKey),
    ]
    // When PayU applies additional charges it prepends them to the reverse hash.
    if (f.additionalCharges) base.unshift(String(f.additionalCharges))
    return sha512(base.join("|"))
  }
}

function formatAmount(amount: number): string {
  return (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2)
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

function str(v: unknown): string {
  return v == null ? "" : String(v)
}

function parseFormBody(rawBody: string): Record<string, string> {
  const out: Record<string, string> = {}
  const trimmed = String(rawBody ?? "").trim()
  // PayU posts application/x-www-form-urlencoded, but tolerate a JSON body too.
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed)
      for (const [k, v] of Object.entries(obj)) out[k] = v == null ? "" : String(v)
      return out
    } catch {
      /* fall through to form parsing */
    }
  }
  const params = new URLSearchParams(trimmed)
  params.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function sha512(input: string): string {
  return createHash("sha512").update(input, "utf8").digest("hex")
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
