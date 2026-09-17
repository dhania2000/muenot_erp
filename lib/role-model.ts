// =============================================================
// SPEC 3 — Platform vs Tenant role model (pure, testable core)
// -------------------------------------------------------------
// The ERP is a single Muenot platform hosting many independent customer
// tenants (see SPEC 1/2). Until now the only roles were the coarse
// `users.role` = admin | employee, which made a Muenot admin functionally
// identical to a customer-tenant admin — there was NO boundary between
// operating the PLATFORM and operating a single TENANT's data.
//
// This module introduces two ORTHOGONAL role axes and the rules that keep
// them from bleeding into each other:
//
//   Platform axis (who operates the Muenot SaaS itself):
//     none          -> not a platform operator
//     platform_staff-> Muenot staff/admin: manage tenants, plans, support
//     platform_super_admin -> full platform control incl. platform staff mgmt
//
//   Tenant axis (what a user can do INSIDE their own tenant):
//     tenant_owner  -> the tenant's ultimate owner (billing, delete tenant)
//     tenant_admin  -> full admin within the tenant
//     module_admin  -> department/module admin (elevated, but scoped by the
//                      permission matrix to specific modules)
//     employee      -> normal user, scoped by the permission matrix
//
// THE BOUNDARY (the core requirement of SPEC 3):
//   * A platform role NEVER implicitly grants tenant-data permissions. A
//     platform super admin cannot add/edit/delete a customer tenant's
//     records just by being a platform admin — they must explicitly and
//     auditably IMPERSONATE that tenant first (see lib/platform-roles.ts).
//   * A tenant role NEVER grants platform access. A customer's tenant_admin
//     (or even tenant_owner) cannot reach the platform console.
//   * The two axes are stored and evaluated separately so neither can be
//     mistaken for the other.
//
// This file is intentionally free of DB / server-only imports so it can be
// unit-tested directly and reused on both server and (type-only) client.
// =============================================================

export const PLATFORM_ROLES = ["none", "platform_staff", "platform_super_admin"] as const
export type PlatformRole = (typeof PLATFORM_ROLES)[number]

export const TENANT_ROLES = ["employee", "module_admin", "tenant_admin", "tenant_owner"] as const
export type TenantRole = (typeof TENANT_ROLES)[number]

/** Rank within the platform axis. Higher = more authority. `none` = 0. */
const PLATFORM_RANK: Record<PlatformRole, number> = {
  none: 0,
  platform_staff: 10,
  platform_super_admin: 20,
}

/** Rank within the tenant axis. Higher = more authority. */
const TENANT_RANK: Record<TenantRole, number> = {
  employee: 0,
  module_admin: 10,
  tenant_admin: 20,
  tenant_owner: 30,
}

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && (PLATFORM_ROLES as readonly string[]).includes(value)
}

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value)
}

/** Normalize an unknown value to a valid platform role, defaulting to `none`. */
export function toPlatformRole(value: unknown): PlatformRole {
  return isPlatformRole(value) ? value : "none"
}

/** Normalize an unknown value to a valid tenant role, defaulting to `employee`. */
export function toTenantRole(value: unknown): TenantRole {
  return isTenantRole(value) ? value : "employee"
}

export function platformRank(role: PlatformRole): number {
  return PLATFORM_RANK[role] ?? 0
}

export function tenantRank(role: TenantRole): number {
  return TENANT_RANK[role] ?? 0
}

/** True when `role` is at least as authoritative as `min` on the platform axis. */
export function platformAtLeast(role: PlatformRole, min: PlatformRole): boolean {
  return platformRank(role) >= platformRank(min)
}

/** True when `role` is at least as authoritative as `min` on the tenant axis. */
export function tenantAtLeast(role: TenantRole, min: TenantRole): boolean {
  return tenantRank(role) >= tenantRank(min)
}

/** Any non-`none` platform role means the user operates the platform. */
export function isPlatformUser(role: PlatformRole): boolean {
  return role !== "none"
}

/**
 * Derive the legacy coarse role (`admin` | `employee`) that the existing
 * permission engine (lib/permissions.ts, lib/permission-store.ts) understands,
 * from a tenant role. Tenant admins and owners map to `admin`; module admins
 * and employees map to `employee` (their elevated access comes from the
 * permission matrix, exactly as today). This lets the new axis coexist with
 * every existing feature/matrix check without rewiring them.
 */
export function tenantRoleToLegacy(role: TenantRole): "admin" | "employee" {
  return tenantAtLeast(role, "tenant_admin") ? "admin" : "employee"
}

/**
 * Derive a tenant role from the legacy coarse role. Used to backfill sessions
 * / rows that predate the new axis: `admin` -> tenant_admin, everything else
 * -> employee. Module-admin and owner are opt-in distinctions set explicitly.
 */
export function legacyToTenantRole(legacy: "admin" | "employee"): TenantRole {
  return legacy === "admin" ? "tenant_admin" : "employee"
}

// ---------------------------------------------------------------------------
// The identity a request acts under, and the boundary rules over it.
// ---------------------------------------------------------------------------

