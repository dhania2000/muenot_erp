import { mobileJson } from "@/lib/mobile-api"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { ApplicationError, registerShopkeeper, type PublicRegistration } from "@/lib/shopkeeper-applications"

export const runtime = "nodejs"
export async function POST(request: Request) {
  const ip = getClientIp(request)
  const limit = await checkRateLimit(`shopkeeper-register:${ip}`, { max: 5, windowMs: 60 * 60_000 })
  if (!limit.allowed) return mobileJson({ error: "Too many registration attempts.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } })
  const raw = await request.text().catch(() => "")
  if (raw.length > 8192) return mobileJson({ error: "Request is too large.", code: "invalid_request" }, { status: 413 })
  let body: unknown = null
  try { body = JSON.parse(raw) } catch { /* invalid JSON handled below */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) return mobileJson({ error: "Invalid request.", code: "invalid_request" }, { status: 400 })
  try {
    const result = await registerShopkeeper(body as PublicRegistration)
    return mobileJson(result, { status: 201 })
  } catch (error) {
    if (error instanceof ApplicationError) return mobileJson({ error: error.message, code: error.status === 409 ? "conflict" : "invalid_request", field: error.field }, { status: error.status })
    return mobileJson({ error: "Registration is temporarily unavailable.", code: "server_error" }, { status: 500 })
  }
}
