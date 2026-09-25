import "server-only"
/**
 * Spec28 (#125) — Request-level maintenance gate for route handlers and the
 * workspace shell. Returns a 503 with a human message + Retry-After when the
 * caller's tenant/module is in an active window and the caller may not bypass.
 */
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { resolveRoleContext } from "@/lib/platform-roles"
import { effectiveTenantId } from "@/lib/role-model"
import { getMaintenanceFor } from "@/lib/maintenance/store"
import {
  type MaintenanceWindow,
  canBypassMaintenance,
  retryAfterSeconds,
  userMessage,
} from "@/lib/maintenance/model"

export type MaintenanceGate =
  | { blocked: false; bypassed: MaintenanceWindow | null; upcoming: MaintenanceWindow[]; activeModules: string[] }
  | { blocked: true; window: MaintenanceWindow; message: string; retryAfter: number | null }

/** Evaluate maintenance for the signed-in caller (tenant from the verified session only). */
export async function evaluateMaintenanceForSession(moduleKey?: string | null): Promise<MaintenanceGate> {
  const session = await getSession()
  if (!session) return { blocked: false, bypassed: null, upcoming: [], activeModules: [] }
  const ctx = await resolveRoleContext(session as { userId: number; impersonatedTenantId?: number | null })
  const tenantId = ctx ? effectiveTenantId(ctx) : null
  const res = await getMaintenanceFor({ tenantId, moduleKey: moduleKey ?? null })
  if (!res.active) return { blocked: false, bypassed: null, upcoming: res.upcoming, activeModules: res.activeModules }
  const bypass =
    ctx != null &&
    canBypassMaintenance(res.active, { platformRole: ctx.platformRole, tenantRole: ctx.tenantRole, tenantId })
  if (bypass) return { blocked: false, bypassed: res.active, upcoming: res.upcoming, activeModules: res.activeModules }
  return { blocked: true, window: res.active, message: userMessage(res.active), retryAfter: retryAfterSeconds(res.active) }
}

export function maintenanceResponse(gate: Extract<MaintenanceGate, { blocked: true }>): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store" }
  if (gate.retryAfter != null) headers["Retry-After"] = String(gate.retryAfter)
  return NextResponse.json(
    {
      error: gate.message,
      code: "MAINTENANCE",
      maintenance: {
        scope: gate.window.scope,
        moduleKey: gate.window.moduleKey,
        title: gate.window.title,
        endsAt: gate.window.endsAt,
      },
    },
    { status: 503, headers },
  )
}

/** Route-handler helper: `const blocked = await blockIfMaintenance("support"); if (blocked) return blocked` */
export async function blockIfMaintenance(moduleKey?: string | null): Promise<NextResponse | null> {
  const gate = await evaluateMaintenanceForSession(moduleKey)
  return gate.blocked ? maintenanceResponse(gate) : null
}
