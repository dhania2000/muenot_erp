import crypto from "crypto"
import type { SocialPlatformId } from "@/lib/social-platforms"
import type { SocialAccountType } from "@/lib/social-accounts"

/**
 * Server-only OAuth logic for connecting real social accounts. Each platform
 * uses its OWN developer app, its OWN current official OAuth/API flow, its OWN
 * scopes and its OWN callback route. They are NOT interchangeable.
 *
 *   LinkedIn   → LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET
 *                OpenID Connect member sign-in (openid profile email w_member_social)
 *   X (Twitter)→ X_CLIENT_ID / X_CLIENT_SECRET
 *                OAuth 2.0 Authorization Code + PKCE
 *   Facebook   → FACEBOOK_APP_ID / FACEBOOK_APP_SECRET
 *                Facebook Login for Pages (Graph API)
 *   Instagram  → INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET
 *                Instagram API with Instagram Login (instagram.com/oauth) —
 *                NOT the Facebook dialog. Uses its own app id/secret.
 *
 * Optional: SOCIAL_REDIRECT_BASE pins the OAuth redirect origin in production.
 */

const GRAPH_VERSION = "v21.0"

type ScopeSeparator = " " | ","

type PlatformOAuthConfig = {
  clientIdEnv: string
  clientSecretEnv: string
  authorizeUrl: string
  scopes: string[]
  /** LinkedIn/X/Facebook use space, Instagram Business Login uses commas. */
  scopeSeparator: ScopeSeparator
  /** X uses PKCE (code_verifier / code_challenge). */
  usesPkce: boolean
}

const OAUTH_CONFIG: Record<SocialPlatformId, PlatformOAuthConfig> = {
  linkedin: {
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    // Only scopes actually configured on the LinkedIn app. Do NOT request
    // w_organization_social / r_organization_admin unless approved.
    scopes: ["openid", "profile", "email", "w_member_social"],
    scopeSeparator: " ",
    usesPkce: false,
  },
  x: {
    clientIdEnv: "X_CLIENT_ID",
    clientSecretEnv: "X_CLIENT_SECRET",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    scopeSeparator: " ",
    usesPkce: true,
  },
  facebook: {
    clientIdEnv: "FACEBOOK_APP_ID",
    clientSecretEnv: "FACEBOOK_APP_SECRET",
    authorizeUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    scopes: ["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    scopeSeparator: " ",
    usesPkce: false,
  },
  instagram: {
    // Instagram Business Login uses a dedicated Instagram app — never the
    // Facebook app id/secret (that causes PLATFORM_INVALID_APP_ID).
    clientIdEnv: "INSTAGRAM_APP_ID",
    clientSecretEnv: "INSTAGRAM_APP_SECRET",
    authorizeUrl: "https://www.instagram.com/oauth/authorize",
    scopes: [
      "instagram_business_basic",
      "instagram_business_manage_messages",
      "instagram_business_manage_comments",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
    ],
    scopeSeparator: ",",
    usesPkce: false,
  },
}

export function getClientId(platform: SocialPlatformId) {
  return process.env[OAUTH_CONFIG[platform].clientIdEnv]
}
export function getClientSecret(platform: SocialPlatformId) {
  return process.env[OAUTH_CONFIG[platform].clientSecretEnv]
}

export function isPlatformConfigured(platform: SocialPlatformId) {
  return Boolean(getClientId(platform) && getClientSecret(platform))
}

export function platformUsesPkce(platform: SocialPlatformId) {
  return OAUTH_CONFIG[platform].usesPkce
}

export function resolveRedirectUri(platform: SocialPlatformId, origin: string) {
  const base = process.env.SOCIAL_REDIRECT_BASE || origin
  return `${base.replace(/\/$/, "")}/api/marketing/social/callback/${platform}`
}

/* ------------------------------------------------------------------ */
/* PKCE helpers (X)                                                    */
/* ------------------------------------------------------------------ */

export function generatePkce() {
  const verifier = crypto.randomBytes(48).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/* ------------------------------------------------------------------ */
/* Authorize URL                                                       */
/* ------------------------------------------------------------------ */

export function buildAuthUrl(opts: {
  platform: SocialPlatformId
  redirectUri: string
  state: string
  codeChallenge?: string
}) {
  const cfg = OAUTH_CONFIG[opts.platform]
  const clientId = getClientId(opts.platform)!
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: cfg.scopes.join(cfg.scopeSeparator),
    state: opts.state,
  })
  if (cfg.usesPkce && opts.codeChallenge) {
    params.set("code_challenge", opts.codeChallenge)
    params.set("code_challenge_method", "S256")
  }
  return `${cfg.authorizeUrl}?${params.toString()}`
}

