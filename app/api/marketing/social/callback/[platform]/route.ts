import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSession } from "@/lib/auth"
import { SOCIAL_PLATFORMS, type SocialPlatformId } from "@/lib/social-platforms"
import { exchangeCode, fetchIdentity, resolveRedirectUri } from "@/lib/social-oauth"
import { upsertSocialAccount } from "@/lib/social-accounts"
import {
  RETURN_PATH,
  SOCIAL_STATE_COOKIE,
  SOCIAL_TYPE_COOKIE,
  SOCIAL_VERIFIER_COOKIE,
  SOCIAL_REDIRECT_COOKIE,
  resolveOrigin,
} from "@/app/api/marketing/social/connect/route"

const PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id)

function isPlatformId(value: string): value is SocialPlatformId {
  return PLATFORM_IDS.includes(value as SocialPlatformId)
}

export async function GET(request: Request, ctx: { params: Promise<{ platform: string }> }) {
  const url = new URL(request.url)
  const origin = resolveOrigin(request, url.origin)
  const { platform } = await ctx.params

  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/login", origin))

  const returnUrl = new URL(RETURN_PATH, origin)
  const fail = (reason: string, detail?: string) => {
    returnUrl.searchParams.set("social", reason)
    returnUrl.searchParams.set("platform", platform)
    if (detail) returnUrl.searchParams.set("detail", detail.slice(0, 200))
    return NextResponse.redirect(returnUrl)
  }

  if (!isPlatformId(platform)) return fail("badplatform")

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const oauthError = url.searchParams.get("error")

  const cookieStore = await cookies()
  const savedStateRaw = cookieStore.get(SOCIAL_STATE_COOKIE)?.value
  const type = cookieStore.get(SOCIAL_TYPE_COOKIE)?.value === "personal" ? "personal" : "company"
  const verifier = cookieStore.get(SOCIAL_VERIFIER_COOKIE)?.value
  // The redirect URI pinned at the authorize step — reused verbatim so the
  // token exchange matches byte-for-byte. Fall back only if the cookie is gone.
  const pinnedRedirectUri = cookieStore.get(SOCIAL_REDIRECT_COOKIE)?.value
  cookieStore.delete(SOCIAL_STATE_COOKIE)
  cookieStore.delete(SOCIAL_TYPE_COOKIE)
  cookieStore.delete(SOCIAL_VERIFIER_COOKIE)
  cookieStore.delete(SOCIAL_REDIRECT_COOKIE)

  if (oauthError || !code || !state || !savedStateRaw) return fail("error")
  const [savedPlatform, savedState] = savedStateRaw.split(":")
  if (savedPlatform !== platform || savedState !== state) return fail("error")

  try {
    const tokens = await exchangeCode({
      platform,
      code,
      redirectUri: pinnedRedirectUri || resolveRedirectUri(platform, origin),
      codeVerifier: verifier,
    })

    const identity = await fetchIdentity({ platform, type, tokens })

    try {
      await upsertSocialAccount({
        platform,
        accountType: type,
        connectedByUserId: session.userId,
        externalId: identity.externalId,
        handle: identity.handle,
        displayName: identity.displayName,
        ownerName: type === "personal" ? session.name : null,
        followers: identity.followers,
        accessToken: identity.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        pageId: identity.pageId,
        scope: tokens.scope,
      })
    } catch (dbErr: any) {
      // Never report a successful connection if persistence failed.
      throw new Error(`dbsave:${dbErr?.code || dbErr?.message || "unknown"}`)
    }

    returnUrl.searchParams.set("social", "connected")
    returnUrl.searchParams.set("platform", platform)
    return NextResponse.redirect(returnUrl)
  } catch (err: any) {
    const message = String(err?.message || "")
    // Log server-side only; the reason strings below never contain the code,
    // access token or client secret.
    console.error("[v0] Social OAuth callback failed:", message)
    // The text after the first colon is the provider's own error message; it
    // never contains the auth code, access token or client secret.
    const detail = message.includes(":") ? message.slice(message.indexOf(":") + 1).trim() : undefined
    if (message.includes("noadmin")) return fail("noadmin")
    if (message.includes("noorgscope")) return fail("noorgscope")
    if (message.includes("nopage")) return fail("nopage")
    if (message.includes("noig")) return fail("noig")
    if (message.includes("_token")) return fail("tokenfail", detail)
    if (
      message.includes("_account") ||
      message.includes("_userinfo") ||
      message.includes("_pages") ||
      message.includes("_orgacls")
    )
      return fail("profilefail", detail)
    if (message.includes("dbsave")) return fail("dbsave", detail)
    return fail("error")
  }
}
