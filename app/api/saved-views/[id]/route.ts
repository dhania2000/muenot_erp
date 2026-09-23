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
import type { TableViewConfig, ViewVisibility } from "@/lib/saved-views/types"

async function resolveViewer(): Promise<Viewer | null> {
  const session = await getSession()
  if (!session) return null
  const tenantId = session.tenantId ?? 0
  const tenantRole = session.tenantRole ?? (session.role === "admin" ? "tenant_admin" : "employee")
  const roleKeys = new Set<string>([session.role, tenantRole])
  const teamKeys = await resolveTeamKeys(tenantId, session.userId)
  return { userId: session.userId, tenantId, role: session.role, tenantRole, roleKeys, teamKeys }
}

function sanitizeConfig(raw: any): TableViewConfig {
  if (!raw || typeof raw !== "object") return {}
  const columns = Array.isArray(raw.columns)
    ? raw.columns
        .filter((c: any) => c && typeof c.key === "string")
        .slice(0, 200)
        .map((c: any) => ({ key: String(c.key).slice(0, 96), hidden: Boolean(c.hidden) }))
    : undefined
  const sort = Array.isArray(raw.sort)
    ? raw.sort
        .filter((s: any) => s && typeof s.key === "string")
        .slice(0, 8)
        .map((s: any) => ({ key: String(s.key).slice(0, 96), dir: s.dir === "desc" ? "desc" : "asc" }))
    : undefined
  let filters: Record<string, string | string[] | null> | undefined
  if (raw.filters && typeof raw.filters === "object" && !Array.isArray(raw.filters)) {
    filters = {}
    for (const [k, v] of Object.entries(raw.filters).slice(0, 40)) {
      if (v == null) filters[k.slice(0, 64)] = null
      else if (typeof v === "string") filters[k.slice(0, 64)] = v.slice(0, 200)
      else if (Array.isArray(v))
        filters[k.slice(0, 64)] = v.filter((x) => typeof x === "string").slice(0, 50) as string[]
    }
  }
  const pageSize = Number.isFinite(raw.pageSize) ? Math.min(500, Math.max(1, Math.trunc(raw.pageSize))) : undefined
  return {
    search: typeof raw.search === "string" ? raw.search.slice(0, 200) : undefined,
    filters,
    columns,
    sort,
    groupBy: typeof raw.groupBy === "string" ? raw.groupBy.slice(0, 96) : raw.groupBy === null ? null : undefined,
    pageSize,
  }
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
      config: sanitizeConfig(body.config),
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
