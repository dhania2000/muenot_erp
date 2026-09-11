import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { SOCIAL_PLATFORMS, type SocialPlatformId } from "@/lib/social-platforms"
import { describeAuthUrl, resolveRedirectUri, getFacebookConfigId } from "@/lib/social-oauth"
import { resolveOrigin } from "@/app/api/marketing/social/connect/route"

/**
 * Read-only diagnostics for the social OAuth wiring. Returns the REDACTED
 * authorize-URL structure each configured platform will generate — the exact
 * scopes (or Facebook config_id) being requested — so an admin can confirm
 * "Invalid Scopes" is resolved WITHOUT exposing any client id, secret or token.
 *
 * GET /api/marketing/social/debug            → all platforms
 * GET /api/marketing/social/debug?platform=facebook → one platform
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const origin = resolveOrigin(request, url.origin)
  const requested = url.searchParams.get("platform")

  const ids: SocialPlatformId[] = SOCIAL_PLATFORMS.map((p) => p.id).filter(
    (id) => !requested || id === requested,
  )

  const platforms = ids.map((id) => {
    const redirectUri = resolveRedirectUri(id, origin)
    return describeAuthUrl(id, redirectUri)
  })

  return NextResponse.json({
    origin,
    facebook: {
      // Whether this Meta app is wired as "Facebook Login for Business"
      // (config_id path) or classic Facebook Login (raw scopes path).
      mode: getFacebookConfigId() ? "business_login_config_id" : "classic_login_scopes",
    },
    platforms,
  })
}
