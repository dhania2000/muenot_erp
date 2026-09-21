import { mobileLogin } from "@/lib/mobile-auth"
import { mobileJson } from "@/lib/mobile-api"
export const runtime = "nodejs"
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const result = await mobileLogin(request, body)
  if (!result.ok) return mobileJson({ error: result.error, code: result.code }, { status: result.status, headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined })
  return mobileJson({ user: result.user, tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug, tenantType: result.tenant.tenant_type }, ...result.tokens })
}
