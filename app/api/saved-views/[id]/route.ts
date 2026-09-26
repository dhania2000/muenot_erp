import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  deleteView,
  resolveTeamKeys,
  SavedViewError,
  updateView,
  type Viewer,
} from "@/lib/saved-views/store"
import { VIEW_VISIBILITIES } from "@/lib/saved-views/types"
import type { ViewVisibility } from "@/lib/saved-views/types"
import { sanitizeViewConfig } from "@/lib/saved-views/sanitize"

async function resolveViewer(): Promise<Viewer | null> {
  const session = await getSession()
  if (!session) return null
  const tenantId = session.tenantId ?? 0
  const tenantRole = session.tenantRole ?? (session.role === "admin" ? "tenant_admin" : "employee")
  const roleKeys = new Set<string>([session.role, tenantRole])
  const teamKeys = await resolveTeamKeys(tenantId, session.userId)
  return { userId: session.userId, tenantId, role: session.role, tenantRole, roleKeys, teamKeys }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const viewId = Number(id)
  if (!Number.isInteger(viewId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== "string" || typeof body.tableKey !== "string") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }
  const visibility: ViewVisibility = VIEW_VISIBILITIES.includes(body.visibility) ? body.visibility : "private"

  try {
    await updateView(viewer, viewId, {
      tableKey: body.tableKey,
      name: body.name,
      visibility,
      roleKey: typeof body.roleKey === "string" ? body.roleKey : null,
      teamKey: typeof body.teamKey === "string" ? body.teamKey : null,
      config: sanitizeViewConfig(body.config),
      isDefault: Boolean(body.isDefault),
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof SavedViewError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.log("[v0] saved-view update failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to update view" }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const viewId = Number(id)
  if (!Number.isInteger(viewId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  try {
    await deleteView(viewer, viewId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof SavedViewError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.log("[v0] saved-view delete failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to delete view" }, { status: 500 })
  }
}
