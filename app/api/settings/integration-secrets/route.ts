import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import {
  getIntegrationsOverview,
  setIntegrationSecret,
} from "@/lib/secrets/tenant-integration-store"
import { assertNoTenantSecretExposure, normalizeVaultChoice } from "@/lib/secrets/tenant-integrations"

/**
 * Tenant integration secrets API.
 * ---------------------------------------------------------------------------
 * A tenant's OWN integration credentials (Stripe/SMTP/Twilio/…), scoped
 * SEPARATELY from platform secrets. GET returns the MASKED overview for any
 * authenticated tenant member; writing a secret is tenant-admin only. No
 * handler ever returns a plaintext value — the overview is asserted
 * exposure-free before it leaves, and a write only echoes the new version.
 *
 * Tenant scope is derived from the verified session (requireTenant), never
 * from client input, so one tenant can never read or mutate another's.
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const integrations = await getIntegrationsOverview()
    assertNoTenantSecretExposure(integrations)
    return NextResponse.json({ integrations })
  } catch (err) {
    console.error("[v0] tenant integration secrets GET failed", err)
    return NextResponse.json({ error: "Unable to load integrations" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can set integration secrets" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const integrationKey = body?.integrationKey ? String(body.integrationKey) : ""
  const fieldKey = body?.fieldKey ? String(body.fieldKey) : ""
  const value = body?.value != null ? String(body.value) : ""
  if (!integrationKey) return NextResponse.json({ error: "integrationKey is required" }, { status: 400 })
  if (!fieldKey) return NextResponse.json({ error: "fieldKey is required" }, { status: 400 })
  if (!value) return NextResponse.json({ error: "A secret value is required" }, { status: 400 })

  const idempotencyKey = req.headers.get("idempotency-key")

  try {
    const outcome = await setIntegrationSecret({
      integrationKey,
      fieldKey,
      value,
      vaultChoice: normalizeVaultChoice(body?.vaultChoice),
      actor: { userId: auth.session.userId, email: auth.session.email },
      idempotencyKey,
    })
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to store secret" }, { status: 400 })
  }
}
