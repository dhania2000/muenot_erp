import { describe, expect, it } from "vitest"
import {
  AFFILIATE_COOKIE,
  advanceConversion,
  assertPayoutTransition,
  attributionDays,
  canonicalEmail,
  commissionTotals,
  decideTouch,
  detectSelfReferral,
  evaluateClick,
  isBot,
  newClickToken,
  parseClickCookie,
  readCookie,
  sameHash,
  sha256,
  signClickCookie,
  toSqlDateTime,
  touchPolicy,
  validateCurrency,
  validateLinkInput,
  validateLinkStatus,
  validatePayoutAction,
  type ClickRecord,
  type ConversionRow,
  type ExistingTouch,
  type LedgerEntry,
} from "@/lib/affiliates/model"
import { PartnerError } from "@/lib/partners/model"

/**
 * Spec30 (#173) — pure affiliate rules: signed click cookies, multi-touch,
 * self-referral, the conversion lifecycle and commission/payout projections.
 * No DB, no clock beyond the `now` we pass in.
 */

const SECRET = "unit-test-session-secret-value"
const future = "2027-02-10 09:00:00"
const now = new Date("2027-02-01T09:00:00Z")

function expectValidationError(fn: () => unknown) {
  const err = (() => {
    try {
      fn()
      return null
    } catch (e) {
      return e
    }
  })()
  expect(err).toBeInstanceOf(PartnerError)
  expect(err).toMatchObject({ status: 400 })
}

describe("policy from env", () => {
  it("clamps the attribution window to 1..90 and defaults to 30", () => {
    expect(attributionDays("45")).toBe(45)
    expect(attributionDays("90")).toBe(90)
    expect(attributionDays("120")).toBe(90)
    expect(attributionDays("0")).toBe(30)
    expect(attributionDays("-3")).toBe(30)
    expect(attributionDays("nope")).toBe(30)
    expect(attributionDays(undefined)).toBe(30)
  })

  it("reads the multi-touch policy, defaulting to last-click", () => {
    expect(touchPolicy("first")).toBe("first")
    expect(touchPolicy("last")).toBe("last")
    expect(touchPolicy("garbage")).toBe("last")
    expect(touchPolicy(undefined)).toBe("last")
  })
})

describe("link input validation", () => {
  it("trims and nullifies labels and caps the length", () => {
    expect(validateLinkInput({ label: "  Summer  " })).toEqual({ label: "Summer" })
    expect(validateLinkInput({ label: "   " })).toEqual({ label: null })
    expect(validateLinkInput({})).toEqual({ label: null })
    expectValidationError(() => validateLinkInput({ label: "x".repeat(81) }))
  })

  it("only accepts the two known statuses", () => {
    expect(validateLinkStatus("active")).toBe("active")
    expect(validateLinkStatus("disabled")).toBe("disabled")
    expectValidationError(() => validateLinkStatus("enabled"))
    expectValidationError(() => validateLinkStatus(undefined))
  })
})

describe("signed click cookie", () => {
  it("round-trips a signed cookie and rejects forgery, tampering and replay of the wrong secret", () => {
    const token = newClickToken()
    const cookie = signClickCookie(42, token, SECRET)
    expect(parseClickCookie(cookie, SECRET)).toEqual({ clickId: 42, token })

    // wrong secret → no attribution
    expect(parseClickCookie(cookie, "other-secret")).toBeNull()
    // empty secret is never trusted
    expect(parseClickCookie(cookie, "")).toBeNull()
    // tampered click id (signature no longer matches)
    const [, tok, sig] = cookie.split(".")
    expect(parseClickCookie(`99.${tok}.${sig}`, SECRET)).toBeNull()
    // structurally invalid
    expect(parseClickCookie("garbage", SECRET)).toBeNull()
    expect(parseClickCookie("1.2", SECRET)).toBeNull()
    expect(parseClickCookie("x".repeat(300), SECRET)).toBeNull()
    expect(parseClickCookie(null, SECRET)).toBeNull()
    // leading-zero / non-positive ids are refused before any crypto work
    expect(parseClickCookie(`0.${tok}.${sig}`, SECRET)).toBeNull()
  })

  it("sameHash is length-safe and only true for equal hashes", () => {
    expect(sameHash(sha256("a"), sha256("a"))).toBe(true)
    expect(sameHash(sha256("a"), sha256("b"))).toBe(false)
    expect(sameHash("short", sha256("a"))).toBe(false)
  })

  it("reads a named cookie out of a header and ignores others", () => {
    const header = `foo=bar; ${AFFILIATE_COOKIE}=abc.def.ghi; other=1`
    expect(readCookie(header, AFFILIATE_COOKIE)).toBe("abc.def.ghi")
    expect(readCookie(header, "missing")).toBeNull()
    expect(readCookie(null, AFFILIATE_COOKIE)).toBeNull()
  })
})

describe("bot filter", () => {
  it("treats missing or known crawler agents as bots", () => {
    expect(isBot(null)).toBe(true)
    expect(isBot("Googlebot/2.1")).toBe(true)
    expect(isBot("curl/8.0")).toBe(true)
    expect(isBot("python-requests/2.31")).toBe(true)
    expect(isBot("Mozilla/5.0 (Macintosh) Safari/605.1")).toBe(false)
  })
})

