import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { disconnectConnector } from "@/lib/marketplace/connector-store"

/**
 * Disconnect a connector for the current tenant. Tenant-admin only. Revokes
 * every active credential (they can no longer be resolved) and marks the
 * install disconnected, while preserving credential and audit history. An
 * Idempotency-Key collapses retries to a single effect.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can disconnect connectors" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const connectorKey = body?.connectorKey ? String(body.connectorKey) : ""
  if (!connectorKey) return NextResponse.json({ error: "connectorKey is required" }, { status: 400 })

  try {
    const outcome = await disconnectConnector({
      connectorKey,
      actor: { userId: auth.session.userId, email: auth.session.email },
      idempotencyKey: req.headers.get("idempotency-key"),
    })
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to disconnect connector" }, { status: 400 })
  }
}
