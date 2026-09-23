import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { getAllowedWidgetKeys } from "@/lib/dashboards/catalog"
import {
  DashboardError,
  deleteDashboard,
  updateDashboard,
  type Viewer,
} from "@/lib/dashboards/store"
import type { DashboardConfig } from "@/lib/dashboards/types"

async function resolveViewer(): Promise<Viewer | null> {
  const session = await getSession()
  if (!session) return null
  const tenantId = session.tenantId ?? 0
  const tenantRole = session.tenantRole ?? (session.role === "admin" ? "tenant_admin" : "employee")
  const roleKeys = new Set<string>([session.role, tenantRole])
  return { userId: session.userId, tenantId, role: session.role, tenantRole, roleKeys }
}

function sanitizeConfig(raw: any, allowed: Set<string>): DashboardConfig {
  const widgets = Array.isArray(raw?.widgets)
    ? raw.widgets
        .filter((w: any) => w && typeof w.key === "string" && allowed.has(w.key))
        .slice(0, 40)
        .map((w: any) => ({ id: String(w.id ?? w.key), key: String(w.key) }))
    : []
  const f = raw?.filters ?? {}
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  return {
    widgets,
    filters: {
      preset: typeof f.preset === "string" ? f.preset.slice(0, 24) : "last_30",
      from: typeof f.from === "string" && dateRe.test(f.from) ? f.from : null,
      to: typeof f.to === "string" && dateRe.test(f.to) ? f.to : null,
      department: typeof f.department === "string" && f.department.trim() ? f.department.slice(0, 120) : null,
      modules: Array.isArray(f.modules)
        ? f.modules.filter((m: any) => typeof m === "string").slice(0, 30)
        : null,
    },
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const dashboardId = Number(id)
  if (!Number.isInteger(dashboardId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const can = await getFeatureChecker(viewer.userId, viewer.role)
  const allowed = getAllowedWidgetKeys(can)
  const scope = ["personal", "role", "tenant"].includes(body.scope) ? body.scope : "personal"

  try {
    await updateDashboard(viewer, dashboardId, {
      name: body.name,
      scope,
      roleKey: typeof body.roleKey === "string" ? body.roleKey : null,
      config: sanitizeConfig(body.config, allowed),
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof DashboardError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.log("[v0] dashboard update failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to update dashboard" }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const dashboardId = Number(id)
  if (!Number.isInteger(dashboardId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  try {
    await deleteDashboard(viewer, dashboardId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof DashboardError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.log("[v0] dashboard delete failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to delete dashboard" }, { status: 500 })
  }
}
