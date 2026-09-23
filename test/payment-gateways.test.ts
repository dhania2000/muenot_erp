import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  configureGatewaysFromEnv,
  currencyExponent,
  fromMinorUnits,
  getGateway,
  hasGateway,
  listGateways,
  registerGateway,
  resetRegistry,
  toMinorUnits,
} from "@/lib/billing/gateways"
import { GatewayError, isRetryableHttpStatus, withRetry } from "@/lib/billing/gateways/retry"
import { RazorpayGateway } from "@/lib/billing/gateways/razorpay"
import { StripeGateway } from "@/lib/billing/gateways/stripe"
import type { PaymentGateway } from "@/lib/billing/gateways/types"

/**
 * Phase 4. Provider-agnostic validation of the payment gateway
 * abstraction: money conversion, retry/backoff classification, charge
 * success/failure, webhook signature verification, event normalization, and
 * the registry. Adapters call an injected `fetch`, so nothing here touches the
 * network or a real provider.
 */

const noSleep = () => Promise.resolve()

// ── Money helpers ─────────────────────────────────────────────────────────────

describe("money helpers", () => {
  it("converts major↔minor units for 2-decimal currencies", () => {
    expect(toMinorUnits(12.5, "USD")).toBe(1250)
    expect(toMinorUnits(0.1, "INR")).toBe(10)
    expect(fromMinorUnits(1250, "USD")).toBe(12.5)
    expect(fromMinorUnits(1, "USD")).toBe(0.01)
  })

  it("treats zero-decimal currencies (JPY) without a ×100 factor", () => {
    expect(currencyExponent("JPY")).toBe(0)
    expect(toMinorUnits(500, "JPY")).toBe(500)
    expect(fromMinorUnits(500, "JPY")).toBe(500)
  })

  it("rounds to the nearest minor unit and survives float error", () => {
    expect(toMinorUnits(2.675, "EUR")).toBe(268)
    expect(fromMinorUnits(2999, "EUR")).toBe(29.99)
  })
})

// ── Retry / error classification ───────────────────────────────────────────────

describe("withRetry + GatewayError", () => {
  it("classifies only 429 and 5xx as retryable", () => {
    expect(isRetryableHttpStatus(500)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableHttpStatus(402)).toBe(false)
    expect(isRetryableHttpStatus(404)).toBe(false)
  })

  it("retries a transient failure then succeeds", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new GatewayError("boom", { retryable: true })
        return "ok"
      },
      { attempts: 3, sleep: noSleep },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  it("does NOT retry a non-retryable decline and rethrows immediately", async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new GatewayError("card declined", { retryable: false, status: 402 })
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toThrow("card declined")
    expect(calls).toBe(1)
  })

  it("gives up after the attempt budget and reports the last error", async () => {
    let calls = 0
    const onRetry = vi.fn()
    await expect(
      withRetry(
        async () => {
          calls++
          throw new GatewayError("still down", { retryable: true })
        },
        { attempts: 3, sleep: noSleep, onRetry },
      ),
    ).rejects.toThrow("still down")
    expect(calls).toBe(3)
    expect(onRetry).toHaveBeenCalledTimes(2) // retries between the 3 attempts
  })

  it("treats an unknown thrown error (dropped fetch) as retryable", async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls === 1) throw new TypeError("network error")
        return "recovered"
      },
      { attempts: 2, sleep: noSleep },
    )
    expect(result).toBe("recovered")
    expect(calls).toBe(2)
  })
})

// ── Test helpers to fake provider HTTP ──────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// ── Razorpay adapter ────────────────────────────────────────────────────────────

