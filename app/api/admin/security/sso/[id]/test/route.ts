import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getProviderById, recordTestResult } from "@/lib/sso-store"
import { resolveEndpoints } from "@/lib/sso-oidc"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/**
 * "Test connection". For OIDC this actually reaches the IdP:
 * resolves discovery (or validates manual endpoints) and fetches the JWKS,
 * which is the same trust anchor the real login callback verifies against.
 * SAML has no live handshake to test without a real IdP-initiated flow, so it
 * only validates that the required metadata fields are present.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = Number((await params).id)
  const row = await getProviderById(id)
  if (!row || row.tenant_id !== ctx.tenantId) return NextResponse.json({ error: "Not found" }, { status: 404 })

  try {
    if (row.type === "oidc") {
      const endpoints = await resolveEndpoints(row)
      const jwksRes = await fetch(endpoints.jwks_uri, { cache: "no-store" })
      if (!jwksRes.ok) throw new Error(`JWKS endpoint returned ${jwksRes.status}`)
      if (!row.client_id) throw new Error("Client ID is not set")
      await recordTestResult(id, true, "Discovery and JWKS reachable")
      return NextResponse.json({ ok: true, message: "Discovery and JWKS reachable" })
    }

    if (!row.entity_id || !row.sso_url || !row.certificate) {
      throw new Error("Entity ID, SSO URL and certificate are all required")
    }
    await recordTestResult(id, true, "SAML metadata is complete")
    return NextResponse.json({ ok: true, message: "SAML metadata is complete (live handshake requires an IdP-initiated login)" })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Test failed"
    await recordTestResult(id, false, message)
    return NextResponse.json({ ok: false, message }, { status: 200 })
  }
}
