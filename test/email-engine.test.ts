import { describe, expect, it } from "vitest"
import { EMAIL_MODULES, renderEmailTemplate, validateEmailRequest } from "@/lib/email-engine/model"

const request = {
  tenantId: 7, module: "sales" as const, to: "Customer@Example.com",
  subject: "Welcome", html: "<p>Hello</p>", trackingConsent: false,
}

describe(" email engine contracts", () => {
  it("uses a fixed module allowlist", () => expect(EMAIL_MODULES).toContain("system"))
  it("normalizes recipient identity and keeps tracking opt-in", () => {
    expect(validateEmailRequest(request)).toMatchObject({ to: "customer@example.com", trackingConsent: false })
  })
  it.each([
    { tenantId: 0 }, { module: "payroll" }, { to: "not-an-email" }, { subject: "" },
    { attachments: [{ pathname: "/etc/passwd" }] },
  ])("rejects unsafe email request %j", (change) => {
    expect(() => validateEmailRequest({ ...request, ...change } as any)).toThrow()
  })
  it("renders literal variables only and rejects missing values", () => {
    expect(renderEmailTemplate("Hello {{ customer.name }}", { "customer.name": "Asha" })).toBe("Hello Asha")
    expect(() => renderEmailTemplate("{{missing}}", {})).toThrow("Missing email template variable")
  })
})
