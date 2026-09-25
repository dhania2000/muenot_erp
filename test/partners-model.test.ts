import { describe, expect, it } from "vitest"
import {
  PartnerError,
  assertStatusTransition,
  clawbackCents,
  commissionCents,
  decideSettlement,
  normalizeReferralCode,
  referralOnDay,
  summarize,
  toDashboardCommission,
  toDashboardReferral,
  validatePartnerInput,
  validateTerms,
  type InvoiceRecord,
  type PartnerRecord,
  type ReferralRecord,
} from "@/lib/partners/model"

/** Spec29 (#172) — pure partner rules: validation, attribution, settlement, clawback. */

const terms = {
  revenueShareBps: 2000,
  refundWindowDays: 30,
  contractStart: "2027-01-01",
  contractEnd: null,
  eligibilityMonths: null,
}
const partner = (over: Partial<PartnerRecord> = {}): PartnerRecord => ({ id: 1, status: "active", terms, ...over })
const ref = (over: Partial<ReferralRecord> = {}): ReferralRecord => ({
  id: 1,
  partnerId: 1,
  tenantId: 10,
  status: "active",
  attributedAt: "2027-01-10 09:00:00",
  endedAt: null,
  ...over,
})
const invoice = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: 100,
  tenantId: 10,
  amount: "100.00",
  refundedAmount: "0.00",
  status: "paid",
  issuedAt: "2027-02-01 00:00:00",
  periodStart: "2027-02-01",
  paidAt: "2027-02-03 12:00:00",
  ...over,
})
const decide = (inv: InvoiceRecord, refs: ReferralRecord[], ps: PartnerRecord[], today: string) =>
  decideSettlement(inv, refs, new Map(ps.map((p) => [p.id, p])), today)

describe("validation", () => {
  it("accepts a valid partner and applies defaults", () => {
    const out = validatePartnerInput({
      name: "  Acme Resellers ",
      kind: "reseller",
      contactEmail: " Ops@Acme.TEST ",
      terms: { revenueShareBps: "1500", contractStart: "2027-01-01" },
    })
    expect(out).toEqual({
      name: "Acme Resellers",
      kind: "reseller",
      contactEmail: "ops@acme.test",
      terms: { revenueShareBps: 1500, refundWindowDays: 30, contractStart: "2027-01-01", contractEnd: null, eligibilityMonths: null },
    })
  })

  it.each([
    [{ name: "A", terms }, "name"],
    [{ name: "Acme", kind: "affiliate", terms }, "kind"],
    [{ name: "Acme", contactEmail: "not-an-email", terms }, "contactEmail"],
    [{ name: "Acme", terms: { ...terms, revenueShareBps: 5001 } }, "revenueShareBps"],
    [{ name: "Acme", terms: { ...terms, revenueShareBps: -1 } }, "revenueShareBps"],
    [{ name: "Acme", terms: { ...terms, revenueShareBps: 12.5 } }, "revenueShareBps"],
    [{ name: "Acme", terms: { ...terms, refundWindowDays: 366 } }, "refundWindowDays"],
    [{ name: "Acme", terms: { ...terms, contractStart: "2027-13-01" } }, "contractStart"],
    [{ name: "Acme", terms: { ...terms, contractEnd: "2026-12-31" } }, "contractEnd"],
    [{ name: "Acme", terms: { ...terms, eligibilityMonths: 0 } }, "eligibilityMonths"],
    [{ name: "Acme" }, "revenueShareBps"],
  ])("rejects invalid input %#", (raw, field) => {
    expect(() => validatePartnerInput(raw)).toThrow(new RegExp(field))
  })

  it("merges partial term patches over the current terms", () => {
    expect(validateTerms({ revenueShareBps: 500 }, terms)).toEqual({ ...terms, revenueShareBps: 500 })
    expect(() => validateTerms({ contractEnd: "2026-01-01" }, terms)).toThrow(PartnerError)
  })

  it("never reactivates a terminated partner", () => {
    expect(() => assertStatusTransition("active", "suspended")).not.toThrow()
    expect(() => assertStatusTransition("suspended", "active")).not.toThrow()
    try {
      assertStatusTransition("terminated", "active")
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(PartnerError)
      expect((err as PartnerError).status).toBe(409)
    }
    expect(() => assertStatusTransition("active", "deleted" as any)).toThrow(/Invalid status/)
  })

  it("normalizes referral codes and treats malformed ones as absent", () => {
    expect(normalizeReferralCode(" abcd2345 ")).toBe("ABCD2345")
    expect(normalizeReferralCode("x'; DROP TABLE--")).toBeNull()
    expect(normalizeReferralCode("ABC")).toBeNull()
    expect(normalizeReferralCode(42)).toBeNull()
  })
})

