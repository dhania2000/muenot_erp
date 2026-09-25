import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { checkConnectorHealth } from "@/lib/marketplace/connector-store"

/**
 * Run a connector's readiness health check. Tenant-admin only. Executes the
 * reviewed adapter's probe against the tenant's active credentials, persists
 * and audits the result. Never returns any credential material.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can run a connector health check" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const connectorKey = body?.connectorKey ? String(body.connectorKey) : ""
  if (!connectorKey) return NextResponse.json({ error: "connectorKey is required" }, { status: 400 })

  try {
    const result = await checkConnectorHealth({
      connectorKey,
      actor: { userId: auth.session.userId, email: auth.session.email },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to check connector health" }, { status: 400 })
  }
}
