import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { rotateIntegrationSecret } from "@/lib/secrets/tenant-integration-store"
import { normalizeVaultChoice } from "@/lib/secrets/tenant-integrations"

/**
 * Rotate a tenant integration secret. Tenant-admin only. A rotation appends a
 * new encrypted version, retires the previous one, and advances the rotation
 * clock. The new value is supplied by the operator; the response only confirms
 * the resulting version. An Idempotency-Key collapses retries to one version.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can rotate integration secrets" }, { status: 403 })

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
  if (!value) return NextResponse.json({ error: "A new secret value is required to rotate" }, { status: 400 })

  try {
    const outcome = await rotateIntegrationSecret({
      integrationKey,
      fieldKey,
      value,
      vaultChoice: normalizeVaultChoice(body?.vaultChoice),
      actor: { userId: auth.session.userId, email: auth.session.email },
      idempotencyKey: req.headers.get("idempotency-key"),
    })
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to rotate secret" }, { status: 400 })
  }
}