describe("RazorpayGateway.createPayment", () => {
  it("posts paise + notes and normalizes the order into a canonical result", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.amount).toBe(150000) // 1500.00 INR → paise
      expect(body.currency).toBe("INR")
      expect(body.notes.reference).toBe("BPAY-1")
      expect(body.notes.tenant_id).toBe("7")
      expect(init.headers["X-Razorpay-Idempotency-Key"]).toBe("idem-1")
      return jsonResponse({ id: "order_abc", status: "created", amount: 150000, currency: "INR" })
    }) as unknown as typeof fetch

    const gw = new RazorpayGateway({ keyId: "rzp_key", keySecret: "secret", webhookSecret: "wh", fetchImpl })
    const res = await gw.createPayment({
      amount: 1500,
      currency: "INR",
      reference: "BPAY-1",
      metadata: { tenant_id: 7, invoice_id: 42 },
      idempotencyKey: "idem-1",
    })

    expect(res.gateway).toBe("razorpay")
    expect(res.providerId).toBe("order_abc")
    expect(res.status).toBe("created")
    expect(res.amount).toBe(1500)
    expect((res.clientParams as any).order_id).toBe("order_abc")
    expect((res.clientParams as any).key).toBe("rzp_key")
  })

  it("retries a 500 then succeeds", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return jsonResponse({ error: "server" }, 500)
      return jsonResponse({ id: "order_x", status: "created", amount: 1000, currency: "USD" })
    }) as unknown as typeof fetch

    const gw = new RazorpayGateway({
      keyId: "k",
      keySecret: "s",
      webhookSecret: "wh",
      fetchImpl,
      retry: { sleep: noSleep },
    })
    const res = await gw.createPayment({ amount: 10, currency: "USD", reference: "BPAY-2" })
    expect(calls).toBe(2)
    expect(res.providerId).toBe("order_x")
  })

  it("does NOT retry a 400 and surfaces a GatewayError", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return jsonResponse({ error: { description: "bad request" } }, 400)
    }) as unknown as typeof fetch

    const gw = new RazorpayGateway({
      keyId: "k",
      keySecret: "s",
      webhookSecret: "wh",
      fetchImpl,
      retry: { sleep: noSleep },
    })
    await expect(gw.createPayment({ amount: 10, currency: "USD", reference: "BPAY-3" })).rejects.toBeInstanceOf(
      GatewayError,
    )
    expect(calls).toBe(1)
  })
})

describe("RazorpayGateway webhook + events", () => {
  const secret = "whsecret"
  const gw = new RazorpayGateway({ keyId: "k", keySecret: "apisecret", webhookSecret: secret })

  function sign(body: string): string {
    return createHmac("sha256", secret).update(body, "utf8").digest("hex")
  }

  it("accepts a correctly signed webhook and rejects a tampered one", () => {
    const body = JSON.stringify({ event: "payment.captured" })
    expect(gw.verifyWebhook({ rawBody: body, headers: { "x-razorpay-signature": sign(body) } })).toBe(true)
    expect(gw.verifyWebhook({ rawBody: body + " ", headers: { "x-razorpay-signature": sign(body) } })).toBe(false)
    expect(gw.verifyWebhook({ rawBody: body, headers: {} })).toBe(false)
  })

  it("normalizes payment.captured into payment.succeeded with major-unit amount", () => {
    const body = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_1",
            order_id: "order_abc",
            amount: 150000,
            currency: "INR",
            status: "captured",
            notes: { reference: "BPAY-1", tenant_id: "7", invoice_id: "42" },
            created_at: 1700000000,
          },
        },
      },
    })
    const event = gw.parseEvent(body)
    expect(event.type).toBe("payment.succeeded")
    expect(event.status).toBe("succeeded")
    expect(event.providerPaymentId).toBe("pay_1")
    expect(event.providerOrderId).toBe("order_abc")
    expect(event.amount).toBe(1500)
    expect(event.currency).toBe("INR")
    expect(event.reference).toBe("BPAY-1")
    expect(event.metadata.tenant_id).toBe("7")
  })

  it("normalizes payment.failed and refund.processed", () => {
    const failed = gw.parseEvent(
      JSON.stringify({
        event: "payment.failed",
        payload: { payment: { entity: { id: "pay_2", amount: 500, currency: "USD", status: "failed", notes: {} } } },
      }),
    )
    expect(failed.type).toBe("payment.failed")
    expect(failed.status).toBe("failed")

    const refund = gw.parseEvent(
      JSON.stringify({
        event: "refund.processed",
        payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 150000, currency: "INR", notes: { reference: "BPAY-1" } } } },
      }),
    )
    expect(refund.type).toBe("refund.succeeded")
    expect(refund.providerRefundId).toBe("rfnd_1")
    expect(refund.providerPaymentId).toBe("pay_1")
    expect(refund.amount).toBe(1500)
  })

  it("marks unrecognized events as unknown", () => {
    const event = gw.parseEvent(JSON.stringify({ event: "order.paid", payload: {} }))
    expect(event.type).toBe("unknown")
  })

  it("verifies the checkout hand-back payment signature", () => {
    const orderId = "order_abc"
    const paymentId = "pay_1"
    const good = createHmac("sha256", "apisecret").update(`${orderId}|${paymentId}`, "utf8").digest("hex")
    expect(gw.verifyPaymentSignature({ orderId, paymentId, signature: good })).toBe(true)
    expect(gw.verifyPaymentSignature({ orderId, paymentId, signature: "deadbeef" })).toBe(false)
  })
})

