import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { installConnector } from "@/lib/marketplace/connector-store"

/**
 * Install a marketplace connector for the current tenant. Tenant-admin only.
 * The install validates scopes + credentials, stores credentials encrypted,
 * runs the reviewed adapter's readiness probe, and records the install — all
 * with rollback, so a failed probe leaves no partial credential behind. An
 * Idempotency-Key collapses retries to a single install.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can install connectors" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const connectorKey = body?.connectorKey ? String(body.connectorKey) : ""
  if (!connectorKey) return NextResponse.json({ error: "connectorKey is required" }, { status: 400 })

  const requestedScopes = Array.isArray(body?.requestedScopes) ? body.requestedScopes.map((s: unknown) => String(s)) : null
  const credentials =
    body?.credentials && typeof body.credentials === "object" && !Array.isArray(body.credentials)
      ? (body.credentials as Record<string, unknown>)
      : {}

  try {
    const outcome = await installConnector({
      connectorKey,
      requestedScopes,
      credentials,
      actor: { userId: auth.session.userId, email: auth.session.email },
      idempotencyKey: req.headers.get("idempotency-key"),
    })
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to install connector" }, { status: 400 })
  }
}
