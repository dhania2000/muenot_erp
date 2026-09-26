import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { captureAuditContext } from "@/lib/audit-log-store"
import { getRecycleEntry, purgeEntry, restoreEntry } from "@/lib/recycle-bin/store"

/** SPEC 35 — Read a single recycle bin entry (tenant-scoped). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const entry = await getRecycleEntry(tenantId, id)
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ entry })
}

/**
 * SPEC 35 — Restore a soft-deleted record. `overrideWindow` lets an admin
 * recover past the restore window explicitly. The store re-checks tenant scope,
 * legal hold and window before touching any data and writes an immutable audit
 * event either way.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  const audit = await captureAuditContext(request).catch(() => undefined)

  try {
    const result = await restoreEntry(tenantId, id, actor, { overrideWindow: Boolean(body?.overrideWindow) }, audit)
    if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return NextResponse.json({ entry: result.entry })
  } catch (err) {
    console.error("[v0] recycle-bin restore error:", err)
    return NextResponse.json({ error: "Failed to restore record" }, { status: 500 })
  }
}

/**
 * SPEC 35 — Manually purge (permanently delete) a recycle bin entry. Blocked
 * while a legal hold covers the record.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  const audit = await captureAuditContext(request).catch(() => undefined)

  try {
    const result = await purgeEntry(tenantId, id, actor, "manual", audit)
    if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status })
    return NextResponse.json({ entry: result.entry })
  } catch (err) {
    console.error("[v0] recycle-bin purge error:", err)
    return NextResponse.json({ error: "Failed to purge record" }, { status: 500 })
  }
}
