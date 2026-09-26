import { describe, expect, it } from "vitest"
import {
  addressHash,
  consentKeyword,
  decideSend,
  maskAddress,
  normalizeAddress,
  nextWindow,
  parseEmailEvents,
  validateProviderConfig,
  verifyEventSignature,
  windowStart,
  SOFT_BOUNCE_THRESHOLD,
} from "@/lib/comms-governance/model"
import crypto from "node:crypto"

/**
 * Spec41 (#135-139, #218-219) — pure governance rules. These decide whether an
 * outbound message may leave the platform, so their correctness is the whole
 * feature: provider allow-listing, secret rejection, suppression/consent logic,
 * send-window math, and duplicate-safe provider event parsing.
 */

describe("provider config validation", () => {
  const base = { channel: "email", provider: "ses", enabled: true, credentialRef: "vault:ses-key", settings: {} }

  it("accepts a valid config and normalizes the provider", () => {
    const out = validateProviderConfig({ ...base, provider: "SES" })
    expect(out).toMatchObject({ channel: "email", provider: "ses", enabled: true, credentialRef: "vault:ses-key" })
  })

  it("rejects a provider that is not allow-listed for the channel", () => {
    expect(() => validateProviderConfig({ ...base, provider: "twilio" })).toThrow(/not supported/)
  })

  it("requires a credentialRef for a non-platform provider when enabled", () => {
    expect(() => validateProviderConfig({ ...base, credentialRef: null })).toThrow(/requires a credentialRef/)
  })

  it("allows the shared platform transport without a credential", () => {
    expect(validateProviderConfig({ ...base, provider: "platform", credentialRef: null }).credentialRef).toBeNull()
  })

  it("NEVER accepts an inline secret in credentialRef or settings", () => {
    expect(() => validateProviderConfig({ ...base, credentialRef: "AKIA SECRET WITH SPACES!!" })).toThrow(/vault reference/)
    expect(() => validateProviderConfig({ ...base, settings: { api_key: "sk-live-123" } })).toThrow(/looks like a secret/)
    expect(() => validateProviderConfig({ ...base, settings: { password: "hunter2" } })).toThrow(/looks like a secret/)
  })

  it("validates send limits and their ordering", () => {
    expect(validateProviderConfig({ ...base, hourlyLimit: 10, dailyLimit: 100 }).dailyLimit).toBe(100)
    expect(() => validateProviderConfig({ ...base, hourlyLimit: 200, dailyLimit: 100 })).toThrow(/cannot exceed/)
    expect(() => validateProviderConfig({ ...base, hourlyLimit: -1 })).toThrow(/between 0 and/)
  })

  it("rejects unknown channels and non-boolean enabled", () => {
    expect(() => validateProviderConfig({ ...base, channel: "carrier-pigeon" })).toThrow(/Unknown channel/)
    expect(() => validateProviderConfig({ ...base, enabled: "yes" })).toThrow(/must be a boolean/)
  })
})

describe("address normalization / hashing / masking", () => {
  it("normalizes email and phone canonically", () => {
    expect(normalizeAddress("email", "  Customer@Example.COM ")).toBe("customer@example.com")
    expect(normalizeAddress("sms", "+1 (555) 123-4567")).toBe("15551234567")
  })
  it("rejects malformed addresses", () => {
    expect(() => normalizeAddress("email", "not-an-email")).toThrow()
    expect(() => normalizeAddress("sms", "123")).toThrow()
  })
  it("hash is stable across formatting and channel-scoped", () => {
    expect(addressHash("email", "A@B.com")).toBe(addressHash("email", "a@b.com"))
    expect(addressHash("sms", "+15551234567")).not.toBe(addressHash("whatsapp", "+15551234567"))
  })
  it("masks PII for display", () => {
    expect(maskAddress("email", "customer@example.com")).toBe("cu***@example.com")
    expect(maskAddress("sms", "+15551234567")).toBe("***4567")
  })
})

describe("send decision (bounce / complaint / opt-out / limits)", () => {
  it("blocks everything when the tenant provider is disabled", () => {
    expect(decideSend({ providerEnabled: false, suppressions: [] })).toEqual({ ok: false, code: "provider_disabled" })
  })
  it("blocks hard bounces and manual suppressions unconditionally", () => {
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "hard_bounce" }] }).ok).toBe(false)
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "manual" }] }).ok).toBe(false)
  })
  it("blocks soft bounces only at the threshold", () => {
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "soft_bounce", count: SOFT_BOUNCE_THRESHOLD - 1 }] }).ok).toBe(true)
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "soft_bounce", count: SOFT_BOUNCE_THRESHOLD }] }).ok).toBe(false)
  })
  it("blocks consent withdrawals unless the message is mandatory", () => {
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "opt_out" }] }).ok).toBe(false)
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "complaint" }] }).ok).toBe(false)
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "opt_out" }], mandatory: true }).ok).toBe(true)
    // A hard bounce is undeliverable even for mandatory security notices.
    expect(decideSend({ providerEnabled: true, suppressions: [{ reason: "hard_bounce" }], mandatory: true }).ok).toBe(false)
  })
})