// ── Stripe adapter ────────────────────────────────────────────────────────────

describe("StripeGateway.createPayment", () => {
  it("form-encodes cents + metadata and normalizes the PaymentIntent", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const form = new URLSearchParams(init.body)
      expect(form.get("amount")).toBe("2500") // 25.00 USD → cents
      expect(form.get("currency")).toBe("usd")
      expect(form.get("metadata[reference]")).toBe("BPAY-9")
      expect(form.get("metadata[tenant_id]")).toBe("3")
      expect(init.headers["Idempotency-Key"]).toBe("idem-9")
      return jsonResponse({
        id: "pi_1",
        status: "requires_payment_method",
        amount: 2500,
        currency: "usd",
        client_secret: "pi_1_secret",
      })
    }) as unknown as typeof fetch

    const gw = new StripeGateway({ secretKey: "sk_test", webhookSecret: "wh", publishableKey: "pk_test", fetchImpl })
    const res = await gw.createPayment({
      amount: 25,
      currency: "USD",
      reference: "BPAY-9",
      metadata: { tenant_id: 3, invoice_id: 88 },
      idempotencyKey: "idem-9",
    })

    expect(res.gateway).toBe("stripe")
    expect(res.providerId).toBe("pi_1")
    expect(res.status).toBe("pending")
    expect(res.amount).toBe(25)
    expect((res.clientParams as any).clientSecret).toBe("pi_1_secret")
    expect((res.clientParams as any).publishableKey).toBe("pk_test")
  })

  it("retries a 429 then succeeds", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return jsonResponse({ error: "rate limited" }, 429)
      return jsonResponse({ id: "pi_2", status: "succeeded", amount: 100, currency: "usd", client_secret: "cs" })
    }) as unknown as typeof fetch

    const gw = new StripeGateway({ secretKey: "sk", webhookSecret: "wh", fetchImpl, retry: { sleep: noSleep } })
    const res = await gw.createPayment({ amount: 1, currency: "USD", reference: "BPAY-10" })
    expect(calls).toBe(2)
    expect(res.status).toBe("succeeded")
  })

  it("does NOT retry a 402 card decline", async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return jsonResponse({ error: { message: "declined" } }, 402)
    }) as unknown as typeof fetch

    const gw = new StripeGateway({ secretKey: "sk", webhookSecret: "wh", fetchImpl, retry: { sleep: noSleep } })
    await expect(gw.createPayment({ amount: 1, currency: "USD", reference: "BPAY-11" })).rejects.toBeInstanceOf(
      GatewayError,
    )
    expect(calls).toBe(1)
  })
})

