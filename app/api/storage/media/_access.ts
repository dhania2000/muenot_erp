import "server-only"
import { getScope } from "@/lib/permission-store"
import type { SessionPayload } from "@/lib/auth"

/**
 * Map a media asset's ERP module to the permission-model module key that guards
 * it. Monitoring media is guarded by `hr.screen_monitoring`; training/LMS media
 * have no dedicated permission module, so any authenticated tenant member may
 * view them (they remain tenant-scoped by the storage layer).
 */
function permissionModuleFor(module: string): string | null {
  if (module === "hr.screen_monitoring") return "hr.screen_monitoring"
  return null
}

/** Whether the session may VIEW media in the given module. */
export async function canViewMediaModule(session: SessionPayload, module: string): Promise<boolean> {
  const key = permissionModuleFor(module)
  if (!key) return true // no dedicated permission module — tenant membership suffices
  const scope = await getScope(session.userId, session.role, key, "view")
  return scope !== "none"
}

/** Whether the session may DELETE (purge) media in the given module. */
export async function canDeleteMediaModule(session: SessionPayload, module: string): Promise<boolean> {
  const key = permissionModuleFor(module)
  if (!key) return session.role === "admin"
  const scope = await getScope(session.userId, session.role, key, "delete")
  return scope !== "none"
}
