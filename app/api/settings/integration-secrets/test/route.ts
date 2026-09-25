import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { testIntegrationConnection } from "@/lib/secrets/tenant-integration-store"
import { normalizeVaultChoice } from "@/lib/secrets/tenant-integrations"

/**
 * Test connection / health for the vault an integration uses (or a requested
 * one) WITHOUT moving any secret material. Tenant-admin only. Persists the
 * resulting health state and audits the test.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can test integration connections" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const integrationKey = body?.integrationKey ? String(body.integrationKey) : ""
  if (!integrationKey) return NextResponse.json({ error: "integrationKey is required" }, { status: 400 })

  try {
    const result = await testIntegrationConnection({
      integrationKey,
      vaultChoice: normalizeVaultChoice(body?.vaultChoice),
      actor: { userId: auth.session.userId, email: auth.session.email },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to test connection" }, { status: 400 })
  }
}
