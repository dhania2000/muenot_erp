import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getSyncConnection, runConnectionSync, SyncBusy, SyncConnectionNotFound } from "@/lib/integration-sync/store"
import { SyncError, type SyncMode } from "@/lib/integration-sync/model"

/**
 * Spec16 — trigger a sync for one connection (#90-91). Tenant-admin only.
 *
 * The mode defaults to `incremental` once the connection has a cursor, else
 * `initial`. An optional `slot` (or the `Idempotency-Key` header) collapses
 * duplicate triggers into a single run, so a double-click or client retry cannot
 * start two overlapping syncs. The connection lease additionally rejects a run
 * that races the scheduler with 409 SyncBusy.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (auth.session.role !== "admin")
    return NextResponse.json({ error: "Only a tenant administrator can run a sync" }, { status: 403 })

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid connection id" }, { status: 400 })

  let body: any = {}
  try {
    body = (await req.json()) ?? {}
  } catch {
    body = {}
  }

  const connection = await getSyncConnection(auth.tenantId, id)
  if (!connection) return NextResponse.json({ error: "Sync connection not found" }, { status: 404 })

  const requestedMode = body?.mode ? String(body.mode) : null
  const mode: SyncMode =
    requestedMode === "initial" || requestedMode === "incremental"
      ? requestedMode
      : connection.cursorPosition
        ? "incremental"
        : "initial"

  const slot = body?.slot != null ? String(body.slot) : req.headers.get("idempotency-key") ?? undefined

  try {
    const run = await runConnectionSync(auth.tenantId, auth.session.userId, id, mode, {
      triggerSource: "manual",
      slot,
    })
    return NextResponse.json({ ok: true, run })
  } catch (err: any) {
    if (err instanceof SyncBusy) return NextResponse.json({ error: err.message }, { status: 409 })
    if (err instanceof SyncConnectionNotFound) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof SyncError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err?.message ?? "Failed to run sync" }, { status: 400 })
  }
}
