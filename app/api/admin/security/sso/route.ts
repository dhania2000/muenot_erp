import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { createProvider, listProviders, type ProviderInput } from "@/lib/sso-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const providers = await listProviders(ctx.tenantId)
  return NextResponse.json({ providers })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as (ProviderInput & { name?: string }) | null
  if (!body?.name?.trim()) return NextResponse.json({ error: "Provider name is required" }, { status: 400 })
  if (body.type !== "oidc" && body.type !== "saml") {
    return NextResponse.json({ error: "Provider type must be oidc or saml" }, { status: 400 })
  }
  if (body.type === "oidc" && !body.discoveryUrl && !body.authorizationEndpoint) {
    return NextResponse.json(
      { error: "Provide either a discovery URL or manual authorization/token/JWKS endpoints" },
      { status: 400 },
    )
  }
  if (body.type === "saml" && (!body.entityId || !body.ssoUrl || !body.certificate)) {
    return NextResponse.json({ error: "SAML providers require an entity ID, SSO URL, and certificate" }, { status: 400 })
  }

  const id = await createProvider(ctx.tenantId, body, ctx.session.userId)
  return NextResponse.json({ id }, { status: 201 })
}
