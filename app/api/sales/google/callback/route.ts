import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getSession } from "@/lib/auth"
import { exchangeGoogleCode } from "@/lib/google-calendar"
import { getGoogleAccount, saveGoogleAccount } from "@/lib/google-accounts"
import { OAUTH_STATE_COOKIE } from "@/app/api/sales/google/connect/route"

function resolveRedirectUri(origin: string) {
  return process.env.GOOGLE_REDIRECT_URI || `${origin}/api/sales/google/callback`
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const meetingsUrl = new URL("/modules/sales/meetings", url.origin)

  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/login", url.origin))

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const oauthError = url.searchParams.get("error")

  const cookieStore = await cookies()
  const savedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value
  cookieStore.delete(OAUTH_STATE_COOKIE)

  const fail = (reason: string) => {
    meetingsUrl.searchParams.set("google", reason)
    return NextResponse.redirect(meetingsUrl)
  }

  if (oauthError || !code) return fail("error")
  if (!state || !savedState || state !== savedState) return fail("error")

  try {
    const { tokens, email } = await exchangeGoogleCode(resolveRedirectUri(url.origin), code)

    // Google only returns refresh_token on first consent for a scope set. We
    // force prompt=consent so it should always come back, but fall back to the
    // previously-stored token just in case.
    let refreshToken = tokens.refresh_token ?? null
    if (!refreshToken) {
      const existing = await getGoogleAccount(session.userId)
      refreshToken = existing?.refresh_token ?? null
    }
    if (!refreshToken) return fail("noretoken")

    await saveGoogleAccount(session.userId, {
      refreshToken,
      email,
      scope: tokens.scope ?? null,
    })

    return fail("connected")
  } catch (err: any) {
    console.error("[v0] Google OAuth callback failed:", err?.message || err)
    return fail("error")
  }
}
