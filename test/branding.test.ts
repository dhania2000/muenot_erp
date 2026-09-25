import { describe, expect, it } from "vitest"
import { brandingFromSettings, renderBrandedEmail, emailButtonStyle } from "@/lib/branding"

describe("branding projection (SPEC 155)", () => {
  it("maps every configured branding key onto the typed projection", () => {
    const b = brandingFromSettings({
      "company.name": "Acme Pvt Ltd",
      "app.name": "Acme ERP",
      "company.logo": "https://cdn.acme.com/logo.png",
      "company.login_logo": "https://cdn.acme.com/login.png",
      "company.favicon": "https://cdn.acme.com/fav.ico",
      "company.website": "https://acme.com",
      "company.custom_domain": "Portal.ACME.com",
      "theme.primary_color": "#123456",
      "theme.sidebar_color": "#0a0a0a",
      "theme.login_background": "https://cdn.acme.com/bg.jpg",
      "email.brand_logo": "https://cdn.acme.com/email.png",
      "email.brand_color": "#ff0000",
      "email.button_color": "#00ff00",
      "email.footer_text": "Acme footer",
      "pdf.brand_logo": "https://cdn.acme.com/pdf.png",
      "pdf.accent_color": "#0000ff",
      "pdf.footer_text": "Thank you",
    })

    expect(b.companyName).toBe("Acme Pvt Ltd")
    expect(b.appName).toBe("Acme ERP")
    expect(b.logo).toBe("https://cdn.acme.com/logo.png")
    expect(b.loginLogo).toBe("https://cdn.acme.com/login.png")
    expect(b.favicon).toBe("https://cdn.acme.com/fav.ico")
    expect(b.website).toBe("https://acme.com")
    expect(b.primaryColor).toBe("#123456")
    expect(b.sidebarColor).toBe("#0a0a0a")
    expect(b.loginBackground).toBe("https://cdn.acme.com/bg.jpg")
    // Custom domain is normalised to lowercase for host matching.
    expect(b.customDomain).toBe("portal.acme.com")
    expect(b.email).toMatchObject({
      logo: "https://cdn.acme.com/email.png",
      headerColor: "#ff0000",
      buttonColor: "#00ff00",
      footerText: "Acme footer",
    })
    expect(b.pdf).toMatchObject({
      logo: "https://cdn.acme.com/pdf.png",
      accentColor: "#0000ff",
      footerText: "Thank you",
    })
  })

  it("applies sensible fallbacks so partial config still renders a full brand", () => {
    const b = brandingFromSettings({ "company.name": "Solo Co", "theme.primary_color": "#abcdef", "company.logo": "https://x/logo.png" })
    // appName inherits companyName; sub-brand colours inherit the primary colour;
    // email/pdf logos inherit the company logo.
    expect(b.appName).toBe("Solo Co")
    expect(b.sidebarColor).toBe("#abcdef")
    expect(b.email.headerColor).toBe("#abcdef")
    expect(b.email.buttonColor).toBe("#abcdef")
    expect(b.pdf.accentColor).toBe("#abcdef")
    expect(b.email.logo).toBe("https://x/logo.png")
    expect(b.pdf.logo).toBe("https://x/logo.png")
    expect(b.email.footerText).toContain("Solo Co")
  })

  it("falls back to platform defaults when nothing is configured", () => {
    const b = brandingFromSettings({})
    expect(b.companyName).toBe("Muenot Business Suite")
    expect(b.primaryColor).toBe("#6d28d9")
    expect(b.customDomain).toBe("")
  })

  it("keeps two tenants' brandings fully isolated (no shared mutable state)", () => {
    const tenantA = brandingFromSettings({ "company.name": "Tenant A", "theme.primary_color": "#111111" })
    const tenantB = brandingFromSettings({ "company.name": "Tenant B", "theme.primary_color": "#222222" })
    expect(tenantA.companyName).toBe("Tenant A")
    expect(tenantB.companyName).toBe("Tenant B")
    expect(tenantA.primaryColor).toBe("#111111")
    expect(tenantB.primaryColor).toBe("#222222")
    // Mutating one projection must never leak into another.
    tenantA.email.footerText = "mutated"
    expect(tenantB.email.footerText).not.toBe("mutated")
  })

  it("escapes untrusted branding values when rendering a branded email shell", () => {
    const b = brandingFromSettings({
      "company.name": 'Acme "&" <Co>',
      "email.brand_color": "#334455",
      "email.footer_text": "<script>alert(1)</script>",
    })
    const html = renderBrandedEmail("<p>Body</p>", b, { title: "Hello" })
    expect(html).toContain("#334455")
    expect(html).toContain("<p>Body</p>") // body is inserted as-is (caller owns safety)
    expect(html).not.toContain("<script>alert(1)</script>") // footer is escaped
    expect(html).toContain("&lt;script&gt;")
    expect(emailButtonStyle(b)).toContain("background:")
  })
})
