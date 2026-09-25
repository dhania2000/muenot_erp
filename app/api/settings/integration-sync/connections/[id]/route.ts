import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import {
  getSyncConnection,
  updateSyncConnection,
  SyncConnectionNotFound,
  SyncVersionConflict,
} from "@/lib/integration-sync/store"
import { SyncError } from "@/lib/integration-sync/model"

/**
 * Spec16 — a single sync connection (#90-91).
 * GET returns the connection (read: any tenant member).
 * PATCH updates schedule/label/enabled/config with optimistic locking
 * (mutating: tenant-admin only).
 */
export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid connection id" }, { status: 400 })
  const connection = await getSyncConnection(auth.tenantId, id)
  if (!connection) return NextResponse.json({ error: "Sync connection not found" }, { status: 404 })
  return NextResponse.json({ connection })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can update sync connections" }, { status: 403 })
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid connection id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const expectedVersion = Number(body?.expectedVersion)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    return NextResponse.json({ error: "expectedVersion is required for a safe update" }, { status: 400 })

  try {
    const connection = await updateSyncConnection(
      auth.tenantId,
      auth.session.userId,
      id,
      {
        label: body?.label != null ? String(body.label) : undefined,
        enabled: body?.enabled === undefined ? undefined : Boolean(body.enabled),
        cronExpression:
          body?.cronExpression === undefined ? undefined : body.cronExpression == null ? null : String(body.cronExpression),
        config: body?.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : undefined,
      },
      expectedVersion,
    )
    return NextResponse.json({ ok: true, connection })
  } catch (err: any) {
    if (err instanceof SyncConnectionNotFound) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof SyncVersionConflict) return NextResponse.json({ error: err.message }, { status: 409 })
    if (err instanceof SyncError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err?.message ?? "Failed to update sync connection" }, { status: 400 })
  }
}
