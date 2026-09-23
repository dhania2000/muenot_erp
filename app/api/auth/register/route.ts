import { NextResponse } from "next/server"
import { createSessionToken, setSessionCookie } from "@/lib/auth"
import { getNum } from "@/lib/settings/server"
import { recordActivity } from "@/lib/notifications"
import { registerBusiness, RegistrationError } from "@/lib/tenant-registration"
import { createEmailVerification } from "@/lib/user-lifecycle"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"

function isDbConfigured() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME)
}

/**
 * self-service Business/Organization signup.
 *
 * Creates a new tenant + owner/admin user transactionally, establishes the
 * tenant session, kicks off email verification, and returns the WhatsApp
 * onboarding redirect. The tenant is created before the session and before any
 * WhatsApp Embedded Signup, so Meta always connects to the correct tenant.
 */
export async function POST(request: Request) {
  try {
    // Brute-force / abuse protection: cap signups per IP per window.
    const ip = getClientIp(request)
    const rl = await checkRateLimit(`register:${ip}`, { max: 5, windowMs: 60 * 60 * 1000 })
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many signup attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      )
    }

    if (!isDbConfigured()) {
      console.error("[v0] register error: database is not configured (DB_HOST/DB_USER/DB_NAME).")
      return NextResponse.json(
        { error: "The server is not connected to a database. Please contact support." },
        { status: 503 },
      )
    }

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

    const result = await registerBusiness({
      companyName: body.companyName,
      adminName: body.adminName,
      email: body.email,
      mobile: body.mobile,
      password: body.password,
    })

    // Establish the tenant session immediately. Tenant + roles come from the
    // freshly-created records (server-side), never from client input.
    const timeoutMinutes = await getNum("security.session_timeout", 480)
    const durationSeconds = Math.max(60, Math.round(timeoutMinutes * 60))
    const token = await createSessionToken(
      {
        userId: result.userId,
        email: result.email,
        name: result.name,
        role: result.role,
        tenantId: result.tenantId,
        platformRole: "none",
        tenantRole: "tenant_owner",
        impersonatedTenantId: null,
      },
      durationSeconds,
    )
    await setSessionCookie(token, durationSeconds)

    // Kick off email verification (best-effort — never blocks signup). The
    // token can be delivered/confirmed later; login is not gated on it unless
    // the tenant enables the require-email-verification policy.
    try {
      const verifyToken = await createEmailVerification(result.tenantId, result.userId)
      const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || ""
      const link = `${appUrl}/verify-email?token=${verifyToken}`
      console.log("[v0] email verification link created for", result.email, link)
    } catch (err) {
      console.error("[v0] failed to create email verification token:", err)
    }

    void recordActivity({
      action: "create",
      title: `${result.name} registered ${result.email}`,
      body: `New business tenant created (${result.tenantSlug})`,
      link: "/admin",
      actor: { userId: result.userId, name: result.name, email: result.email, role: result.role },
    })

    return NextResponse.json({
      user: {
        id: result.userId,
        name: result.name,
        email: result.email,
        role: result.role,
      },
      tenant: { id: result.tenantId, slug: result.tenantSlug },
      redirect: "/onboarding/whatsapp",
    })
  } catch (error) {
    if (error instanceof RegistrationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: error.status })
    }
    const code = (error as { code?: string })?.code
    console.error("[v0] register error:", { code, error })
    switch (code) {
      case "ECONNREFUSED":
      case "ETIMEDOUT":
      case "ENOTFOUND":
      case "EHOSTUNREACH":
      case "PROTOCOL_CONNECTION_LOST":
        return NextResponse.json(
          { error: "Unable to reach the database. Please try again shortly." },
          { status: 503 },
        )
      default:
        return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
    }
  }
}