/* ------------------------------------------------------------------ */
/* Token exchange                                                      */
/* ------------------------------------------------------------------ */

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  scope: string | null
}

function expiresAtFrom(expiresIn: unknown): string | null {
  const n = Number(expiresIn)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(Date.now() + n * 1000).toISOString().slice(0, 19).replace("T", " ")
}

export async function exchangeCode(opts: {
  platform: SocialPlatformId
  code: string
  redirectUri: string
  codeVerifier?: string
}): Promise<OAuthTokens> {
  const { platform, code, redirectUri, codeVerifier } = opts
  const clientId = getClientId(platform)!
  const clientSecret = getClientSecret(platform)!

  if (platform === "linkedin") return linkedinToken({ code, redirectUri, clientId, clientSecret })
  if (platform === "x") return xToken({ code, redirectUri, clientId, clientSecret, codeVerifier: codeVerifier! })
  if (platform === "instagram") return instagramToken({ code, redirectUri, clientId, clientSecret })
  return facebookToken({ code, redirectUri, clientId, clientSecret })
}

async function linkedinToken(a: { code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: a.code,
    redirect_uri: a.redirectUri,
    client_id: a.clientId,
    client_secret: a.clientSecret,
  })
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`linkedin_token:${res.status}`)
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: expiresAtFrom(json.expires_in),
    scope: json.scope ?? null,
  }
}

async function xToken(a: {
  code: string
  redirectUri: string
  clientId: string
  clientSecret: string
  codeVerifier: string
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: a.code,
    redirect_uri: a.redirectUri,
    code_verifier: a.codeVerifier,
    client_id: a.clientId,
  })
  const basic = Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`x_token:${res.status}`)
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: expiresAtFrom(json.expires_in),
    scope: json.scope ?? null,
  }
}

async function facebookToken(a: { code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  // 1. short-lived user token
  const shortParams = new URLSearchParams({
    client_id: a.clientId,
    client_secret: a.clientSecret,
    redirect_uri: a.redirectUri,
    code: a.code,
  })
  const shortRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${shortParams.toString()}`,
  )
  const shortJson = await shortRes.json()
  if (!shortRes.ok) throw new Error(`facebook_token:${shortRes.status}`)

  // 2. exchange for a long-lived user token (page tokens derived from it do
  //    not expire), best-effort — fall back to the short-lived token.
  let accessToken: string = shortJson.access_token
  let expiresAt = expiresAtFrom(shortJson.expires_in)
  const longParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: a.clientId,
    client_secret: a.clientSecret,
    fb_exchange_token: shortJson.access_token,
  })
  const longRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${longParams.toString()}`,
  )
  if (longRes.ok) {
    const longJson = await longRes.json()
    if (longJson.access_token) {
      accessToken = longJson.access_token
      expiresAt = expiresAtFrom(longJson.expires_in)
    }
  }

  return { accessToken, refreshToken: null, expiresAt, scope: null }
}

