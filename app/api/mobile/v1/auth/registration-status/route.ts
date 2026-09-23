import { mobileJson } from "@/lib/mobile-api"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { ApplicationError, getRegistrationStatus } from "@/lib/shopkeeper-applications"

export const runtime = "nodejs"
export async function GET(request: Request) {
  const limit = checkRateLimit(`shopkeeper-registration-status:${getClientIp(request)}`, { max: 60, windowMs: 15 * 60_000 })
  if (!limit.allowed) return mobileJson({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } })
  const token = /^Registration ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") || "")?.[1] ?? ""
  try { return mobileJson(await getRegistrationStatus(token)) }
  catch (error) {
    if (error instanceof ApplicationError) return mobileJson({ error: error.message, code: "invalid_registration_token" }, { status: error.status })
    return mobileJson({ error: "Status is temporarily unavailable.", code: "server_error" }, { status: 500 })
  }
}
