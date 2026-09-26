import "server-only"
/**
 * Request-level authorization guards for the platform/tenant boundary.
 * ---------------------------------------------------------------------------
 * These are the helpers route handlers call. They combine the verified session
 * (lib/auth.ts) with the stored roles (lib/platform-roles.ts) and the pure
 * boundary rules (lib/role-model.ts) to answer two separate questions that must
 * never be conflated:
 *
 *   requirePlatform*()  — may this request operate the Muenot PLATFORM?
 *   requireTenant*()    — may this request operate a specific TENANT's data?
 *
 * Authorization ALWAYS re-resolves roles from the DB source of truth rather
 * than trusting the token fields, so a stale or forged token cannot widen
 * access. Every guard returns a discriminated result the caller turns into an
 * HTTP status, keeping the "who can do what" decision in one auditable place.
 */
import { getSession } from "@/lib/auth"
import {
  type PlatformRole,
  type RoleContext,
  type TenantRole,
  canActOnPlatform,
  canActOnTenant,
  effectiveTenantId,
  isImpersonating,
} from "@/lib/role-model"
import { resolveRoleContext } from "@/lib/platform-roles"

export type GuardOk = {
  ok: true
  ctx: RoleContext
  session: { userId: number; email: string; name: string }
}
export type GuardDenied = {
  ok: false
  status: 401 | 403
  reason: string
}
export type GuardResult = GuardOk | GuardDenied

async function loadContext(): Promise<
  | { session: { userId: number; email: string; name: string; impersonatedTenantId?: number | null }; ctx: RoleContext }
  | null
> {
  const session = await getSession()
  if (!session) return null
  const ctx = await resolveRoleContext({
    userId: session.userId,
    impersonatedTenantId: session.impersonatedTenantId,
    impersonationExpiresAt: session.impersonationExpiresAt ?? null,
  })
  if (!ctx) return null
  return { session, ctx }
}

/**
 * Require at least `min` PLATFORM authority. Tenant roles are irrelevant here:
 * a customer tenant_owner/tenant_admin can NEVER pass this, which is what keeps
 * the platform console off-limits to tenant users.
 */
export async function requirePlatformRole(min: PlatformRole): Promise<GuardResult> {
  const loaded = await loadContext()
  if (!loaded) return { ok: false, status: 401, reason: "Not authenticated" }
  if (!canActOnPlatform(loaded.ctx, min)) {
    return { ok: false, status: 403, reason: "Platform privileges required" }
  }
  return { ok: true, ctx: loaded.ctx, session: loaded.session }
}

export function requirePlatformStaff(): Promise<GuardResult> {
  return requirePlatformRole("platform_staff")
}
export function requirePlatformSuperAdmin(): Promise<GuardResult> {
  return requirePlatformRole("platform_super_admin")
}

/**
 * Require at least `min` TENANT authority over `targetTenantId`. When
 * targetTenantId is omitted it defaults to the request's effective tenant
 * (home tenant, or the impersonated tenant during an active impersonation).
 *
 * THE BOUNDARY: a platform role alone grants NOTHING here. A platform operator
 * only clears this guard for a customer tenant while actively impersonating it,
 * and even then is capped at tenant_admin — never tenant_owner (see
 * canActOnTenant). A cross-tenant target id is always rejected, which is the
 * core cross-tenant IDOR/authZ defense for tenant-scoped routes.
 */
export async function requireTenantRole(
  min: TenantRole,
  targetTenantId?: number,
): Promise<GuardResult> {
  const loaded = await loadContext()
  if (!loaded) return { ok: false, status: 401, reason: "Not authenticated" }
  const target = targetTenantId ?? effectiveTenantId(loaded.ctx)
  if (target == null) return { ok: false, status: 403, reason: "No tenant in context" }
  if (!canActOnTenant(loaded.ctx, target, min)) {
    return { ok: false, status: 403, reason: "Insufficient tenant privileges" }
  }
  return { ok: true, ctx: loaded.ctx, session: loaded.session }
}

export function requireTenantAdmin(targetTenantId?: number): Promise<GuardResult> {
  return requireTenantRole("tenant_admin", targetTenantId)
}
export function requireTenantOwner(targetTenantId?: number): Promise<GuardResult> {
  return requireTenantRole("tenant_owner", targetTenantId)
}

export { effectiveTenantId, isImpersonating }
