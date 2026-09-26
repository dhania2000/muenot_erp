import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  canManageShared,
  createView,
  listViews,
  resolveTeamKeys,
  SavedViewError,
  type Viewer,
} from "@/lib/saved-views/store"
import { ROLE_KEYS, ROLE_KEY_LABELS, VIEW_VISIBILITIES } from "@/lib/saved-views/types"
import type { SavedViewsBootstrap, ViewVisibility } from "@/lib/saved-views/types"
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

export async function GET(request: Request) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const tableKey = new URL(request.url).searchParams.get("table")?.trim()
  if (!tableKey) return NextResponse.json({ error: "A table key is required" }, { status: 400 })

  const views = await listViews(viewer, tableKey.slice(0, 96))
  const payload: SavedViewsBootstrap = {
    views,
    permissions: { canManageShared: canManageShared(viewer) },
    roles: ROLE_KEYS.map((key) => ({ key, label: ROLE_KEY_LABELS[key] ?? key })),
    teams: Array.from(viewer.teamKeys),
  }
  return NextResponse.json(payload)
}

export async function POST(request: Request) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== "string" || typeof body.tableKey !== "string") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }
  const visibility: ViewVisibility = VIEW_VISIBILITIES.includes(body.visibility) ? body.visibility : "private"

  try {
    const id = await createView(viewer, {
      tableKey: body.tableKey,
      name: body.name,
      visibility,
      roleKey: typeof body.roleKey === "string" ? body.roleKey : null,
      teamKey: typeof body.teamKey === "string" ? body.teamKey : null,
      config: sanitizeViewConfig(body.config),
      isDefault: Boolean(body.isDefault),
    })
    return NextResponse.json({ id })
  } catch (err) {
    if (err instanceof SavedViewError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.log("[v0] saved-view create failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to create view" }, { status: 500 })
  }
}