describe("StripeGateway webhook + events", () => {
  const secret = "whsec_test"
  const fixedNow = 1_700_000_000_000 // ms
  const gw = new StripeGateway({ secretKey: "sk", webhookSecret: secret, now: () => fixedNow })

  function stripeSig(body: string, ts: number): string {
    const signed = `${ts}.${body}`
    const v1 = createHmac("sha256", secret).update(signed, "utf8").digest("hex")
    return `t=${ts},v1=${v1}`
  }

  it("accepts an in-tolerance signature and rejects a tampered body", () => {
    const ts = Math.floor(fixedNow / 1000)
    const body = JSON.stringify({ type: "payment_intent.succeeded" })
    expect(gw.verifyWebhook({ rawBody: body, headers: { "stripe-signature": stripeSig(body, ts) } })).toBe(true)
    expect(gw.verifyWebhook({ rawBody: body + "x", headers: { "stripe-signature": stripeSig(body, ts) } })).toBe(false)
  })

  it("rejects a stale timestamp outside the tolerance window (replay)", () => {
    const staleTs = Math.floor(fixedNow / 1000) - 4000 // > 300s default
    const body = JSON.stringify({ type: "payment_intent.succeeded" })
    expect(gw.verifyWebhook({ rawBody: body, headers: { "stripe-signature": stripeSig(body, staleTs) } })).toBe(false)
  })

  it("normalizes payment_intent.succeeded", () => {
    const event = gw.parseEvent(
      JSON.stringify({
        id: "evt_1",
        type: "payment_intent.succeeded",
        created: 1700000000,
        data: {
          object: {
            id: "pi_1",
            status: "succeeded",
            amount: 2500,
            amount_received: 2500,
            currency: "usd",
            metadata: { reference: "BPAY-9", tenant_id: "3", invoice_id: "88" },
          },
        },
      }),
    )
    expect(event.id).toBe("evt_1")
    expect(event.type).toBe("payment.succeeded")
    expect(event.status).toBe("succeeded")
    expect(event.providerPaymentId).toBe("pi_1")
    expect(event.amount).toBe(25)
    expect(event.metadata.invoice_id).toBe("88")
  })

  it("normalizes payment_intent.payment_failed and charge.refunded", () => {
    const failed = gw.parseEvent(
      JSON.stringify({
        id: "evt_2",
        type: "payment_intent.payment_failed",
        data: { object: { id: "pi_2", status: "requires_payment_method", amount: 500, currency: "usd", metadata: {} } },
      }),
    )
    expect(failed.type).toBe("payment.failed")

    const refunded = gw.parseEvent(
      JSON.stringify({
        id: "evt_3",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_1",
            object: "charge",
            payment_intent: "pi_1",
            amount: 2500,
            amount_refunded: 2500,
            currency: "usd",
            metadata: { reference: "BPAY-9" },
          },
        },
      }),
    )
    expect(refunded.type).toBe("refund.succeeded")
    expect(refunded.providerPaymentId).toBe("pi_1")
    expect(refunded.amount).toBe(25)
  })
})

// ── Registry ────────────────────────────────────────────────────────────────

describe("gateway registry", () => {
  beforeEach(() => resetRegistry())

  it("registers, looks up (case-insensitive), and lists providers", () => {
    const fake: PaymentGateway = {
      name: "razorpay",
      createPayment: async () => ({ gateway: "razorpay", providerId: "x", status: "created", amount: 0, currency: "USD", clientParams: {}, raw: {} }),
      verifyWebhook: () => true,
      parseEvent: () => ({ id: "1", gateway: "razorpay", type: "unknown", providerPaymentId: null, providerOrderId: null, providerRefundId: null, reference: null, metadata: {}, amount: null, currency: null, status: "created", occurredAt: null, raw: {} }),
      mapStatus: () => "created",
    }
    registerGateway(fake)
    expect(hasGateway("Razorpay")).toBe(true)
    expect(getGateway("RAZORPAY")).toBe(fake)
    expect(listGateways()).toContain("razorpay")
  })

  it("throws a helpful error for an unconfigured gateway", () => {
    expect(() => getGateway("paypal")).toThrow(/not configured/i)
  })

  it("configures adapters from environment credentials", () => {
    const gateways = configureGatewaysFromEnv(
      {
        RAZORPAY_KEY_ID: "rzp",
        RAZORPAY_KEY_SECRET: "s",
        RAZORPAY_WEBHOOK_SECRET: "wh",
        STRIPE_SECRET_KEY: "sk",
        STRIPE_WEBHOOK_SECRET: "whsec",
      } as NodeJS.ProcessEnv,
      true,
    )
    expect(gateways).toEqual(expect.arrayContaining(["razorpay", "stripe"]))
    expect(getGateway("razorpay")).toBeInstanceOf(RazorpayGateway)
    expect(getGateway("stripe")).toBeInstanceOf(StripeGateway)
  })

  it("omits a provider whose credentials are absent", () => {
    resetRegistry()
    configureGatewaysFromEnv({ STRIPE_SECRET_KEY: "sk" } as NodeJS.ProcessEnv, true)
    expect(hasGateway("stripe")).toBe(true)
    expect(hasGateway("razorpay")).toBe(false)
  })
})
