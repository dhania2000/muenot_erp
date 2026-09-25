import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { reconnectConnector } from "@/lib/marketplace/connector-store"

/**
 * Reconnect (re-authenticate) an installed or disconnected connector. Tenant-
 * admin only. New credentials may be supplied (rotated in) or, when the stored
 * credentials are still active, reused. Runs the readiness probe and, on
 * success, marks the connector installed again. Rolled back on failure.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can reconnect connectors" }, { status: 403 })

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
      : null

  try {
    const outcome = await reconnectConnector({
      connectorKey,
      requestedScopes,
      credentials,
      actor: { userId: auth.session.userId, email: auth.session.email },
      idempotencyKey: req.headers.get("idempotency-key"),
    })
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to reconnect connector" }, { status: 400 })
  }
}
