import { NextResponse } from "next/server"
import { issueClientCredentialsToken } from "@/lib/oauth/oauth-apps-store"
import { API_VERSION } from "@/lib/api-platform/response"

/**
 * OAuth 2.0 token endpoint — client-credentials grant (RFC 6749 §4.4).
 * ---------------------------------------------------------------------------
 * Deliberately does NOT run through `withApiV1`: it is the endpoint that MINTS
 * bearer tokens, so it cannot itself require one. It accepts credentials in the
 * standard `application/x-www-form-urlencoded` body, and also tolerates JSON for
 * convenience. Errors follow the OAuth error response shape (RFC 6749 §5.2)
 * rather than the platform envelope, so standard OAuth clients understand them.
 *
 * Tenant scope is derived entirely from the resolved app inside the store —
 * never from request input — which is what guarantees a client can only ever
 * receive a token for its own tenant.
 */

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-API-Version": API_VERSION,
}

function oauthError(error: string, description: string, status: number): NextResponse {
  return NextResponse.json({ error, error_description: description }, { status, headers: baseHeaders })
}

async function parseBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    try {
      const json = (await request.json()) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(json)) if (v != null) out[k] = String(v)
      return out
    } catch {
      return {}
    }
  }
  // form-urlencoded (default) — also handles multipart form data
  try {
    const form = await request.formData()
    const out: Record<string, string> = {}
    for (const [k, v] of form.entries()) out[k] = String(v)
    return out
  } catch {
    return {}
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseBody(request)

  // Credentials may arrive in the body or via HTTP Basic per RFC 6749 §2.3.1.
  let clientId = body.client_id ?? ""
  let clientSecret = body.client_secret ?? ""
  const authHeader = request.headers.get("authorization") || ""
  const basic = /^Basic\s+(.+)$/i.exec(authHeader)
  if (basic && (!clientId || !clientSecret)) {
    try {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8")
      const idx = decoded.indexOf(":")
      if (idx >= 0) {
        clientId = decodeURIComponent(decoded.slice(0, idx))
        clientSecret = decodeURIComponent(decoded.slice(idx + 1))
      }
    } catch {
      // fall through to invalid_client below
    }
  }

  const grantType = body.grant_type ?? ""
  if (grantType !== "client_credentials") {
    return oauthError("unsupported_grant_type", "Only the client_credentials grant is supported.", 400)
  }
  if (!clientId || !clientSecret) {
    return oauthError("invalid_request", "client_id and client_secret are required.", 400)
  }

  const requestedScopes = (body.scope ?? "").split(/\s+/).filter(Boolean)
  const result = await issueClientCredentialsToken({ clientId, clientSecret, requestedScopes })

  if (!result.ok) {
    if (result.error === "invalid_scope") {
      return oauthError("invalid_scope", `Requested scope exceeds granted scopes: ${result.detail ?? ""}`.trim(), 400)
    }
    if (result.error === "app_revoked") {
      return oauthError("invalid_client", "The client application has been revoked.", 401)
    }
    return oauthError("invalid_client", "Client authentication failed.", 401)
  }

  return NextResponse.json(
    {
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      scope: result.scope,
    },
    { status: 200, headers: baseHeaders },
  )
}
