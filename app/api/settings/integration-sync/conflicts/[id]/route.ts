import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import {
  getSyncConflict,
  resolveSyncConflict,
  SyncConflictAlreadyResolved,
  SyncConflictNotFound,
  SyncConflictStale,
} from "@/lib/integration-sync/store"
import { isValidResolution, SyncError, type NormalizedRecord } from "@/lib/integration-sync/model"

/**
 * Spec16 — inspect / resolve a single conflict (#90-91).
 * GET returns the conflict with both snapshots (read: any tenant member).
 * POST resolves it with erp_wins | external_wins | manual (mutating:
 * tenant-admin only). Resolution is idempotent (a second resolve of a closed
 * conflict is rejected) and guarded against a simultaneous ERP edit made after
 * the reviewer loaded the snapshot (409 SyncConflictStale).
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
  if (id == null) return NextResponse.json({ error: "Invalid conflict id" }, { status: 400 })
  const conflict = await getSyncConflict(auth.tenantId, id)
  if (!conflict) return NextResponse.json({ error: "Conflict not found" }, { status: 404 })
  return NextResponse.json({ conflict })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can resolve conflicts" }, { status: 403 })
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid conflict id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const resolution = body?.resolution
  if (!isValidResolution(resolution))
    return NextResponse.json({ error: "resolution must be erp_wins, external_wins, or manual" }, { status: 400 })

  const mergePatch: Partial<NormalizedRecord> | null =
    resolution === "manual" && body?.mergePatch && typeof body.mergePatch === "object" && !Array.isArray(body.mergePatch)
      ? (body.mergePatch as Partial<NormalizedRecord>)
      : null

  try {
    const conflict = await resolveSyncConflict(auth.tenantId, auth.session.userId, id, resolution, mergePatch)
    return NextResponse.json({ ok: true, conflict })
  } catch (err: any) {
    if (err instanceof SyncConflictNotFound) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof SyncConflictAlreadyResolved) return NextResponse.json({ error: err.message }, { status: 409 })
    if (err instanceof SyncConflictStale) return NextResponse.json({ error: err.message }, { status: 409 })
    if (err instanceof SyncError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err?.message ?? "Failed to resolve conflict" }, { status: 400 })
  }
}