async function instagramToken(a: { code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  // 1. exchange the auth code for a short-lived Instagram token
  const form = new URLSearchParams({
    client_id: a.clientId,
    client_secret: a.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: a.redirectUri,
    code: a.code,
  })
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  })
  const shortJson = await shortRes.json()
  if (!shortRes.ok || !shortJson.access_token) throw new Error(`instagram_token:${shortRes.status}`)

  // 2. exchange for a 60-day long-lived token
  const longParams = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: a.clientSecret,
    access_token: shortJson.access_token,
  })
  const longRes = await fetch(`https://graph.instagram.com/access_token?${longParams.toString()}`)
  const longJson = await longRes.json().catch(() => ({}))

  const accessToken: string = longRes.ok && longJson.access_token ? longJson.access_token : shortJson.access_token
  const expiresAt = longRes.ok ? expiresAtFrom(longJson.expires_in) : null
  const scope = Array.isArray(shortJson.permissions)
    ? shortJson.permissions.join(",")
    : shortJson.permissions ?? null

  return { accessToken, refreshToken: null, expiresAt, scope }
}

/* ------------------------------------------------------------------ */
/* Identity resolution (who did we just connect?)                      */
/* ------------------------------------------------------------------ */

export type ConnectedIdentity = {
  externalId: string
  handle: string
  displayName: string | null
  followers: number | null
  /** For FB/IG a page/business token replaces the user token for publishing. */
  accessToken: string
  pageId: string | null
}

export async function fetchIdentity(opts: {
  platform: SocialPlatformId
  type: SocialAccountType
  tokens: OAuthTokens
}): Promise<ConnectedIdentity> {
  const { platform, type, tokens } = opts
  if (platform === "linkedin") return linkedinIdentity(type, tokens.accessToken)
  if (platform === "x") return xIdentity(tokens.accessToken)
  if (platform === "facebook") return facebookIdentity(tokens.accessToken)
  return instagramIdentity(tokens.accessToken)
}

async function linkedinIdentity(type: SocialAccountType, accessToken: string): Promise<ConnectedIdentity> {
  // Company posting needs w_organization_social + r_organization_admin, which
  // are not enabled on this app. Fail with a clear, safe message instead of
  // requesting unsupported scopes.
  if (type === "company") throw new Error("noorgscope")

  const res = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`linkedin_userinfo:${res.status}`)
  return {
    externalId: `urn:li:person:${json.sub}`,
    handle: json.name ? `@${String(json.name).replace(/\s+/g, "").toLowerCase()}` : `@${json.sub}`,
    displayName: json.name ?? null,
    followers: null,
    accessToken,
    pageId: null,
  }
}

async function xIdentity(accessToken: string): Promise<ConnectedIdentity> {
  const res = await fetch("https://api.x.com/2/users/me?user.fields=public_metrics,username,name", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`x_userinfo:${res.status}`)
  const u = json.data
  return {
    externalId: u.id,
    handle: `@${u.username}`,
    displayName: u.name ?? null,
    followers: u.public_metrics?.followers_count ?? null,
    accessToken,
    pageId: null,
  }
}

async function facebookIdentity(userAccessToken: string): Promise<ConnectedIdentity> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,followers_count,fan_count&access_token=${encodeURIComponent(userAccessToken)}`,
  )
  const json = await res.json()
  if (!res.ok) throw new Error(`facebook_pages:${res.status}`)
  const page = json.data?.[0]
  if (!page) throw new Error("nopage")
  return {
    externalId: page.id,
    handle: `@${String(page.name).replace(/\s+/g, "").toLowerCase()}`,
    displayName: page.name ?? null,
    followers: page.followers_count ?? page.fan_count ?? null,
    accessToken: page.access_token, // page token — required to publish
    pageId: page.id,
  }
}

async function instagramIdentity(accessToken: string): Promise<ConnectedIdentity> {
  // Instagram API with Instagram Login: the account is resolved directly from
  // the Instagram Graph, NOT through Facebook Pages.
  const res = await fetch(
    `https://graph.instagram.com/me?fields=user_id,username,account_type,followers_count&access_token=${encodeURIComponent(accessToken)}`,
  )
  const json = await res.json()
  if (!res.ok || !(json.user_id || json.id)) throw new Error(`instagram_account:${res.status}`)
  const igId = String(json.user_id ?? json.id)
  return {
    externalId: igId,
    handle: json.username ? `@${json.username}` : `@ig_${igId}`,
    displayName: json.username ?? null,
    followers: json.followers_count ?? null,
    accessToken, // Instagram user token drives publishing in this flow
    pageId: igId,
  }
}
