import { NextResponse } from "next/server"
import { authenticateVendorUser } from "@/lib/vendor-portal/store"
import { createVendorPortalSessionToken, setVendorPortalSessionCookie } from "@/lib/vendor-portal/auth"

export const runtime = "nodejs"

function isDbConfigured() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME)
}

/**
 * SPEC 119 — Vendor Portal · external login (Phase 2).
 * Authenticates against vendor_portal_users and issues a domain-separated
 * vendor-portal session cookie. tenant + vendor scope always come from the
 * matched account, never from request input.
 */
export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }
    if (!isDbConfigured()) {
      return NextResponse.json(
        { error: "The vendor portal is not connected to a database. Please contact the accounts team." },
        { status: 503 },
      )
    }

    const result = await authenticateVendorUser(String(email), String(password))
    if (!result.ok) {
      if (result.reason === "locked") {
        return NextResponse.json(
          { error: "Too many failed attempts. Try again in a few minutes.", code: "ACCOUNT_LOCKED" },
          { status: 423 },
        )
      }
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    const { user } = result
    const token = await createVendorPortalSessionToken({
      portalUserId: user.id,
      tenantId: user.tenant_id,
      vendorId: user.vendor_id,
      email: user.email,
      name: user.name,
    })
    await setVendorPortalSessionCookie(token)

    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email },
    })
  } catch (error) {
    console.error("[v0] vendor portal login error:", error)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
