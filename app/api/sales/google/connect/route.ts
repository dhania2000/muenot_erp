import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import crypto from "crypto"
import { getSession } from "@/lib/auth"
import { buildGoogleAuthUrl, isGoogleOAuthConfigured } from "@/lib/google-calendar"

export const OAUTH_STATE_COOKIE = "g_oauth_state"

/** Resolve the redirect URI Google will call back. Overridable via env for prod. */
function resolveRedirectUri(origin: string) {
  return process.env.GOOGLE_REDIRECT_URI || `${origin}/api/sales/google/callback`
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const meetingsUrl = new URL("/modules/sales/meetings", url.origin)

  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/login", url.origin))

  if (!isGoogleOAuthConfigured()) {
    meetingsUrl.searchParams.set("google", "notconfigured")
    return NextResponse.redirect(meetingsUrl)
  }

  const state = crypto.randomBytes(16).toString("hex")
  const cookieStore = await cookies()
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  })

  const authUrl = buildGoogleAuthUrl(resolveRedirectUri(url.origin), state)
  return NextResponse.redirect(authUrl)
}
