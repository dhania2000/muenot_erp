import { requirePlatformStaff } from "@/lib/platform-guard"
import { listTenants } from "@/lib/tenant-service"
import { isImpersonating } from "@/lib/role-model"
import { TenantManager, type TenantRow } from "@/components/platform/tenant-manager"

export const dynamic = "force-dynamic"

export default async function TenantsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const tenants = await listTenants()
  const canManage = guard.ctx.platformRole === "platform_super_admin"
  const impersonatingId = isImpersonating(guard.ctx) ? guard.ctx.impersonatedTenantId : null

  const rows: TenantRow[] = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    plan: t.plan,
    deploymentModel: t.deployment_model,
    isPlatformOwner: t.is_platform_owner,
  }))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tenants &amp; lifecycle</h1>
        <p className="text-sm text-muted-foreground">
          The full customer tenant roster. Enter a tenant to support it via audited impersonation, or manage its
          lifecycle.{" "}
          {canManage
            ? "As a super admin you can provision new tenants and suspend, reactivate or deactivate existing ones."
            : "Lifecycle changes require platform super-admin authority."}
        </p>
      </header>

      <TenantManager
        tenants={rows}
        homeTenantId={guard.ctx.homeTenantId}
        impersonatingId={impersonatingId}
        canManage={canManage}
      />
    </div>
  )
}