describe("consent keywords (WhatsApp / SMS STOP/START)", () => {
  it("recognizes opt-out and opt-in keywords regardless of case/space", () => {
    expect(consentKeyword(" stop ")).toBe("opt_out")
    expect(consentKeyword("UNSUBSCRIBE")).toBe("opt_out")
    expect(consentKeyword("Start")).toBe("opt_in")
    expect(consentKeyword("hello there")).toBeNull()
  })
})

describe("send-limit windows", () => {
  it("floors to the UTC hour/day and advances one window", () => {
    const at = new Date("2027-02-12T13:37:45.000Z")
    expect(windowStart("hour", at).toISOString()).toBe("2027-02-12T13:00:00.000Z")
    expect(windowStart("day", at).toISOString()).toBe("2027-02-12T00:00:00.000Z")
    expect(nextWindow("hour", at).toISOString()).toBe("2027-02-12T14:00:00.000Z")
    expect(nextWindow("day", at).toISOString()).toBe("2027-02-13T00:00:00.000Z")
  })
})

describe("provider event parsing (duplicate-safe, multi-provider)", () => {
  it("parses SES permanent bounce as a hard bounce with a unique event id", () => {
    const body = {
      MessageId: "sns-1",
      Message: JSON.stringify({
        notificationType: "Bounce",
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@b.com" }] },
        mail: { messageId: "msg-1" },
      }),
    }
    const events = parseEmailEvents("ses", body)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "hard_bounce", address: "a@b.com", providerMessageId: "msg-1" })
  })

  it("parses SendGrid spamreport as a complaint and blocked as a soft bounce", () => {
    const events = parseEmailEvents("sendgrid", [
      { event: "spamreport", email: "c@d.com", sg_event_id: "e1", sg_message_id: "m1.filter" },
      { event: "bounce", type: "blocked", email: "e@f.com", sg_event_id: "e2", sg_message_id: "m2.filter" },
    ])
    expect(events.map((e) => e.type)).toEqual(["complaint", "soft_bounce"])
    expect(events[0].providerMessageId).toBe("m1")
  })

  it("parses Resend bounce type into hard/soft correctly", () => {
    const hard = parseEmailEvents("resend", { type: "email.bounced", data: { email_id: "r1", to: ["x@y.com"], bounce: { type: "Permanent" } } })
    expect(hard[0]).toMatchObject({ type: "hard_bounce", address: "x@y.com" })
    const soft = parseEmailEvents("resend", { type: "email.bounced", data: { email_id: "r2", to: ["x@y.com"], bounce: { type: "Transient" } } })
    expect(soft[0].type).toBe("soft_bounce")
  })

  it("drops unknown event types instead of guessing", () => {
    expect(parseEmailEvents("sendgrid", [{ event: "open", email: "a@b.com", sg_event_id: "z" }])).toHaveLength(0)
    expect(parseEmailEvents("generic", { events: [{ type: "clicked", id: "z", email: "a@b.com" }] })).toHaveLength(0)
  })

  it("skips events without an address or event id", () => {
    expect(parseEmailEvents("generic", { events: [{ type: "hard_bounce", email: "a@b.com" }] })).toHaveLength(0)
    expect(parseEmailEvents("generic", { events: [{ type: "hard_bounce", id: "x" }] })).toHaveLength(0)
  })
})

describe("webhook signature verification", () => {
  const secret = "shhh"
  const rawBody = JSON.stringify({ events: [] })
  const ts = String(Math.floor(Date.now() / 1000))
  const sign = (t: string, b: string) => "sha256=" + crypto.createHmac("sha256", secret).update(`${t}.${b}`).digest("hex")

  it("accepts a fresh, correctly signed body", () => {
    expect(verifyEventSignature({ secret, rawBody, timestamp: ts, signature: sign(ts, rawBody) })).toBe(true)
  })
  it("rejects a tampered body, wrong secret, missing parts and stale timestamp", () => {
    expect(verifyEventSignature({ secret, rawBody: rawBody + "x", timestamp: ts, signature: sign(ts, rawBody) })).toBe(false)
    expect(verifyEventSignature({ secret: "other", rawBody, timestamp: ts, signature: sign(ts, rawBody) })).toBe(false)
    expect(verifyEventSignature({ secret: undefined, rawBody, timestamp: ts, signature: sign(ts, rawBody) })).toBe(false)
    const old = String(Math.floor(Date.now() / 1000) - 10_000)
    expect(verifyEventSignature({ secret, rawBody, timestamp: old, signature: sign(old, rawBody) })).toBe(false)
  })
})
