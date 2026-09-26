import { NextResponse } from "next/server"
import { deleteView, getView, SavedViewError, updateView } from "@/lib/saved-views/store"
import { assertTableAccess, resolveViewer, validateViewName } from "@/lib/saved-views/guard"
import { VIEW_VISIBILITIES } from "@/lib/saved-views/types"
import type { ViewVisibility } from "@/lib/saved-views/types"
import { sanitizeViewConfig } from "@/lib/saved-views/sanitize"
import { captureAuditContext, recordAuditLog } from "@/lib/audit-log-store"

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof SavedViewError) return NextResponse.json({ error: err.message }, { status: err.status })
  console.log("[v0] saved-view request failed:", (err as Error)?.message)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const viewId = parseId((await params).id)
    if (!viewId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    if (body.visibility != null && !VIEW_VISIBILITIES.includes(body.visibility)) {
      return NextResponse.json({ error: "Invalid visibility" }, { status: 400 })
    }
    const visibility: ViewVisibility = body.visibility ?? "private"
    const tableKey = await assertTableAccess(viewer, body.tableKey, visibility)
    const name = validateViewName(body.name)

    const before = await updateView(viewer, viewId, {
      tableKey,
      name,
      visibility,
      roleKey: typeof body.roleKey === "string" ? body.roleKey : null,
      teamKey: typeof body.teamKey === "string" ? body.teamKey : null,
      config: sanitizeViewConfig(body.config),
      isDefault: Boolean(body.isDefault),
    })
    const ctx = await captureAuditContext(request).catch(() => undefined)
    await recordAuditLog(
      {
        action: "saved_view.update",
        entityType: "saved_view",
        entityId: viewId,
        entityLabel: name,
        before: { name: before.name, visibility: before.visibility, isDefault: before.isDefault },
        after: { name, visibility, isDefault: Boolean(body.isDefault) },
      },
      ctx,
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, "Failed to update view")
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const viewId = parseId((await params).id)
    if (!viewId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

    // Losing access to a table also revokes managing its views.
    const target = await getView(viewer, viewId)
    if (!target) return NextResponse.json({ error: "View not found" }, { status: 404 })
    await assertTableAccess(viewer, target.tableKey)
    const removed = await deleteView(viewer, viewId)
    const ctx = await captureAuditContext(request).catch(() => undefined)
    await recordAuditLog(
      {
        action: "saved_view.delete",
        entityType: "saved_view",
        entityId: viewId,
        entityLabel: removed.name,
        before: { tableKey: removed.tableKey, name: removed.name, visibility: removed.visibility },
      },
      ctx,
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, "Failed to delete view")
  }
}