describe("money", () => {
  it("rounds commission down so the platform never overpays", () => {
    expect(commissionCents(3333, 1500)).toBe(499)
    expect(commissionCents(0, 2000)).toBe(0)
    expect(commissionCents(-500, 2000)).toBe(0)
  })
})

describe("attribution changes", () => {
  const transferred = ref({ id: 1, partnerId: 1, status: "transferred", endedAt: "2027-02-15 08:00:00" })
  const successor = ref({ id: 2, partnerId: 2, attributedAt: "2027-02-15 08:00:00" })

  it("pays the partner that owned the tenant on the invoice issue day", () => {
    expect(referralOnDay([transferred, successor], "2027-02-14")?.partnerId).toBe(1)
    expect(referralOnDay([transferred, successor], "2027-02-15")?.partnerId).toBe(2)
    expect(referralOnDay([transferred, successor], "2027-01-09")).toBeNull()
  })

  it("resolves same-day re-attribution to the newest referral regardless of input order", () => {
    const a = ref({ id: 5, partnerId: 1, attributedAt: "2027-03-01 09:00:00" })
    const b = ref({ id: 6, partnerId: 2, attributedAt: "2027-03-01 11:00:00" })
    expect(referralOnDay([a, b], "2027-03-02")?.id).toBe(6)
    expect(referralOnDay([b, a], "2027-03-02")?.id).toBe(6)
  })

  it("splits settlement between old and new partner across a transfer", () => {
    const ps = [partner({ id: 1 }), partner({ id: 2, terms: { ...terms, revenueShareBps: 1000 } })]
    const before = decide(invoice({ issuedAt: "2027-02-14" }), [transferred, successor], ps, "2027-12-01")
    const after = decide(invoice({ issuedAt: "2027-02-20" }), [transferred, successor], ps, "2027-12-01")
    expect(before).toMatchObject({ eligible: true, partnerId: 1, amountCents: 2000 })
    expect(after).toMatchObject({ eligible: true, partnerId: 2, amountCents: 1000 })
  })

  it("stops earning after cancellation but keeps invoices issued before it", () => {
    const cancelled = ref({ status: "cancelled", endedAt: "2027-02-15 00:00:00" })
    expect(decide(invoice({ issuedAt: "2027-02-01" }), [cancelled], [partner()], "2027-12-01")).toMatchObject({ eligible: true })
    expect(decide(invoice({ issuedAt: "2027-03-01" }), [cancelled], [partner()], "2027-12-01")).toEqual({
      eligible: false,
      reason: "not_attributed",
      retry: false,
    })
  })
})

