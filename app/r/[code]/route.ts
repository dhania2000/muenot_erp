import { NextResponse } from "next/server"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { AFFILIATE_COOKIE, isBot, readCookie, sha256 } from "@/lib/affiliates/model"
import { recordClick } from "@/lib/affiliates/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ code: string }> }

/**
 * Spec30 (#173) — Affiliate link entry point: /r/<code> → /signup.
 * Always redirects the same way whether or not the code exists, so codes
 * cannot be enumerated. Bots and rate-limited clients are redirected without
 * a recorded click or cookie. IP/UA are stored only as hashes.
 */
export async function GET(request: Request, { params }: Ctx) {
  const redirect = NextResponse.redirect(new URL("/signup", request.url), 303)
  redirect.headers.set("Cache-Control", "no-store")
  redirect.headers.set("Referrer-Policy", "no-referrer")

  const ua = request.headers.get("user-agent")
  if (isBot(ua)) return redirect
  const ip = getClientIp(request)
  try {
    const rl = await checkRateLimit(`aff-click:${ip}`, { max: 60, windowMs: 60 * 60 * 1000 })
    if (!rl.allowed) return redirect
    const result = await recordClick({
      code: (await params).code,
      existingCookie: readCookie(request.headers.get("cookie"), AFFILIATE_COOKIE),
      ipHash: ip === "unknown" ? null : sha256(`aff-ip:${ip}`),
      uaHash: ua ? sha256(`aff-ua:${ua}`) : null,
      now: new Date(),
    })
    if (result?.cookie) {
      redirect.cookies.set(AFFILIATE_COOKIE, result.cookie.value, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: result.cookie.maxAge,
      })
    }
  } catch (err) {
    console.error("[affiliate] click tracking failed:", err)
  }
  return redirect
}
