import { requirePlatformStaff } from "@/lib/platform-guard"
import { resolveRoleContext } from "@/lib/platform-roles"
import { listTenants } from "@/lib/tenant-service"
import { isImpersonating } from "@/lib/role-model"
import { TenantConsole } from "@/components/platform/tenant-console"

/**
 * SPEC 3 — Platform operator landing page: the audited entry point for tenant
 * support. Lists every tenant and lets an operator explicitly IMPERSONATE one
 * (never implicit tenant access), or exit an active impersonation.
 */
export default async function PlatformPage() {
  // The layout already gates access; re-reading here gives us the operator's
  // resolved context (home tenant + active impersonation) for the UI.
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const [tenants, ctx] = await Promise.all([
    listTenants(),
    resolveRoleContext({ userId: guard.session.userId, impersonatedTenantId: undefined }).then((c) => c),
  ])

  const activeCtx = await resolveRoleContext({
    userId: guard.session.userId,
    impersonatedTenantId: guard.ctx.impersonatedTenantId,
  })
  const impersonatingId =
    activeCtx && isImpersonating(activeCtx) ? activeCtx.impersonatedTenantId : null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          Enter a customer tenant to provide support. Impersonation grants delegated tenant-admin
          access only — never ownership — and every session is written to the platform audit log.
        </p>
      </div>
      <TenantConsole
        tenants={tenants.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          status: t.status,
          plan: t.plan,
          isPlatformOwner: t.is_platform_owner,
        }))}
        homeTenantId={ctx?.homeTenantId ?? null}
        impersonatingId={impersonatingId}
      />
    </div>
  )
}
