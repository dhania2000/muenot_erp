import { requirePlatformStaff } from "@/lib/platform-guard"
import { listDemoTenants } from "@/lib/demo-tenant-store"
import { DemoTenantManager } from "@/components/platform/demo-tenant-manager"

export const dynamic = "force-dynamic"

export default async function DemoTenantsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const demoTenants = await listDemoTenants()
  const canManage = guard.ctx.platformRole === "platform_super_admin"

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Demo tenants</h1>
        <p className="text-sm text-muted-foreground text-pretty">
          Throwaway, clearly-marked tenants cloned from a synthetic demo template. Clones get fresh IDs and admin
          credentials and never contain customer data, secrets, integrations or payment methods. Expired clones are
          locked out and purged automatically.
          {canManage ? "" : " Creating, resetting and cleaning up demos requires platform super-admin authority."}
        </p>
      </header>
      <DemoTenantManager demoTenants={demoTenants} canManage={canManage} />
    </div>
  )
}
