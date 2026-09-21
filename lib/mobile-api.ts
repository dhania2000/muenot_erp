import "server-only"
import { NextResponse } from "next/server"
import { setCurrentActor } from "@/lib/actor-context"
import { authenticateMobileRequest, type MobilePrincipal } from "@/lib/mobile-auth"
import { runForTenant } from "@/lib/tenant-scope"
import { requireShopkeeperFeature, type ShopkeeperFeature } from "@/lib/shopkeeper"
import { auditMobileAction } from "@/lib/mobile-auth"
import { checkRateLimit } from "@/lib/rate-limit"

export const mobileNoStore = { "Cache-Control": "no-store" }
export function mobileJson(body: unknown, init: ResponseInit = {}) { return NextResponse.json(body, { ...init, headers: { ...mobileNoStore, ...(init.headers || {}) } }) }
export function boundedPage(value: string | null, fallback = 50, maximum = 200) { const n = Number(value); return Number.isInteger(n) ? Math.max(1, Math.min(maximum, n)) : fallback }

export async function withMobileAuth<T>(request: Request, handler: (principal: MobilePrincipal) => Promise<T>, feature?: ShopkeeperFeature): Promise<T | NextResponse> {
  const principal = await authenticateMobileRequest(request)
  if (!principal) return mobileJson({ error: "Unauthorized", code: "invalid_token" }, { status: 401 })
  const requestUrl = new URL(request.url)
  const rate = checkRateLimit(`mobile-api:${principal.userId}:${requestUrl.pathname}`, { max: 600, windowMs: 15 * 60_000 })
  if (!rate.allowed) return mobileJson({ error: "Too many requests.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfter) } })
  if (feature) {
    const gate = await requireShopkeeperFeature(principal.tenantId, feature)
    if (!gate.ok) return mobileJson({ error: gate.reason, code: "not_entitled" }, { status: gate.status })
  }
  void auditMobileAction({ tenantId: principal.tenantId, userId: principal.userId, sessionId: principal.sessionId, action: "mobile_api_request", method: request.method, path: requestUrl.pathname })
  setCurrentActor({ userId: principal.userId, name: principal.name, email: principal.email, role: principal.role })
  return runForTenant({ tenantId: principal.tenantId }, () => handler(principal))
}
export function isMobileResponse(value: unknown): value is NextResponse { return value instanceof NextResponse }
