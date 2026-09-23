import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyPassword } from "@/lib/password"
import { createSessionToken, setSessionCookie } from "@/lib/auth"
import { getBool, getNum } from "@/lib/settings/server"
import { recordActivity } from "@/lib/notifications"
import { resolveTenantIdForUser } from "@/lib/tenant-service"
import { getStoredRoles } from "@/lib/platform-roles"
import { getPublicSettings } from "@/lib/settings/server"
import { evaluateLogin } from "@/lib/user-lifecycle-core"
import { consumeMfaChallenge, getLoginSnapshot } from "@/lib/user-lifecycle"
import { createSession, newSessionId, isKnownDevice } from "@/lib/session-store"
import { requiresMfaByPolicy } from "@/lib/mfa-policy"
import { checkLockout, recordFailedLogin, recordSuccessfulLogin } from "@/lib/password-policy"
import { checkIpAllowlist } from "@/lib/ip-allowlist-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import { evaluateAccessPolicies } from "@/lib/access-policy-store"

type UserRow = {
  id: number
  name: string
  email: string
  password_hash: string
  role: "admin" | "employee"
  status: "active" | "inactive"
  must_change_password: number
}

function isDbConfigured() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME)
}

export async function POST(request: Request) {
  try {
    const { email, password, mfaCode } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }

    // Source IP (first hop of X-Forwarded-For, else X-Real-IP) and geo hint,
    // used by SPEC 62 (IP allowlist) and SPEC 63 (access policy) enforcement.
    const forwardedFor = request.headers.get("x-forwarded-for")
    const requestIp = forwardedFor ? forwardedFor.split(",")[0].trim() : request.headers.get("x-real-ip")
    const requestCountry = request.headers.get("x-vercel-ip-country")

    if (!isDbConfigured()) {
      console.error(
        "[v0] login error: database is not configured. Missing one of DB_HOST/DB_USER/DB_NAME env vars in this deployment.",
      )
      return NextResponse.json(
        { error: "The server is not connected to a database. Please contact your administrator." },
        { status: 503 },
      )
    }

    const rows = await query<UserRow[]>("SELECT * FROM users WHERE email = ? LIMIT 1", [
      String(email).toLowerCase().trim(),
    ])
    const user = rows[0]

    if (!user) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    // SPEC 62 — IP allowlist: evaluated before the password check (like the
    // lockout check below) so a blocked network never learns whether the
    // credentials were otherwise valid.
    const requireIpAllowlist = await getBool("security.ip_allowlist_enabled", false)
    if (requireIpAllowlist) {
      const tenantIdForIp = await resolveTenantIdForUser(user.id)
      const ipCheck = await checkIpAllowlist(tenantIdForIp, requestIp, user.role === "admin" ? "admin" : "all")
      if (!ipCheck.allowed) {
        // Emergency break-glass: an authorized platform Super Admin can sign in
        // from a blocked network when the tenant has explicitly enabled it, so
        // a misconfigured allowlist can never permanently lock out the
        // operator who has to fix it. Every bypass is audited.
        const emergencyBypass = await getBool("security.ip_allowlist_emergency_bypass", false)
        const roles = emergencyBypass ? await getStoredRoles(user.id) : null
        if (emergencyBypass && roles?.platformRole === "platform_super_admin") {
          await recordSecurityEvent({
            tenantId: tenantIdForIp,
            category: "emergency_bypass",
            action: "ip_allowlist_bypass",
            outcome: "bypassed",
            actorUserId: user.id,
            actorName: user.name,
            subjectEmail: user.email,
            ipAddress: requestIp,
            detail: { scope: user.role === "admin" ? "admin" : "all" },
          })
        } else {
          await recordSecurityEvent({
            tenantId: tenantIdForIp,
            category: "ip_allowlist",
            action: "sign_in_blocked",
            outcome: "blocked",
            actorUserId: user.id,
            actorName: user.name,
            subjectEmail: user.email,
            ipAddress: requestIp,
            detail: { matchedEntryId: ipCheck.matchedEntryId ?? null },
          })
          return NextResponse.json(
            { error: "Sign-in is not allowed from this network. Contact your administrator.", code: "IP_BLOCKED" },
            { status: 403 },
          )
        }
      }
    }

    // SPEC 60 — password lockout: check BEFORE verifying the password so a
    // locked account never leaks whether the submitted password was correct.
    const lockout = await checkLockout(user.id)
    if (lockout.locked) {
      return NextResponse.json(
        {
          error: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`,
          code: "ACCOUNT_LOCKED",
        },
        { status: 423, headers: { "Retry-After": String(lockout.retryAfterSeconds) } },
      )
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      await recordFailedLogin(user.id)
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 })
    }

    // SPEC 14 — evaluate the full lifecycle gate (invited / suspended /
    // deactivated / expired temporary access / email verification) AFTER the
    // password check, so a wrong password never reveals account state.
    const snapshot = await getLoginSnapshot(user.id)
    if (snapshot) {
      const settings = await getPublicSettings()
      const decision = evaluateLogin(
        {
          lifecycleState: snapshot.lifecycleState,
          accessExpiresAt: snapshot.accessExpiresAt,
          emailVerifiedAt: snapshot.emailVerifiedAt,
          mfaEnabled: snapshot.mfaEnabled,
          requireEmailVerification: Boolean(settings["security.require_email_verification"]),
        },
        new Date(),
      )
      if (!decision.allowed) {
        return NextResponse.json({ error: decision.reason, code: decision.code }, { status: 403 })
      }

      // SPEC 63 — conditional access policies. Evaluated after the password +
      // lifecycle gates so a wrong password never reveals policy state. A
      // matching Deny blocks sign-in outright; a matching "Require MFA"
      // obligation forces the MFA challenge below even when org policy would
      // not; "Require re-authentication" is inherently satisfied by this fresh
      // sign-in.
      const policyRoles = await getStoredRoles(user.id)
      const policyTenantId = await resolveTenantIdForUser(user.id)
      const deviceTrusted = await isKnownDevice(user.id, request.headers.get("user-agent"))
      const policyDecision = await evaluateAccessPolicies(policyTenantId, {
        userId: user.id,
        email: user.email,
        tenantRole: policyRoles?.tenantRole ?? (user.role === "admin" ? "tenant_admin" : "employee"),
        ip: requestIp,
        country: requestCountry,
        mfaEnabled: snapshot.mfaEnabled,
        deviceTrusted,
      })
      if (policyDecision.denied) {
        await recordSecurityEvent({
          tenantId: policyTenantId,
          category: "access_policy",
          action: "sign_in_denied",
          outcome: "blocked",
          actorUserId: user.id,
          actorName: user.name,
          subjectEmail: user.email,
          ipAddress: requestIp,
          detail: { policy: policyDecision.deniedByPolicy },
        })
        return NextResponse.json(
          {
            error: "Sign-in is blocked by an access policy. Contact your administrator.",
            code: "ACCESS_POLICY_DENIED",
          },
          { status: 403 },
        )
      }

      // SPEC 14 — MFA challenge. When enabled, the password step alone is not
      // enough: without a code we ask the client to collect one (no session is
      // issued); with a code we verify a live TOTP or a one-time backup code.
      const policyRequiresMfa =
        requiresMfaByPolicy({ role: user.role, mfaEnabled: snapshot.mfaEnabled, settings }) ||
        policyDecision.requireMfa
      if (policyRequiresMfa && !snapshot.mfaEnabled) {
        return NextResponse.json({ error: "Your organization requires MFA enrollment before access is granted", code: "MFA_ENROLLMENT_REQUIRED" }, { status: 403 })
      }
      if (decision.requiresMfa || policyDecision.requireMfa) {
        if (!mfaCode) {
          return NextResponse.json({ mfaRequired: true }, { status: 200 })
        }
        const passed = await consumeMfaChallenge(user.id, String(mfaCode))
        if (!passed) {
          await recordFailedLogin(user.id)
          return NextResponse.json({ error: "Invalid authentication code", mfaRequired: true }, { status: 401 })
        }
      }
    } else if (user.status !== "active") {
      // Defensive fallback if the lifecycle snapshot is unavailable.
      return NextResponse.json({ error: "This account has been deactivated" }, { status: 403 })
    }

    // Only a fully authenticated login clears the lockout counter. Otherwise
    // an attacker who knows the password could brute-force MFA indefinitely.
    await recordSuccessfulLogin(user.id)

    // Resolve the tenant this user belongs to (source of truth: users.tenant_id).
    // Baked into the session token so every subsequent request derives its
    // tenant from the verified session, never from client input.
    const tenantId = (await resolveTenantIdForUser(user.id)) ?? undefined

    // SPEC 3 — capture the platform/tenant role axes from the DB source of
    // truth. Carried in the token for cheap UI hints only; guards re-resolve
    // from the DB before authorizing. A fresh login never carries an
    // impersonation — that is only ever set by the audited impersonation
    // endpoint, so signing in always drops back to the operator's home tenant.
    const roles = await getStoredRoles(user.id)

    // Session lifetime is configurable in Settings → Security (minutes).
    const timeoutMinutes = await getNum("security.session_timeout", 480)
    const durationSeconds = Math.max(60, Math.round(timeoutMinutes * 60))
    const sid = newSessionId()
    const token = await createSessionToken(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId,
        platformRole: roles?.platformRole ?? "none",
        tenantRole: roles?.tenantRole ?? (user.role === "admin" ? "tenant_admin" : "employee"),
        impersonatedTenantId: null,
        sid,
      },
      durationSeconds,
    )
    await setSessionCookie(token, durationSeconds)

    // SPEC 61 — persist a server-side session record so this login shows up
    // in Session management, can be individually revoked, and counts against
    // the per-user concurrent-session cap. Best-effort: a session-store
    // failure never blocks sign-in, since the JWT cookie alone still works.
    try {
      const concurrentLimit = await getNum("security.concurrent_session_limit", 0)
      await createSession({
        sessionId: sid,
        userId: user.id,
        tenantId: tenantId ?? null,
        ipAddress: requestIp,
        userAgent: request.headers.get("user-agent"),
        loginMethod: "password",
        expiresAt: new Date(Date.now() + durationSeconds * 1000),
        concurrentLimit: concurrentLimit > 0 ? concurrentLimit : undefined,
      })
    } catch (err) {
      console.error("[v0] session store write failed (login still succeeds):", err)
    }

    // Notify full-access users (admins) that this account signed in.
    void recordActivity({
      action: "login",
      title: `${user.name} signed in`,
      body: user.email,
      link: "/modules/hr/employees",
      actor: { userId: user.id, name: user.name, email: user.email, role: user.role },
    })

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
      },
    })
  } catch (error) {
    const code = (error as { code?: string })?.code
    console.error("[v0] login error:", { code, error })

    // Surface actionable diagnostics for the most common infrastructure
    // failures instead of a blanket "Something went wrong."
    switch (code) {
      case "ECONNREFUSED":
      case "ETIMEDOUT":
      case "ENOTFOUND":
      case "EHOSTUNREACH":
      case "PROTOCOL_CONNECTION_LOST":
        return NextResponse.json(
          { error: "Unable to reach the database. Please contact your administrator." },
          { status: 503 },
        )
      case "ER_ACCESS_DENIED_ERROR":
        return NextResponse.json(
          { error: "Database credentials are invalid. Please contact your administrator." },
          { status: 503 },
        )
      case "ER_NO_SUCH_TABLE":
      case "ER_BAD_DB_ERROR":
        return NextResponse.json(
          { error: "The database is not set up correctly. Please contact your administrator." },
          { status: 503 },
        )
      default:
        return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
    }
  }
}
