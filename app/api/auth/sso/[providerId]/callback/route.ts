import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { createSessionToken, setSessionCookie } from "@/lib/auth"
import { newSessionId, createSession } from "@/lib/session-store"
import {
  getProviderById,
  getIdentity,
  linkIdentity,
  recordLogin,
  recordLoginEvent,
  resolveClientSecret,
} from "@/lib/sso-store"
import { exchangeCodeForClaims, resolveEndpoints } from "@/lib/sso-oidc"
import { consumeSsoState } from "@/lib/sso-state"
import { sameTenant } from "@/lib/sso-provider-catalog"
import { ssoOrigin } from "@/lib/sso-origin"

const requestOrigin = ssoOrigin

function fail(request: Request, reason: string) {
  return NextResponse.redirect(new URL(`/login?sso_error=${encodeURIComponent(reason)}`, requestOrigin(request)))
}

/**
 * SPEC 56-57 — OIDC callback: exchanges the code, verifies the ID token
 * against the IdP's live JWKS, then finds-or-provisions the local user and
 * mints the same session (JWT + server-side session row) that password
 * login issues, so every downstream guard treats an SSO session identically.
 */
export async function GET(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const errorParam = url.searchParams.get("error")

  const provider = await getProviderById(Number(providerId))
  const savedState = await consumeSsoState()

  if (errorParam) return fail(request, "denied")
  if (!provider || provider.type !== "oidc" || provider.status !== "enabled") return fail(request, "unavailable")
  if (!code || !state || !savedState || savedState.protocol === "saml" || savedState.state !== state || savedState.providerId !== provider.id || !savedState.codeVerifier) {
    return fail(request, "state_mismatch")
  }

  const clientSecret = resolveClientSecret(provider)
  if (!provider.client_id || !clientSecret) return fail(request, "misconfigured")

  try {
    const endpoints = await resolveEndpoints(provider)
    const redirectUri = `${requestOrigin(request)}/api/auth/sso/${provider.id}/callback`
    const claims = await exchangeCodeForClaims({
      tokenEndpoint: endpoints.token_endpoint,
      jwksUri: endpoints.jwks_uri,
      issuer: endpoints.issuer,
      clientId: provider.client_id,
      clientSecret,
      redirectUri,
      code,
      nonce: savedState.nonce,
      codeVerifier: savedState.codeVerifier,
    })

    const email = claims.email?.toLowerCase().trim()
    if (!email) {
      await recordLoginEvent({ providerId: provider.id, tenantId: provider.tenant_id, status: "error", message: "No email claim" })
      return fail(request, "no_email")
    }

    if (provider.domains) {
      const allowed = provider.domains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
      const domain = email.split("@")[1]
      if (allowed.length > 0 && !allowed.includes(domain)) {
        await recordLoginEvent({ providerId: provider.id, tenantId: provider.tenant_id, email, status: "error", message: "Domain not allowed" })
        return fail(request, "domain_not_allowed")
      }
    }

    const identity = await getIdentity(provider.id, claims.sub)
    let user: { id: number; name: string; email: string; role: "admin" | "employee"; status: string; tenant_id: number | null } | undefined
    if (identity?.deprovisioned_at) return fail(request, "account_inactive")
    if (identity) {
      const linked = await query<typeof user[]>("SELECT id,name,email,role,status,tenant_id FROM users WHERE id=? LIMIT 1", [identity.user_id])
      user = linked[0]
      if (!user || !sameTenant(provider.tenant_id, user.tenant_id)) return fail(request, "account_inactive")
    } else {
      // Email linking is permitted only inside this provider's tenant. This
      // prevents a shared address in another tenant being silently adopted.
      const existing = await query<typeof user[]>("SELECT id,name,email,role,status,tenant_id FROM users WHERE email=? AND tenant_id <=> ? LIMIT 1", [email, provider.tenant_id])
      user = existing[0]
    }
    if (!user) {
      if (!provider.auto_provision) {
        await recordLoginEvent({ providerId: provider.id, tenantId: provider.tenant_id, email, status: "error", message: "No account and auto-provisioning disabled" })
        return fail(request, "no_account")
      }
      const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || email
      const result = await query<any>(
        `INSERT INTO users (tenant_id, name, email, password_hash, role, status, must_change_password)
         VALUES (?, ?, ?, NULL, ?, 'active', 0)`,
        [provider.tenant_id, name, email, provider.default_role],
      )
      user = {
        id: result.insertId,
        name,
        email,
        role: provider.default_role,
        status: "active",
        tenant_id: provider.tenant_id,
      }
    }

    if (user.status !== "active") {
      await recordLoginEvent({ providerId: provider.id, tenantId: provider.tenant_id, userId: user.id, email, status: "error", message: "Account not active" })
      return fail(request, "account_inactive")
    }

    await linkIdentity({ providerId: provider.id, tenantId: provider.tenant_id, userId: user.id, subject: claims.sub, email })

    const sid = newSessionId()
    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenant_id ?? provider.tenant_id ?? undefined,
      sid,
    })
    await createSession({
      sessionId: sid,
      userId: user.id,
      tenantId: user.tenant_id ?? provider.tenant_id ?? null,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
      loginMethod: "sso",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      concurrentLimit: 5,
    })
    await setSessionCookie(token)
    await recordLogin(provider.id)
    await recordLoginEvent({ providerId: provider.id, tenantId: provider.tenant_id, userId: user.id, email, status: "success" })

    return NextResponse.redirect(new URL(user.role === "admin" ? "/admin" : "/dashboard", requestOrigin(request)))
  } catch (err) {
    console.error("[v0] sso callback failed", err)
    await recordLoginEvent({
      providerId: provider.id,
      tenantId: provider.tenant_id,
      status: "error",
      message: err instanceof Error ? err.message : "Unknown error",
    })
    return fail(request, "exchange_failed")
  }
}