describe("multi-touch decision", () => {
  const existing = (over: Partial<NonNullable<ExistingTouch>> = {}): ExistingTouch => ({
    linkId: 1,
    expiresAt: future,
    consumed: false,
    ...over,
  })

  it("records a new click when there is no valid existing one", () => {
    expect(decideTouch(null, 1, "last", now)).toBe("new")
    expect(decideTouch(existing({ consumed: true }), 1, "last", now)).toBe("new")
    expect(decideTouch(existing({ expiresAt: "2027-01-01 00:00:00" }), 1, "last", now)).toBe("new")
  })

  it("reuses the same link without inflating clicks or extending the window", () => {
    expect(decideTouch(existing(), 1, "last", now)).toBe("reuse")
    expect(decideTouch(existing(), 1, "first", now)).toBe("reuse")
  })

  it("applies first- vs last-click on a different link", () => {
    expect(decideTouch(existing(), 2, "last", now)).toBe("new")
    expect(decideTouch(existing(), 2, "first", now)).toBe("keep")
  })
})

describe("server-side click validity at signup", () => {
  const click = (over: Partial<ClickRecord> = {}): ClickRecord => ({
    id: 1,
    linkId: 1,
    partnerId: 1,
    tokenHash: "hash",
    expiresAt: future,
    consumedAt: null,
    linkStatus: "active",
    partnerStatus: "active",
    ...over,
  })

  it("accepts a fresh active click and rejects expired/consumed/inactive ones", () => {
    expect(evaluateClick(click(), now)).toBeNull()
    expect(evaluateClick(click({ consumedAt: "2027-02-01 08:00:00" }), now)).toBe("consumed")
    expect(evaluateClick(click({ expiresAt: "2027-01-10 00:00:00" }), now)).toBe("expired")
    expect(evaluateClick(click({ linkStatus: "disabled" }), now)).toBe("link_inactive")
    expect(evaluateClick(click({ partnerStatus: "suspended" }), now)).toBe("partner_inactive")
  })
})

describe("self-referral detection", () => {
  it("canonicalizes mailboxes (case, +tags, gmail dots)", () => {
    expect(canonicalEmail("John.Doe+promo@Gmail.com")).toBe("johndoe@gmail.com")
    expect(canonicalEmail("a.b@googlemail.com")).toBe("ab@gmail.com")
    expect(canonicalEmail("Person+x@company.io")).toBe("person@company.io")
    expect(canonicalEmail("nope")).toBeNull()
    expect(canonicalEmail("@x.com")).toBeNull()
  })

  it("blocks the logged-in partner member, matching mailboxes and shared company domain", () => {
    const base = { partnerContactEmail: "sales@acmepartners.io", members: [{ userId: 7, email: "rep@acmepartners.io" }] }
    // browser already signed in as a member
    expect(detectSelfReferral({ ...base, registrantEmail: "new@customer.com", sessionUserId: 7 })).toBe("self_referral_session")
    // registrant mailbox equals a member (gmail-normalized)
    expect(
      detectSelfReferral({
        registrantEmail: "Rep+tag@acmepartners.io",
        sessionUserId: null,
        partnerContactEmail: null,
        members: [{ userId: 7, email: "rep@acmepartners.io" }],
      }),
    ).toBe("self_referral_email")
    // registrant shares the partner's own company domain
    expect(detectSelfReferral({ ...base, registrantEmail: "someoneelse@acmepartners.io", sessionUserId: null })).toBe(
      "self_referral_domain",
    )
  })

  it("does not treat a shared free-mail domain as a self-referral", () => {
    expect(
      detectSelfReferral({
        registrantEmail: "brandnew@gmail.com",
        sessionUserId: null,
        partnerContactEmail: "affiliate@gmail.com",
        members: [],
      }),
    ).toBeNull()
  })

  it("allows an unrelated registrant", () => {
    expect(
      detectSelfReferral({
        registrantEmail: "customer@bigco.com",
        sessionUserId: 3,
        partnerContactEmail: "sales@acmepartners.io",
        members: [{ userId: 7, email: "rep@acmepartners.io" }],
      }),
    ).toBeNull()
  })
})

