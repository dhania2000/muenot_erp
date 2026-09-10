import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import crypto from "crypto"
import { getSession } from "@/lib/auth"
import { buildGoogleAuthUrl, isGoogleOAuthConfigured } from "@/lib/google-calendar"

export const OAUTH_STATE_COOKIE = "g_oauth_state"
export const OAUTH_RETURN_COOKIE = "g_oauth_return"

/**
 * Only allow redirecting back to known in-app pages after OAuth. The connect
 * flow is shared: Meetings sends the user back to the meetings page, the
 * Calendar module sends them back to the calendar.
 */
const ALLOWED_RETURNS = ["/modules/sales/meetings", "/modules/calendar"]

export function resolveReturnPath(raw: string | null | undefined) {
  return raw && ALLOWED_RETURNS.includes(raw) ? raw : "/modules/sales/meetings"
}

/** Resolve the redirect URI Google will call back. Overridable via env for prod. */
function resolveRedirectUri(origin: string) {
  return process.env.GOOGLE_REDIRECT_URI || `${origin}/api/sales/google/callback`
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const returnPath = resolveReturnPath(url.searchParams.get("return"))
  const returnUrl = new URL(returnPath, url.origin)

  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/login", url.origin))

  if (!isGoogleOAuthConfigured()) {
    returnUrl.searchParams.set("google", "notconfigured")
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
  cookieStore.set(OAUTH_STATE_COOKIE, state, cookieOpts)
  cookieStore.set(OAUTH_RETURN_COOKIE, returnPath, cookieOpts)

  const authUrl = buildGoogleAuthUrl(resolveRedirectUri(url.origin), state)
  return NextResponse.redirect(authUrl)
}
