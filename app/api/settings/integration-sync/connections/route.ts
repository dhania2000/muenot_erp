import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { createSyncConnection, listSyncConnections, SyncVersionConflict } from "@/lib/integration-sync/store"
import { SyncError } from "@/lib/integration-sync/model"
import { listSyncSources } from "@/lib/integration-sync/providers"

/**
 * Spec16 — tenant sync connections (#90-91).
 * GET lists this tenant's configured feeds (read: any tenant member).
 * POST creates one (mutating: tenant-admin only). Tenant id always comes from
 * the verified session, never from the body.
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const connections = await listSyncConnections(auth.tenantId)
  return NextResponse.json({ connections, sources: listSyncSources() })
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can configure sync connections" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const providerKey = body?.providerKey ? String(body.providerKey) : ""
  const entityKind = body?.entityKind ? String(body.entityKind) : ""
  if (!providerKey || !entityKind)
    return NextResponse.json({ error: "providerKey and entityKind are required" }, { status: 400 })

  try {
    const connection = await createSyncConnection(auth.tenantId, auth.session.userId, {
      providerKey,
      entityKind,
      label: body?.label != null ? String(body.label) : undefined,
      enabled: body?.enabled === undefined ? undefined : Boolean(body.enabled),
      cronExpression: body?.cronExpression === undefined ? undefined : (body.cronExpression == null ? null : String(body.cronExpression)),
      config: body?.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : undefined,
    })
    return NextResponse.json({ ok: true, connection }, { status: 201 })
  } catch (err: any) {
    if (err instanceof SyncVersionConflict) return NextResponse.json({ error: err.message }, { status: 409 })
    if (err instanceof SyncError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err?.message ?? "Failed to create sync connection" }, { status: 400 })
  }
}