describe("settlement eligibility", () => {
  it("only settles verified-paid invoices", () => {
    expect(decide(invoice({ status: "open", paidAt: null }), [ref()], [partner()], "2027-12-01")).toEqual({
      eligible: false,
      reason: "not_paid",
      retry: true,
    })
    expect(decide(invoice({ status: "void" }), [ref()], [partner()], "2027-12-01")).toMatchObject({ reason: "not_paid", retry: false })
    expect(decide(invoice({ paidAt: null }), [ref()], [partner()], "2027-12-01")).toMatchObject({ reason: "payment_unverified", retry: true })
  })

  it("waits for the full refund window to elapse after payment", () => {
    expect(decide(invoice(), [ref()], [partner()], "2027-03-04")).toEqual({ eligible: false, reason: "refund_window_open", retry: true })
    expect(decide(invoice(), [ref()], [partner()], "2027-03-05")).toEqual({
      eligible: true,
      partnerId: 1,
      referralId: 1,
      amountCents: 2000,
      shareBps: 2000,
    })
  })

  it("settles on the net of refunds recorded before settlement", () => {
    expect(decide(invoice({ refundedAmount: "25.00" }), [ref()], [partner()], "2027-12-01")).toMatchObject({ amountCents: 1500 })
    expect(decide(invoice({ refundedAmount: "100.00" }), [ref()], [partner()], "2027-12-01")).toMatchObject({
      reason: "nothing_to_pay",
      retry: false,
    })
  })

  it("defers suspended partners instead of paying or dropping them", () => {
    expect(decide(invoice(), [ref()], [partner({ status: "suspended" })], "2027-12-01")).toEqual({
      eligible: false,
      reason: "partner_suspended",
      retry: true,
    })
  })

  it("enforces contract and eligibility windows on the issue day", () => {
    const ended = partner({ status: "terminated", terms: { ...terms, contractEnd: "2027-02-10" } })
    expect(decide(invoice({ issuedAt: "2027-02-01" }), [ref()], [ended], "2027-12-01")).toMatchObject({ eligible: true })
    expect(decide(invoice({ issuedAt: "2027-02-11" }), [ref()], [ended], "2027-12-01")).toMatchObject({ reason: "outside_contract" })

    const capped = partner({ terms: { ...terms, eligibilityMonths: 1 } })
    expect(decide(invoice({ issuedAt: "2027-02-09" }), [ref()], [capped], "2027-12-01")).toMatchObject({ eligible: true })
    expect(decide(invoice({ issuedAt: "2027-02-10" }), [ref()], [capped], "2027-12-01")).toMatchObject({ reason: "eligibility_expired" })
  })

  it("ignores invoices issued before the tenant was attributed", () => {
    expect(decide(invoice({ issuedAt: "2027-01-05" }), [ref()], [partner()], "2027-12-01")).toMatchObject({ reason: "not_attributed" })
  })
})

describe("refund clawback", () => {
  const base = { invoiceAmount: "100.00", shareBps: 2000 }

  it("claws back the refunded share and is a no-op on replay", () => {
    expect(clawbackCents({ ...base, refundedAmount: "25.00", voided: false, ledgerCents: 2000 })).toBe(-500)
    expect(clawbackCents({ ...base, refundedAmount: "25.00", voided: false, ledgerCents: 1500 })).toBe(0)
  })

  it("claws back everything on void and never produces a positive adjustment", () => {
    expect(clawbackCents({ ...base, refundedAmount: "25.00", voided: true, ledgerCents: 1500 })).toBe(-1500)
    expect(clawbackCents({ ...base, refundedAmount: "0.00", voided: false, ledgerCents: 1000 })).toBe(0)
  })

  it("uses the settlement-time share snapshot, not current terms", () => {
    expect(clawbackCents({ ...base, shareBps: 1000, refundedAmount: "50.00", voided: false, ledgerCents: 1000 })).toBe(-500)
  })
})

describe("partner-facing projections", () => {
  it("allow-lists referral fields and drops customer internals", () => {
    const row = {
      id: 3,
      tenant_id: 99,
      tenant_name: "Globex",
      ownership: "partner",
      status: "active",
      source: "signup",
      attributed_at: "2027-01-10 09:00:00",
      ended_at: null,
      created_by: 7,
      db_password: "s3cret",
      stripe_customer_id: "cus_123",
      owner_email: "ceo@globex.test",
    }
    const out = toDashboardReferral(row)
    expect(Object.keys(out).sort()).toEqual(["attributedAt", "customerName", "endedAt", "id", "ownership", "source", "status"])
    expect(JSON.stringify(out)).not.toMatch(/s3cret|cus_123|ceo@globex|99/)
  })

  it("allow-lists commission fields and totals earned vs clawed back", () => {
    const rows = [
      { id: 1, kind: "commission", amount: "20.00", currency: "USD", share_bps: 2000, settled_at: "2027-03-05", invoice_number: "INV-1", tenant_id: 9 },
      { id: 2, kind: "clawback", amount: "-5.00", currency: "USD", share_bps: 2000, settled_at: "2027-03-06", invoice_number: "INV-1" },
    ].map(toDashboardCommission)
    expect(Object.keys(rows[0]).sort()).toEqual(["amount", "currency", "id", "invoiceNumber", "kind", "settledAt", "shareBps"])
    expect(summarize(rows)).toEqual({ earned: "20.00", clawedBack: "-5.00", net: "15.00" })
  })
})
