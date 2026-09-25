import { NextResponse } from "next/server"
import { SESSION_COOKIE, createSessionToken, setSessionCookie, verifySessionToken } from "@/lib/auth"
import { AFFILIATE_COOKIE, readCookie } from "@/lib/affiliates/model"
import { checkPartnerCodeSignup, claimSignup, recordCodeConversion } from "@/lib/affiliates/store"
import { getNum } from "@/lib/settings/server"
import { recordActivity } from "@/lib/notifications"
import { registerBusiness, RegistrationError } from "@/lib/tenant-registration"
import { createEmailVerification } from "@/lib/user-lifecycle"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { attributeSignup } from "@/lib/partners/store"
import { recordPlatformAudit } from "@/lib/platform-roles"

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

    // Spec30 — affiliate attribution from the signed click cookie, then the
    // Spec29 `?ref=` partner code as a fallback. Best-effort: never blocks
    // signup. A browser already logged in as a partner member is treated as a
    // self-referral, so the PRIOR session (incoming cookie) is checked.
    const cookieHeader = request.headers.get("cookie")
    const affiliateCookie = readCookie(cookieHeader, AFFILIATE_COOKIE)
    const priorToken = readCookie(cookieHeader, SESSION_COOKIE)
    const priorSession = priorToken ? await verifySessionToken(priorToken).catch(() => null) : null
    const sessionUserId = priorSession?.userId ?? null
    const auditBase = { actorUserId: result.userId, actorEmail: result.email, targetTenantId: result.tenantId }

    let affiliateDecided = false
    if (affiliateCookie) {
      try {
        const claim = await claimSignup({
          cookieValue: affiliateCookie,
          tenantId: result.tenantId,
          registrant: { userId: result.userId, email: result.email },
          sessionUserId,
          now: new Date(),
        })
        if (claim.status === "attributed") {
          affiliateDecided = true
          await recordPlatformAudit({
            ...auditBase,
            action: "affiliate_referral_attributed",
            detail: { partnerId: claim.partnerId, linkId: claim.linkId, clickId: claim.clickId, referralId: claim.referralId },
          })
        } else if (claim.status === "rejected") {
          affiliateDecided = true
          await recordPlatformAudit({
            ...auditBase,
            action: "affiliate_referral_rejected",
            detail: { partnerId: claim.partnerId, clickId: claim.clickId, reason: claim.reason },
          })
        }
      } catch (err) {
        console.error("[register] affiliate attribution failed:", err)
      }
    }

    if (!affiliateDecided && body.partnerCode) {
      try {
        const check = await checkPartnerCodeSignup({ rawCode: body.partnerCode, registrantEmail: result.email, sessionUserId })
        if (check?.reason) {
          await recordPlatformAudit({
            ...auditBase,
            action: "affiliate_referral_rejected",
            detail: { partnerId: check.partnerId, reason: check.reason, source: "signup" },
          })
        } else if (check) {
          const attributed = await attributeSignup(result.tenantId, body.partnerCode, result.userId)
          if (attributed) {
            await recordCodeConversion({ partnerId: attributed.partnerId, tenantId: result.tenantId, referralId: attributed.referralId, now: new Date() })
            await recordPlatformAudit({
              ...auditBase,
              action: "partner_referral_attributed",
              detail: { partnerId: attributed.partnerId, referralId: attributed.referralId, source: "signup" },
            })
          }
        }
      } catch (err) {
        console.error("[register] partner attribution failed:", err)
      }
    }

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

    const response = NextResponse.json({
      user: {
        id: result.userId,
        name: result.name,
        email: result.email,
        role: result.role,
      },
      tenant: { id: result.tenantId, slug: result.tenantSlug },
      redirect: "/onboarding/whatsapp",
    })
    if (affiliateCookie) response.cookies.set(AFFILIATE_COOKIE, "", { path: "/", maxAge: 0 })
    return response
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
