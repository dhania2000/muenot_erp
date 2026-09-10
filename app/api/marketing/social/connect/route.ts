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

export const RETURN_PATH = "/modules/marketing/campaigns/social"

const PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id)

function isPlatformId(value: string | null): value is SocialPlatformId {
  return Boolean(value && PLATFORM_IDS.includes(value as SocialPlatformId))
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const returnUrl = new URL(RETURN_PATH, url.origin)

  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/login", url.origin))

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

  const authUrl = buildAuthUrl({
    platform,
    redirectUri: resolveRedirectUri(platform, url.origin),
    state,
    codeChallenge,
  })
  return NextResponse.redirect(authUrl)
}