export type RoleContext = {
  userId: number
  /** The user's HOME tenant (users.tenant_id) — never client-supplied. */
  homeTenantId: number | null
  /** True when the home tenant is the Muenot platform-owner tenant. */
  isPlatformOwnerTenant: boolean
  platformRole: PlatformRole
  tenantRole: TenantRole
  /**
   * When a platform operator has EXPLICITLY entered a customer tenant, this is
   * that tenant's id (and differs from homeTenantId). Null in normal operation.
   * Derived server-side from an audited impersonation grant, never from input.
   */
  impersonatedTenantId: number | null
}

/**
 * The tenant whose data the request is allowed to touch:
 *   - During an active impersonation, the impersonated tenant.
 *   - Otherwise, the user's home tenant.
 * This is the ONLY tenant a request may read/write, and it is what the
 * tenant-context / tenant-guard layer scopes on.
 */
export function effectiveTenantId(ctx: RoleContext): number | null {
  return ctx.impersonatedTenantId ?? ctx.homeTenantId
}

export function isImpersonating(ctx: RoleContext): boolean {
  return ctx.impersonatedTenantId != null && ctx.impersonatedTenantId !== ctx.homeTenantId
}

/**
 * Whether the request may perform a TENANT-level action requiring at least
 * `min` tenant authority against `targetTenantId`.
 *
 * THE BOUNDARY, enforced here:
 *   1. The action must target the effective tenant. A request can never act on
 *      a tenant other than its home tenant unless it is actively impersonating
 *      exactly that tenant.
 *   2. A platform role alone confers NO tenant authority. While impersonating,
 *      a platform operator acts with tenant authority ONLY up to the level the
 *      impersonation grants (capped at tenant_admin — impersonation can never
 *      become tenant_owner, so it can never delete a tenant or transfer
 *      ownership).
 *   3. Without impersonation, tenant authority comes purely from the user's own
 *      tenantRole within their own tenant.
 */
export function canActOnTenant(
  ctx: RoleContext,
  targetTenantId: number,
  min: TenantRole,
): boolean {
  const effective = effectiveTenantId(ctx)
  if (effective == null || targetTenantId !== effective) return false

  if (isImpersonating(ctx)) {
    // Impersonation grants delegated tenant-admin authority, never ownership.
    const delegated: TenantRole = "tenant_admin"
    return tenantAtLeast(delegated, min)
  }

  return tenantAtLeast(ctx.tenantRole, min)
}

/**
 * Whether the request may perform a PLATFORM-level action requiring at least
 * `min` platform authority. Tenant roles are irrelevant here — only the
 * platform axis counts — which is what stops a customer tenant_admin from ever
 * reaching the platform console.
 */
export function canActOnPlatform(ctx: RoleContext, min: PlatformRole): boolean {
  return platformAtLeast(ctx.platformRole, min)
}

// ---------------------------------------------------------------------------
// Privilege-escalation guard for role assignment.
// ---------------------------------------------------------------------------

/**
 * Whether `assigner` may grant/revoke the platform role `target` on someone.
 * Rules that prevent escalation:
 *   - Only platform operators can assign platform roles at all.
 *   - You can never grant a platform role higher than your own.
 *   - Only a platform_super_admin can create/modify another
 *     platform_super_admin (staff cannot mint super admins).
 */
export function canAssignPlatformRole(assigner: RoleContext, target: PlatformRole): boolean {
  if (!isPlatformUser(assigner.platformRole)) return false
  if (target === "platform_super_admin") {
    return assigner.platformRole === "platform_super_admin"
  }
  return platformRank(assigner.platformRole) >= platformRank(target)
}

/**
 * Whether `assigner` may grant the tenant role `target` to a user in
 * `targetTenantId`. Rules that prevent escalation:
 *   - The assigner must have tenant-admin authority over that exact tenant
 *     (which, per canActOnTenant, means it is their own tenant, or one they are
 *     actively impersonating).
 *   - You can never grant a tenant role higher than your OWN tenant role
 *     (an impersonating platform operator is capped at tenant_admin, so can
 *     never mint a tenant_owner).
 *   - Granting tenant_owner additionally requires the assigner to actually be a
 *     tenant_owner (never available via impersonation).
 */
export function canAssignTenantRole(
  assigner: RoleContext,
  targetTenantId: number,
  target: TenantRole,
): boolean {
  if (!canActOnTenant(assigner, targetTenantId, "tenant_admin")) return false

  const assignerEffectiveRank = isImpersonating(assigner)
    ? tenantRank("tenant_admin")
    : tenantRank(assigner.tenantRole)

  if (target === "tenant_owner") {
    // Ownership can only be conferred by a real owner, never by impersonation.
    return !isImpersonating(assigner) && assigner.tenantRole === "tenant_owner"
  }
  return assignerEffectiveRank >= tenantRank(target)
}

/** Human-readable label for UI. */
export function platformRoleLabel(role: PlatformRole): string {
  switch (role) {
    case "platform_super_admin":
      return "Platform Super Admin"
    case "platform_staff":
      return "Platform Staff"
    default:
      return "—"
  }
}

export function tenantRoleLabel(role: TenantRole): string {
  switch (role) {
    case "tenant_owner":
      return "Tenant Owner"
    case "tenant_admin":
      return "Tenant Admin"
    case "module_admin":
      return "Department/Module Admin"
    default:
      return "Employee"
  }
}
