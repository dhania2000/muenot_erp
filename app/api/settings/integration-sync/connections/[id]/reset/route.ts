import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { resetSyncBaseline, SyncBusy, SyncConnectionNotFound } from "@/lib/integration-sync/store"

/**
 * Spec16 — reset a connection's sync baseline (#90-91). Tenant-admin only.
 *
 * Bumps the generation (invalidating any in-flight cursor as stale) and clears
 * the stored position so the next run performs a fresh initial sync. Mappings
 * and the immutable log are retained, so replay safety and audit history are
 * preserved. Refused (409) while a sync holds the connection lease.
 */
export const dynamic = "force-dynamic"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can reset a sync baseline" }, { status: 403 })

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid connection id" }, { status: 400 })

  try {
    const connection = await resetSyncBaseline(auth.tenantId, auth.session.userId, id)
    return NextResponse.json({ ok: true, connection })
  } catch (err: any) {
    if (err instanceof SyncConnectionNotFound) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof SyncBusy) return NextResponse.json({ error: err.message }, { status: 409 })
    return NextResponse.json({ error: err?.message ?? "Failed to reset sync baseline" }, { status: 400 })
  }
}
