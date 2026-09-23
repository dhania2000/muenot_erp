import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { getCatalogForUser, getAllowedWidgetKeys } from "@/lib/dashboards/catalog"
import {
  canManageShared,
  createDashboard,
  DashboardError,
  getDepartments,
  listDashboards,
  type Viewer,
} from "@/lib/dashboards/store"
import type { DashboardBootstrap, DashboardConfig } from "@/lib/dashboards/types"

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

export async function GET() {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const session = await getSession()
  const can = await getFeatureChecker(viewer.userId, viewer.role)
  const catalog = getCatalogForUser(can)
  const [dashboards, departments] = await Promise.all([listDashboards(viewer), getDepartments()])

  const modules = Array.from(new Map(catalog.map((c) => [c.moduleSlug, c.module])).entries()).map(
    ([slug, label]) => ({ slug, label }),
  )

  const payload: DashboardBootstrap = {
    dashboards,
    catalog,
    options: { departments, modules },
    permissions: { canManageShared: canManageShared(viewer) },
  }
  void session
  return NextResponse.json(payload)
}

export async function POST(request: Request) {
  const viewer = await resolveViewer()
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== "string") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const can = await getFeatureChecker(viewer.userId, viewer.role)
  const allowed = getAllowedWidgetKeys(can)
  const scope = ["personal", "role", "tenant"].includes(body.scope) ? body.scope : "personal"

  try {
    const id = await createDashboard(viewer, {
      name: body.name,
      scope,
      roleKey: typeof body.roleKey === "string" ? body.roleKey : null,
      config: sanitizeConfig(body.config, allowed),
    })
    return NextResponse.json({ id })
  } catch (err) {
    if (err instanceof DashboardError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.log("[v0] dashboard create failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to create dashboard" }, { status: 500 })
  }
}
