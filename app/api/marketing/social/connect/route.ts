import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import crypto from "crypto"
import { getSession } from "@/lib/auth"
import { SOCIAL_PLATFORMS, type SocialPlatformId } from "@/lib/social-platforms"
import {
  buildAuthUrl,
  generatePkce,
  isPlatformConfigured,
  platformUsesPkce,
  resolveRedirectUri,
} from "@/lib/social-oauth"

export const SOCIAL_STATE_COOKIE = "social_oauth_state"
export const SOCIAL_TYPE_COOKIE = "social_oauth_type"
export const SOCIAL_VERIFIER_COOKIE = "social_oauth_verifier"
export const SOCIAL_REDIRECT_COOKIE = "social_oauth_redirect"

export const RETURN_PATH = "/modules/marketing/campaigns/social"

const PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id)

function isPlatformId(value: string | null): value is SocialPlatformId {
  return Boolean(value && PLATFORM_IDS.includes(value as SocialPlatformId))
}

export function resolveOrigin(request: Request, fallback: string) {
  // Prefer the pinned base, then the app's configured public URL, then the
  // proxy-forwarded host, and only fall back to the raw request origin (which
  // in dev is the 0.0.0.0 bind address that OAuth providers reject). Every
  // provider's OAuth redirect URI must be an exact, stable public URL — the
  // callback here MUST resolve to the same origin used to build the authorize
  // request, so we never hand a provider a 0.0.0.0/127.0.0.1 redirect.
  const pinned = process.env.SOCIAL_REDIRECT_BASE || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (pinned) return pinned.replace(/\/$/, "")

  const host = request.headers.get("x-forwarded-host") || request.headers.get("host")
  if (host && !host.startsWith("0.0.0.0") && !host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
    const proto = request.headers.get("x-forwarded-proto") || "https"
    return `${proto}://${host}`
  }
  return fallback
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = resolveOrigin(request, url.origin)
  const returnUrl = new URL(RETURN_PATH, origin)

  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/login", origin))

  const platform = url.searchParams.get("platform")
  const type = url.searchParams.get("type") === "personal" ? "personal" : "company"

  if (!isPlatformId(platform)) {
    returnUrl.searchParams.set("social", "badplatform")
    return NextResponse.redirect(returnUrl)
  }

  if (!isPlatformConfigured(platform)) {
    returnUrl.searchParams.set("social", "notconfigured")
    returnUrl.searchParams.set("platform", platform)
    return NextResponse.redirect(returnUrl)
  }

  const state = crypto.randomBytes(16).toString("hex")
  const cookieStore = await cookies()
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  }
  cookieStore.set(SOCIAL_STATE_COOKIE, `${platform}:${state}`, cookieOpts)
  cookieStore.set(SOCIAL_TYPE_COOKIE, type, cookieOpts)

  let codeChallenge: string | undefined
  if (platformUsesPkce(platform)) {
    const { verifier, challenge } = generatePkce()
    codeChallenge = challenge
    cookieStore.set(SOCIAL_VERIFIER_COOKIE, verifier, cookieOpts)
  }

  // Pin the EXACT redirect URI used here so the token exchange in the callback
  // reuses it byte-for-byte. Providers (Instagram especially) reject the code
  // if the token-step redirect_uri differs at all from the authorize-step one,
  // which happens when host resolution drifts between the two requests.
  const redirectUri = resolveRedirectUri(platform, origin)
  cookieStore.set(SOCIAL_REDIRECT_COOKIE, redirectUri, cookieOpts)

  const authUrl = buildAuthUrl({
    platform,
    redirectUri,
    state,
    codeChallenge,
  })
  return NextResponse.redirect(authUrl)
}