describe("conversion lifecycle", () => {
  const row = (over: Partial<ConversionRow> = {}): ConversionRow => ({
    state: "referred",
    trialAt: null,
    convertedAt: null,
    paidAt: null,
    firstPaidInvoiceId: null,
    cancelledAt: null,
    ...over,
  })
  const nowSql = "2027-02-01 09:00:00"

  it("advances referred → trial → converted → paid and stamps each stage once", () => {
    const trial = advanceConversion(row(), { subscriptionStatus: "trialing", mrr: 0, firstPaidInvoice: null, referralActive: true }, nowSql)
    expect(trial).toMatchObject({ state: "trial", trialAt: nowSql })

    const converted = advanceConversion(trial!, { subscriptionStatus: "active", mrr: 5000, firstPaidInvoice: null, referralActive: true }, "2027-02-02 09:00:00")
    expect(converted).toMatchObject({ state: "converted", convertedAt: "2027-02-02 09:00:00", trialAt: nowSql })

    const paid = advanceConversion(
      converted!,
      { subscriptionStatus: "active", mrr: 5000, firstPaidInvoice: { id: 88, paidAt: "2027-02-03 10:00:00" }, referralActive: true },
      "2027-02-04 09:00:00",
    )
    expect(paid).toMatchObject({ state: "paid", paidAt: "2027-02-03 10:00:00", firstPaidInvoiceId: 88 })
  })

  it("never regresses and returns null when nothing changes", () => {
    // paid stays paid even if the subscription later reports merely active
    expect(
      advanceConversion(
        row({ state: "paid", paidAt: "2027-02-03 10:00:00", firstPaidInvoiceId: 88, convertedAt: nowSql, trialAt: nowSql }),
        { subscriptionStatus: "active", mrr: 5000, firstPaidInvoice: { id: 88, paidAt: "2027-02-03 10:00:00" }, referralActive: true },
        "2027-03-01 09:00:00",
      ),
    ).toBeNull()
  })

  it("cancels on a cancelled subscription or an ended attribution", () => {
    expect(
      advanceConversion(row({ state: "converted", convertedAt: nowSql }), { subscriptionStatus: "canceled", mrr: 0, firstPaidInvoice: null, referralActive: true }, nowSql),
    ).toMatchObject({ state: "cancelled", cancelledAt: nowSql })
    expect(
      advanceConversion(row({ state: "trial", trialAt: nowSql }), { subscriptionStatus: "active", mrr: 5000, firstPaidInvoice: null, referralActive: false }, nowSql),
    ).toMatchObject({ state: "cancelled" })
  })

  it("treats cancelled and rejected as terminal", () => {
    expect(advanceConversion(row({ state: "cancelled" }), { subscriptionStatus: "active", mrr: 5000, firstPaidInvoice: null, referralActive: true }, nowSql)).toBeNull()
    expect(advanceConversion(row({ state: "rejected" }), { subscriptionStatus: "active", mrr: 5000, firstPaidInvoice: null, referralActive: true }, nowSql)).toBeNull()
  })
})

describe("commission projections", () => {
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ id: 1, kind: "commission", amountCents: 0, currency: "USD", payoutStatus: null, ...over })

  it("splits per currency into pending/available/inPayout/paidOut and nets clawbacks", () => {
    const totals = commissionTotals(
      [
        entry({ id: 1, amountCents: 1000, payoutStatus: null }),
        entry({ id: 2, amountCents: 500, payoutStatus: "pending" }),
        entry({ id: 3, amountCents: 800, payoutStatus: "paid" }),
        entry({ id: 4, kind: "clawback", amountCents: -300, payoutStatus: null }),
        entry({ id: 5, amountCents: 700, currency: "EUR", payoutStatus: null }),
      ],
      [{ currency: "USD", cents: 250 }],
    )
    const usd = totals.find((t) => t.currency === "USD")!
    expect(usd).toMatchObject({ pendingCents: 250, availableCents: 700, inPayoutCents: 500, paidOutCents: 800, clawedBackCents: 300 })
    // currencies come back sorted
    expect(totals.map((t) => t.currency)).toEqual(["EUR", "USD"])
  })
})

describe("payout rules", () => {
  it("normalizes currency and rejects non 3-letter codes", () => {
    expect(validateCurrency(undefined)).toBe("USD")
    expect(validateCurrency("")).toBe("USD")
    expect(validateCurrency("eur")).toBe("EUR")
    expectValidationError(() => validateCurrency("US"))
    expectValidationError(() => validateCurrency("dollars"))
  })

  it("only allows transitions out of pending", () => {
    expect(assertPayoutTransition("pending", "mark_paid")).toBe("paid")
    expect(assertPayoutTransition("pending", "void")).toBe("void")
    for (const from of ["paid", "void"] as const) {
      const err = (() => {
        try {
          assertPayoutTransition(from, "mark_paid")
          return null
        } catch (e) {
          return e
        }
      })()
      expect(err).toMatchObject({ code: "INVALID_PAYOUT_TRANSITION", status: 409 })
    }
  })

  it("requires a reference to pay and a reason to void", () => {
    expect(validatePayoutAction({ action: "mark_paid", reference: "wire-12345" })).toEqual({ action: "mark_paid", reference: "wire-12345", reason: null })
    expect(validatePayoutAction({ action: "void", reason: "duplicate payout" })).toEqual({ action: "void", reference: null, reason: "duplicate payout" })
    expectValidationError(() => validatePayoutAction({ action: "mark_paid", reference: "no" }))
    expectValidationError(() => validatePayoutAction({ action: "void", reason: "x" }))
    expectValidationError(() => validatePayoutAction({ action: "delete" }))
  })
})

describe("sql datetime", () => {
  it("formats a Date as MySQL DATETIME (UTC)", () => {
    expect(toSqlDateTime(new Date("2027-02-01T09:30:15.500Z"))).toBe("2027-02-01 09:30:15")
  })
})
