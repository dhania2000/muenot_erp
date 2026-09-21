import { refreshMobileSession } from "@/lib/mobile-auth"
import { mobileJson } from "@/lib/mobile-api"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
export const runtime = "nodejs"
export async function POST(request: Request) {
  const rate = checkRateLimit(`mobile-refresh:${getClientIp(request)}`, { max: 30, windowMs: 15 * 60_000 })
  if (!rate.allowed) return mobileJson({ error: "Too many refresh attempts." }, { status: 429, headers: { "Retry-After": String(rate.retryAfter) } })
  const body = await request.json().catch(() => ({})); const result = await refreshMobileSession(body.refreshToken)
  return result.ok ? mobileJson(result.tokens) : mobileJson({ error: result.error, code: "invalid_refresh_token" }, { status: result.status })
}
