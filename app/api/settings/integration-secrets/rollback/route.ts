import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { rollbackIntegrationSecret } from "@/lib/secrets/tenant-integration-store"

/**
 * Roll a tenant integration secret field back to a prior version by
 * REACTIVATING it. Tenant-admin only. Append-only history is preserved (no
 * ciphertext is rewritten); the response confirms the reactivated version.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can roll back integration secrets" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const integrationKey = body?.integrationKey ? String(body.integrationKey) : ""
  const fieldKey = body?.fieldKey ? String(body.fieldKey) : ""
  const targetVersion = Number(body?.targetVersion)
  if (!integrationKey) return NextResponse.json({ error: "integrationKey is required" }, { status: 400 })
  if (!fieldKey) return NextResponse.json({ error: "fieldKey is required" }, { status: 400 })
  if (!Number.isInteger(targetVersion) || targetVersion < 1)
    return NextResponse.json({ error: "A valid targetVersion is required" }, { status: 400 })

  try {
    const outcome = await rollbackIntegrationSecret({
      integrationKey,
      fieldKey,
      targetVersion,
      actor: { userId: auth.session.userId, email: auth.session.email },
      idempotencyKey: req.headers.get("idempotency-key"),
    })
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to roll back secret" }, { status: 400 })
  }
}
