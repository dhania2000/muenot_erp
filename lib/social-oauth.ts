import crypto from "crypto"
import type { SocialPlatformId } from "@/lib/social-platforms"
import type { SocialAccountType } from "@/lib/social-accounts"

/**
 * Server-only OAuth 2.0 logic for connecting real social accounts. Each
 * platform needs its own developer app credentials, supplied via env vars:
 *
 *   LinkedIn   → LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
 *   X (Twitter)→ X_CLIENT_ID, X_CLIENT_SECRET
 *   Facebook   → FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
 *   Instagram  → FACEBOOK_APP_ID, FACEBOOK_APP_SECRET (shares the Meta app)
 *
 * Optional: SOCIAL_REDIRECT_BASE to pin the OAuth redirect origin in prod.
 */

const GRAPH_VERSION = "v21.0"

type PlatformOAuthConfig = {
  clientIdEnv: string
  clientSecretEnv: string
  authorizeUrl: string
  scopes: string[]
  /** X uses PKCE (public/confidential client with code_verifier). */
  usesPkce: boolean
}

const OAUTH_CONFIG: Record<SocialPlatformId, PlatformOAuthConfig> = {
  linkedin: {
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    scopes: ["openid", "profile", "email", "w_member_social", "w_organization_social", "r_organization_admin"],
    usesPkce: false,
  },
  x: {
    clientIdEnv: "X_CLIENT_ID",
    clientSecretEnv: "X_CLIENT_SECRET",
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    usesPkce: true,
  },
  facebook: {
    clientIdEnv: "FACEBOOK_APP_ID",
    clientSecretEnv: "FACEBOOK_APP_SECRET",
    authorizeUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    scopes: ["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    usesPkce: false,
  },
  instagram: {
    clientIdEnv: "FACEBOOK_APP_ID",
    clientSecretEnv: "FACEBOOK_APP_SECRET",
    authorizeUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    scopes: [
      "public_profile",
      "pages_show_list",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_content_publish",
    ],
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
    scope: cfg.scopes.join(" "),
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

export async function exchangeCode(opts: {
  platform: SocialPlatformId
  code: string
  redirectUri: string
  codeVerifier?: string
}): Promise<OAuthTokens> {
  const { platform, code, redirectUri, codeVerifier } = opts
  const clientId = getClientId(platform)!
  const clientSecret = getClientSecret(platform)!

  if (platform === "linkedin") {
    return linkedinToken({ code, redirectUri, clientId, clientSecret })
  }
  if (platform === "x") {
    return xToken({ code, redirectUri, clientId, clientSecret, codeVerifier: codeVerifier! })
  }
  // facebook + instagram share the Graph token endpoint
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
  if (!res.ok) throw new Error(`LinkedIn token error: ${JSON.stringify(json)}`)
  return normalizeTokens(json)
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
  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`X token error: ${JSON.stringify(json)}`)
  return normalizeTokens(json)
}

async function facebookToken(a: { code: string; redirectUri: string; clientId: string; clientSecret: string }) {
  const params = new URLSearchParams({
    client_id: a.clientId,
    client_secret: a.clientSecret,
    redirect_uri: a.redirectUri,
    code: a.code,
  })
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${params.toString()}`)
  const json = await res.json()
  if (!res.ok) throw new Error(`Facebook token error: ${JSON.stringify(json)}`)
  return normalizeTokens(json)
}

function normalizeTokens(json: any): OAuthTokens {
  const expiresIn = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(Date.now() + expiresIn * 1000).toISOString().slice(0, 19).replace("T", " ")
      : null,
    scope: json.scope ?? null,
  }
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
  const auth = { Authorization: `Bearer ${accessToken}` }

  if (type === "company") {
    const res = await fetch(
      "https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName,vanityName)))",
      { headers: { ...auth, "X-Restli-Protocol-Version": "2.0.0" } },
    )
    const json = await res.json()
    if (!res.ok) throw new Error(`LinkedIn org error: ${JSON.stringify(json)}`)
    const el = json.elements?.[0]
    const org = el?.["organization~"]
    const orgUrn: string | undefined = el?.organization
    const orgId = orgUrn?.split(":").pop()
    if (!orgId) throw new Error("noadmin")
    return {
      externalId: `urn:li:organization:${orgId}`,
      handle: org?.vanityName ? `@${org.vanityName}` : org?.localizedName || `Org ${orgId}`,
      displayName: org?.localizedName ?? null,
      followers: null,
      accessToken,
      pageId: orgId,
    }
  }

  const res = await fetch("https://api.linkedin.com/v2/userinfo", { headers: auth })
  const json = await res.json()
  if (!res.ok) throw new Error(`LinkedIn userinfo error: ${JSON.stringify(json)}`)
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
  const res = await fetch("https://api.twitter.com/2/users/me?user.fields=public_metrics,username,name", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`X userinfo error: ${JSON.stringify(json)}`)
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
  if (!res.ok) throw new Error(`Facebook pages error: ${JSON.stringify(json)}`)
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

async function instagramIdentity(userAccessToken: string): Promise<ConnectedIdentity> {
  const pagesRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(userAccessToken)}`,
  )
  const pagesJson = await pagesRes.json()
  if (!pagesRes.ok) throw new Error(`Instagram pages error: ${JSON.stringify(pagesJson)}`)
  const page = (pagesJson.data || []).find((p: any) => p.instagram_business_account)
  if (!page) throw new Error("noig")
  const igId = page.instagram_business_account.id

  const igRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${igId}?fields=username,followers_count&access_token=${encodeURIComponent(page.access_token)}`,
  )
  const igJson = await igRes.json()
  if (!igRes.ok) throw new Error(`Instagram account error: ${JSON.stringify(igJson)}`)

  return {
    externalId: igId,
    handle: igJson.username ? `@${igJson.username}` : `@ig_${igId}`,
    displayName: igJson.username ?? null,
    followers: igJson.followers_count ?? null,
    accessToken: page.access_token, // page token drives IG publishing
    pageId: igId,
  }
}
